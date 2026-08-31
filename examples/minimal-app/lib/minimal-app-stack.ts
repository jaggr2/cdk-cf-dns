import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  CloudflareARecord,
  CloudflareCnameRecord,
  CloudflareTxtRecord,
  CloudflareValidatedCertificate,
  CloudflareZone,
} from '@jaggr2/cdk-cf-dns';

/**
 * A tiny CDK app proving the library composes: it references an existing
 * Cloudflare zone and manages three records through the shared provider.
 *
 * The zone ID, token secret and record values here are placeholders; replace
 * them before deploying.
 */
export class MinimalAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const zone = CloudflareZone.fromZoneId(this, 'Zone', {
      zoneId: 'c0ffee00000000000000000000000000',
      zoneName: 'example.com',
      apiToken: secretsmanager.Secret.fromSecretNameV2(this, 'CfToken', 'cloudflare/dns-token'),
    });

    new CloudflareARecord(this, 'ApexA', {
      zone,
      content: '1.2.3.4',
    });

    new CloudflareCnameRecord(this, 'AppCname', {
      zone,
      recordName: 'app',
      content: 'd1234.cloudfront.net',
      proxied: true,
    });

    new CloudflareTxtRecord(this, 'DomainVerify', {
      zone,
      recordName: '_amazonses',
      content: 'amazonses-verification-value',
    });

    new CloudflareValidatedCertificate(this, 'Cert', {
      domainName: 'example.com',
      subjectAlternativeNames: ['*.example.com'],
      zone,
    });
  }
}
