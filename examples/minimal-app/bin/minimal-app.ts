import * as cdk from 'aws-cdk-lib';
import { MinimalAppStack } from '../lib/minimal-app-stack';

const app = new cdk.App();
new MinimalAppStack(app, 'MinimalAppStack', {
  env: { account: '123456789012', region: 'us-east-1' },
});
