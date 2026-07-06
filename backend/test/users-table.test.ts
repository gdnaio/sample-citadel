import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { UsersTable } from '../lib/constructs/users-table';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  new UsersTable(stack, 'UsersTable', { environment: 'test' });
  return Template.fromStack(stack);
}

describe('UsersTable construct', () => {
  it('creates citadel-users-{env} with on-demand billing, PITR and KMS', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'citadel-user-profiles-test',
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true },
    });
  });

  it('defines org and email GSIs', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'org-index' }),
        Match.objectLike({ IndexName: 'email-index' }),
      ]),
    });
  });

  it('retains the users table on deletion', () => {
    const template = synth();
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });
});
