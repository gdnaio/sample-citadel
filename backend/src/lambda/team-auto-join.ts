import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { TeamRepository } from '../identity/teams/team-repository';
import { DomainEventPublisher } from '../identity/events/publisher';

/**
 * team-auto-join (C5) — event-driven team membership on
 * `citadel.identity.UserProvisioned` (US-006b).
 *
 * Resolves a newly-provisioned user's operational units to teams (via the
 * inverse GSI1 reverse lookup) and writes idempotent memberships with
 * `joinedBy='system'`, then emits a single `citadel.team.MembershipChanged`.
 *
 * Cross-unit contract (A → B): the handler needs the user's `operationalUnits`
 * in the event payload. Until Unit A emits them, `operationalUnits` is absent
 * and this handler is a graceful no-op (memberships stay admin-assignable).
 * Idempotency (PB5): re-processing the same event never creates a duplicate
 * membership — the repository's conditional put is the idempotency point.
 */

/** Dependencies — mockable in tests (mirrors provision-reconciler's DI style). */
export interface TeamAutoJoinDeps {
  repo: Pick<TeamRepository, 'listTeamsForOperationalUnit' | 'addTeamMember'>;
  /** Optional — a `MembershipChanged` event is emitted when ≥1 team is joined. */
  publisher?: Pick<DomainEventPublisher, 'publish'>;
}

export interface AutoJoinResult {
  /** True when the handler no-op'd (no operationalUnits on the event). */
  skipped: boolean;
  /** Number of distinct teams the user was joined to. */
  joined: number;
  /** The distinct team ids resolved from the user's operational units. */
  teams: string[];
}

/** Business payload carried inside the UserProvisioned event. */
interface UserProvisionedPayload {
  sub: string;
  orgId: string;
  operationalUnits?: string[];
}

/**
 * Extracts the inner business payload from the EventBridge envelope. The
 * DomainEventPublisher nests the payload under `detail.detail`; tolerate a
 * flattened shape (`detail`) and a raw payload as fallbacks.
 */
function extractPayload(event: any): UserProvisionedPayload {
  const detail = event?.detail;
  // Wrapped envelope: DomainEventPublisher nests the payload under detail.detail.
  if (detail && typeof detail === 'object' && 'detail' in detail) {
    return detail.detail as UserProvisionedPayload;
  }
  // Flattened envelope: the payload is directly under detail.
  if (detail) {
    return detail as UserProvisionedPayload;
  }
  // Raw payload: no envelope at all.
  return (event ?? {}) as UserProvisionedPayload;
}

export function createTeamAutoJoin(deps: TeamAutoJoinDeps) {
  return async function autoJoin(event: unknown): Promise<AutoJoinResult> {
    const { sub, orgId, operationalUnits } = extractPayload(event);

    // Graceful no-op until Unit A carries operationalUnits on the event.
    if (!Array.isArray(operationalUnits) || operationalUnits.length === 0) {
      return { skipped: true, joined: 0, teams: [] };
    }

    // Resolve op-units → teams via the inverse GSI1, de-duped.
    const teamIds = new Set<string>();
    for (const ouId of operationalUnits) {
      const teams = await deps.repo.listTeamsForOperationalUnit(ouId);
      for (const t of teams) teamIds.add(t);
    }

    // Idempotent membership write per resolved team (system-initiated join).
    const teams = [...teamIds];
    for (const teamId of teams) {
      await deps.repo.addTeamMember({ orgId, teamId, userSub: sub, joinedBy: 'system' });
    }

    // Emit a single MembershipChanged only when something changed.
    if (teams.length > 0 && deps.publisher) {
      await deps.publisher.publish({
        source: 'citadel.team',
        detailType: 'MembershipChanged',
        detail: { sub, orgId, teams },
      });
    }

    return { skipped: false, joined: teams.length, teams };
  };
}

// ── Lambda entrypoint — wires real deps from the environment ────────────────
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const realRepo = new TeamRepository(docClient, process.env.TEAMS_TABLE!);
const realPublisher = new DomainEventPublisher(new EventBridgeClient({}), process.env.EVENT_BUS_NAME!);

export const handler = createTeamAutoJoin({ repo: realRepo, publisher: realPublisher });
