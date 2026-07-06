import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { TeamsTable } from '../lib/constructs/teams-table';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  new TeamsTable(stack, 'TeamsTable', { environment: 'test' });
  return Template.fromStack(stack);
}

describe('TeamsTable construct', () => {
  it('creates citadel-teams-{env} with on-demand billing, PITR and KMS', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'citadel-teams-test',
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true },
    });
  });

  it('uses a composite pk/sk key schema', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'pk', KeyType: 'HASH' }),
        Match.objectLike({ AttributeName: 'sk', KeyType: 'RANGE' }),
      ]),
    });
  });

  it('defines the inverse GSI1 for reverse lookups', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: Match.arrayWith([
            Match.objectLike({ AttributeName: 'GSI1PK', KeyType: 'HASH' }),
            Match.objectLike({ AttributeName: 'GSI1SK', KeyType: 'RANGE' }),
          ]),
        }),
      ]),
    });
  });

  it('retains the teams table on deletion with deletion protection', () => {
    const template = synth();
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: true,
    });
  });

  it('provisions exactly one teams table', () => {
    const template = synth();
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });
});
