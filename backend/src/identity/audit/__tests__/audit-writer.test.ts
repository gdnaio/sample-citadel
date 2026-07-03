import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import * as fc from 'fast-check';
import { AuditWriter, AuditAttemptInput } from '../audit-writer';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'citadel-identity-audit-test';

function docClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
}

const baseInput: AuditAttemptInput = {
  actor: 'user-sub-1',
  action: 'USER_PROVISIONED',
  targetType: 'USER',
  targetId: 'user-sub-1',
  orgId: 'org-1',
  correlationId: 'corr-1',
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
});

describe('AuditWriter', () => {
  it('P1: every write is a conditional put that refuses to overwrite', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          actor: fc.string({ minLength: 1 }),
          action: fc.string({ minLength: 1 }),
          targetType: fc.string({ minLength: 1 }),
          targetId: fc.string({ minLength: 1 }),
          orgId: fc.string({ minLength: 1 }),
          correlationId: fc.string({ minLength: 1 }),
        }),
        async (input) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});
          const writer = new AuditWriter(docClient(), TABLE);
          await writer.writeAttempt(input);

          const calls = ddbMock.commandCalls(PutCommand);
          expect(calls).toHaveLength(1);
          const put = calls[0].args[0].input;
          expect(put.TableName).toBe(TABLE);
          expect(put.ConditionExpression).toContain('attribute_not_exists(pk)');
          expect(put.ConditionExpression).toContain('attribute_not_exists(sk)');
          expect((put.Item as { pk: string }).pk).toBe(`TARGET#${input.targetType}#${input.targetId}`);
        },
      ),
    );
  });

  it('P2: an attempt is recorded before the outcome, with attempt.ts <= outcome.ts', async () => {
    let tick = 0;
    const now = (): Date => new Date(1_700_000_000_000 + tick++ * 1000);
    const writer = new AuditWriter(docClient(), TABLE, { now });

    const attempt = await writer.writeAttempt(baseInput);
    const outcome = await writer.writeOutcome({ ...baseInput, outcome: 'allowed' });

    expect(attempt.decisionPhase).toBe('before-auth');
    expect(attempt.outcome).toBe('attempted');
    expect(outcome.decisionPhase).toBe('after-auth');
    expect(outcome.outcome).toBe('allowed');
    expect(attempt.timestamp <= outcome.timestamp).toBe(true);

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(2);
    // The attempt (before-auth) must be the first write.
    expect((puts[0].args[0].input.Item as { decisionPhase: string }).decisionPhase).toBe('before-auth');
  });

  it('P5: re-delivering an identical record is idempotent (no throw, no duplicate error)', async () => {
    const fixed = (): Date => new Date('2026-01-01T00:00:00.000Z');
    const writer = new AuditWriter(docClient(), TABLE, { now: fixed, idGenerator: () => 'stable-id' });

    // First write succeeds; a second identical key hits the condition and rejects.
    const conditional = new Error('The conditional request failed');
    conditional.name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejectsOnce(conditional).resolves({});

    await expect(writer.writeAttempt(baseInput)).resolves.toMatchObject({ auditId: 'stable-id' });
  });

  it('rethrows non-conditional errors', async () => {
    const boom = new Error('throttled');
    boom.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(PutCommand).rejects(boom);
    const writer = new AuditWriter(docClient(), TABLE);
    await expect(writer.writeAttempt(baseInput)).rejects.toThrow('throttled');
  });
});
