import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template } from 'aws-cdk-lib/assertions';
import { CloudflareZone, ICloudflareZone } from '../src/zone';
import {
  CloudflareAaaaRecord,
  CloudflareARecord,
  CloudflareCaaRecord,
  CloudflareCnameRecord,
  CloudflareMxRecord,
  CloudflareRecord,
  CloudflareRecordType,
  CloudflareTtl,
  CloudflareTxtRecord,
} from '../src/record';

const RECORD_ID = 'c0ffee00000000000000000000000000';

interface TestStack {
  stack: cdk.Stack;
  zone: ICloudflareZone;
}

function makeStack(zoneName = 'example.com', secretName = 'cloudflare/dns-token'): TestStack {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  const secret = secretsmanager.Secret.fromSecretNameV2(stack, 'CfToken', secretName);
  const zone = CloudflareZone.fromZoneId(stack, 'Zone', {
    zoneId: RECORD_ID,
    zoneName,
    apiToken: secret,
  });
  return { stack, zone };
}

function recordProperties(template: Template): Record<string, unknown> {
  const resources = template.findResources('Custom::CloudflareDnsRecord');
  const first = Object.values(resources)[0] as { Properties: Record<string, unknown> };
  return first.Properties;
}

describe('CloudflareRecord', () => {
  test('one record synthesises one custom resource and exactly one handler function', () => {
    const { stack, zone } = makeStack();
    new CloudflareARecord(stack, 'Rec', { zone, content: '1.2.3.4' });

    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::CloudflareDnsRecord', 1);
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  test('ten records still produce only one handler function (singleton provider)', () => {
    const { stack, zone } = makeStack();
    for (let i = 0; i < 10; i++) {
      new CloudflareARecord(stack, `Rec${i}`, { zone, content: `1.2.3.${i}` });
    }

    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::CloudflareDnsRecord', 10);
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  test('two zones with two secrets both appear in the handler IAM policy', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');
    const secret1 = secretsmanager.Secret.fromSecretNameV2(stack, 'Tok1', 'cloudflare/dns-token');
    const secret2 = secretsmanager.Secret.fromSecretNameV2(stack, 'Tok2', 'cloudflare/second-token');
    const zone1 = CloudflareZone.fromZoneId(stack, 'Zone1', { zoneId: RECORD_ID, apiToken: secret1 });
    const zone2 = CloudflareZone.fromZoneId(stack, 'Zone2', { zoneId: 'feedfacefeedfacefeedfacefeedface', apiToken: secret2 });

    new CloudflareARecord(stack, 'Rec1', { zone: zone1, content: '1.2.3.4' });
    new CloudflareARecord(stack, 'Rec2', { zone: zone2, content: '1.2.3.5' });

    const template = Template.fromStack(stack);
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const handlerPolicy = policies.find((p) => JSON.stringify(p).includes('secretsmanager:GetSecretValue'));
    expect(handlerPolicy).toBeDefined();
    const json = JSON.stringify(handlerPolicy);
    expect(json).toContain('cloudflare/dns-token');
    expect(json).toContain('cloudflare/second-token');
  });

  test('granting the same secret twice does not duplicate policy statements', () => {
    const { stack, zone } = makeStack();
    new CloudflareARecord(stack, 'Rec1', { zone, content: '1.2.3.4' });
    new CloudflareARecord(stack, 'Rec2', { zone, content: '1.2.3.5' });

    const template = Template.fromStack(stack);
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: unknown[] } } }).Properties.PolicyDocument.Statement);
    const matching = statements.filter((s) => JSON.stringify(s).includes('cloudflare/dns-token'));
    expect(matching).toHaveLength(1);
  });

  test('the API token literal never appears in the synthesized template', () => {
    const { stack, zone } = makeStack();
    new CloudflareARecord(stack, 'Rec', { zone, content: '1.2.3.4' });

    const template = Template.fromStack(stack);
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('cf_token_here');
    expect(json).not.toContain('SecretString');
  });

  test('record resource carries the zone id, secret ARN and control flags', () => {
    const { stack, zone } = makeStack();
    new CloudflareARecord(stack, 'Rec', { zone, content: '1.2.3.4' });

    const template = Template.fromStack(stack);
    const props = recordProperties(template);
    expect(props.zoneId).toBe(RECORD_ID);
    expect(JSON.stringify(props.apiTokenSecretArn)).toContain('cloudflare/dns-token');
    expect(props.adoptExisting).toBe(false);
    expect(props.retainOnDelete).toBe(false);
  });

  test('removalPolicy RETAIN sets retainOnDelete', () => {
    const { stack, zone } = makeStack();
    new CloudflareARecord(stack, 'Rec', { zone, content: '1.2.3.4', removalPolicy: cdk.RemovalPolicy.RETAIN });

    const template = Template.fromStack(stack);
    const props = recordProperties(template);
    expect(props.retainOnDelete).toBe(true);
  });
});

