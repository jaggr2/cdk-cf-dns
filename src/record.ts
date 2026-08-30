import * as cdk from 'aws-cdk-lib';
import { Annotations, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ICloudflareZone } from './zone';
import { CloudflareDnsProvider } from './provider';

/**
 * The DNS record types supported by this library.
 */
export enum CloudflareRecordType {
  /** An IPv4 address record. */
  A = 'A',
  /** An IPv6 address record. */
  AAAA = 'AAAA',
  /** A canonical name record. */
  CNAME = 'CNAME',
  /** A text record. */
  TXT = 'TXT',
  /** A mail exchanger record. */
  MX = 'MX',
  /** A name server record. */
  NS = 'NS',
  /** A service locator record. */
  SRV = 'SRV',
  /** A certification authority authorization record. */
  CAA = 'CAA',
  /** A pointer record. */
  PTR = 'PTR',
  /** A uniform resource identifier record. */
  URI = 'URI',
}

/**
 * TTL helpers for Cloudflare records.
 */
export class CloudflareTtl {
  /**
   * Cloudflare's automatic TTL (a value of `1` on the wire).
   */
  public static readonly AUTO: Duration = Duration.seconds(1);
}

/**
 * The set of record types that may be proxied through Cloudflare.
 */
const PROXIED_TYPES = new Set([CloudflareRecordType.A, CloudflareRecordType.AAAA, CloudflareRecordType.CNAME]);

/**
 * The set of record types that require a priority.
 */
const PRIORITY_TYPES = new Set([CloudflareRecordType.MX, CloudflareRecordType.SRV, CloudflareRecordType.URI]);

/**
 * The minimum TTL accepted by Cloudflare.
 */
const MIN_TTL_SECONDS = 60;

/**
 * The maximum TTL accepted by Cloudflare.
 */
const MAX_TTL_SECONDS = 86400;

/**
 * Properties for a Cloudflare DNS record.
 */
export interface CloudflareRecordProps {
  /**
   * The Cloudflare zone the record belongs to.
   */
  readonly zone: ICloudflareZone;

  /**
   * Record name. If it does not end in the zone name and `zone.zoneName` is set,
   * it is treated as relative and the zone name is appended.
   * Use `'@'` or omit for the zone apex.
   *
   * @default - the zone apex
   */
  readonly recordName?: string;

  /**
   * The record type.
   */
  readonly type: CloudflareRecordType;

  /**
   * Record value. Mutually exclusive with `data`.
   */
  readonly content?: string;

  /**
   * Structured value for SRV/CAA/URI records. Mutually exclusive with `content`.
   */
  readonly data?: Record<string, unknown>;

  /**
   * The time-to-live for the record.
   *
   * @default Duration.minutes(5) — pass `CloudflareTtl.AUTO` for Cloudflare's automatic TTL (1)
   */
  readonly ttl?: Duration;

  /**
   * Whether to proxy the record through Cloudflare. Only valid for A, AAAA and CNAME.
   *
   * @default false
   */
  readonly proxied?: boolean;

  /**
   * Record priority. Required for MX, SRV and URI.
   */
  readonly priority?: number;

  /**
   * A free-form comment attached to the record.
   *
   * @default - no comment
   */
  readonly comment?: string;

  /**
   * Whether to add a comment identifying the record as managed by this library,
   * including the CloudFormation stack name and account id (e.g. `managed by
   * cdk-cf-dns (stack: MyStack, account: 123456789012)`).
   *
   * Cloudflare only supports record *tags* on paid (Pro/Business/Enterprise)
   * plans, so this uses the `comment` field, which is available on all plans.
   * When `comment` is provided it takes precedence and no automatic comment is
   * added.
   *
   * @default true
   */
  readonly managedByCdkComment?: boolean;

  /**
   * Tags attached to the record.
   *
   * @default - no tags
   */
  readonly tags?: string[];

  /**
   * If a record with the same name+type already exists in Cloudflare, adopt and
   * manage it instead of failing the deployment.
   *
   * @default false
   */
  readonly adoptExisting?: boolean;

  /**
   * If RETAIN, the record is left in Cloudflare when the stack resource is deleted.
   *
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * A Cloudflare DNS record managed as a CloudFormation resource.
 *
 * The construct synthesises a `Custom::CloudflareDnsRecord` custom resource whose
 * Lambda handler calls the Cloudflare API. The API token is resolved at runtime
 * from Secrets Manager; only the secret ARN ever appears in the template.
 */
export class CloudflareRecord extends Construct {
  /**
   * Cloudflare's record ID, from `GetAtt`. This is the value you can use to
   * locate the record in the Cloudflare dashboard.
   */
  public readonly recordId: string;

  /**
   * The fully-qualified name actually written to Cloudflare (e.g. `app.example.com`).
   */
  public readonly domainName: string;

