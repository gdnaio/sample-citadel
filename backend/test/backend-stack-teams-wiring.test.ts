/**
 * CDK synth + IAM-scoping checks for the Unit B (team & operational-unit
 * management) wiring in BackendStack — task 6.2.
 *
 * The Unit B resources live in the `TeamManagementStack` NestedStack (kept out of
 * the parent template to respect CloudFormation's 500-resource limit). Synth of
 * both templates is exercised by `Template.fromStack` (fails on invalid
 * constructs), doubling as the `cdk synth` gate. The IAM assertions verify the
 * cdk-nag intent directly ("no unscoped IAM"): the new custom grants are scoped
 * to specific ARNs and never use `Resource: "*"`. Table-level cdk-nag (KMS/PITR)
 * is covered by teams-table.nag.test.ts.
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

function makeStack(withOidc: boolean): BackendStack {
  const app = new cdk.App({ context: { adminEmail: 'test-admin@example.com' } });
  return new BackendStack(app, 'TestBackendStack', {
    environment: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...(withOidc ? { oidcConfig } : {}),
  });
}

/** Collect every IAM policy statement in a template. */
function allPolicyStatements(template: Template): any[] {
  const policies = template.findResources('AWS::IAM::Policy');
  const statements: any[] = [];
  for (const key of Object.keys(policies)) {
    statements.push(...(policies[key].Properties?.PolicyDocument?.Statement ?? []));
  }
  return statements;
}

function statementsWithAction(statements: any[], action: string): any[] {
  return statements.filter((s) => {
    const a = Array.isArray(s.Action) ? s.Action : [s.Action];
    return a.includes(action);
  });
}

describe('BackendStack — Unit B team wiring (nested stack synth)', () => {
  let nested: Template;
  let parent: Template;
  beforeAll(() => {
    const stack = makeStack(true);
    parent = Template.fromStack(stack);
    expect(stack.teamManagement).toBeDefined();
    nested = Template.fromStack(stack.teamManagement!);
  });

  it('parent template stays within the CFN 500-resource limit (synth succeeds)', () => {
    // Template.fromStack(stack) above throws TooManyResourcesInStack if >500.
    // The nested stack appears in the parent as a single CFN::Stack resource.
    parent.resourceCountIs('AWS::CloudFormation::Stack', 1);
  });

  it('creates the citadel-teams-{env} table in the nested stack', () => {
    nested.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'citadel-teams-test' });
  });

  it('creates the team-resolver and team-auto-join Lambda functions', () => {
    nested.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'citadel-team-resolver-test' });
    nested.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'citadel-team-auto-join-test' });
  });

  it('registers the UserProvisioned auto-join EventBridge rule', () => {
    nested.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ source: ['citadel.identity'], 'detail-type': ['UserProvisioned'] }),
    });
  });

  it('registers AppSync resolvers for the team query + mutation fields', () => {
    nested.resourceCountIs('AWS::AppSync::Resolver', 14);
    for (const fieldName of ['listTeams', 'getTeam', 'createTeam', 'mapTeamToOperationalUnit', 'elevateRole']) {
      nested.hasResourceProperties('AWS::AppSync::Resolver', { FieldName: fieldName });
    }
  });
});

describe('BackendStack — Unit B IAM scoping (cdk-nag intent: no unscoped IAM)', () => {
  let statements: any[];
  beforeAll(() => {
    statements = allPolicyStatements(Template.fromStack(makeStack(true).teamManagement!));
  });

  it('scopes the audit-table write to the identity-audit table ARN (append-only PutItem)', () => {
    const auditWrite = statementsWithAction(statements, 'dynamodb:PutItem').find((s) =>
      JSON.stringify(s.Resource).includes('table/citadel-identity-audit-test'),
    );
    expect(auditWrite).toBeDefined();
    expect(auditWrite.Resource).not.toBe('*');
  });

  it('scopes elevateRole AdminAddUserToGroup to a userpool ARN (not "*")', () => {
    const elevate = statementsWithAction(statements, 'cognito-idp:AdminAddUserToGroup');
    expect(elevate.length).toBeGreaterThanOrEqual(1);
    for (const s of elevate) {
      expect(JSON.stringify(s.Resource)).toContain(':userpool/');
      expect(s.Resource).not.toBe('*');
    }
  });

  it('never grants AdminAddUserToGroup or audit PutItem on Resource "*"', () => {
    for (const action of ['cognito-idp:AdminAddUserToGroup', 'dynamodb:PutItem']) {
      for (const s of statementsWithAction(statements, action)) {
        expect(s.Resource).not.toBe('*');
      }
    }
  });
});

describe('BackendStack — Unit B opt-in guarantee', () => {
  it('instantiates no team-management nested stack without oidcConfig', () => {
    const stack = makeStack(false);
    const template = Template.fromStack(stack);
    expect(stack.teamManagement).toBeUndefined();
    template.resourceCountIs('AWS::CloudFormation::Stack', 0);
  });
});
