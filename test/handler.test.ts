import type { GetSecretValueCommandOutput } from '@aws-sdk/client-secrets-manager';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceDeleteEvent, CloudFormationCustomResourceUpdateEvent } from 'aws-lambda';
import { handler } from '../src/handler';
import { redact } from '../src/handler/cloudflare';

interface MockResponseSpec {
  status: number;
  body: unknown;
  retryAfter?: string;
}

function mockFetch(...responses: MockResponseSpec[]): jest.Mock {
  const fetchMock = jest.fn();
  let index = 0;
  fetchMock.mockImplementation(async () => {
    const spec = responses[Math.min(index, responses.length - 1)];
    index++;
    return {
      status: spec.status,
      headers: { get: (name: string) => (name === 'Retry-After' ? spec.retryAfter ?? null : null) },
      text: async () => JSON.stringify(spec.body),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function okResult(id: string, name: string) {
  return { success: true, errors: [], messages: [], result: { id, name, type: 'A' } };
}

function errorResponse(status: number, code: number, message: string) {
  return { status, body: { success: false, errors: [{ code, message }], messages: [], result: null } };
}

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    RequestType: 'Create',
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:Provider',
    ResponseURL: 'https://example.invalid/response',
    StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/Test/a',
    RequestId: 'req-1',
    LogicalResourceId: 'Rec',
    ResourceType: 'Custom::CloudflareDnsRecord',
    ResourceProperties: {
      zoneId: 'c0ffee00000000000000000000000000',
      apiTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:cloudflare/dns-token-abc',
      adoptExisting: false,
      retainOnDelete: false,
      record: { name: 'app.example.com', type: 'A', content: '1.2.3.4', ttl: 300 },
    },
    ...overrides,
  };
}

function updateEvent(overrides: Record<string, unknown> = {}): CloudFormationCustomResourceUpdateEvent {
  const base = baseEvent({ RequestType: 'Update', PhysicalResourceId: 'a'.repeat(32), ...overrides }) as Record<string, unknown>;
  if (base.OldResourceProperties === undefined) {
    base.OldResourceProperties = base.ResourceProperties;
  }
  return base as unknown as CloudFormationCustomResourceUpdateEvent;
}

function deleteEvent(physicalId: string, overrides: Record<string, unknown> = {}): CloudFormationCustomResourceDeleteEvent {
  return baseEvent({ RequestType: 'Delete', PhysicalResourceId: physicalId, ...overrides }) as unknown as CloudFormationCustomResourceDeleteEvent;
}

describe('handler', () => {
  beforeEach(() => {
    const sendMock = jest.spyOn(SecretsManagerClient.prototype as unknown as { send: () => Promise<GetSecretValueCommandOutput> }, 'send');
    sendMock.mockResolvedValue({ SecretString: 'test-api-token' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('create happy path returns the Cloudflare id as the physical id', async () => {
    const fetchMock = mockFetch({ status: 200, body: okResult('a'.repeat(32), 'app.example.com') });

    const result = await handler(baseEvent() as never);

    expect(result.PhysicalResourceId).toBe('a'.repeat(32));
    expect(result.Data).toEqual({ RecordId: 'a'.repeat(32), DomainName: 'app.example.com' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('coerces stringified ttl/priority/proxied values from CloudFormation', async () => {
    const fetchMock = mockFetch({ status: 200, body: okResult('a'.repeat(32), 'app.example.com') });

    const event = baseEvent({
      ResourceProperties: {
        ...(baseEvent().ResourceProperties as Record<string, unknown>),
        record: {
          name: 'app.example.com',
          type: 'A',
          content: '1.2.3.4',
          ttl: '300',
          proxied: 'true',
        },
      },
    });

    await handler(event as never);

    const sent = fetchMock.mock.calls[0][1].body as string;
    expect(JSON.parse(sent)).toEqual({
      name: 'app.example.com',
      type: 'A',
      content: '1.2.3.4',
      ttl: 300,
      proxied: true,
    });
  });

  test('create conflict with adoptExisting=false throws a helpful error', async () => {
    mockFetch(errorResponse(400, 81057, 'DNS record already exists'));

    await expect(handler(baseEvent() as never)).rejects.toThrow(/adoptExisting/);
  });

  test('create conflict with stringified adoptExisting="false" throws a helpful error', async () => {
    mockFetch(errorResponse(400, 81057, 'DNS record already exists'));

    const event = baseEvent({
      ResourceProperties: {
        ...(baseEvent().ResourceProperties as Record<string, unknown>),
        adoptExisting: 'false',
      },
    });

    await expect(handler(event as never)).rejects.toThrow(/adoptExisting/);
  });

  test('create conflict with adoptExisting=true looks up, patches and returns the existing id', async () => {
    const fetchMock = mockFetch(
      errorResponse(400, 81057, 'already exists'),
      { status: 200, body: { success: true, errors: [], messages: [], result: [{ id: 'f'.repeat(32), name: 'app.example.com' }] } },
      { status: 200, body: okResult('f'.repeat(32), 'app.example.com') },
    );

    const result = await handler(baseEvent({
      ResourceProperties: {
        ...(baseEvent().ResourceProperties as Record<string, unknown>),
        adoptExisting: true,
      },
    }) as never);

    expect(result.PhysicalResourceId).toBe('f'.repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('update keeps the same physical id when the zone is unchanged', async () => {
    const fetchMock = mockFetch({ status: 200, body: okResult('a'.repeat(32), 'app.example.com') });

    const result = await handler(updateEvent());

    expect(result.PhysicalResourceId).toBe('a'.repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('update across zones returns a new physical id', async () => {
    const fetchMock = mockFetch({ status: 200, body: okResult('b'.repeat(32), 'app.example.com') });

    const result = await handler(updateEvent({
      ResourceProperties: { ...(baseEvent().ResourceProperties as Record<string, unknown>), zoneId: 'feedfacefeedfacefeedfacefeedface' },
      OldResourceProperties: baseEvent().ResourceProperties,
    }));

    expect(result.PhysicalResourceId).toBe('b'.repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('update that hits a deleted record recreates it', async () => {
    const fetchMock = mockFetch(
      errorResponse(404, 81044, 'record not found'),
      { status: 200, body: okResult('c'.repeat(32), 'app.example.com') },
    );

    const result = await handler(updateEvent());

    expect(result.PhysicalResourceId).toBe('c'.repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('delete on 404 resolves successfully', async () => {
    const fetchMock = mockFetch(errorResponse(404, 81044, 'record not found'));

    const result = await handler(deleteEvent('a'.repeat(32)));

    expect(result.PhysicalResourceId).toBe('a'.repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('delete with a non-record physical id skips the API call', async () => {
    const fetchMock = mockFetch();

    const result = await handler(deleteEvent('arn:aws:cloudformation:us-east-1:123456789012:stack/Test/a'));

    expect(result.PhysicalResourceId).toContain('arn:aws:cloudformation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('delete with retainOnDelete does not call Cloudflare', async () => {
    const fetchMock = mockFetch();

    const result = await handler(deleteEvent('a'.repeat(32), {
      ResourceProperties: { ...(baseEvent().ResourceProperties as Record<string, unknown>), retainOnDelete: true },
    }));

    expect(result.PhysicalResourceId).toBe('a'.repeat(32));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('delete with stringified retainOnDelete="false" still deletes the record', async () => {
    const fetchMock = mockFetch({ status: 200, body: { success: true, errors: [], messages: [], result: { id: 'a'.repeat(32) } } });

    const result = await handler(deleteEvent('a'.repeat(32), {
      ResourceProperties: { ...(baseEvent().ResourceProperties as Record<string, unknown>), retainOnDelete: 'false' },
    }));

    expect(result.PhysicalResourceId).toBe('a'.repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('success=false with errors throws a message containing the code', async () => {
    mockFetch(errorResponse(400, 1004, 'Invalid request'));

    await expect(handler(baseEvent() as never)).rejects.toThrow(/1004/);
  });

  test('a 429 followed by a 200 succeeds and issues exactly two fetch calls', async () => {
    const fetchMock = mockFetch(
      { status: 429, body: { success: false, errors: [{ code: 9109, message: 'rate limited' }], messages: [], result: null }, retryAfter: '0' },
      { status: 200, body: okResult('a'.repeat(32), 'app.example.com') },
    );

    const result = await handler(baseEvent() as never);

    expect(result.PhysicalResourceId).toBe('a'.repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('redact', () => {
  const TOKEN = 'A1b2C3d4E5f6A1b2C3d4E5f6A1b2C3d4E5f6A1b2';

  test('replaces token-shaped strings', () => {
    expect(String(redact(`token=${TOKEN}`))).not.toContain(TOKEN);
    expect(String(redact(`token=${TOKEN}`))).toContain('[REDACTED]');
  });

  test('recurses through objects and arrays', () => {
    const out = redact({ nested: { value: TOKEN }, list: [TOKEN, 'ok'] }) as { nested: { value: string }; list: string[] };
    expect(out.nested.value).toBe('[REDACTED]');
    expect(out.list[0]).toBe('[REDACTED]');
    expect(out.list[1]).toBe('ok');
  });

  test('leaves short strings like zone ids untouched', () => {
    expect(redact('c0ffee00000000000000000000000000')).toBe('c0ffee00000000000000000000000000');
  });

  test('a token-shaped string never reaches the log output', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const out = redact({ token: TOKEN, name: 'app.example.com' });
      console.log(out);
      const calls = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(calls).not.toContain(TOKEN);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('cloudflare error details containing a token-shaped string are scrubbed', async () => {
    mockFetch({ status: 401, body: { success: false, errors: [{ code: 9107, message: `bad token ${TOKEN}` }], messages: [], result: null } });

    const error = await handler(baseEvent() as never).catch((e: unknown) => e as Error);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('9107');
  });
});
