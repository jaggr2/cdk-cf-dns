import { ACMClient, DeleteCertificateCommand, DescribeCertificateCommand, RequestCertificateCommand } from '@aws-sdk/client-acm';
import type { CloudFormationCustomResourceCreateEvent, CloudFormationCustomResourceDeleteEvent, CloudFormationCustomResourceEvent, CloudFormationCustomResourceUpdateEvent } from 'aws-lambda';
import { assertSuccess, findRecord, getApiToken, isAlreadyExists, log, request } from './cloudflare';

const acmClient = new ACMClient({});

/**
 * A single ACM DNS validation CNAME (name/value pair).
 */
interface ValidationRecord {
  name: string;
  value: string;
}

/**
 * Sleeps for the given number of milliseconds.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Requests a new DNS-validated certificate and returns its ARN.
 */
async function requestCertificate(domainName: string, subjectAlternativeNames: string[]): Promise<string> {
  const response = await acmClient.send(new RequestCertificateCommand({
    DomainName: domainName,
    SubjectAlternativeNames: subjectAlternativeNames.length > 0 ? subjectAlternativeNames : undefined,
    ValidationMethod: 'DNS',
  }));
  if (!response.CertificateArn) {
    throw new Error('RequestCertificate returned no CertificateArn');
  }
  return response.CertificateArn;
}

/**
 * Describes the certificate and returns the deduplicated DNS validation records
 * that ACM currently exposes. A wildcard SAN and its apex share one record, so
 * records are deduplicated on the name/value pair.
 */
async function describeValidationRecords(certificateArn: string): Promise<ValidationRecord[]> {
  const response = await acmClient.send(new DescribeCertificateCommand({ CertificateArn: certificateArn }));
  const options = response.Certificate?.DomainValidationOptions ?? [];
  const records: ValidationRecord[] = [];

  for (const option of options) {
    const resourceRecord = option.ResourceRecord;
    if (resourceRecord?.Name && resourceRecord.Value) {
      const name = resourceRecord.Name.replace(/\.$/, '');
      const value = resourceRecord.Value.replace(/\.$/, '');
      const duplicate = records.some((r) => r.name === name && r.value === value);
      if (!duplicate) {
        records.push({ name, value });
      }
    }
  }

  return records;
}

/**
 * Polls ACM until the validation `ResourceRecord`s are populated. They are
 * absent for a few seconds after the certificate is requested, so the handler
 * retries until they appear or the deadline is reached.
 */
async function pollValidationRecords(
  certificateArn: string,
  delaySeconds: number,
  timeoutSeconds: number,
): Promise<ValidationRecord[]> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const records = await describeValidationRecords(certificateArn);
    if (records.length > 0) {
      return records;
    }
    await sleep(delaySeconds * 1000);
  }

  throw new Error(`Timed out waiting for ACM DNS validation records for ${certificateArn}`);
}

/**
 * Polls until the certificate reaches ISSUED. Returns true if it did, false if
 * the deadline elapsed first (the records are already written, so ACM will
 * complete validation shortly after).
 */
async function pollUntilIssued(certificateArn: string, delaySeconds: number, timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const response = await acmClient.send(new DescribeCertificateCommand({ CertificateArn: certificateArn }));
    if (response.Certificate?.Status === 'ISSUED') {
      return true;
    }
    await sleep(delaySeconds * 1000);
  }

  return false;
}

/**
 * Creates (or adopts) a CNAME validation record in Cloudflare. Validation
 * records must never be proxied and must use a plain TTL.
 */