describe('record name resolution', () => {
  const cases: Array<[string | undefined, string]> = [
    ['app', 'app.example.com'],
    ['@', 'example.com'],
    [undefined, 'example.com'],
    ['example.com', 'example.com'],
    ['sub.example.com', 'sub.example.com'],
    ['app', 'app.example.com'],
  ];

  for (const [recordName, expected] of cases) {
    test(`resolves recordName=${JSON.stringify(recordName)} to ${expected}`, () => {
      const { stack, zone } = makeStack();
      new CloudflareARecord(stack, 'Rec', { zone, recordName, content: '1.2.3.4' });

      const template = Template.fromStack(stack);
      const props = recordProperties(template);
      expect((props.record as Record<string, unknown>).name).toBe(expected);
    });
  }

  test('uses recordName verbatim when the zone has no zoneName', () => {
    const { stack, zone } = makeStack();
    new CloudflareARecord(stack, 'Rec', { zone, recordName: 'app.example.com', content: '1.2.3.4' });

    const template = Template.fromStack(stack);
    const props = recordProperties(template);
    expect((props.record as Record<string, unknown>).name).toBe('app.example.com');
  });
});

describe('validation at synth time', () => {
  test('throws when both content and data are provided', () => {
    const { stack, zone } = makeStack();
    expect(() => new CloudflareRecord(stack, 'Rec', {
      zone,
      type: CloudflareRecordType.CNAME,
      content: 'target.example.com',
      data: { service: '_x', proto: '_tcp', name: 'app', priority: 1, weight: 1, port: 80, target: 'svc' },
    })).toThrow(/exactly one of "content" or "data"/i);
  });

  test('throws when neither content nor data is provided', () => {
    const { stack, zone } = makeStack();
    expect(() => new CloudflareRecord(stack, 'Rec', { zone, type: CloudflareRecordType.CNAME })).toThrow(/exactly one of "content" or "data"/i);
  });

  test('throws when proxied is set on a non-proxyable type', () => {
    const { stack, zone } = makeStack();
    expect(() => new CloudflareRecord(stack, 'Rec', { zone, type: CloudflareRecordType.TXT, content: 'hello', proxied: true })).toThrow(/proxied.*only valid for A, AAAA and CNAME/i);
  });

  test('throws when priority is set on a non-priority type', () => {
    const { stack, zone } = makeStack();
    expect(() => new CloudflareRecord(stack, 'Rec', { zone, type: CloudflareRecordType.A, content: '1.2.3.4', priority: 10 })).toThrow(/priority.*only valid for MX, SRV and URI/i);
  });

  test('throws when priority is missing for MX', () => {
    const { stack, zone } = makeStack();
    expect(() => new CloudflareRecord(stack, 'Rec', { zone, type: CloudflareRecordType.MX, content: 'mx.example.com' })).toThrow(/priority.*required for MX/i);
  });

  test('throws when ttl is out of the valid range', () => {
    const { stack, zone } = makeStack();
    expect(() => new CloudflareARecord(stack, 'Rec', { zone, content: '1.2.3.4', ttl: cdk.Duration.seconds(30) })).toThrow(/ttl must be between 60 and 86400/i);
  });

  test('accepts CloudflareTtl.AUTO', () => {
    const { stack, zone } = makeStack();
    expect(() => new CloudflareARecord(stack, 'Rec', { zone, content: '1.2.3.4', ttl: CloudflareTtl.AUTO })).not.toThrow();
  });

  test('proxied records force ttl to 1 and emit an annotation', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');
    const secret = secretsmanager.Secret.fromSecretNameV2(stack, 'CfToken', 'cloudflare/dns-token');
    const zone = CloudflareZone.fromZoneId(stack, 'Zone', { zoneId: RECORD_ID, zoneName: 'example.com', apiToken: secret });
    const record = new CloudflareARecord(stack, 'Rec', { zone, content: '1.2.3.4', proxied: true, ttl: cdk.Duration.minutes(5) });

    const template = Template.fromStack(stack);
    const props = recordProperties(template);
    expect((props.record as Record<string, unknown>).ttl).toBe(1);
    expect((props.record as Record<string, unknown>).proxied).toBe(true);

    const messages = record.node.metadata
      .filter((m) => m.type === 'aws:cdk:info')
      .map((m) => m.data);
    expect(messages.some((m) => String(m).includes('forcing ttl'))).toBe(true);
  });
});

