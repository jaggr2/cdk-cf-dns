# Build: `@jaggr2/cdk-cf-dns` — a reusable AWS CDK construct library

## Mission

Create a standalone, publishable TypeScript package that lets any AWS CDK app manage
Cloudflare DNS records as CloudFormation resources, so that Route 53 hosted zones
(and their $0.50/zone/month charge) are no longer needed.

The developer experience must feel as close to `aws-cdk-lib/aws-route53` as possible.

Target call site:

```ts
const zone = CloudflareZone.fromZoneId(this, &#x27;Zone&#x27;, {
  zoneId: &#x27;abc123...&#x27;,
  apiToken: secretsmanager.Secret.fromSecretNameV2(this, &#x27;CfToken&#x27;, &#x27;cloudflare/dns-token&#x27;),
  zoneName: &#x27;example.com&#x27;,
});

new CloudflareRecord(this, &#x27;AppCname&#x27;, {
  zone,
  recordName: &#x27;app&#x27;,            // relative -&gt; app.example.com
  type: CloudflareRecordType.CNAME,
  content: distribution.distributionDomainName,
  proxied: true,
});
```

---

## Non-negotiable constraints

1. **Zero runtime npm dependencies in the Lambda handler.** Use the global `fetch`
   built into the Node.js runtime. Do NOT add the `cloudflare` SDK — it is a large
   package and we make at most four HTTP calls.
2. **`aws-cdk-lib` and `constructs` are `peerDependencies` + `devDependencies` only.**
   Never a regular `dependency`. Use a permissive range (`^2.x`).
3. **The API token never appears in a CloudFormation template, a construct prop, an
   environment variable value, or a log line.** Only the Secrets Manager ARN travels
   through CloudFormation; the Lambda resolves the secret at runtime.
4. **One shared Lambda per stack**, not one per record. Implement a
   `getOrCreate(scope)` singleton keyed by a stable construct id on the `Stack` scope.
5. The library must build and pass tests with `npm ci && npm run build && npm test`
   on a clean checkout.

---

## Repository layout

```
.
├── src/
│   ├── index.ts                  # public barrel export
│   ├── zone.ts                   # ICloudflareZone + CloudflareZone
│   ├── record.ts                 # CloudflareRecord + prop types + enums
│   ├── provider.ts               # singleton custom-resource provider
│   └── handler/
│       └── index.ts              # Lambda entry (bundled, never imported by CDK code)
├── test/
│   ├── record.test.ts            # assertions-based template tests
│   ├── handler.test.ts           # handler unit tests with mocked fetch
│   └── __snapshots__/
├── examples/
│   └── minimal-app/              # a tiny CDK app proving the library composes
├── API.md                        # generated API reference
├── README.md
├── package.json
├── tsconfig.json
├── .eslintrc.json
└── .github/workflows/ci.yml
```

---

## Task 1 — Package scaffolding

- `package.json`: name `@jaggr2/cdk-cf-dns`, `main: lib/index.js`,
  `types: lib/index.d.ts`, `files: ["lib", "API.md"]`, `license: MIT`.
- TypeScript strict mode on. `target: ES2022`, `module: NodeNext`,
  `declaration: true`, `outDir: lib`.
- Test runner: Jest with `ts-jest`.
- Scripts: `build`, `watch`, `test`, `test:update`, `lint`.
- Do **not** introduce projen. Keep the toolchain plain and readable.

---

## Task 2 — `src/zone.ts`

```ts
export interface ICloudflareZone {
  readonly zoneId: string;
  readonly zoneName?: string;
  readonly apiToken: secretsmanager.ISecret;
}

export interface CloudflareZoneAttributes {
  readonly zoneId: string;
  readonly apiToken: secretsmanager.ISecret;
  /** Apex domain, e.g. &quot;example.com&quot;. Enables relative record names. */
  readonly zoneName?: string;
}

export class CloudflareZone {
  public static fromZoneId(
    scope: Construct, id: string, attrs: CloudflareZoneAttributes
  ): ICloudflareZone;
}
```

