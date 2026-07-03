import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

/** Domain event sources for this feature (extends the platform `citadel.*` convention). */
export type IdentityEventSource = 'citadel.identity' | 'citadel.team';

/** Schema version stamped on every published event envelope. */
export const EVENT_SCHEMA_VERSION = '1';

export interface DomainEventInput {
  source: IdentityEventSource;
  detailType: string;
  detail: Record<string, unknown>;
  /** Correlation id for trace linkage; generated if omitted. */
  correlationId?: string;
}

export interface PublishedEnvelope {
  source: IdentityEventSource;
  detailType: string;
  version: string;
  correlationId: string;
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface DomainEventPublisherOptions {
  now?: () => Date;
  idGenerator?: () => string;
}

/**
 * Publishes domain events to the shared `citadel.*` EventBridge bus (US-018).
 *
 * Every event carries a consistent envelope — `source`, `version`, and
 * `correlationId` (P6) — so downstream consumers (Units A/B/C, the arbiter) can
 * route and correlate reliably.
 */
export class DomainEventPublisher {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly client: EventBridgeClient,
    private readonly eventBusName: string,
    options: DomainEventPublisherOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.newId = options.idGenerator ?? randomUUID;
  }

  async publish(input: DomainEventInput): Promise<PublishedEnvelope> {
    const envelope: PublishedEnvelope = {
      source: input.source,
      detailType: input.detailType,
      version: EVENT_SCHEMA_VERSION,
      correlationId: input.correlationId ?? this.newId(),
      occurredAt: this.now().toISOString(),
      detail: input.detail,
    };

    await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.eventBusName,
            Source: envelope.source,
            DetailType: envelope.detailType,
            Detail: JSON.stringify({
              version: envelope.version,
              correlationId: envelope.correlationId,
              occurredAt: envelope.occurredAt,
              detail: envelope.detail,
            }),
          },
        ],
      }),
    );

    return envelope;
  }
}