  /**
   * The underlying custom resource.
   */
  private readonly resource: cdk.CustomResource;

  public constructor(scope: Construct, id: string, props: CloudflareRecordProps) {
    super(scope, id);

    validateRecordProps(props);

    const provider = CloudflareDnsProvider.getOrCreate(this);
    provider.grantSecretRead(props.zone.apiToken, props.zone.apiTokenRegion);

    const fqdn = resolveRecordName(props.recordName, props.zone.zoneName);
    const ttl = resolveTtl(this, props);
    const content = props.content === undefined
      ? undefined
      : chunkTxt(props.type, props.content);

    const record: Record<string, unknown> = {
      name: fqdn,
      type: props.type,
      ttl: ttl.toSeconds(),
    };

    if (props.proxied) {
      record.proxied = true;
    }
    if (content !== undefined) {
      record.content = content;
    }
    if (props.data !== undefined) {
      record.data = props.data;
    }
    if (props.priority !== undefined) {
      record.priority = props.priority;
    }
    if (props.comment !== undefined) {
      record.comment = props.comment;
    } else if (props.managedByCdkComment ?? true) {
      record.comment = buildManagedByComment(this);
    }
    if (props.tags !== undefined) {
      record.tags = props.tags;
    }

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    this.resource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CloudflareDnsRecord',
      removalPolicy,
      properties: {
        zoneId: props.zone.zoneId,
        apiTokenSecretId: props.zone.apiToken.secretName,
        apiTokenRegion: props.zone.apiTokenRegion,
        adoptExisting: props.adoptExisting ?? false,
        retainOnDelete: removalPolicy === RemovalPolicy.RETAIN,
        record,
      },
    });

    this.recordId = this.resource.getAttString('RecordId');
    this.domainName = this.resource.getAttString('DomainName');
  }
}

/**
 * Builds the default "managed by cdk-cf-dns" comment, referencing the
 * CloudFormation stack name and account id so records can be traced back to
 * their source stack.
 */
function buildManagedByComment(scope: Construct): string {
  const stack = cdk.Stack.of(scope);
  return `managed by cdk-cf-dns (stack: ${stack.stackName}, account: ${stack.account})`;
}

/**
 * Validates the record props at synth time, throwing a helpful error rather than
 * deferring the failure to deployment.
 */
function validateRecordProps(props: CloudflareRecordProps): void {
  const hasContent = props.content !== undefined;
  const hasData = props.data !== undefined;

  if (hasContent === hasData) {
    throw new Error(
      `CloudflareRecord must specify exactly one of "content" or "data"; got content=${props.content === undefined ? 'undefined' : JSON.stringify(props.content)}, data=${props.data === undefined ? 'undefined' : 'object'}`,
    );
  }

  if (props.proxied && !PROXIED_TYPES.has(props.type)) {
    throw new Error(`CloudflareRecord "proxied" is only valid for A, AAAA and CNAME records, got ${props.type}`);
  }

  if (props.priority !== undefined && !PRIORITY_TYPES.has(props.type)) {
    throw new Error(`CloudflareRecord "priority" is only valid for MX, SRV and URI records, got ${props.type}`);
  }
  if (props.priority === undefined && PRIORITY_TYPES.has(props.type)) {
    throw new Error(`CloudflareRecord "priority" is required for ${props.type} records`);
  }

  if (props.ttl !== undefined) {
    const seconds = props.ttl.toSeconds();
    const isAuto = seconds === CloudflareTtl.AUTO.toSeconds();
    if (!isAuto && (seconds < MIN_TTL_SECONDS || seconds > MAX_TTL_SECONDS)) {
      throw new Error(
        `CloudflareRecord ttl must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS} seconds, or CloudflareTtl.AUTO (1); got ${seconds}`,
      );
    }
  }

  if (props.type === CloudflareRecordType.TXT && hasContent && props.content !== undefined && props.content.length === 0) {
    throw new Error('CloudflareRecord TXT records require non-empty content');
  }
}

/**
 * Resolves the effective TTL for the record. Cloudflare rejects any TTL other
 * than `1` when `proxied` is true, so the TTL is silently forced to automatic
 * and an informational annotation is emitted.
 */
function resolveTtl(scope: Construct, props: CloudflareRecordProps): Duration {
  const ttl = props.ttl ?? Duration.minutes(5);

  if (props.proxied && ttl.toSeconds() !== CloudflareTtl.AUTO.toSeconds()) {
    Annotations.of(scope).addInfo(
      `Cloudflare requires an automatic TTL (1) for proxied records; forcing ttl to CloudflareTtl.AUTO for ${props.type} record`,
    );
    return CloudflareTtl.AUTO;
  }

  return ttl;
}

/**
 * Resolves a relative record name against the zone name, matching the
 * `aws-cdk-lib/aws-route53` ergonomics.
 *
 * - `undefined` or `'@'` resolves to the zone apex.
 * - A name that already ends in the zone name is used verbatim.
 * - Anything else is treated as relative and the zone name is appended.
 */
