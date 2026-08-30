import { ACMClient } from '@aws-sdk/client-acm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceDeleteEvent } from 'aws-lambda';
import { handler } from '../src/handler/acm';

interface MockResponseSpec {
  status: number;
  body: unknown;
  retryAfter?: string;
}

let acmResults: Array<Record<string, unknown>>;

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

function acmResponse(...options: Array<{ domain: string; value: string }>) {
  return {
    Certificate: {
      DomainValidationOptions: options.map((o) => ({
        DomainName: o.domain,
        ResourceRecord: { Name: `${o.domain}.`, Type: 'CNAME', Value: `${o.value}.` },
      })),
    },
  };
}

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    RequestType: 'Create',
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:CertificateProvider',
    ResponseURL: 'https://example.invalid/response',
    StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/Test/a',
    RequestId: 'req-1',
    LogicalResourceId: 'CertValidation',
    ResourceType: 'Custom::CloudflareCertificateDnsValidation',
    ResourceProperties: {
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
      zoneId: 'c0ffee00000000000000000000000000',
      apiTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:cloudflare/dns-token-abc',
      pollDelaySeconds: 0,
      pollTimeoutSeconds: 5,
    },
    ...overrides,
  };
}

function okCloudflare(body: unknown) {
  return { status: 200, body: { success: true, errors: [], messages: [], result: body } };
}

describe('acm handler', () => {
  beforeEach(() => {
    acmResults = [];
    jest.spyOn(ACMClient.prototype as unknown as { send: () => Promise<Record<string, unknown> | undefined> }, 'send')
      .mockImplementation(async () => acmResults.shift());
    jest.spyOn(SecretsManagerClient.prototype as unknown as { send: () => Promise<Record<string, unknown>> }, 'send')
      .mockResolvedValue({ SecretString: 'test-api-token' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('create writes each validation CNAME into Cloudflare', async () => {
    acmResults.push(acmResponse(
      { domain: '_acme-challenge.example.com', value: '_aaaa.acm-validations.aws' },
      { domain: '_acme-challenge.example.com', value: '_aaaa.acm-validations.aws' },
      { domain: '_acme-challenge.www.example.com', value: '_bbbb.acm-validations.aws' },
    ));
    const fetchMock = mockFetch(
      okCloudflare({ id: 'a'.repeat(32), name: '_acme-challenge.example.com' }),
      okCloudflare({ id: 'b'.repeat(32), name: '_acme-challenge.www.example.com' }),
    );

    const result = await handler(baseEvent() as never);

    expect(result.PhysicalResourceId).toBe('arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000');
    // The wildcard and apex share one record; only two CNAMEs are written.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.Data).toEqual({
      ValidationRecords: ['_acme-challenge.example.com', '_acme-challenge.www.example.com'],
    });
  });

  test('polls until the validation records appear', async () => {
    acmResults.push(acmResponse());
    acmResults.push(acmResponse({ domain: '_acme-challenge.example.com', value: '_aaaa.acm-validations.aws' }));
    const fetchMock = mockFetch(okCloudflare({ id: 'a'.repeat(32), name: '_acme-challenge.example.com' }));

    const result = await handler(baseEvent() as never);

    expect(result.PhysicalResourceId).toBe('arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('adopts an existing validation CNAME', async () => {
    acmResults.push(acmResponse({ domain: '_acme-challenge.example.com', value: '_aaaa.acm-validations.aws' }));
    const fetchMock = mockFetch(
      { status: 400, body: { success: false, errors: [{ code: 81057, message: 'already exists' }], messages: [], result: null } },
      { status: 200, body: { success: true, errors: [], messages: [], result: [{ id: 'f'.repeat(32), name: '_acme-challenge.example.com' }] } },
      okCloudflare({ id: 'f'.repeat(32), name: '_acme-challenge.example.com' }),
    );

    const result = await handler(baseEvent() as never);

    expect(result.PhysicalResourceId).toBe('arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('delete is a no-op that leaves the validation records', async () => {
    const fetchMock = mockFetch();
    const event = { ...baseEvent({ RequestType: 'Delete' }), PhysicalResourceId: 'arn:aws:acm:us-east-1:123456789012:certificate/x' } as CloudFormationCustomResourceDeleteEvent;

    const result = await handler(event);

    expect(result.PhysicalResourceId).toBe('arn:aws:acm:us-east-1:123456789012:certificate/x');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
