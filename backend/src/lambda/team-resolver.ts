import { randomUUID } from 'node:crypto';
import { AppSyncResolverEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { TeamRepository } from '../identity/teams/team-repository';
import { AuditWriter } from '../identity/audit/audit-writer';
import { isAdminFromEvent, extractOrgFromEvent } from '../utils/auth-event';

/**
 * team-resolver (C4) — admin-gated GraphQL resolvers for teams, operational
 * units, mappings, and memberships (US-012/013/014/015).
 *
 * Authorization model (design.md → Authorization):
 *  - Queries are org-scoped: a caller may only read within their own orgId
 *    (derived from the token via extractOrgFromEvent). A query carrying a
 *    disagreeing `orgId` argument is rejected (PB4).
 *  - Every mutation is admin-only AND audited **before** the authorization
 *    decision (audit-before-auth / non-repudiation, via the Foundation
 *    AuditWriter): writeAttempt() runs ahead of the isAdminFromEvent check,
 *    writeOutcome() records allowed|denied afterwards (PB3). A denied mutation
 *    throws and performs no repository/Cognito write. `elevateRole` to a
 *    privileged group is admin-only + audited (consistent with US-008).
 *
 * Least-privilege: the resolver never grants Cognito platform groups implicitly
 * — team membership is an org/team association only.
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new TeamRepository(docClient, process.env.TEAMS_TABLE!);
const auditWriter = new AuditWriter(docClient, process.env.IDENTITY_AUDIT_TABLE!);
const cognito = new CognitoIdentityProviderClient({});

class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

interface AuditContext {
  actor: string;
  orgId: string;
  correlationId: string;
}

function actorOf(event: AppSyncResolverEvent<unknown>): string {
  const identity = (event.identity ?? {}) as { sub?: string; username?: string };
  return identity.sub ?? identity.username ?? 'anonymous';
}

function correlationOf(event: AppSyncResolverEvent<unknown>): string {
  const headers = (event.request?.headers ?? {}) as Record<string, string | undefined>;
  return headers['x-amzn-trace-id'] ?? headers['x-correlation-id'] ?? randomUUID();
}

/** Reject any query/mutation whose explicit `orgId` argument crosses orgs (PB4). */
function assertSameOrg(argOrgId: unknown, callerOrg: string): void {
  if (typeof argOrgId === 'string' && argOrgId !== callerOrg) {
    throw new UnauthorizedError('Forbidden: cross-organization access denied');
  }
}

/**
 * Run an admin-only mutation with audit-before-auth. Records the attempt BEFORE
 * the authorization decision, denies (and audits) non-admin or cross-org
 * callers, then performs the effect and audits the allowed outcome.
 */
async function guardedMutation<T>(
  event: AppSyncResolverEvent<unknown>,
  ctx: AuditContext,
  spec: { action: string; targetType: string; targetId: string; argOrgId?: unknown; detail?: Record<string, unknown> },
  perform: () => Promise<T>,
): Promise<T> {
  const base = {
    actor: ctx.actor,
    action: spec.action,
    targetType: spec.targetType,
    targetId: spec.targetId,
    orgId: ctx.orgId,
    correlationId: ctx.correlationId,
    detail: spec.detail,
  };

  // Audit-before-auth: durably record the attempt ahead of the decision.
  await auditWriter.writeAttempt(base);

  const authorized =
    isAdminFromEvent(event) &&
    (spec.argOrgId === undefined || spec.argOrgId === ctx.orgId);

  if (!authorized) {
    await auditWriter.writeOutcome({ ...base, outcome: 'denied' });
    throw new UnauthorizedError('Unauthorized: admin role required');
  }

  const result = await perform();
  await auditWriter.writeOutcome({ ...base, outcome: 'allowed' });
  return result;
}

export async function handler(event: AppSyncResolverEvent<Record<string, unknown>>): Promise<unknown> {
  const field = event.info.fieldName;
  const args = event.arguments ?? {};
  const callerOrg = await extractOrgFromEvent(event);
  if (!callerOrg) {
    throw new UnauthorizedError('Forbidden: no organization scope on caller');
  }
  const ctx: AuditContext = { actor: actorOf(event), orgId: callerOrg, correlationId: correlationOf(event) };

  switch (field) {
    // ── Queries (org-scoped, any authenticated caller) ─────────────────────
    case 'listTeams':
      assertSameOrg(args.orgId, callerOrg);
      return repo.listTeams(callerOrg);
    case 'getTeam':
      return repo.getTeam(callerOrg, args.teamId as string);
    case 'listOperationalUnits':
      assertSameOrg(args.orgId, callerOrg);
      return repo.listOperationalUnits(callerOrg);
    case 'listTeamMembers':
      return repo.listTeamMembers(args.teamId as string);
    case 'listTeamsForOperationalUnit': {
      const teamIds = await repo.listTeamsForOperationalUnit(args.ouId as string);
      const teams = await Promise.all(teamIds.map((id) => repo.getTeam(callerOrg, id)));
      return teams.filter((t) => t !== undefined);
    }

    // ── Admin-only mutations (audit-before-auth) ───────────────────────────
    case 'createTeam':
      return guardedMutation(
        event,
        ctx,
        { action: 'CREATE_TEAM', targetType: 'TEAM', targetId: String(args.name), argOrgId: args.orgId },
        () => repo.createTeam({ orgId: callerOrg, name: args.name as string, createdBy: ctx.actor }),
      );
    case 'renameTeam':
      return guardedMutation(
        event,
        ctx,
        { action: 'RENAME_TEAM', targetType: 'TEAM', targetId: String(args.teamId) },
        async () => {
          await repo.renameTeam(callerOrg, args.teamId as string, args.name as string);
          return repo.getTeam(callerOrg, args.teamId as string);
        },
      );
    case 'deleteTeam':
      return guardedMutation(
        event,
        ctx,
        { action: 'DELETE_TEAM', targetType: 'TEAM', targetId: String(args.teamId) },
        async () => {
          await repo.deleteTeam(callerOrg, args.teamId as string);
          return { success: true, message: 'Team deleted' };
        },
      );
    case 'createOperationalUnit':
      return guardedMutation(
        event,
        ctx,
        { action: 'CREATE_OPERATIONAL_UNIT', targetType: 'OPERATIONAL_UNIT', targetId: String(args.name), argOrgId: args.orgId },
        () => repo.createOperationalUnit({ orgId: callerOrg, name: args.name as string, source: args.source as string }),
      );
    case 'mapTeamToOperationalUnit':
      return guardedMutation(
        event,
        ctx,
        { action: 'MAP_TEAM_OU', targetType: 'TEAM', targetId: String(args.teamId), detail: { ouId: args.ouId } },
        () => repo.mapTeamToOperationalUnit({ orgId: callerOrg, teamId: args.teamId as string, operationalUnitId: args.ouId as string }),
      );
    case 'unmapTeamFromOperationalUnit':
      return guardedMutation(
        event,
        ctx,
        { action: 'UNMAP_TEAM_OU', targetType: 'TEAM', targetId: String(args.teamId), detail: { ouId: args.ouId } },
        async () => {
          await repo.unmapTeamFromOperationalUnit(args.teamId as string, args.ouId as string);
          return { success: true, message: 'Mapping removed' };
        },
      );
    case 'addTeamMember':
      return guardedMutation(
        event,
        ctx,
        { action: 'ADD_TEAM_MEMBER', targetType: 'TEAM', targetId: String(args.teamId), detail: { userSub: args.userSub } },
        () => repo.addTeamMember({ orgId: callerOrg, teamId: args.teamId as string, userSub: args.userSub as string, joinedBy: ctx.actor }),
      );
    case 'removeTeamMember':
      return guardedMutation(
        event,
        ctx,
        { action: 'REMOVE_TEAM_MEMBER', targetType: 'TEAM', targetId: String(args.teamId), detail: { userSub: args.userSub } },
        async () => {
          await repo.removeTeamMember(args.teamId as string, args.userSub as string);
          return { success: true, message: 'Member removed' };
        },
      );
    case 'elevateRole':
      return guardedMutation(
        event,
        ctx,
        { action: 'ELEVATE_ROLE', targetType: 'USER', targetId: String(args.userSub), detail: { group: args.group } },
        async () => {
          await cognito.send(
            new AdminAddUserToGroupCommand({
              UserPoolId: process.env.USER_POOL_ID,
              Username: args.userSub as string,
              GroupName: args.group as string,
            }),
          );
          return { success: true, message: `User added to group ${args.group}` };
        },
      );

    default:
      throw new Error(`Unknown field: ${field}`);
  }
}
