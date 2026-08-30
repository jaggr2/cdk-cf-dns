import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CloudflareCertificateProvider } from './provider';
import { ICloudflareZone } from './zone';

/**
 * Properties for a Cloudflare-validated ACM certificate.
 */
export interface CloudflareValidatedCertificateProps {
  /**
   * The primary domain name the certificate covers.
   */
  readonly domainName: string;

  /**
   * Additional domain names the certificate should cover.
   *
   * @default - no additional names
   */
  readonly subjectAlternativeNames?: string[];

  /**
   * The Cloudflare zone where the DNS validation CNAMEs are written.
   */
  readonly zone: ICloudflareZone;
}

/**
 * An ACM certificate whose DNS validation records are written into Cloudflare
 * automatically, removing the manual copy-paste step.
 *
 * A CloudFormation `AWS::CertificateManager::Certificate` resource cannot be
 * used here: with DNS validation and no Route 53 hosted zone, CloudFormation
 * waits for the validation CNAMEs to exist, but the custom resource that writes
 * them depends on the certificate — a deadlock. Instead, the custom resource
 * creates the certificate itself (`acm:RequestCertificate`), polls until the
 * validation `ResourceRecord`s appear, writes each unique CNAME into
 * Cloudflare, and polls until the certificate is ISSUED before returning the
 * certificate ARN. The construct exposes the result through
 * `acm.Certificate.fromCertificateArn`.
 *
 * Note: if the certificate is attached to CloudFront it must live in
 * `us-east-1`; this construct does not solve cross-region certificates.
 */
export class CloudflareValidatedCertificate extends Construct {
  /**
   * The ACM certificate created by the custom resource.
   */
  public readonly certificate: acm.ICertificate;

  public constructor(scope: Construct, id: string, props: CloudflareValidatedCertificateProps) {
    super(scope, id);

    const provider = CloudflareCertificateProvider.getOrCreate(this);
    provider.grantSecretRead(props.zone.apiToken, props.zone.apiTokenRegion);

    const validation = new cdk.CustomResource(this, 'DnsValidation', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CloudflareCertificateDnsValidation',
      properties: {
        domainName: props.domainName,
        subjectAlternativeNames: props.subjectAlternativeNames ?? [],
        zoneId: props.zone.zoneId,
        apiTokenSecretId: props.zone.apiToken.secretName,
        apiTokenRegion: props.zone.apiTokenRegion,
      },
    });

    this.certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', validation.getAttString('CertificateArn'));
  }
}