export function resolveRecordName(recordName: string | undefined, zoneName: string | undefined): string {
  if (recordName === undefined || recordName === '@') {
    return zoneName ?? '@';
  }

  if (zoneName !== undefined && (recordName === zoneName || recordName.endsWith(`.${zoneName}`))) {
    return recordName;
  }

  if (zoneName !== undefined) {
    return `${recordName}.${zoneName}`;
  }

  return recordName;
}

/**
 * Encodes a TXT record value for Cloudflare. TXT content must consist of RFC
 * 1035 "character strings" delimited by double quotes; Cloudflare's dashboard
 * warns when content is not quoted and treats unquoted content as a single
 * string. Values longer than 255 characters are split into a series of quoted
 * segments.
 */
function chunkTxt(type: CloudflareRecordType, content: string): string {
  if (type !== CloudflareRecordType.TXT) {
    return content;
  }
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += 255) {
    chunks.push(content.slice(i, i + 255));
  }
  return chunks.map((chunk) => `"${escapeTxt(chunk)}"`).join(' ');
}

/**
 * Escapes double quotes and backslashes so the value can be wrapped as a single
 * RFC 1035 quoted string (internal `"` and `\` are escaped with a backslash).
 */
function escapeTxt(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Properties for an A record.
 */
export interface CloudflareARecordProps extends Omit<CloudflareRecordProps, 'type' | 'data' | 'priority'> {
  /** The IPv4 address. */
  readonly content: string;
  /** Whether to proxy the record through Cloudflare. @default false */
  readonly proxied?: boolean;
}

/**
 * An A record.
 */
export class CloudflareARecord extends CloudflareRecord {
  public constructor(scope: Construct, id: string, props: CloudflareARecordProps) {
    super(scope, id, { ...props, type: CloudflareRecordType.A });
  }
}

/**
 * Properties for an AAAA record.
 */
export interface CloudflareAaaaRecordProps extends Omit<CloudflareRecordProps, 'type' | 'data' | 'priority'> {
  /** The IPv6 address. */
  readonly content: string;
  /** Whether to proxy the record through Cloudflare. @default false */
  readonly proxied?: boolean;
}

/**
 * An AAAA record.
 */
export class CloudflareAaaaRecord extends CloudflareRecord {
  public constructor(scope: Construct, id: string, props: CloudflareAaaaRecordProps) {
    super(scope, id, { ...props, type: CloudflareRecordType.AAAA });
  }
}

/**
 * Properties for a CNAME record.
 */
export interface CloudflareCnameRecordProps extends Omit<CloudflareRecordProps, 'type' | 'data' | 'priority'> {
  /** The canonical name. */
  readonly content: string;
  /** Whether to proxy the record through Cloudflare. @default false */
  readonly proxied?: boolean;
}

/**
 * A CNAME record.
 */
export class CloudflareCnameRecord extends CloudflareRecord {
  public constructor(scope: Construct, id: string, props: CloudflareCnameRecordProps) {
    super(scope, id, { ...props, type: CloudflareRecordType.CNAME });
  }
}

/**
 * Properties for a TXT record.
 */
export interface CloudflareTxtRecordProps extends Omit<CloudflareRecordProps, 'type' | 'data' | 'proxied' | 'priority'> {
  /** The text value. Values longer than 255 characters are automatically chunked. */
  readonly content: string;
}

/**
 * A TXT record.
 */
export class CloudflareTxtRecord extends CloudflareRecord {
  public constructor(scope: Construct, id: string, props: CloudflareTxtRecordProps) {
    super(scope, id, { ...props, type: CloudflareRecordType.TXT });
  }
}

/**
 * Properties for an MX record.
 */
export interface CloudflareMxRecordProps extends Omit<CloudflareRecordProps, 'type' | 'data' | 'proxied'> {
  /** The mail exchanger host. */
  readonly content: string;
  /** The MX priority. */
  readonly priority: number;
}

/**
 * An MX record.
 */
export class CloudflareMxRecord extends CloudflareRecord {
  public constructor(scope: Construct, id: string, props: CloudflareMxRecordProps) {
    super(scope, id, { ...props, type: CloudflareRecordType.MX });
  }
}

/**
 * Properties for a CAA record.
 */
export interface CloudflareCaaRecordProps extends Omit<CloudflareRecordProps, 'type' | 'data' | 'proxied' | 'priority'> {
  /** The CAA value. */
  readonly content: string;
}

/**
 * A CAA record.
 */
export class CloudflareCaaRecord extends CloudflareRecord {
  public constructor(scope: Construct, id: string, props: CloudflareCaaRecordProps) {
    super(scope, id, { ...props, type: CloudflareRecordType.CAA });
  }
}
