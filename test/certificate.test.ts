import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template } from 'aws-cdk-lib/assertions';
import { CloudflareARecord } from '../src/record';
import { CloudflareZone } from '../src/zone';
import { CloudflareValidatedCertificate } from '../src/certificate';

const RECORD_ID = 'c0ffee00000000000000000000000000';

describe('CloudflareValidatedCertificate', () => {
  function makeStack() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');
    const secret = secretsmanager.Secret.fromSecretNameV2(stack, 'CfToken', 'cloudflare/dns-token');
    const zone = CloudflareZone.fromZoneId(stack, 'Zone', { zoneId: RECORD_ID, zoneName: 'example.com', apiToken: secret });
    return { stack, zone };
  }

  test('synthesises the certificate and the DNS validation custom resource', () => {
    const { stack, zone } = makeStack();
    new CloudflareValidatedCertificate(stack, 'Cert', {
      domainName: 'example.com',
      subjectAlternativeNames: ['*.example.com'],
      zone,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    template.resourceCountIs('Custom::CloudflareCertificateDnsValidation', 1);
  });

  test('grants acm:DescribeCertificate and secret read to the handler', () => {
    const { stack, zone } = makeStack();
    new CloudflareValidatedCertificate(stack, 'Cert', { domainName: 'example.com', zone });

    const template = Template.fromStack(stack);
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('acm:DescribeCertificate');
    expect(json).toContain('secretsmanager:GetSecretValue');
    expect(json).toContain('cloudflare/dns-token');
  });

  test('the validation resource waits on the certificate', () => {
    const { stack, zone } = makeStack();
    new CloudflareValidatedCertificate(stack, 'Cert', { domainName: 'example.com', zone });

    const template = Template.fromStack(stack);
    const resources = template.findResources('Custom::CloudflareCertificateDnsValidation');
    const first = Object.values(resources)[0] as { DependsOn?: string[]; Properties: Record<string, unknown> };
    expect(first.DependsOn).toBeDefined();
    expect(first.Properties.certificateArn).toBeDefined();
    expect(first.Properties.zoneId).toBe(RECORD_ID);
  });

  test('the API token literal never appears in the template', () => {
    const { stack, zone } = makeStack();
    new CloudflareValidatedCertificate(stack, 'Cert', { domainName: 'example.com', zone });

    const template = Template.fromStack(stack);
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('cf_token_here');
    expect(json).not.toContain('SecretString');
  });

  test('DNS records and certificates use separate shared providers (one handler each)', () => {
    const { stack, zone } = makeStack();
    new CloudflareValidatedCertificate(stack, 'Cert', { domainName: 'example.com', zone });
    new CloudflareARecord(stack, 'Rec', { zone, content: '1.2.3.4' });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Function', 4);
  });
});
