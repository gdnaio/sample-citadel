/**
 * Async provisioning reconciler (US-004).
 *
 * Consumes `citadel.identity.ProvisionRetry` events (emitted when first-login
 * provisioning failed) and re-runs provisioning idempotently. Errors propagate so
 * EventBridge can retry / dead-letter.
 */
import type { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { UserProvisioningService } from '../identity/provisioning/user-provisioning-service';
import { DomainEventPublisher } from '../identity/events/publisher';
import { createProvisionReconciler } from '../identity/provisioning/provision-reconciler';
import { PlatformGroup } from '../identity/types';

interface ProvisionRetryDetail {
  sub: string;
  email: string;
  givenName?: string;
  familyName?: string;
  orgId: string;
  intendedGroup?: string;
}

export const handler = async (
  event: EventBridgeEvent<'ProvisionRetry', ProvisionRetryDetail>,
): Promise<void> => {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const provisioning = new UserProvisioningService(ddb, process.env.USERS_TABLE as string, {
    eventPublisher: new DomainEventPublisher(new EventBridgeClient({}), process.env.EVENT_BUS_NAME ?? 'default'),
  });
  const reconcile = createProvisionReconciler({ provisioning });

  const detail = event.detail;
  await reconcile({
    sub: detail.sub,
    email: detail.email,
    givenName: detail.givenName,
    familyName: detail.familyName,
    orgId: detail.orgId,
    intendedGroup: detail.intendedGroup as PlatformGroup | undefined,
    correlationId: detail.sub,
  });
};