There is no "create a zone" construct — zones are assumed to already exist in
Cloudflare. Say so explicitly in the README.

`zoneId` may be a plain string or a CDK token (e.g. from SSM). Never validate it
with a regex that would break on `${Token[...]}`; guard any validation with
`cdk.Token.isUnresolved()`.

---

## Task 3 — `src/record.ts`

### Public API

```ts
export enum CloudflareRecordType {
  A, AAAA, CNAME, TXT, MX, NS, SRV, CAA, PTR, URI
}

export interface CloudflareRecordProps {
  readonly zone: ICloudflareZone;
  /**

* Record name. If it does not end in the zone name and `zone.zoneName` is set,
* it is treated as relative and the zone name is appended.
* Use &#x27;@&#x27; or omit for the zone apex.
   */
  readonly recordName?: string;
  readonly type: CloudflareRecordType;
  /** Record value. Mutually exclusive with `data`. */
  readonly content?: string;
  /** Structured value for SRV/CAA/URI records. Mutually exclusive with `content`. */
  readonly data?: Record&lt;string, unknown&gt;;
  /** @default Duration.minutes(5) — pass `CloudflareTtl.AUTO` for Cloudflare&#x27;s automatic TTL (1) */
  readonly ttl?: Duration;
  /** Only valid for A, AAAA and CNAME. @default false */
  readonly proxied?: boolean;
  /** Required for MX, SRV and URI. */
  readonly priority?: number;
  readonly comment?: string;
  readonly tags?: string[];
  /**

* If a record with the same name+type already exists in Cloudflare, adopt and
* manage it instead of failing the deployment. @default false
   */
  readonly adoptExisting?: boolean;
  /**

* If RETAIN, the record is left in Cloudflare when the stack resource is deleted.
* @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

export class CloudflareRecord extends Construct {
  readonly recordId: string;    // Cloudflare&#x27;s record id, from GetAtt
  readonly domainName: string;  // fully-qualified name actually written
}
```

Also ship thin subclasses that mirror the Route 53 ergonomics, each narrowing
`type` and validating its own required fields:
`CloudflareARecord`, `CloudflareAaaaRecord`, `CloudflareCnameRecord`,
`CloudflareTxtRecord`, `CloudflareMxRecord`, `CloudflareCaaRecord`.

### Validation at synth time (throw, do not defer to deploy)

- Exactly one of `content` / `data` is provided.
- `proxied: true` only with A, AAAA, CNAME.
- `priority` present for MX, SRV, URI; rejected for other types.
- `ttl` must be 60s–86400s, **or** the sentinel `1` meaning automatic. Cloudflare
  rejects any TTL other than `1` when `proxied` is true — so when `proxied` is true,
  silently force ttl to `1` and emit an `Annotations.addInfo` note.
- TXT `content` longer than 255 chars must be chunked into quoted segments; do this
  automatically and cover it with a test.

### Implementation

Instantiate `cdk.CustomResource` with:
- `serviceToken` from `CloudflareDnsProvider.getOrCreate(this).serviceToken`
- `resourceType: 'Custom::CloudflareDnsRecord'`
- `removalPolicy` passed through
- `properties`: the resolved record payload **plus** `zoneId`, `apiTokenSecretArn`,
  `adoptExisting`, and `retainOnDelete`.

Expose `recordId` via `resource.getAttString('RecordId')`.

---

## Task 4 — `src/provider.ts`

```ts
export class CloudflareDnsProvider extends Construct {
  public static getOrCreate(scope: Construct): CloudflareDnsProvider;
  public readonly serviceToken: string;
  public grantSecretRead(secret: secretsmanager.ISecret): void;
}
```

- Look up `Stack.of(scope).node.tryFindChild('AcmeCloudflareDnsProvider')`; create it
  on the stack scope if absent. This is the standard CDK singleton pattern.
- Handler: `NodejsFunction` (from `aws-cdk-lib/aws-lambda-nodejs`).
  - `runtime: lambda.Runtime.NODEJS_22_X`
  - `architecture: lambda.Architecture.ARM_64`
  - `timeout: Duration.minutes(2)`
  - `memorySize: 256`
  - `logGroup` with `retention: RetentionDays.ONE_MONTH` and
    `removalPolicy: DESTROY`
  - `bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] }`
