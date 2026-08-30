import { ACMClient, DescribeCertificateCommand } from '@aws-sdk/client-acm';
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
 * absent for a few seconds after the certificate is created, so the handler
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
 * Handles both `Create` and `Update`: reads the certificate's validation
 * records from ACM and writes each unique CNAME into Cloudflare.
 */
async function onUpsert(
  event: CloudFormationCustomResourceCreateEvent | CloudFormationCustomResourceUpdateEvent,
): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  const properties = event.ResourceProperties as Record<string, unknown>;
  const certificateArn = String(properties.certificateArn);
  const zoneId = String(properties.zoneId);
  const token = await getApiToken(String(properties.apiTokenSecretArn));
  const delaySeconds = Number(properties.pollDelaySeconds ?? 5);
  const timeoutSeconds = Number(properties.pollTimeoutSeconds ?? 120);

  log('validation', { certificateArn, zoneId });

  const records = await pollValidationRecords(certificateArn, delaySeconds, timeoutSeconds);
  for (const record of records) {
    await upsertCname(zoneId, record.name, record.value, token);
  }

  log('validation', { message: `wrote ${records.length} validation record(s)`, names: records.map((r) => r.name) });
  return {
    PhysicalResourceId: certificateArn,
    Data: { ValidationRecords: records.map((r) => r.name) },
  };
}

/**
 * Handles `Delete`. The validation CNAMEs are left in Cloudflare — they are
 * harmless after issuance and cleaning them up would add fragile delete logic.
 */
async function onDelete(event: CloudFormationCustomResourceDeleteEvent): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  log('validation', { message: 'delete; leaving validation records in Cloudflare' });
  return { PhysicalResourceId: event.PhysicalResourceId, Data: {} };
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
