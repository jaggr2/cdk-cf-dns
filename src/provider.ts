import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as custom_resources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * The stable construct ID used for the shared DNS provider on each Stack.
 */
const PROVIDER_ID = 'AcmeCloudflareDnsProvider';

/**
 * The stable construct ID used for the shared ACM provider on each Stack.
 */
const CERTIFICATE_PROVIDER_ID = 'AcmeCloudflareCertificateProvider';

/**
 * Resolves a handler entry point. When the library is consumed from the
 * compiled `lib/` output the source lives at `<package>/src/handler/<file>`;
 * when tests run against `src/` directly it is at `src/handler/<file>`.
 */
function handlerEntry(file: string): string {
  const fromLib = path.join(__dirname, '..', 'src', 'handler', file);
  if (fs.existsSync(fromLib)) {
    return fromLib;
  }
  return path.join(__dirname, 'handler', file);
}

/**
 * Creates the shared handler function with the provider's standard
 * configuration: Node 22 on ARM, 256 MB, a one-month log group that is deleted
 * with the stack, and an esbuild bundle with the AWS SDK kept external.
 */
function createHandler(scope: Construct, id: string, file: string, timeout: cdk.Duration): { handler: NodejsFunction; role: iam.IRole } {
  // `NodejsFunction` requires its entry (and lock file) to live under
  // `projectRoot`. The library is consumed from a different project, so both
  // are pointed at the package's own root. The handler has no runtime npm
  // dependencies, so the shipped `deps.lock.json` marker is never actually
  // read — it only satisfies the path validation.
  const projectRoot = path.join(__dirname, '..');

  const handler = new NodejsFunction(scope, id, {
    entry: handlerEntry(file),
    projectRoot,
    depsLockFilePath: path.join(projectRoot, 'src', 'handler', 'deps.lock.json'),
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    timeout,
    memorySize: 256,
    bundling: {
      minify: true,
      sourceMap: true,
      externalModules: ['@aws-sdk/*'],
    },
  });

  const logGroup = new logs.LogGroup(scope, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${handler.functionName}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  logGroup.node.addDependency(handler);

  if (!handler.role) {
    throw new Error(`Cloudflare provider handler ${id} requires an IAM role`);
  }

  return { handler, role: handler.role };
}

/**
 * The shared custom-resource provider that performs the Cloudflare DNS API
 * calls.
 *
 * One instance exists per stack (a singleton keyed by `Stack`), so a stack with
 * many records still has exactly one Lambda handler. All records route their
 * custom-resource events through this handler.
 */
export class CloudflareDnsProvider extends Construct {
  /**
   * Gets (or lazily creates) the provider for the stack of `scope`.
   *
   * @param scope Any construct within the stack that should own the provider.
   */
  public static getOrCreate(scope: Construct): CloudflareDnsProvider {
    const stack = cdk.Stack.of(scope);
    const existing = stack.node.tryFindChild(PROVIDER_ID) as CloudflareDnsProvider | undefined;
    if (existing) {
      return existing;
    }
    return new CloudflareDnsProvider(stack, PROVIDER_ID);
  }

  /**
   * The custom-resource service token that records use as their `serviceToken`.
   */
  public readonly serviceToken: string;

  /**
   * The IAM role used by the handler. Record constructs grant `GetSecretValue`
   * on their zone's secret here.
   */
  private readonly handlerRole: iam.IRole;

  /**
   * Secrets that have already been granted, deduplicated by ARN.
   */
  private readonly grantedSecrets: Set<string> = new Set();

  private constructor(scope: Construct, id: string) {
    super(scope, id);

    const { handler, role } = createHandler(this, 'Handler', 'index.ts', cdk.Duration.minutes(2));

    const provider = new custom_resources.Provider(this, 'Provider', {
      onEventHandler: handler,
    });

    this.serviceToken = provider.serviceToken;
    this.handlerRole = role;
  }

  /**
   * Grants the provider's handler `secretsmanager:GetSecretValue` on the given
   * secret. Repeated grants of the same secret are deduplicated.
   *
   * @param secret The secret holding a Cloudflare API token.
   */
  public grantSecretRead(secret: secretsmanager.ISecret): void {
    const arn = secret.secretArn;
    if (this.grantedSecrets.has(arn)) {
      return;
    }
    this.grantedSecrets.add(arn);
    this.handlerRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [arn],
    }));
  }
}

/**
 * The shared custom-resource provider that writes ACM DNS validation records
 * into Cloudflare.
 *
 * Like `CloudflareDnsProvider`, one instance exists per stack. It additionally
 * grants its handler `acm:DescribeCertificate` on all certificates.
 */
export class CloudflareCertificateProvider extends Construct {
  /**
   * Gets (or lazily creates) the provider for the stack of `scope`.
   *
   * @param scope Any construct within the stack that should own the provider.
   */
  public static getOrCreate(scope: Construct): CloudflareCertificateProvider {
    const stack = cdk.Stack.of(scope);
    const existing = stack.node.tryFindChild(CERTIFICATE_PROVIDER_ID) as CloudflareCertificateProvider | undefined;
    if (existing) {
      return existing;
    }
    return new CloudflareCertificateProvider(stack, CERTIFICATE_PROVIDER_ID);
  }

  /**
   * The custom-resource service token that the certificate construct uses as
   * its `serviceToken`.
   */
  public readonly serviceToken: string;

  /**
   * The IAM role used by the handler.
   */
  private readonly handlerRole: iam.IRole;

  /**
   * Secrets that have already been granted, deduplicated by ARN.
   */
  private readonly grantedSecrets: Set<string> = new Set();

  private constructor(scope: Construct, id: string) {
    super(scope, id);

    // ACM validation records can take a while to appear after certificate
    // creation, so the handler gets a generous timeout to poll for them.
    const { handler, role } = createHandler(this, 'Handler', 'acm.ts', cdk.Duration.minutes(5));

    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['acm:DescribeCertificate'],
      resources: ['*'],
    }));

    const provider = new custom_resources.Provider(this, 'Provider', {
      onEventHandler: handler,
    });

    this.serviceToken = provider.serviceToken;
    this.handlerRole = role;
  }

  /**
   * Grants the provider's handler `secretsmanager:GetSecretValue` on the given
   * secret. Repeated grants of the same secret are deduplicated.
   *
   * @param secret The secret holding a Cloudflare API token.
   */
  public grantSecretRead(secret: secretsmanager.ISecret): void {
    const arn = secret.secretArn;
    if (this.grantedSecrets.has(arn)) {
      return;
    }
    this.grantedSecrets.add(arn);
    this.handlerRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [arn],
    }));
  }
}
