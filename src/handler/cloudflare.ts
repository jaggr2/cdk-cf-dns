import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Shared helpers for the Lambda handlers. This module is bundled into each
 * handler entry point by esbuild; it is never imported by CDK library code.
 */

/**
 * The base URL for the Cloudflare API v4.
 */
export const CF_BASE_URL = 'https://api.cloudflare.com/client/v4';

/**
 * How many attempts the retrying HTTP helper makes before giving up.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Base backoff delay in milliseconds, doubled each attempt with full jitter.
 */
export const BACKOFF_BASE_MS = 500;

/**
 * Upper bound for a single backoff sleep in milliseconds.
 */
export const BACKOFF_CAP_MS = 4000;

/**
 * A regular expression matching strings that look like Cloudflare credentials
 * (API tokens are 40 characters, global API keys 37). Anything matching is
 * redacted from logs.
 */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{37,}/g;

/**
 * Cloudflare record IDs are 32 lowercase hex characters.
 */
export const RECORD_ID_PATTERN = /^[a-f0-9]{32}$/;

/**
 * The shape of a Cloudflare API response envelope.
 */
export interface CloudflareResponse {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: unknown;
}

/**
 * A DNS record as returned by the Cloudflare API.
 */
export interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
}

const secretCache = new Map<string, string>();
const secretClients = new Map<string, SecretsManagerClient>();

/**
 * Redacts strings that look like Cloudflare credentials (and known token
 * values) from arbitrary log payloads.
 *
 * @param value The value to redact.
 * @returns A copy of `value` with token-shaped strings replaced.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(TOKEN_PATTERN, '[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redact(item);
    }
    return out;
  }
  return value;
}

/**
 * Logs a message to CloudWatch with all token-shaped strings redacted.
 */
export function log(...args: unknown[]): void {
  console.log(...args.map((arg) => redact(arg)));
}

/**
 * Resolves the Cloudflare API token from Secrets Manager, caching it per
 * (region, secret id) so warm invocations skip the API call. Supports the
 * secret being either a raw string or a JSON blob with an `apiToken` key.
 *
 * The secret id may be a full ARN, a partial ARN, or the secret name. The
 * region comes from the zone's resolved `apiTokenRegion`, so secrets in a
 * different region than the stack are read from the right endpoint.
 *
 * @param secretId The secret id (name, partial ARN or full ARN) holding the token.
 * @param region   The region the secret lives in.
 */
export async function getApiToken(secretId: string, region: string): Promise<string> {
  const cacheKey = `${region}/${secretId}`;
  const cached = secretCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let client = secretClients.get(region);
  if (!client) {
    client = new SecretsManagerClient({ region });
    secretClients.set(region, client);
  }

  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const secretString = response.SecretString;
  if (secretString === undefined) {
    throw new Error(`Secret ${secretId} has no SecretString; store the API token as a raw string or a JSON blob with an "apiToken" key`);
  }

  let token = secretString;
  try {
    const parsed: unknown = JSON.parse(secretString);
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).apiToken === 'string') {
      token = (parsed as Record<string, unknown>).apiToken as string;
    }
  } catch {
    // Not JSON: treat the raw string as the token.
  }

  if (token.length === 0) {
    throw new Error(`Secret ${secretId} resolved to an empty API token`);
  }

  secretCache.set(cacheKey, token);
  return token;
}

/**
 * Returns true when a boolean custom resource property is true. CloudFormation
 * delivers nested property values stringified, so `false` arrives as the string
 * `"false"` (which is truthy in JavaScript); this treats it correctly.
 */
export function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * A Cloudflare API error, carrying the HTTP status and the error payload so the
 * lifecycle logic can inspect specific error codes.
 */
export class CloudflareApiError extends Error {
  public readonly status: number;
  public readonly errors: Array<{ code: number; message: string }>;

  public constructor(status: number, errors: Array<{ code: number; message: string }>) {
    const details = errors.map((error) => `${error.code}: ${error.message}`).join('; ');
    super(`Cloudflare API error (HTTP ${status}): ${String(redact(details))}`);
    this.status = status;
    this.errors = errors;
  }
}

/**
 * Performs an HTTP request against the Cloudflare API with retries.
 *
 * Retries with exponential backoff + full jitter on HTTP 429, 5xx and network
 * errors, honouring the `Retry-After` header when present.
 *
 * @param path    The API path, e.g. `/zones/{id}/dns_records`.
 * @param options Request options. A resolved token is sent as `token`.
 */