- Wrap it in `custom_resources.Provider` (`onEventHandler` only — no isComplete
  handler is needed, Cloudflare writes are synchronous).
- IAM: the function needs `secretsmanager:GetSecretValue` on **each** secret used.
  Because the provider is shared, `CloudflareRecord` must call
  `provider.grantSecretRead(props.zone.apiToken)` for its own zone's secret.
  Deduplicate grants so repeated calls with the same secret do not produce
  duplicate policy statements.

---

## Task 5 — `src/handler/index.ts` (the important part)

Signature: `export async function handler(event: CloudFormationCustomResourceEvent)`
returning `{ PhysicalResourceId, Data: { RecordId, DomainName } }`.

### Cloudflare API contract

Base URL `https://api.cloudflare.com/client/v4`.
Header `Authorization: Bearer <token>`, `Content-Type: application/json`.

| Operation | Method + path |
|---|---|
| Create | `POST /zones/{zone_id}/dns_records` |
| Update in place | `PATCH /zones/{zone_id}/dns_records/{record_id}` |
| Delete | `DELETE /zones/{zone_id}/dns_records/{record_id}` |
| Find by name+type | `GET /zones/{zone_id}/dns_records?name={fqdn}&type={type}` |

Every response is `{ success: boolean, errors: [{code, message}], messages: [], result: ... }`.
**Do not trust the HTTP status alone — always check `success`.** On `success: false`,
throw an `Error` whose message includes every `errors[].code` and `errors[].message`,
because that string is what a developer will see in the CloudFormation events pane.

### Lifecycle logic

**Create**
1. Build the payload from `event.ResourceProperties`.
2. `POST`. On success, return `PhysicalResourceId = result.id`.
3. If it fails with an "already exists" error (HTTP 400, Cloudflare error code in the
   `81053`/`81057` family — match on code *and* on `/already exists/i` in the message
   as a belt-and-braces fallback) then:
   - if `adoptExisting` is false → rethrow, with a message telling the user to either
     delete the record in the Cloudflare dashboard or set `adoptExisting: true`;
   - if true → `GET` the record by name+type, `PATCH` it to our desired state, and
     return its existing id as the physical id.

**Update**
- If `ZoneId` differs between `ResourceProperties` and `OldResourceProperties`,
  return a **new** physical id (create the record in the new zone). CloudFormation
  will then send a `Delete` for the old physical id, which cleans up the old zone.
- Otherwise `PATCH` the existing `event.PhysicalResourceId` and return that **same**
  physical id. This is what makes name/content/proxied/ttl changes non-replacing.
- If the `PATCH` returns 404 (record deleted out-of-band in the dashboard), fall back
  to `POST` to recreate it and return the new id. Log a warning.

**Delete**
- If `retainOnDelete` is true, return the physical id without calling Cloudflare.
- If the physical id does not look like a Cloudflare record id (e.g. it is the
  CloudFormation-generated `arn:...` placeholder from a failed create), return
  immediately — never throw.
- `DELETE`. Treat HTTP 404 and the "record does not exist" error code (`81044`) as
  **success**; a delete must be idempotent or stacks become undeletable.

### Cross-cutting handler requirements

- **Retries**: a `request()` helper wrapping `fetch` with up to 5 attempts and
  exponential backoff + full jitter on HTTP `429`, `5xx`, and network errors.
  Honour the `Retry-After` header when present. Cap total time under the Lambda
  timeout.
- **Secrets**: fetch the token with `@aws-sdk/client-secrets-manager` (available in
  the runtime, marked external in bundling). Cache the resolved token in a
  module-level variable keyed by ARN so warm invocations skip the call. Support the
  secret being either a raw string or a JSON blob with an `apiToken` key.
- **Logging**: log the operation, zone id, record name and type. Write a
  `redact()` helper and route every log through it; assert in a unit test that a
  token-shaped string never reaches the log output.
