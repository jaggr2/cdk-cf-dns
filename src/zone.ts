import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * A reference to a Cloudflare zone that already exists in the Cloudflare account.
 *
 * `CloudflareZone.fromZoneId()` is the only supported way to obtain one; this
 * library deliberately does not create zones. Zones are assumed to be managed in
 * the Cloudflare dashboard (or elsewhere) and referenced here by their Zone ID.
 */
export interface ICloudflareZone {
  /**
   * The Cloudflare Zone ID, e.g. `"abc123..."`. This may be a plain string or a
   * CDK token (for example resolved from SSM at deploy time).
   */
  readonly zoneId: string;

  /**
   * The apex domain, e.g. `"example.com"`. When set, `recordName` values that do
   * not already end in the zone name are treated as relative and this suffix is
   * appended, matching `aws-cdk-lib/aws-route53` ergonomics.
   *
   * @default - record names are used verbatim
   */
  readonly zoneName?: string;

  /**
   * The Secrets Manager secret holding the Cloudflare API token. The secret may
   * contain the token as a raw string or as a JSON blob with an `apiToken` key.
   * Only the secret name (and region) ever appear in the CloudFormation template.
   */
  readonly apiToken: secretsmanager.ISecret;

  /**
   * The region where the API token secret lives. This is only needed when the
   * secret is in a different region than the stack (for example an ACM
   * certificate stack in `us-east-1` whose token secret lives in
   * `eu-central-1`). When omitted, it is inferred from the secret ARN when the
   * secret was imported by full ARN, otherwise the stack region is used.
   *
   * @default - inferred from the secret ARN, otherwise the stack region
   */
  readonly apiTokenRegion?: string;
}

/**
 * Properties for referencing an existing Cloudflare zone.
 */
export interface CloudflareZoneAttributes {
  /**
   * The Cloudflare Zone ID, e.g. `"abc123..."`. This may be a plain string or a
   * CDK token (for example resolved from SSM at deploy time).
   */
  readonly zoneId: string;

  /**
   * The Secrets Manager secret holding the Cloudflare API token. The secret may
   * contain the token as a raw string or as a JSON blob with an `apiToken` key.
   * Only the secret name (and region) ever appear in the CloudFormation template.
   */
  readonly apiToken: secretsmanager.ISecret;

  /**
   * The apex domain, e.g. `"example.com"`. Enables relative record names.
   *
   * @default - record names are used verbatim
   */
  readonly zoneName?: string;

  /**
   * The region where the API token secret lives. Only needed when the secret is
   * in a different region than the stack (for example an ACM certificate stack
   * in `us-east-1` whose token secret lives in `eu-central-1`). When omitted,
   * it is inferred from the secret ARN when the secret was imported by full
   * ARN, otherwise the stack region is used.
   *
   * @default - inferred from the secret ARN, otherwise the stack region
   */
  readonly apiTokenRegion?: string;
}

/**
 * A reference to an existing Cloudflare zone.
 *
 * Zones are not created by this library; they must already exist in the
 * Cloudflare account. Use `CloudflareZone.fromZoneId()` to reference one.
 */
export class CloudflareZone extends Construct implements ICloudflareZone {
  /**
   * Reference an existing Cloudflare zone by its Zone ID.
   *
   * @param scope The scope in which to define this construct.
   * @param id    The scoped construct ID.
   * @param attrs The zone attributes.
   */
  public static fromZoneId(scope: Construct, id: string, attrs: CloudflareZoneAttributes): ICloudflareZone {
    return new CloudflareZone(scope, id, attrs);
  }

  public readonly zoneId: string;
  public readonly zoneName?: string;
  public readonly apiToken: secretsmanager.ISecret;
  public readonly apiTokenRegion: string;

  private constructor(scope: Construct, id: string, attrs: CloudflareZoneAttributes) {
    super(scope, id);

    if (attrs.zoneId === undefined || attrs.zoneId === '') {
      throw new Error('CloudflareZone requires a zoneId');
    }
    if (attrs.apiToken === undefined) {
      throw new Error('CloudflareZone requires an apiToken secret');
    }

    this.zoneId = validateNoToken(attrs.zoneId, 'zoneId');
    this.zoneName = attrs.zoneName === undefined ? undefined : validateNoToken(attrs.zoneName, 'zoneName');
    this.apiToken = attrs.apiToken;
    this.apiTokenRegion = resolveApiTokenRegion(scope, attrs);
  }
}

/**
 * Resolves the region where the API token secret lives: an explicit
 * `apiTokenRegion` wins, otherwise the region is read from a literal secret ARN
 * when one was provided, otherwise the stack region is assumed.
 */
function resolveApiTokenRegion(scope: Construct, attrs: CloudflareZoneAttributes): string {
  if (attrs.apiTokenRegion !== undefined) {
    return attrs.apiTokenRegion;
  }

  const arn = attrs.apiToken.secretArn;
  if (!cdk.Token.isUnresolved(arn)) {
    const match = /^arn:[^:]+:secretsmanager:([^:]+):/.exec(arn);
    if (match) {
      return match[1];
    }
  }

  return cdk.Stack.of(scope).region;
}

/**
 * Validates a string value that may be a CDK token. Tokens are never validated
 * with patterns (a regex would break on `${Token[...]}`); only the syntactic
 * sanity of resolved values is checked.
 */
function validateNoToken(value: string, field: string): string {
  if (cdk.Token.isUnresolved(value)) {
    return value;
  }
  if (value.length === 0) {
    throw new Error(`CloudflareZone ${field} must not be empty`);
  }
  if (/[^A-Za-z0-9._-]/.test(value)) {
    throw new Error(`CloudflareZone ${field} contains invalid characters: ${value}`);
  }
  return value;
}
