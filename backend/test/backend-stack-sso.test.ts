/**
 * CDK tests for the cognito-sso-team-management wiring in BackendStack.
 * Verifies the feature synthesizes when `oidcConfig` is supplied, and that the stack
 * is unchanged (no new resources) when it is absent — the opt-in guarantee.
 */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import * as fs from 'fs';

const assetDirs = [
  path.resolve(__dirname, '../src/schema'),
  path.resolve(__dirname, '../dist/lambda'),
  path.resolve(__dirname, '../src/lambda/seed-admin-user'),
  path.resolve(__dirname, '../src/lambda/seed-organizations'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from '../lib/backend-stack';

const oidcConfig = {
  issuerUrl: 'https://idp.example.com',
  clientId: 'client-abc',
  clientSecretName: 'citadel/oidc/client-secret-test',
  hostedUiDomainPrefix: 'citadel-sso-test',
  callbackUrls: ['https://app.example.com/'],
  logoutUrls: ['https://app.example.com/logout'],
};

function synth(withOidc: boolean): Template {
  const app = new cdk.App({ context: { adminEmail: 'test-admin@example.com' } });
  const stack = new BackendStack(app, 'TestBackendStack', {
    environment: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...(withOidc ? { oidcConfig } : {}),
  });
  return Template.fromStack(stack);
}

describe('BackendStack — SSO wiring', () => {
  describe('with oidcConfig', () => {
    let template: Template;
    beforeAll(() => {
      template = synth(true);
    });

    it('registers the OIDC identity provider', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', { ProviderType: 'OIDC' });
    });

    it('creates the user-profiles and identity-audit tables', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'citadel-user-profiles-test' });
      template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'citadel-identity-audit-test' });
    });

    it('registers a ProvisionRetry EventBridge rule', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({ 'detail-type': ['ProvisionRetry'], source: ['citadel.identity'] }),
      });
    });

    it('lists the OIDC provider as a supported identity provider on the client', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        SupportedIdentityProviders: Match.arrayWith(['COGNITO', 'CorporateSSO']),
      });
    });

    it('adds a reconciler DLQ and identity alarms (observability)', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'citadel-provision-reconciler-dlq-test',
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmDescription: Match.stringLikeRegexp('pre-token errors'),
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmDescription: Match.stringLikeRegexp('reconciler DLQ not empty'),
      });
    });
  });

  describe('without oidcConfig (opt-in guarantee)', () => {
    let template: Template;
    beforeAll(() => {
      template = synth(false);
    });

    it('creates no OIDC identity provider', () => {
      template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
    });

    it('creates no user-profiles table', () => {
      const tables = template.findResources('AWS::DynamoDB::Table', {
        Properties: { TableName: 'citadel-user-profiles-test' },
      });
      expect(Object.keys(tables)).toHaveLength(0);
    });
  });
});