describe('TXT encoding', () => {
  test('short TXT values are wrapped in double quotes', () => {
    const { stack, zone } = makeStack();
    new CloudflareTxtRecord(stack, 'Rec', { zone, content: 'short' });

    const template = Template.fromStack(stack);
    const props = recordProperties(template);
    expect((props.record as Record<string, unknown>).content).toBe('"short"');
  });

  test('TXT values longer than 255 characters are chunked into quoted segments', () => {
    const { stack, zone } = makeStack();
    const content = 'x'.repeat(300);
    new CloudflareTxtRecord(stack, 'Rec', { zone, content });

    const template = Template.fromStack(stack);
    const props = recordProperties(template);
    const chunked = (props.record as Record<string, unknown>).content as string;
    expect(chunked).toBe(`"${'x'.repeat(255)}" "${'x'.repeat(45)}"`);
  });

  test('internal double quotes are escaped inside the quoted string', () => {
    const { stack, zone } = makeStack();
    new CloudflareTxtRecord(stack, 'Rec', { zone, content: 'say "hi"' });

    const template = Template.fromStack(stack);
    const props = recordProperties(template);
    expect((props.record as Record<string, unknown>).content).toBe('"say \\"hi\\""');
  });

  test('backslashes are preserved', () => {
    const { stack, zone } = makeStack();
    new CloudflareTxtRecord(stack, 'Rec', { zone, content: 'C:\\path\\to' });

    const template = Template.fromStack(stack);
    const props = recordProperties(template);
    expect((props.record as Record<string, unknown>).content).toBe('"C:\\\\path\\\\to"');
  });
});

describe('subclass record types', () => {
  test('subclasses set the expected record type', () => {
    const { stack, zone } = makeStack();
    new CloudflareARecord(stack, 'A', { zone, content: '1.2.3.4' });
    new CloudflareAaaaRecord(stack, 'AAAA', { zone, content: '::1' });
    new CloudflareCnameRecord(stack, 'CNAME', { zone, recordName: 'app', content: 'target.example.com' });
    new CloudflareTxtRecord(stack, 'TXT', { zone, recordName: 'verify', content: 'abc' });
    new CloudflareMxRecord(stack, 'MX', { zone, content: 'mail.example.com', priority: 10 });
    new CloudflareCaaRecord(stack, 'CAA', { zone, content: '0 issue "letsencrypt.org"' });

    const template = Template.fromStack(stack);
    const resources = Object.values(template.findResources('Custom::CloudflareDnsRecord'));
    const types = resources
      .map((r) => ((r as { Properties: { record: { type: string } } }).Properties.record.type))
      .sort();
    expect(types).toEqual(['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'TXT']);
  });
});

describe('snapshot', () => {
  test('matches the snapshot', () => {
    const { stack, zone } = makeStack();
    new CloudflareARecord(stack, 'Rec', { zone, recordName: 'app', content: '1.2.3.4', proxied: true });

    const template = Template.fromStack(stack);
    expect(normalizeTemplate(template.toJSON())).toMatchSnapshot();
  });
});

/**
 * Removes platform-dependent Lambda asset references (their S3 hashes differ
 * between operating systems) so the snapshot is stable across CI environments.
 */
function normalizeTemplate(template: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(template)) as {
    Parameters?: Record<string, unknown>;
    Resources?: Record<string, { Properties?: { Code?: Record<string, unknown> } }>;
  };

  if (clone.Parameters) {
    for (const key of Object.keys(clone.Parameters)) {
      if (key.startsWith('AssetParameters')) {
        delete clone.Parameters[key];
      }
    }
  }

  for (const resource of Object.values(clone.Resources ?? {})) {
    if (resource.Properties?.Code) {
      delete resource.Properties.Code.S3Bucket;
      delete resource.Properties.Code.S3Key;
      delete resource.Properties.Code.S3ObjectVersion;
    }
  }

  return clone;
}