- **Timeout safety**: catch everything at the top level and rethrow with context.
  Never let the function time out silently — a timed-out custom resource hangs the
  stack for an hour.

---

## Task 6 — Tests

`test/record.test.ts` (uses `aws-cdk-lib/assertions`):
- Synthesises one record → template contains exactly one `Custom::CloudflareDnsRecord`
  and exactly one `AWS::Lambda::Function` for the handler (plus the provider framework
  function).
- Synthesises **ten** records → still only one handler function. This is the
  regression test for the singleton.
- Two different zones with two different secrets → both ARNs appear in the IAM policy.
- The API token literal never appears anywhere in `JSON.stringify(template)`.
- Each synth-time validation rule throws with a helpful message.
- Relative vs absolute vs `@` record names all resolve to the right FQDN.
- One snapshot test.

`test/handler.test.ts` (mock global `fetch`; no network):
- Create happy path returns the Cloudflare id as `PhysicalResourceId`.
- Create conflict + `adoptExisting: false` → throws.
- Create conflict + `adoptExisting: true` → looks up, patches, returns existing id.
- Update keeps the same physical id; update across zones returns a new one.
- Delete on 404 resolves successfully.
- `success: false` with a populated `errors` array throws containing the code.
- A `429` followed by a `200` succeeds and issues exactly two `fetch` calls.

---

## Task 7 — README.md

Must contain, in this order:

1. One-paragraph statement of purpose (replace Route 53 hosted zones when Cloudflare
   is already authoritative).
2. Install + peer dependency note.
3. **Cloudflare API token setup**: dashboard → My Profile → API Tokens → Create Token
   → *Edit zone DNS* template → scope it to the single zone. Then the exact AWS CLI
   command to store it:
```
aws secretsmanager create-secret --name cloudflare/dns-token --secret-string &#x27;cf_token_here&#x27;
```
   State plainly that the token grants DNS write access to that zone and should be
   scoped as narrowly as possible.
4. Where to find the Zone ID (Cloudflare dashboard → domain → Overview, right rail).
5. Usage examples: CNAME to a CloudFront distribution, apex A record, TXT for domain
   verification, MX records.
6. A **"Proxied records and ACM"** section warning that ACM DNS-validation `_acme`
   CNAMEs must be `proxied: false`, or validation will never complete.
7. A **Limitations** section: no zone creation, no zone-level settings, no page rules,
   no bulk import, and the fact that out-of-band edits in the Cloudflare dashboard are
   only reconciled on the next stack update.

---

## Task 8 (optional, only after 1–7 are green) — `CloudflareValidatedCertificate`

A construct that removes the manual copy-paste step during ACM DNS validation.

```ts
const cert = new CloudflareValidatedCertificate(this, &#x27;Cert&#x27;, {
  domainName: &#x27;example.com&#x27;,
  subjectAlternativeNames: [&#x27;*.example.com&#x27;],
  zone,
});
```

Implementation notes, because this one is subtle:
- CloudFormation does **not** expose the validation `ResourceRecord` as an attribute
  of `AWS::CertificateManager::Certificate`. So: create the certificate with
  `validation: CertificateValidation.fromDns()` (no zone), then use a second custom
  resource that calls `acm:DescribeCertificate`, **polls** until
  `DomainValidationOptions[].ResourceRecord` is populated (it is absent for a few
  seconds after creation), and writes each unique CNAME into Cloudflare.
- Deduplicate: a wildcard SAN and its apex normally share one validation record.
- Force `proxied: false` and `ttl: 60` on the validation records.
- Add an explicit dependency so the certificate resource waits on the DNS writes.
- IAM: `acm:DescribeCertificate` on `*`.
- If the certificate is for CloudFront it must live in `us-east-1`; note this in the
  docstring rather than trying to solve cross-region here.

---

## Definition of done

- `npm ci && npm run build && npm test && npm run lint` all pass from a clean clone.
- `examples/minimal-app` runs `cdk synth` without error.
- Every public class, interface and property has a TSDoc comment with `@default`
  where applicable.
- `API.md` is generated and committed.
- No `any` in the public API surface.
​