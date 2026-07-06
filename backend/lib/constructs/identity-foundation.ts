import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { GovernanceRegistration } from './governance-registration';

export interface IdentityFoundationProps {
  /** Deployment environment (e.g. dev/staging/prod), used in resource names. */
  readonly environment: string;
}

/**
 * Foundation shared-kernel infrastructure for the cognito-sso-team-management feature.
 *
 * Provisions the immutable identity **audit trail** (US-018) that Units A/B/C write to
 * via the `AuditWriter`. The table is RETAINed with deletion protection so the
 * non-repudiation record survives stack teardown.
 *
 * The reusable Cognito-trigger IAM grant (`grantTriggerGroupManagement`, US-020) is
 * added to this construct in Phase 5.
 */
export class IdentityFoundation extends Construct {
  /** Append-only audit trail table (`citadel-identity-audit-{env}`). */
  public readonly auditTable: dynamodb.Table;

  /** Deploy-time governance ADR / authority-unit registration (US-019). */
  public readonly governance: GovernanceRegistration;

  constructor(scope: Construct, id: string, props: IdentityFoundationProps) {
    super(scope, id);

    // Immutable audit trail. RETAIN + deletion protection for non-repudiation
    // (US-018) — mirrors the platform's critical governance tables. KMS (AWS-managed)
    // at rest per D3-1; PITR uses the non-deprecated `pointInTimeRecoverySpecification`.
    this.auditTable = new dynamodb.Table(this, 'AuditTable', {
      tableName: `citadel-identity-audit-${props.environment}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    // GSI1 — query audit records by actor over time.
    this.auditTable.addGlobalSecondaryIndex({
      indexName: 'actor-index',
      partitionKey: { name: 'actor', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

    // GSI2 — query audit records by organization over time.
    this.auditTable.addGlobalSecondaryIndex({
      indexName: 'org-index',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

    // Deploy-time governance registration (US-019).
    this.governance = new GovernanceRegistration(this, 'Governance', {
      environment: props.environment,
    });
  }

  /**
   * Grant a Cognito trigger Lambda the permissions to manage user-pool groups
   * (US-020). Uses a pseudo-parameter ARN (`userpool/*`) rather than a reference
   * to the concrete pool, which would introduce a UserPool<->trigger circular
   * dependency in CloudFormation. Mirrors the gdna-aeos `grantTriggerGroupManagement`.
   */
  public grantTriggerGroupManagement(grantee: iam.IGrantable): void {
    const stack = cdk.Stack.of(this);
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminLinkProviderForUser',
        ],
        // Pseudo-parameter ARN — decouples from the concrete UserPool to avoid the
        // UserPool<->trigger circular dependency (US-020).
        resources: [
          `arn:${stack.partition}:cognito-idp:${stack.region}:${stack.account}:userpool/*`,
        ],
      }),
    );
  }
}
