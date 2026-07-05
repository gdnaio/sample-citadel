import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface UsersTableProps {
  readonly environment: string;
}

/**
 * Provisioned Citadel user records (US-004), keyed by Cognito `sub`.
 *
 * Table `citadel-users-{env}` — on-demand, KMS at rest, PITR. RETAINed with deletion
 * protection because it carries identity/linked-provider state that should survive
 * stack teardown.
 */
export class UsersTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: UsersTableProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `citadel-user-profiles-${props.environment}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    // Query users by organization, most-recent login first.
    this.table.addGlobalSecondaryIndex({
      indexName: 'org-index',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lastLoginAt', type: dynamodb.AttributeType.STRING },
    });

    // Look up a user by email (account linking).
    this.table.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
    });
  }
}
