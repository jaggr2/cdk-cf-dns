import type { CloudFormationCustomResourceCreateEvent, CloudFormationCustomResourceDeleteEvent, CloudFormationCustomResourceEvent, CloudFormationCustomResourceUpdateEvent } from 'aws-lambda';
import {
  assertSuccess,
  buildRecordPayload,
  createRecord,
  findRecord,
  getApiToken,
  isAlreadyExists,
  isRecordDoesNotExist,
  isTrue,
  log,
  RECORD_ID_PATTERN,
  request,
} from './cloudflare';

/**
 * Handles the `Create` request type.
 */
async function onCreate(event: CloudFormationCustomResourceCreateEvent): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  const properties = event.ResourceProperties as Record<string, unknown>;
  const zoneId = String(properties.zoneId);
  const payload = buildRecordPayload(properties);
  const token = await getApiToken(String(properties.apiTokenSecretArn));

  log('create', { zoneId, name: payload.name, type: payload.type });

  const response = await request(`/zones/${zoneId}/dns_records`, { method: 'POST', token, body: payload });

  if (isAlreadyExists(response)) {
    if (!isTrue(properties.adoptExisting)) {
      throw new Error(
        `DNS record ${String(payload.name)} (${String(payload.type)}) already exists in zone ${zoneId}. ` +
          'Either delete it in the Cloudflare dashboard, or set adoptExisting: true to adopt and manage it.',
      );
    }

    log('adopt', { zoneId, name: payload.name, type: payload.type });
    const existing = await findRecord(zoneId, String(payload.name), String(payload.type), token);
    if (!existing) {
      throw new Error(`Cloudflare reported ${String(payload.name)} already exists but the lookup found no matching record`);
    }

    await request(`/zones/${zoneId}/dns_records/${existing.id}`, { method: 'PATCH', token, body: payload });
    return { PhysicalResourceId: existing.id, Data: { RecordId: existing.id, DomainName: existing.name } };
  }

  assertSuccess(response);
  const result = response.body.result as { id: string; name: string };
  return { PhysicalResourceId: result.id, Data: { RecordId: result.id, DomainName: result.name } };
}

/**
 * Handles the `Update` request type.
 */
async function onUpdate(event: CloudFormationCustomResourceUpdateEvent): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  const properties = event.ResourceProperties as Record<string, unknown>;
  const oldProperties = event.OldResourceProperties as Record<string, unknown>;
  const zoneId = String(properties.zoneId);
  const payload = buildRecordPayload(properties);
  const token = await getApiToken(String(properties.apiTokenSecretArn));

  log('update', { zoneId, name: payload.name, type: payload.type });

  // If the zone changed, the record must be created in the new zone. Returning a
  // new physical id tells CloudFormation to send a Delete for the old one.
  if (String(oldProperties.zoneId) !== zoneId) {
    log('update', { message: 'zone changed; creating in new zone', zoneId });
    const created = await createRecord(zoneId, payload, token);
    return { PhysicalResourceId: created.id, Data: { RecordId: created.id, DomainName: created.name } };
  }

  const physicalId = event.PhysicalResourceId;
  const response = await request(`/zones/${zoneId}/dns_records/${physicalId}`, { method: 'PATCH', token, body: payload });

  // The record was deleted out-of-band (e.g. in the dashboard); recreate it.
  if (response.status === 404 || (response.body.success === false && isRecordDoesNotExist(response))) {
    log('update', { message: 'record not found; recreating', zoneId, name: payload.name });
    const created = await createRecord(zoneId, payload, token);
    return { PhysicalResourceId: created.id, Data: { RecordId: created.id, DomainName: created.name } };
  }

  assertSuccess(response);
  const result = response.body.result as { id: string; name: string };
  return { PhysicalResourceId: physicalId, Data: { RecordId: result.id, DomainName: result.name } };
}

/**
 * Handles the `Delete` request type. Deleting is idempotent: a missing record
 * is treated as success so stacks never become undeletable.
 */
async function onDelete(event: CloudFormationCustomResourceDeleteEvent): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  const properties = event.ResourceProperties as Record<string, unknown>;
  const zoneId = String(properties.zoneId);
  const physicalId = event.PhysicalResourceId;

  if (isTrue(properties.retainOnDelete)) {
    log('delete', { message: 'retainOnDelete set; leaving record in Cloudflare', zoneId });
    return { PhysicalResourceId: physicalId, Data: {} };
  }

  // A failed Create can leave CloudFormation's arn:... placeholder as the
  // physical id; never throw in that case.
  if (!RECORD_ID_PATTERN.test(physicalId)) {
    log('delete', { message: 'physical id is not a Cloudflare record id; skipping delete', physicalId });
    return { PhysicalResourceId: physicalId, Data: {} };
  }

  const token = await getApiToken(String(properties.apiTokenSecretArn));
  log('delete', { zoneId, physicalId });

  const response = await request(`/zones/${zoneId}/dns_records/${physicalId}`, { method: 'DELETE', token });

  if (response.status === 404 || (response.body.success === false && isRecordDoesNotExist(response))) {
    log('delete', { message: 'record already gone; treating delete as success', physicalId });
    return { PhysicalResourceId: physicalId, Data: {} };
  }

  assertSuccess(response);
  return { PhysicalResourceId: physicalId, Data: {} };
}

/**
 * The Lambda handler for the `Custom::CloudflareDnsRecord` custom resource.
 *
 * @param event The CloudFormation custom resource event.
 * @returns The custom resource result with `PhysicalResourceId` and `Data`.
 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string; Data: Record<string, unknown> }> {
  try {
    log('event', { requestType: event.RequestType });

    switch (event.RequestType) {
      case 'Create':
        return await onCreate(event);
      case 'Update':
        return await onUpdate(event);
      case 'Delete':
        return await onDelete(event);
      default:
        throw new Error(`Unsupported RequestType: ${(event as { RequestType?: string }).RequestType}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cloudflare DNS custom resource failed during ${event.RequestType}: ${message}`);
  }
}
