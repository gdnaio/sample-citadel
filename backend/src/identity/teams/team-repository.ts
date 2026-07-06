import { randomUUID } from 'node:crypto';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  OrgId,
  Team,
  OperationalUnit,
  TeamMembership,
  TeamOperationalUnitMapping,
} from '../types';

export interface CreateTeamInput {
  orgId: OrgId;
  name: string;
  /** Actor sub. */
  createdBy: string;
}

export interface CreateOperationalUnitInput {
  orgId: OrgId;
  name: string;
  /** Identifier of the external source system (or `manual`). */
  source: string;
  /** Optional stable id — defaults to a generated uuid. */
  id?: string;
}

export interface MapTeamInput {
  orgId: OrgId;
  teamId: string;
  operationalUnitId: string;
}

export interface AddTeamMemberInput {
  orgId: OrgId;
  teamId: string;
  userSub: string;
  /** Actor sub, or `system` for auto-join. */
  joinedBy: string;
}

export interface TeamRepositoryOptions {
  /** Injectable clock for deterministic timestamps (testing). */
  now?: () => Date;
  /** Injectable id generator for deterministic ids (testing). */
  idGenerator?: () => string;
}

/** Item shape stored in the single table (domain fields + key attributes). */
type StoredItem = Record<string, unknown>;

/** Idempotent-create condition (P1/P2): never overwrite an existing key. */
const CREATE_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';

/**
 * Single-table access for Unit B — teams, operational units, team↔op-unit
 * mappings, and memberships over `citadel-teams-{env}` (C3).
 *
 * Key model (see design.md → Data Model):
 * | Entity     | pk              | sk                 | GSI1PK        | GSI1SK          |
 * |------------|-----------------|--------------------|---------------|-----------------|
 * | Team       | `ORG#{orgId}`   | `TEAM#{teamId}`    | —             | —               |
 * | OpUnit     | `ORG#{orgId}`   | `OU#{ouId}`        | —             | —               |
 * | Mapping    | `TEAM#{teamId}` | `OU#{ouId}`        | `OU#{ouId}`   | `TEAM#{teamId}` |
 * | Membership | `TEAM#{teamId}` | `MEMBER#{userSub}` | `USER#{sub}`  | `TEAM#{teamId}` |
 *
 * Reverse lookups (op-unit→teams for auto-join, user→teams) use the inverse GSI1.
 * Org-scoping (PB4): teams/op-units are physically keyed by `ORG#{orgId}`, so a
 * caller scoped to one org can never read or mutate another org's items.
 * Mapping/membership creates are idempotent (PB1/PB2) via a conditional put.
 */
