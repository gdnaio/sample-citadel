import { UserProvisioningService } from './user-provisioning-service';
import { PlatformGroup } from '../types';

export interface ReconcileInput {
  sub: string;
  email: string;
  givenName?: string;
  familyName?: string;
  orgId: string;
  intendedGroup?: PlatformGroup;
  correlationId: string;
}

export interface ReconcilerDeps {
  provisioning: Pick<UserProvisioningService, 'provision'>;
}

export interface ReconcileResult {
  recovered: boolean;
}

/**
 * Async reconciler for failed first-login provisioning (US-004).
 *
 * Consumes `ProvisionRetry` events and re-runs provisioning. Because provisioning is
 * idempotent, retries are safe; a thrown error propagates so the event source can
 * retry or dead-letter.
 */
export function createProvisionReconciler(deps: ReconcilerDeps) {
  return async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const result = await deps.provisioning.provision({
      sub: input.sub,
      email: input.email,
      givenName: input.givenName,
      familyName: input.familyName,
      orgId: input.orgId,
      platformGroup: input.intendedGroup,
    });
    return { recovered: result.created };
  };
}