export async function request(
  path: string,
  options: { method: string; token?: string; body?: unknown },
): Promise<{ status: number; body: CloudflareResponse }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.token !== undefined) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const url = `${CF_BASE_URL}${path}`;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: options.method,
        headers,
        body,
      });

      const text = await response.text();
      let parsed: CloudflareResponse;
      try {
        parsed = JSON.parse(text) as CloudflareResponse;
      } catch {
        parsed = {
          success: false,
          errors: [{ code: 0, message: `Non-JSON response (HTTP ${response.status}): ${truncate(text, 500)}` }],
          messages: [],
          result: null,
        };
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        await sleepForRetry(response, attempt);
        continue;
      }

      return { status: response.status, body: parsed };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_ATTEMPTS - 1) {
        log('retry', { path, attempt, reason: `network error: ${lastError.message}` });
        await sleepForRetry(undefined, attempt);
      }
    }
  }

  throw lastError ?? new Error(`Request to ${path} failed after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Sleeps for a backoff interval, honouring `Retry-After` when the server
 * provided one and otherwise using exponential backoff with full jitter.
 */
async function sleepForRetry(response: Response | undefined, attempt: number): Promise<void> {
  let delayMs: number;

  const retryAfter = response?.headers.get('Retry-After');
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number.parseInt(retryAfter, 10);
    delayMs = Number.isFinite(seconds) ? Math.min(seconds * 1000, BACKOFF_CAP_MS) : BACKOFF_CAP_MS;
  } else {
    const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    delayMs = Math.random() * cap;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Truncates a long string for inclusion in an error message.
 */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/**
 * Throws a descriptive error when the Cloudflare response has `success: false`.
 */
export function assertSuccess(response: { status: number; body: CloudflareResponse }): void {
  if (!response.body.success) {
    throw new CloudflareApiError(response.status, response.body.errors);
  }
}

/**
 * Returns true when the response indicates the record already exists.
 */
export function isAlreadyExists(response: { status: number; body: CloudflareResponse }): boolean {
  if (response.body.success) {
    return false;
  }
  return response.body.errors.some((error) => {
    const codeMatches = error.code === 81053 || error.code === 81057;
    const messageMatches = /already exists/i.test(error.message);
    return codeMatches || messageMatches;
  });
}

/**
 * Returns true when the response indicates the record no longer exists.
 */
export function isRecordDoesNotExist(response: { status: number; body: CloudflareResponse }): boolean {
  return response.body.errors.some((error) => error.code === 81044);
}

/**
 * Builds the DNS record payload sent to the Cloudflare API from the custom
 * resource properties.
 *
 * CloudFormation can deliver nested custom resource properties with stringified
 * values (e.g. `ttl: "300"`), so numeric and boolean fields are coerced back to
 * their real types before the payload is sent.
 */
export function buildRecordPayload(properties: Record<string, unknown>): Record<string, unknown> {
  const record = (properties.record ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {};

  for (const key of ['name', 'type', 'content', 'data', 'ttl', 'proxied', 'priority', 'comment', 'tags']) {
    if (record[key] === undefined) {
      continue;
    }
    switch (key) {
      case 'ttl':
      case 'priority':
        payload[key] = Number(record[key]);
        break;
      case 'proxied':
        payload[key] = record[key] === true || record[key] === 'true';
        break;
      default:
        payload[key] = record[key];
    }
  }

  return payload;
}

/**
 * Creates a DNS record and returns the Cloudflare record.
 */
export async function createRecord(zoneId: string, payload: Record<string, unknown>, token: string): Promise<CloudflareDnsRecord> {
  const response = await request(`/zones/${zoneId}/dns_records`, { method: 'POST', token, body: payload });
  assertSuccess(response);
  return response.body.result as CloudflareDnsRecord;
}

/**
 * Looks up a record by name and type in the zone.
 */
export async function findRecord(zoneId: string, name: string, type: string, token: string): Promise<CloudflareDnsRecord | undefined> {
  const response = await request(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&type=${type}`, { method: 'GET', token });
  assertSuccess(response);
  const results = response.body.result as CloudflareDnsRecord[];
  return results[0];
}
