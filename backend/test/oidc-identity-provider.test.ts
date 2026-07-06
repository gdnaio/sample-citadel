import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Template } from 'aws-cdk-lib/assertions';
import { OidcIdentityProvider } from '../lib/constructs/oidc-identity-provider';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const userPool = new cognito.UserPool(stack, 'Pool', { userPoolName: 'citadel-users-test' });
  new OidcIdentityProvider(stack, 'Oidc', {
    userPool,
    environment: 'test',
    clientId: 'client-abc',
    clientSecretName: 'citadel/oidc/client-secret-test',
    issuerUrl: 'https://idp.example.com',
    hostedUiDomainPrefix: 'citadel-test',
  });
  return Template.fromStack(stack);
}

describe('OidcIdentityProvider construct', () => {
  it('registers an OIDC identity provider on the pool', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'OIDC',
      ProviderName: 'CorporateSSO',
    });
  });

  it('creates a Hosted UI domain', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'citadel-test',
    });
  });

  it('references the client secret by name (never inlined)', () => {
    const template = synth();
    const json = JSON.stringify(template.toJSON());
    // Secret is a CloudFormation dynamic reference, not a literal value.
    expect(json).toContain('resolve:secretsmanager:citadel/oidc/client-secret-test');
  });
});
