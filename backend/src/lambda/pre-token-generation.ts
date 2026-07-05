/**
 * Cognito pre-token-generation trigger.
 *
 * Base behaviour (Phase 1 org-scoping foundation, unchanged):
 *   Promotes `custom:organization` and `custom:role` attributes into JWT claims, and
 *   overlays `custom:role: 'admin'` for admin-group members lacking an explicit role.
 *
 * SSO extension (cognito-sso-team-management, feature-flagged by `USERS_TABLE`):
 *   On login it also runs first-login provisioning + IdP-group->role mapping via the
 *   identity shared kernel, adding a `givenRole` claim. This path is ADDITIVE and never
 *   blocks token issuance (PA6). When `USERS_TABLE` is unset the handler behaves exactly
 *   as the original trigger.
 */
import type { PreTokenGenerationTriggerEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import {
  AdminAddUserToGroupCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { AuditWriter } from '../identity/audit/audit-writer';
import { DomainEventPublisher } from '../identity/events/publisher';
import { UserProvisioningService } from '../identity/provisioning/user-provisioning-service';
import {
  createPreTokenOrchestrator,
  GroupAssigner,
  PreTokenInput,
  PreTokenResult,
} from '../identity/provisioning/pre-token-orchestrator';

/** Map the Cognito trigger event to orchestrator input (pure, testable). */
export function buildPreTokenInput(event: PreTokenGenerationTriggerEvent): PreTokenInput {
  const attrs = event.request.userAttributes || {};
  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  // IdP groups delivered by the assertion via attribute mapping (VA-1) — read here,
  // never persisted to a user-writable attribute.
  const raw = attrs['custom:idp_groups'] ?? '';
  const idpGroups = raw
    ? raw.split(',').map((g) => g.trim()).filter(Boolean)
    : [];

  return {
    sub: attrs.sub ?? event.userName,
    email: attrs.email ?? '',
    givenName: attrs.given_name,
    familyName: attrs.family_name,
    orgId: attrs['custom:organization'] ?? 'unknown',
    idpGroups,
    // Manual assignment wins (US-007): explicit custom:role, or admin group membership.
    existingPlatformGroup: attrs['custom:role'] ?? (groups.includes('admin') ? 'admin' : undefined),
    correlationId: event.userName,
  };
}

function provisioningEnabled(): boolean {
  return Boolean(process.env.USERS_TABLE);
}

/** Build the real orchestrator from env + AWS clients (only invoked when enabled). */
function defaultOrchestrate(
  event: PreTokenGenerationTriggerEvent,
  input: PreTokenInput,
): Promise<PreTokenResult> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const eventBus = process.env.EVENT_BUS_NAME ?? 'default';
  const publisher = new DomainEventPublisher(new EventBridgeClient({}), eventBus);
  const provisioning = new UserProvisioningService(ddb, process.env.USERS_TABLE as string, {
    eventPublisher: publisher,
  });
  const cognito = new CognitoIdentityProviderClient({});
  const groupAssigner: GroupAssigner = {
    addUserToGroup: async ({ sub, group }) => {
      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: event.userPoolId,
          Username: sub,
          GroupName: group,
        }),
      );
    },
  };
  const audit = new AuditWriter(ddb, process.env.AUDIT_TABLE ?? (process.env.USERS_TABLE as string));

  return createPreTokenOrchestrator({ provisioning, groupAssigner, audit, publisher })(input);
}

export interface HandlerOverrides {
  /** Force-enable/disable the provisioning path (defaults to the `USERS_TABLE` flag). */
  enabled?: boolean;
  /** Inject the orchestrator (testing). */
  orchestrate?: (input: PreTokenInput) => Promise<PreTokenResult>;
}

export function createHandler(overrides: HandlerOverrides = {}) {
  return async (
    event: PreTokenGenerationTriggerEvent,
  ): Promise<PreTokenGenerationTriggerEvent> => {
    const userAttributes = event.request.userAttributes || {};
    const claimsToAddOrOverride: Record<string, string> = {};

    // --- Base behaviour (unchanged) ---
    const org = userAttributes['custom:organization'];
    if (org) claimsToAddOrOverride['custom:organization'] = org;

    let role = userAttributes['custom:role'];
    if (!role) {
      const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
      if (groups.includes('admin')) {
        role = 'admin';
      }
    }
    if (role) claimsToAddOrOverride['custom:role'] = role;

    // --- SSO extension (feature-flagged, additive, never blocks login) ---
    const enabled = overrides.enabled ?? provisioningEnabled();
    if (enabled) {
      try {
        const input = buildPreTokenInput(event);
        const result = overrides.orchestrate
          ? await overrides.orchestrate(input)
          : await defaultOrchestrate(event, input);
        claimsToAddOrOverride.givenRole = result.resolvedGroup;
      } catch {
        // PA6: token issuance must never be blocked by provisioning failures.
      }
    }

    event.response = event.response || {};
    event.response.claimsOverrideDetails = {
      ...(event.response.claimsOverrideDetails || {}),
      claimsToAddOrOverride,
    };

    return event;
  };
}

export const handler = createHandler();
