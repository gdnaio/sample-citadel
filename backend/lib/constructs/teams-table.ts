import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface TeamsTableProps {
  readonly environment: string;
}

/**
 * Single-table store for Unit B — teams, operational units, team↔op-unit mappings
 * and team memberships (US-012/013/014/006b).
 *
 * Table `citadel-teams-{env}` — on-demand, KMS at rest, PITR, RETAINed with deletion
 * protection (identity-adjacent state that should survive stack teardown).
 *
 * Item types share one table via `pk`/`sk` (see design.md → Data Model):
 * | Entity     | pk              | sk                 | GSI1PK        | GSI1SK        |
 * |------------|-----------------|--------------------|---------------|---------------|
 * | Team       | `ORG#{orgId}`   | `TEAM#{teamId}`    | —             | —             |
 * | OpUnit     | `ORG#{orgId}`   | `OU#{ouId}`        | —             | —             |
 * | Mapping    | `TEAM#{teamId}` | `OU#{ouId}`        | `OU#{ouId}`   | `TEAM#{teamId}` |
 * | Membership | `TEAM#{teamId}` | `MEMBER#{userSub}` | `USER#{sub}`  | `TEAM#{teamId}` |
 *
 * The inverse `GSI1` serves both reverse lookups — an op-unit's teams (auto-join)
 * and a user's teams — from a single index.
 */
export class TeamsTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: TeamsTableProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `citadel-teams-${props.environment}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    // Inverse index: reverse lookups for op-unit→teams (auto-join) and user→teams.
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });
  }
}
