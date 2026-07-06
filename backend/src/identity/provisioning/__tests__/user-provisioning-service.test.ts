import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import * as fc from 'fast-check';
import { UserProvisioningService, ProvisionUserInput } from '../user-provisioning-service';
import { DomainEventPublisher, PublishedEnvelope } from '../../events/publisher';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'citadel-users-test';

function docClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
}

/** Minimal spy publisher capturing published events. */
function spyPublisher(): { publisher: DomainEventPublisher; events: PublishedEnvelope[] } {
  const events: PublishedEnvelope[] = [];
  const publisher = {
    publish: async (input: { source: string; detailType: string; detail: Record<string, unknown> }) => {
      const env = { ...input, version: '1', correlationId: 'c', occurredAt: 'now' } as unknown as PublishedEnvelope;
      events.push(env);
      return env;
    },
  } as unknown as DomainEventPublisher;
  return { publisher, events };
}

const baseInput: ProvisionUserInput = {
  sub: 'user-sub-1',
  email: 'a@b.com',
  orgId: 'org-1',
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
});

describe('UserProvisioningService', () => {
  it('creates a user with the least-privilege default group and active status', async () => {
    const { publisher, events } = spyPublisher();
    const svc = new UserProvisioningService(docClient(), TABLE, { eventPublisher: publisher });

    const result = await svc.provision(baseInput);

    expect(result.created).toBe(true);
    expect(result.user.platformGroup).toBe('developer');
    expect(result.user.status).toBe('active');
    expect(result.user.source).toBe('federated');
    expect(events).toHaveLength(1);
    expect(events[0].detailType).toBe('UserProvisioned');

    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(put.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect((put.Item as { pk: string }).pk).toBe('USER#user-sub-1');
  });

  it('PA2: is idempotent — a duplicate provision does not create or re-emit', async () => {
    const conditional = new Error('exists');
    conditional.name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejects(conditional);

    const { publisher, events } = spyPublisher();
    const svc = new UserProvisioningService(docClient(), TABLE, { eventPublisher: publisher });

    const result = await svc.provision(baseInput);

    expect(result.created).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('PA2 (property): provisioning always defaults to a non-privileged group and never throws for valid input', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          sub: fc.string({ minLength: 1 }),
          email: fc.emailAddress(),
          orgId: fc.string({ minLength: 1 }),
        }),
        async (input) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});
          const svc = new UserProvisioningService(docClient(), TABLE);
          const result = await svc.provision(input);
          expect(result.user.platformGroup).toBe('developer');
          expect(result.created).toBe(true);
        },
      ),
    );
  });

  it('rethrows non-conditional errors', async () => {
    const boom = new Error('throttled');
    boom.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(PutCommand).rejects(boom);
    const svc = new UserProvisioningService(docClient(), TABLE);
    await expect(svc.provision(baseInput)).rejects.toThrow('throttled');
  });
});
