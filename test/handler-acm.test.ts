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

const CERT_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000';

function reqResult(arn = CERT_ARN) {
  return { CertificateArn: arn };
}

function descWithRecords(...options: Array<{ domain: string; value: string }>) {
  return {
    Certificate: {
      DomainValidationOptions: options.map((o) => ({
        DomainName: o.domain,
        ResourceRecord: { Name: `${o.domain}.`, Type: 'CNAME', Value: `${o.value}.` },
      })),
    },
  };
}

function descStatus(status: string) {
  return { Certificate: { Status: status } };
}

function okCloudflare(body: unknown) {
  return { status: 200, body: { success: true, errors: [], messages: [], result: body } };
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
      domainName: 'example.com',
      subjectAlternativeNames: ['*.example.com', 'www.example.com'],
      zoneId: 'c0ffee00000000000000000000000000',
      apiTokenSecretId: 'cloudflare/dns-token',
      apiTokenRegion: 'eu-central-1',
      pollDelaySeconds: 0,
      recordPollTimeoutSeconds: 5,
      issuedPollTimeoutSeconds: 5,
    },
    ...overrides,
  };
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

  test('create requests the cert, writes each unique CNAME and waits for ISSUED', async () => {
    acmResults.push(
      reqResult(),
      descWithRecords(
        { domain: '_acme-challenge.example.com', value: '_aaaa.acm-validations.aws' },
        { domain: '_acme-challenge.example.com', value: '_aaaa.acm-validations.aws' },
        { domain: '_acme-challenge.www.example.com', value: '_bbbb.acm-validations.aws' },
      ),
      descStatus('ISSUED'),
    );
    const fetchMock = mockFetch(
      okCloudflare({ id: 'a'.repeat(32), name: '_acme-challenge.example.com' }),
      okCloudflare({ id: 'b'.repeat(32), name: '_acme-challenge.www.example.com' }),
    );

    const result = await handler(baseEvent() as never);

    expect(result.PhysicalResourceId).toBe(CERT_ARN);
    expect(result.Data.CertificateArn).toBe(CERT_ARN);
    // The wildcard and apex share one record; only two CNAMEs are written.
    expect(result.Data.ValidationRecords).toEqual(['_acme-challenge.example.com', '_acme-challenge.www.example.com']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('adopts an existing validation CNAME', async () => {
    acmResults.push(reqResult(), descWithRecords({ domain: '_acme-challenge.example.com', value: '_aaaa.acm-validations.aws' }), descStatus('ISSUED'));
    const fetchMock = mockFetch(
      { status: 400, body: { success: false, errors: [{ code: 81057, message: 'already exists' }], messages: [], result: null } },
      { status: 200, body: { success: true, errors: [], messages: [], result: [{ id: 'f'.repeat(32), name: '_acme-challenge.example.com' }] } },
      okCloudflare({ id: 'f'.repeat(32), name: '_acme-challenge.example.com' }),
    );

    const result = await handler(baseEvent() as never);

    expect(result.PhysicalResourceId).toBe(CERT_ARN);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('returns the ARN even when the certificate is not yet ISSUED at the deadline', async () => {
    acmResults.push(reqResult(), descWithRecords({ domain: '_acme-challenge.example.com', value: '_aaaa.acm-validations.aws' }));
    const fetchMock = mockFetch(okCloudflare({ id: 'a'.repeat(32), name: '_acme-challenge.example.com' }));

    const event = baseEvent({ ResourceProperties: { ...(baseEvent().ResourceProperties as Record<string, unknown>), issuedPollTimeoutSeconds: 0 } });
    const result = await handler(event as never);

    expect(result.PhysicalResourceId).toBe(CERT_ARN);
    expect(result.Data.CertificateArn).toBe(CERT_ARN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('delete removes the certificate it created', async () => {
    const event = { ...baseEvent({ RequestType: 'Delete' }), PhysicalResourceId: CERT_ARN } as CloudFormationCustomResourceDeleteEvent;

    const result = await handler(event);

    expect(result.PhysicalResourceId).toBe(CERT_ARN);
    const acmSend = (ACMClient.prototype.send as unknown as jest.Mock);
    expect(acmSend).toHaveBeenCalledTimes(1);
    expect(acmSend.mock.calls[0][0].input.CertificateArn).toBe(CERT_ARN);
  });
});
