import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AuditDecisionPhase, AuditOutcome, AuditRecord, OrgId } from '../types';

/** Input for recording an audit attempt (before the authorization decision). */
export interface AuditAttemptInput {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  orgId: OrgId;
  correlationId: string;
  /** Optional stable id for idempotent re-delivery (P5). Defaults to a random uuid. */
  auditId?: string;
  detail?: Record<string, unknown>;
}

/** Input for recording an audit outcome (after the authorization decision). */
export interface AuditOutcomeInput extends AuditAttemptInput {
  outcome: Extract<AuditOutcome, 'allowed' | 'denied'>;
}

export interface AuditWriterOptions {
  /** Injectable clock for deterministic timestamps (testing). */
  now?: () => Date;
  /** Injectable id generator for deterministic ids (testing). */
  idGenerator?: () => string;
}

/**
 * Append-only writer for the identity audit trail (US-018).
 *
 * - **Append-only (P1)**: every write is a conditional `PutCommand` that refuses to
 *   overwrite an existing key.
 * - **Write-before-auth (P2)**: {@link writeAttempt} records `attempted`/`before-auth`
 *   ahead of the authorization decision; {@link writeOutcome} records the result.
 * - **Idempotent (P5)**: re-delivering an identical record is a no-op, not a duplicate.
 */
export class AuditWriter {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    options: AuditWriterOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.newId = options.idGenerator ?? randomUUID;
  }

  /** Record an attempt BEFORE the authorization decision (non-repudiation). */
  async writeAttempt(input: AuditAttemptInput): Promise<AuditRecord> {
    return this.put(this.build(input, 'attempted', 'before-auth'));
  }

  /** Record the outcome AFTER the authorization decision. */
  async writeOutcome(input: AuditOutcomeInput): Promise<AuditRecord> {
    return this.put(this.build(input, input.outcome, 'after-auth'));
  }

  private build(
    input: AuditAttemptInput,
    outcome: AuditOutcome,
    decisionPhase: AuditDecisionPhase,
  ): AuditRecord {
    return {
      auditId: input.auditId ?? this.newId(),
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      orgId: input.orgId,
      outcome,
      decisionPhase,
      correlationId: input.correlationId,
      timestamp: this.now().toISOString(),
      detail: input.detail,
    };
  }

  private async put(record: AuditRecord): Promise<AuditRecord> {
    const item = {
      pk: `TARGET#${record.targetType}#${record.targetId}`,
      sk: `${record.timestamp}#${record.auditId}`,
      ...record,
    };

    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          // P1 (append-only) + P5 (idempotent): never overwrite an existing record.
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        }),
      );
    } catch (err) {
      // Idempotency (P5): a duplicate key means the record already exists — treat as success.
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        return record;
      }
      throw err;
    }

    return record;
  }
}