async function upsertCname(zoneId: string, name: string, value: string, token: string): Promise<void> {
  const payload: Record<string, unknown> = {
    name,
    type: 'CNAME',
    content: value,
    ttl: 60,
    proxied: false,
  };

  const response = await request(`/zones/${zoneId}/dns_records`, { method: 'POST', token, body: payload });

  if (isAlreadyExists(response)) {
    log('validation', { message: 'validation record already exists; adopting', zoneId, name });
    const existing = await findRecord(zoneId, name, 'CNAME', token);
    if (!existing) {
      throw new Error(`Cloudflare reported ${name} already exists but the lookup found no matching record`);
    }
    await request(`/zones/${zoneId}/dns_records/${existing.id}`, { method: 'PATCH', token, body: payload });
    return;
  }

  assertSuccess(response);
}

/**
 * Coerces a string array property. CloudFormation can deliver nested arrays
 * stringified, so a JSON string is parsed back into an array.
 */
function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch {
      // Not a JSON array; treat the string as a single element.
    }
    return [value];
  }
  return [];
}

/**
 * Handles both `Create` and `Update`: requests the certificate, writes each
 * unique validation CNAME into Cloudflare, waits for issuance and returns the
 * certificate ARN.
 */
async function onUpsert(
  event: CloudFormationCustomResourceCreateEvent | CloudFormationCustomResourceUpdateEvent,
): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  const properties = event.ResourceProperties as Record<string, unknown>;
  const domainName = String(properties.domainName);
  const subjectAlternativeNames = coerceStringArray(properties.subjectAlternativeNames);
  const zoneId = String(properties.zoneId);
  const token = await getApiToken(String(properties.apiTokenSecretId), String(properties.apiTokenRegion));
  const delaySeconds = Number(properties.pollDelaySeconds ?? 5);
  const recordPollTimeoutSeconds = Number(properties.recordPollTimeoutSeconds ?? 120);
  const issuedPollTimeoutSeconds = Number(properties.issuedPollTimeoutSeconds ?? 480);

  log('validation', { domainName, subjectAlternativeNames, zoneId });

  const certificateArn = await requestCertificate(domainName, subjectAlternativeNames);
  log('validation', { message: 'certificate requested', certificateArn });

  const records = await pollValidationRecords(certificateArn, delaySeconds, recordPollTimeoutSeconds);
  for (const record of records) {
    await upsertCname(zoneId, record.name, record.value, token);
  }

  const issued = await pollUntilIssued(certificateArn, delaySeconds, issuedPollTimeoutSeconds);
  if (!issued) {
    log('validation', { message: 'certificate not yet ISSUED when the deadline elapsed; returning the ARN', certificateArn });
  }

  return {
    PhysicalResourceId: certificateArn,
    Data: {
      CertificateArn: certificateArn,
      ValidationRecords: records.map((r) => r.name),
    },
  };
}

/**
 * Handles `Delete`: deletes the certificate ACM created. This is best-effort —
 * if the certificate is still in use the delete fails and the record is left.
 */
async function onDelete(event: CloudFormationCustomResourceDeleteEvent): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  const physicalId = event.PhysicalResourceId;
  if (physicalId.startsWith('arn:aws:acm:')) {
    try {
      await acmClient.send(new DeleteCertificateCommand({ CertificateArn: physicalId }));
      log('validation', { message: 'certificate deleted', physicalId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('validation', { message: `certificate delete failed and was ignored: ${message}`, physicalId });
    }
  }
  return { PhysicalResourceId: physicalId, Data: {} };
}

/**
 * The Lambda handler for the `Custom::CloudflareCertificateDnsValidation`
 * custom resource.
 *
 * @param event The CloudFormation custom resource event.
 * @returns The custom resource result with `PhysicalResourceId` and `Data`.
 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  try {
    log('event', { requestType: event.RequestType });

    switch (event.RequestType) {
      case 'Create':
        return await onUpsert(event);
      case 'Update':
        return await onUpsert(event);
      case 'Delete':
        return await onDelete(event);
      default:
        throw new Error(`Unsupported RequestType: ${(event as { RequestType?: string }).RequestType}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cloudflare ACM DNS validation custom resource failed during ${event.RequestType}: ${message}`);
  }
}
