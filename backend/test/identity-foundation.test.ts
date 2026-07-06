import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IdentityFoundation } from '../lib/constructs/identity-foundation';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  new IdentityFoundation(stack, 'IdentityFoundation', { environment: 'test' });
  return Template.fromStack(stack);
}

describe('IdentityFoundation construct', () => {
  it('creates the identity audit table with on-demand billing and PITR', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'citadel-identity-audit-test',
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
    });
  });

  it('retains the audit table on stack deletion (non-repudiation)', () => {
    const template = synth();
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
    });
  });

  it('encrypts the audit table at rest with KMS', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: { SSEEnabled: true },
    });
  });

  it('defines actor and org GSIs for audit queries', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'actor-index' }),
        Match.objectLike({ IndexName: 'org-index' }),
      ]),
    });
  });

  it('provisions exactly one audit table', () => {
    const template = synth();
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });

  it('registers a governance ADR parameter (US-019)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/citadel/governance/adr/team-management-test',
    });
  });
});

describe('grantTriggerGroupManagement (US-020)', () => {
  function synthWithGrant(): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const foundation = new IdentityFoundation(stack, 'IdentityFoundation', { environment: 'test' });
    const role = new iam.Role(stack, 'TriggerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    foundation.grantTriggerGroupManagement(role);
    return Template.fromStack(stack);
  }

  it('grants scoped Cognito group-management actions', () => {
    const template = synthWithGrant();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'cognito-idp:AdminAddUserToGroup',
              'cognito-idp:AdminListGroupsForUser',
              'cognito-idp:AdminGetUser',
            ]),
          }),
        ]),
      },
    });
  });

  it('synthesizes without a circular dependency (pseudo-parameter ARN)', () => {
    expect(() => synthWithGrant()).not.toThrow();
  });
});
