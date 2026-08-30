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
 * CloudFormation does not expose the validation `ResourceRecord` as a
 * certificate attribute, so a custom resource calls `acm:DescribeCertificate`,
 * polls until the records are populated (they are absent for a few seconds
 * after creation), and writes each unique CNAME into Cloudflare.
 *
 * Note: if the certificate is attached to CloudFront it must live in
 * `us-east-1`; this construct does not solve cross-region certificates.
 */
export class CloudflareValidatedCertificate extends Construct {
  /**
   * The underlying ACM certificate.
   */
  public readonly certificate: acm.Certificate;

  public constructor(scope: Construct, id: string, props: CloudflareValidatedCertificateProps) {
    super(scope, id);

    // Create the certificate with DNS validation but no hosted zone: the
    // validation records are written to Cloudflare by the custom resource.
    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      subjectAlternativeNames: props.subjectAlternativeNames,
      validation: acm.CertificateValidation.fromDns(),
    });

    const provider = CloudflareCertificateProvider.getOrCreate(this);
    provider.grantSecretRead(props.zone.apiToken);

    const validation = new cdk.CustomResource(this, 'DnsValidation', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CloudflareCertificateDnsValidation',
      properties: {
        certificateArn: this.certificate.certificateArn,
        zoneId: props.zone.zoneId,
        apiTokenSecretArn: props.zone.apiToken.secretArn,
      },
    });

    // The validation resource can only read records once the certificate exists.
    validation.node.addDependency(this.certificate);
  }
}