export class TeamRepository {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    options: TeamRepositoryOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.newId = options.idGenerator ?? randomUUID;
  }

  // ── Team CRUD (US-012) ────────────────────────────────────────────────────

  async createTeam(input: CreateTeamInput): Promise<Team> {
    const team: Team = {
      teamId: this.newId(),
      name: input.name,
      orgId: input.orgId,
      createdAt: this.now().toISOString(),
      createdBy: input.createdBy,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: `ORG#${team.orgId}`, sk: `TEAM#${team.teamId}`, ...team },
        ConditionExpression: CREATE_CONDITION,
      }),
    );
    return team;
  }

  async getTeam(orgId: OrgId, teamId: string): Promise<Team | undefined> {
    const res = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `ORG#${orgId}`, sk: `TEAM#${teamId}` },
      }),
    );
    return res.Item ? this.toTeam(res.Item) : undefined;
  }

  async listTeams(orgId: OrgId): Promise<Team[]> {
    const items = await this.queryPartition(`ORG#${orgId}`, 'TEAM#');
    return items.map((i) => this.toTeam(i));
  }

  async renameTeam(orgId: OrgId, teamId: string, name: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: `ORG#${orgId}`, sk: `TEAM#${teamId}` },
        UpdateExpression: 'SET #name = :name',
        ExpressionAttributeNames: { '#name': 'name' },
        ExpressionAttributeValues: { ':name': name },
        ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
      }),
    );
  }

  async deleteTeam(orgId: OrgId, teamId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: `ORG#${orgId}`, sk: `TEAM#${teamId}` },
      }),
    );
  }

  // ── OperationalUnit registry (US-013) ─────────────────────────────────────

  async createOperationalUnit(input: CreateOperationalUnitInput): Promise<OperationalUnit> {
    const ou: OperationalUnit = {
      id: input.id ?? this.newId(),
      name: input.name,
      source: input.source,
      orgId: input.orgId,
      active: true,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: `ORG#${ou.orgId}`, sk: `OU#${ou.id}`, ...ou },
        ConditionExpression: CREATE_CONDITION,
      }),
    );
    return ou;
  }

  async listOperationalUnits(orgId: OrgId): Promise<OperationalUnit[]> {
    const items = await this.queryPartition(`ORG#${orgId}`, 'OU#');
    return items.map((i) => this.toOperationalUnit(i));
  }

  // ── M:N mapping (US-013) ──────────────────────────────────────────────────

  async mapTeamToOperationalUnit(input: MapTeamInput): Promise<TeamOperationalUnitMapping> {
    const mapping: TeamOperationalUnitMapping = {
      teamId: input.teamId,
      operationalUnitId: input.operationalUnitId,
      orgId: input.orgId,
    };
    await this.idempotentPut({
      pk: `TEAM#${mapping.teamId}`,
      sk: `OU#${mapping.operationalUnitId}`,
      GSI1PK: `OU#${mapping.operationalUnitId}`,
      GSI1SK: `TEAM#${mapping.teamId}`,
      ...mapping,
    });
    return mapping;
  }

  async unmapTeamFromOperationalUnit(teamId: string, operationalUnitId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: `TEAM#${teamId}`, sk: `OU#${operationalUnitId}` },
      }),
    );
  }

  /** All op-unit ids mapped to a team (forward lookup on the base table). */
  async listOperationalUnitsForTeam(teamId: string): Promise<string[]> {
    const items = await this.queryPartition(`TEAM#${teamId}`, 'OU#');
    return items.map((i) => String(i.operationalUnitId));
  }

  /** All team ids mapped to an op-unit — GSI1 reverse lookup (auto-join). */
  async listTeamsForOperationalUnit(operationalUnitId: string): Promise<string[]> {
    const items = await this.queryIndex(`OU#${operationalUnitId}`);
    return items.map((i) => String(i.teamId));
  }

  // ── Membership (US-014, US-006b) ──────────────────────────────────────────

  async addTeamMember(input: AddTeamMemberInput): Promise<TeamMembership> {
    const membership: TeamMembership = {
      teamId: input.teamId,
      userSub: input.userSub,
      orgId: input.orgId,
      joinedAt: this.now().toISOString(),
      joinedBy: input.joinedBy,
    };
    await this.idempotentPut({
      pk: `TEAM#${membership.teamId}`,
      sk: `MEMBER#${membership.userSub}`,
      GSI1PK: `USER#${membership.userSub}`,
      GSI1SK: `TEAM#${membership.teamId}`,
      ...membership,
    });
    return membership;
  }

  async removeTeamMember(teamId: string, userSub: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: `TEAM#${teamId}`, sk: `MEMBER#${userSub}` },
      }),
    );
  }

  async listTeamMembers(teamId: string): Promise<TeamMembership[]> {
    const items = await this.queryPartition(`TEAM#${teamId}`, 'MEMBER#');
    return items.map((i) => this.toMembership(i));
  }

  /** All team ids a user belongs to — GSI1 reverse lookup. */
  async listTeamsForUser(userSub: string): Promise<string[]> {
    const items = await this.queryIndex(`USER#${userSub}`);
    return items.map((i) => String(i.teamId));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Query one partition scoped to a sort-key prefix (base table). */
  private async queryPartition(pk: string, skPrefix: string): Promise<StoredItem[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
      }),
    );
    return (res.Items ?? []) as StoredItem[];
  }

  /** Query the inverse GSI1 partition. */
  private async queryIndex(gsi1pk: string): Promise<StoredItem[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': gsi1pk },
      }),
    );
    return (res.Items ?? []) as StoredItem[];
  }

  /** Conditional create; a duplicate key (idempotent PB1/PB2) is treated as success. */
  private async idempotentPut(item: StoredItem): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: CREATE_CONDITION,
        }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        return;
      }
      throw err;
    }
  }

  private toTeam(item: StoredItem): Team {
    return {
      teamId: String(item.teamId),
      name: String(item.name),
      orgId: String(item.orgId),
      createdAt: String(item.createdAt),
      createdBy: String(item.createdBy),
    };
  }

  private toOperationalUnit(item: StoredItem): OperationalUnit {
    return {
      id: String(item.id),
      name: String(item.name),
      source: String(item.source),
      orgId: String(item.orgId),
      active: Boolean(item.active),
      lastSyncedAt: item.lastSyncedAt ? String(item.lastSyncedAt) : undefined,
    };
  }

  private toMembership(item: StoredItem): TeamMembership {
    return {
      teamId: String(item.teamId),
      userSub: String(item.userSub),
      orgId: String(item.orgId),
      joinedAt: String(item.joinedAt),
      joinedBy: String(item.joinedBy),
    };
  }
}
