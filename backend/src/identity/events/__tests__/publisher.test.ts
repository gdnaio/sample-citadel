import { mockClient } from 'aws-sdk-client-mock';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import * as fc from 'fast-check';
import {
  DomainEventPublisher,
  EVENT_SCHEMA_VERSION,
  IdentityEventSource,
} from '../publisher';

const ebMock = mockClient(EventBridgeClient);
const BUS = 'citadel-agents-test';

beforeEach(() => {
  ebMock.reset();
  ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
});

describe('DomainEventPublisher', () => {
  it('P6: every published event carries source, version and correlationId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<IdentityEventSource>('citadel.identity', 'citadel.team'),
        fc.string({ minLength: 1 }),
        fc.dictionary(fc.string(), fc.jsonValue()),
        async (source, detailType, detail) => {
          ebMock.reset();
          ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
          const publisher = new DomainEventPublisher(new EventBridgeClient({ region: 'us-east-1' }), BUS);

          const envelope = await publisher.publish({ source, detailType, detail: detail as Record<string, unknown> });

          expect(envelope.source).toBe(source);
          expect(envelope.version).toBe(EVENT_SCHEMA_VERSION);
          expect(envelope.correlationId.length).toBeGreaterThan(0);

          const entry = ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries?.[0];
          expect(entry?.EventBusName).toBe(BUS);
          expect(entry?.Source).toBe(source);
          const parsed = JSON.parse(entry?.Detail ?? '{}');
          expect(parsed.version).toBe(EVENT_SCHEMA_VERSION);
          expect(parsed.correlationId).toBe(envelope.correlationId);
        },
      ),
    );
  });

  it('preserves a supplied correlationId', async () => {
    const publisher = new DomainEventPublisher(new EventBridgeClient({ region: 'us-east-1' }), BUS);
    const envelope = await publisher.publish({
      source: 'citadel.identity',
      detailType: 'UserProvisioned',
      detail: { sub: 'user-1' },
      correlationId: 'corr-xyz',
    });
    expect(envelope.correlationId).toBe('corr-xyz');
  });

  it('generates a correlationId when none is supplied', async () => {
    const publisher = new DomainEventPublisher(new EventBridgeClient({ region: 'us-east-1' }), BUS, {
      idGenerator: () => 'generated-id',
    });
    const envelope = await publisher.publish({
      source: 'citadel.team',
      detailType: 'MappingChanged',
      detail: {},
    });
    expect(envelope.correlationId).toBe('generated-id');
  });
});
