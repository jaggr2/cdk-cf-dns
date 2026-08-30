# API Reference

The public API surface of `@jaggr2/cdk-cf-dns`.

## Table of contents
* **Enums**
  * [CloudflareRecordType](#enumscloudflarerecordtype)
* **Interfaces**
  * [CloudflareAaaaRecordProps](#interfacescloudflareaaaarecordprops)
  * [CloudflareARecordProps](#interfacescloudflarearecordprops)
  * [CloudflareCaaRecordProps](#interfacescloudflarecaarecordprops)
  * [CloudflareCnameRecordProps](#interfacescloudflarecnamerecordprops)
  * [CloudflareMxRecordProps](#interfacescloudflaremxrecordprops)
  * [CloudflareRecordProps](#interfacescloudflarerecordprops)
  * [CloudflareTxtRecordProps](#interfacescloudflaretxtrecordprops)
  * [CloudflareValidatedCertificateProps](#interfacescloudflarevalidatedcertificateprops)
  * [CloudflareZoneAttributes](#interfacescloudflarezoneattributes)
  * [ICloudflareZone](#interfacesicloudflarezone)
* **Classes**
  * [CloudflareAaaaRecord](#classescloudflareaaaarecord)
  * [CloudflareARecord](#classescloudflarearecord)
  * [CloudflareCaaRecord](#classescloudflarecaarecord)
  * [CloudflareCertificateProvider](#classescloudflarecertificateprovider)
  * [CloudflareCnameRecord](#classescloudflarecnamerecord)
  * [CloudflareDnsProvider](#classescloudflarednsprovider)
  * [CloudflareMxRecord](#classescloudflaremxrecord)
  * [CloudflareRecord](#classescloudflarerecord)
  * [CloudflareTtl](#classescloudflarettl)
  * [CloudflareTxtRecord](#classescloudflaretxtrecord)
  * [CloudflareValidatedCertificate](#classescloudflarevalidatedcertificate)
  * [CloudflareZone](#classescloudflarezone)

---

## Enums

### CloudflareRecordType

The DNS record types supported by this library.

| Name | Description |
|------|-------------|
| `A` | An IPv4 address record. |
| `AAAA` | An IPv6 address record. |
| `CNAME` | A canonical name record. |
| `TXT` | A text record. |
| `MX` | A mail exchanger record. |
| `NS` | A name server record. |
| `SRV` | A service locator record. |
| `CAA` | A certification authority authorization record. |
| `PTR` | A pointer record. |
| `URI` | A uniform resource identifier record. |

---

## Interfaces

### CloudflareAaaaRecordProps

Properties for an AAAA record.

Extends: `Omit<CloudflareRecordProps, "type" | "data" | "priority">`

| Name | Type | Description |
|------|------|-------------|
| `content` | `string` | The IPv6 address. |
| `proxied?` | `boolean` | Whether to proxy the record through Cloudflare. |

### CloudflareARecordProps

Properties for an A record.

Extends: `Omit<CloudflareRecordProps, "type" | "data" | "priority">`

| Name | Type | Description |
|------|------|-------------|
| `content` | `string` | The IPv4 address. |
| `proxied?` | `boolean` | Whether to proxy the record through Cloudflare. |

### CloudflareCaaRecordProps

Properties for a CAA record.

Extends: `Omit<CloudflareRecordProps, "type" | "data" | "priority" | "proxied">`

| Name | Type | Description |
|------|------|-------------|
| `content` | `string` | The CAA value. |

### CloudflareCnameRecordProps

Properties for a CNAME record.

Extends: `Omit<CloudflareRecordProps, "type" | "data" | "priority">`

| Name | Type | Description |
|------|------|-------------|
| `content` | `string` | The canonical name. |
| `proxied?` | `boolean` | Whether to proxy the record through Cloudflare. |

### CloudflareMxRecordProps

Properties for an MX record.

Extends: `Omit<CloudflareRecordProps, "type" | "data" | "proxied">`

| Name | Type | Description |
|------|------|-------------|
| `content` | `string` | The mail exchanger host. |
| `priority` | `number` | The MX priority. |

### CloudflareRecordProps

Properties for a Cloudflare DNS record.

| Name | Type | Description |
|------|------|-------------|
| `zone` | `ICloudflareZone` | The Cloudflare zone the record belongs to. |
| `recordName?` | `string` | Record name. If it does not end in the zone name and `zone.zoneName` is set, it is treated as relative and the zone name is appended. Use `'@'` or omit for the zone apex. |
| `type` | `CloudflareRecordType` | The record type. |
| `content?` | `string` | Record value. Mutually exclusive with `data`. |
| `data?` | `Record<string, unknown>` | Structured value for SRV/CAA/URI records. Mutually exclusive with `content`. |
| `ttl?` | `cdk.Duration` | The time-to-live for the record. |
| `proxied?` | `boolean` | Whether to proxy the record through Cloudflare. Only valid for A, AAAA and CNAME. |
| `priority?` | `number` | Record priority. Required for MX, SRV and URI. |
| `comment?` | `string` | A free-form comment attached to the record. |
| `tags?` | `string[]` | Tags attached to the record. |
| `adoptExisting?` | `boolean` | If a record with the same name+type already exists in Cloudflare, adopt and manage it instead of failing the deployment. |
| `removalPolicy?` | `cdk.RemovalPolicy` | If RETAIN, the record is left in Cloudflare when the stack resource is deleted. |

### CloudflareTxtRecordProps

Properties for a TXT record.

Extends: `Omit<CloudflareRecordProps, "type" | "data" | "priority" | "proxied">`

| Name | Type | Description |
|------|------|-------------|
| `content` | `string` | The text value. Values longer than 255 characters are automatically chunked. |

### CloudflareValidatedCertificateProps

Properties for a Cloudflare-validated ACM certificate.

| Name | Type | Description |
|------|------|-------------|
| `domainName` | `string` | The primary domain name the certificate covers. |
| `subjectAlternativeNames?` | `string[]` | Additional domain names the certificate should cover. |
| `zone` | `ICloudflareZone` | The Cloudflare zone where the DNS validation CNAMEs are written. |

### CloudflareZoneAttributes

Properties for referencing an existing Cloudflare zone.

| Name | Type | Description |
|------|------|-------------|
| `zoneId` | `string` | The Cloudflare Zone ID, e.g. `"abc123..."`. This may be a plain string or a CDK token (for example resolved from SSM at deploy time). |
| `apiToken` | `cdk.aws_secretsmanager.ISecret` | The Secrets Manager secret holding the Cloudflare API token. The secret may contain the token as a raw string or as a JSON blob with an `apiToken` key. Only the secret ARN ever appears in the CloudFormation template. |
| `zoneName?` | `string` | The apex domain, e.g. `"example.com"`. Enables relative record names. |

### ICloudflareZone

A reference to a Cloudflare zone that already exists in the Cloudflare account.

`CloudflareZone.fromZoneId()` is the only supported way to obtain one; this
library deliberately does not create zones. Zones are assumed to be managed in
the Cloudflare dashboard (or elsewhere) and referenced here by their Zone ID.

| Name | Type | Description |
|------|------|-------------|
| `zoneId` | `string` | The Cloudflare Zone ID, e.g. `"abc123..."`. This may be a plain string or a CDK token (for example resolved from SSM at deploy time). |
| `zoneName?` | `string` | The apex domain, e.g. `"example.com"`. When set, `recordName` values that do not already end in the zone name are treated as relative and this suffix is appended, matching `aws-cdk-lib/aws-route53` ergonomics. |
| `apiToken` | `cdk.aws_secretsmanager.ISecret` | The Secrets Manager secret holding the Cloudflare API token. The secret may contain the token as a raw string or as a JSON blob with an `apiToken` key. Only the secret ARN ever appears in the CloudFormation template. |

---

## Classes

### CloudflareAaaaRecord

An AAAA record.

Extends: `CloudflareRecord`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareAaaaRecord(scope: Construct, id: string, props: CloudflareAaaaRecordProps)` |  |

### CloudflareARecord

An A record.

Extends: `CloudflareRecord`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareARecord(scope: Construct, id: string, props: CloudflareARecordProps)` |  |

### CloudflareCaaRecord

A CAA record.

Extends: `CloudflareRecord`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareCaaRecord(scope: Construct, id: string, props: CloudflareCaaRecordProps)` |  |

### CloudflareCertificateProvider

The shared custom-resource provider that writes ACM DNS validation records
into Cloudflare.

Like `CloudflareDnsProvider`, one instance exists per stack. It additionally
grants its handler `acm:DescribeCertificate` on all certificates.

Extends: `Construct`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareCertificateProvider(scope: Construct, id: string)` |  *(private)* |

#### Properties

| Name | Description |
|------|-------------|
| `serviceToken: string (readonly)` | The custom-resource service token that the certificate construct uses as its `serviceToken`. |

#### Methods

| Name | Description |
|------|-------------|
| `static getOrCreate(scope: Construct): CloudflareCertificateProvider` | Gets (or lazily creates) the provider for the stack of `scope`. |
| `grantSecretRead(secret: ISecret): void` | Grants the provider's handler `secretsmanager:GetSecretValue` on the given secret. Repeated grants of the same secret are deduplicated. |

### CloudflareCnameRecord

A CNAME record.

Extends: `CloudflareRecord`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareCnameRecord(scope: Construct, id: string, props: CloudflareCnameRecordProps)` |  |

### CloudflareDnsProvider

The shared custom-resource provider that performs the Cloudflare DNS API
calls.

One instance exists per stack (a singleton keyed by `Stack`), so a stack with
many records still has exactly one Lambda handler. All records route their
custom-resource events through this handler.

Extends: `Construct`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareDnsProvider(scope: Construct, id: string)` |  *(private)* |

#### Properties

| Name | Description |
|------|-------------|
| `serviceToken: string (readonly)` | The custom-resource service token that records use as their `serviceToken`. |

#### Methods

| Name | Description |
|------|-------------|
| `static getOrCreate(scope: Construct): CloudflareDnsProvider` | Gets (or lazily creates) the provider for the stack of `scope`. |
| `grantSecretRead(secret: ISecret): void` | Grants the provider's handler `secretsmanager:GetSecretValue` on the given secret. Repeated grants of the same secret are deduplicated. |

### CloudflareMxRecord

An MX record.

Extends: `CloudflareRecord`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareMxRecord(scope: Construct, id: string, props: CloudflareMxRecordProps)` |  |

### CloudflareRecord

A Cloudflare DNS record managed as a CloudFormation resource.

The construct synthesises a `Custom::CloudflareDnsRecord` custom resource whose
Lambda handler calls the Cloudflare API. The API token is resolved at runtime
from Secrets Manager; only the secret ARN ever appears in the template.

Extends: `Construct`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareRecord(scope: Construct, id: string, props: CloudflareRecordProps)` |  |

#### Properties

| Name | Description |
|------|-------------|
| `recordId: string (readonly)` | Cloudflare's record ID, from `GetAtt`. This is the value you can use to locate the record in the Cloudflare dashboard. |
| `domainName: string (readonly)` | The fully-qualified name actually written to Cloudflare (e.g. `app.example.com`). |

### CloudflareTtl

TTL helpers for Cloudflare records.


#### Properties

| Name | Description |
|------|-------------|
| `static AUTO: cdk.Duration (readonly)` | Cloudflare's automatic TTL (a value of `1` on the wire). |

### CloudflareTxtRecord

A TXT record.

Extends: `CloudflareRecord`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareTxtRecord(scope: Construct, id: string, props: CloudflareTxtRecordProps)` |  |

### CloudflareValidatedCertificate

An ACM certificate whose DNS validation records are written into Cloudflare
automatically, removing the manual copy-paste step.

CloudFormation does not expose the validation `ResourceRecord` as a
certificate attribute, so a custom resource calls `acm:DescribeCertificate`,
polls until the records are populated (they are absent for a few seconds
after creation), and writes each unique CNAME into Cloudflare.

Note: if the certificate is attached to CloudFront it must live in
`us-east-1`; this construct does not solve cross-region certificates.

Extends: `Construct`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareValidatedCertificate(scope: Construct, id: string, props: CloudflareValidatedCertificateProps)` |  |

#### Properties

| Name | Description |
|------|-------------|
| `certificate: acm.Certificate (readonly)` | The underlying ACM certificate. |

### CloudflareZone

A reference to an existing Cloudflare zone.

Zones are not created by this library; they must already exist in the
Cloudflare account. Use `CloudflareZone.fromZoneId()` to reference one.

Extends: `Construct`


#### Constructor

| Name | Description |
|------|-------------|
| `new CloudflareZone(scope: Construct, id: string, attrs: CloudflareZoneAttributes)` |  *(private)* |

#### Properties

| Name | Description |
|------|-------------|
| `zoneId: string (readonly)` |  |
| `zoneName?: string (readonly)` |  |
| `apiToken: cdk.aws_secretsmanager.ISecret (readonly)` |  |

#### Methods

| Name | Description |
|------|-------------|
| `static fromZoneId(scope: Construct, id: string, attrs: CloudflareZoneAttributes): ICloudflareZone` | Reference an existing Cloudflare zone by its Zone ID. |

*This document is generated by `npm run docs`; do not edit by hand.*
