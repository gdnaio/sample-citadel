import { UserProvisioningService } from './user-provisioning-service';
import { DEFAULT_GROUP, isPrivilegedGroup, resolveRole } from '../policy/least-privilege';
import { AuditWriter } from '../audit/audit-writer';
import { DomainEventPublisher } from '../events/publisher';
import { PlatformGroup } from '../types';

/** Abstraction over the Cognito `AdminAddUserToGroup` call. */
export interface GroupAssigner {
  addUserToGroup(input: { sub: string; group: PlatformGroup }): Promise<void>;
}

export interface PreTokenInput {
  sub: string;
  email: string;
  givenName?: string;
  familyName?: string;
  orgId: string;
  /** Groups delivered directly by the IdP assertion (read in the trigger — VA-1). */
  idpGroups: string[];
  /** Existing manually-assigned platform group, if any (manual override wins). */
  existingPlatformGroup?: string;
  correlationId: string;
}

export interface PreTokenResult {
  resolvedGroup: PlatformGroup;
  provisioned: boolean;
  degraded: boolean;
  /** Extra JWT claims to merge — never clobbers existing `custom:*` claims (PA5). */
  extraClaims: Record<string, string>;
}

export interface PreTokenDeps {
  provisioning: Pick<UserProvisioningService, 'provision'>;
  groupAssigner: GroupAssigner;
  audit: Pick<AuditWriter, 'writeOutcome'>;
  publisher?: Pick<DomainEventPublisher, 'publish'>;
}

/**
 * Orchestrates first-login provisioning + role mapping for the pre-token trigger (C3).
 *
 * Kept free of Cognito-event plumbing so it is unit/property-testable; the Lambda
 * handler adapts the Cognito event into {@link PreTokenInput} and merges the returned
 * `extraClaims`.
 *
 * Guarantees:
 *  - PA1: never auto-assigns a privileged group (e.g. `admin`) from IdP mapping.
 *  - PA4: maps identity attributes into the provisioned record.
 *  - PA5: returns a `givenRole` claim and nothing that overwrites existing claims.
 *  - PA6: never throws — on failure it degrades to least privilege and emits a retry.
 */
export function createPreTokenOrchestrator(deps: PreTokenDeps) {
  return async function orchestrate(input: PreTokenInput): Promise<PreTokenResult> {
    // Manual assignment wins (US-007); otherwise resolve from IdP groups (never admin — PA1).
    let resolvedGroup: PlatformGroup = input.existingPlatformGroup
      ? (input.existingPlatformGroup as PlatformGroup)
      : resolveRole(input.idpGroups);
    const intendedGroup: PlatformGroup = resolvedGroup;

    let provisioned = false;
    let degraded = false;

    try {
      const result = await deps.provisioning.provision({
        sub: input.sub,
        email: input.email,
        givenName: input.givenName,
        familyName: input.familyName,
        orgId: input.orgId,
        platformGroup: resolvedGroup,
      });
      provisioned = result.created;

      // Only assign a Cognito group when it was derived from mapping and is not
      // privileged. Manual/privileged assignment is admin-only (PA1 / US-008).
      if (!input.existingPlatformGroup && !isPrivilegedGroup(resolvedGroup)) {
        await deps.groupAssigner.addUserToGroup({ sub: input.sub, group: resolvedGroup });
      }
    } catch (err) {
      // PA6: login must never be blocked. Degrade to least privilege and queue a retry.
      degraded = true;
      resolvedGroup = DEFAULT_GROUP;
      if (deps.publisher) {
        await deps.publisher
          .publish({
            source: 'citadel.identity',
            detailType: 'ProvisionRetry',
            detail: {
              sub: input.sub,
              email: input.email,
              givenName: input.givenName,
              familyName: input.familyName,
              orgId: input.orgId,
              intendedGroup,
              reason: err instanceof Error ? err.message : String(err),
            },
            correlationId: input.correlationId,
          })
          .catch(() => undefined);
      }
    }

    // Best-effort audit — must not throw or block login.
    await deps.audit
      .writeOutcome({
        actor: input.sub,
        action: 'USER_PROVISIONED',
        targetType: 'USER',
        targetId: input.sub,
        orgId: input.orgId,
        correlationId: input.correlationId,
        outcome: 'allowed',
        detail: { degraded, provisioned, resolvedGroup },
      })
      .catch(() => undefined);

    return {
      resolvedGroup,
      provisioned,
      degraded,
      extraClaims: { givenRole: resolvedGroup },
    };
  };
}
