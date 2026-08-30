import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template } from 'aws-cdk-lib/assertions';
import { CloudflareARecord } from '../src/record';
import { CloudflareZone } from '../src/zone';
import { CloudflareValidatedCertificate } from '../src/certificate';

const RECORD_ID = 'c0ffee00000000000000000000000000';

describe('CloudflareValidatedCertificate', () => {
  function makeStack(region = 'us-east-1', secretArn?: string) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', { env: { account: '729049750509', region } });
    const secret = secretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(stack, 'CfToken', secretArn)
      : secretsmanager.Secret.fromSecretNameV2(stack, 'CfToken', 'cloudflare/dns-token');
    const zone = CloudflareZone.fromZoneId(stack, 'Zone', { zoneId: RECORD_ID, zoneName: 'example.com', apiToken: secret });
    return { stack, zone };
  }

  test('synthesises only the DNS validation custom resource (no CFN cert resource)', () => {
    const { stack, zone } = makeStack();
    new CloudflareValidatedCertificate(stack, 'Cert', {
      domainName: 'example.com',
      subjectAlternativeNames: ['*.example.com'],
      zone,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('Custom::CloudflareCertificateDnsValidation', 1);
  });

  test('passes the domain, SANs, zone and secret details to the custom resource', () => {
    const { stack, zone } = makeStack();
    new CloudflareValidatedCertificate(stack, 'Cert', { domainName: 'example.com', subjectAlternativeNames: ['*.example.com'], zone });

    const template = Template.fromStack(stack);
    const resources = template.findResources('Custom::CloudflareCertificateDnsValidation');
    const first = Object.values(resources)[0] as { Properties: Record<string, unknown> };
    const props = first.Properties;
    expect(props.domainName).toBe('example.com');
    expect(JSON.stringify(props.subjectAlternativeNames)).toContain('*.example.com');
    expect(props.zoneId).toBe(RECORD_ID);
    expect(String(props.apiTokenSecretId)).toContain('cloudflare/dns-token');
    expect(props.apiTokenRegion).toBeDefined();
  });

  test('grants the ACM permissions and secret read to the handler', () => {
    const { stack, zone } = makeStack();
    new CloudflareValidatedCertificate(stack, 'Cert', { domainName: 'example.com', zone });

    const template = Template.fromStack(stack);
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('acm:RequestCertificate');
    expect(json).toContain('acm:DescribeCertificate');
    expect(json).toContain('acm:DeleteCertificate');
    expect(json).toContain('secretsmanager:GetSecretValue');
  });

  test('a cross-region secret is resolved in its own region (Iam grant and handler region)', () => {
    const euSecretArn = 'arn:aws:secretsmanager:eu-central-1:729049750509:secret:cloudflare/chabis-click-token-p5z7Sr';
    const { stack, zone } = makeStack('us-east-1', euSecretArn);
    new CloudflareValidatedCertificate(stack, 'Cert', { domainName: 'example.com', zone });

    const template = Template.fromStack(stack);

    const resources = template.findResources('Custom::CloudflareCertificateDnsValidation');
    const props = Object.values(resources)[0] as { Properties: Record<string, unknown> };
    expect(props.Properties.apiTokenRegion).toBe('eu-central-1');

    const json = JSON.stringify(template.toJSON());
    // The IAM grant must target the eu-central-1 secret ARN (with the -?????? suffix wildcard).
    expect(json).toContain('eu-central-1');
    expect(json).toContain('cloudflare/chabis-click-token-??????');
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
