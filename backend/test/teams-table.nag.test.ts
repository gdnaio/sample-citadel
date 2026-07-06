/**
 * cdk-nag — AwsSolutions checks for the Unit B `TeamsTable` construct.
 *
 * The single-table store is on-demand, KMS-encrypted at rest, and has
 * Point-in-time Recovery enabled, so the AwsSolutions DynamoDB rules
 * (notably AwsSolutions-DDB3 — PITR) must not raise findings.
 */
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { TeamsTable } from '../lib/constructs/teams-table';

describe('TeamsTable — cdk-nag AwsSolutions', () => {
  let stack: cdk.Stack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    new TeamsTable(stack, 'TeamsTable', { environment: 'test' });
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }));
    // Force synthesis so annotations are populated.
    Annotations.fromStack(stack);
  });

  it('raises no AwsSolutions errors on the teams table', () => {
    const annotations = Annotations.fromStack(stack);
    annotations.hasNoError(
      'TestStack/TeamsTable/Table/Resource',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
  });

  it('raises no AwsSolutions warnings on the teams table (PITR enabled)', () => {
    const annotations = Annotations.fromStack(stack);
    annotations.hasNoWarning(
      'TestStack/TeamsTable/Table/Resource',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
  });
});
