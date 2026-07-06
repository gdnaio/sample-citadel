import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import * as fc from 'fast-check';
import { TeamRepository } from '../team-repository';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'citadel-teams-test';

function docClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
}

/** Deterministic options for stable ids/timestamps in assertions. */
function repo(seq: string[] = ['id-1', 'id-2', 'id-3']): TeamRepository {
  const ids = [...seq];
  return new TeamRepository(docClient(), TABLE, {
    now: () => new Date('2026-07-03T00:00:00.000Z'),
    idGenerator: () => ids.shift() ?? 'id-x',
  });
}

/** Helper: make a ConditionalCheckFailedException. */
function conditionalFail(): Error {
  const e = new Error('conditional');
  e.name = 'ConditionalCheckFailedException';
  return e;
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(GetCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(DeleteCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
});

describe('TeamRepository — Team CRUD (US-012)', () => {
  it('createTeam writes an ORG#/TEAM# item and returns the Team', async () => {
    const r = repo(['team-1']);
    const team = await r.createTeam({ orgId: 'org-1', name: 'Payments-Admins', createdBy: 'admin-1' });

    expect(team.teamId).toBe('team-1');
    expect(team.orgId).toBe('org-1');
    expect(team.name).toBe('Payments-Admins');
    expect(team.createdBy).toBe('admin-1');
    expect(team.createdAt).toBe('2026-07-03T00:00:00.000Z');

    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    const item = put.Item as { pk: string; sk: string };
    expect(item.pk).toBe('ORG#org-1');
    expect(item.sk).toBe('TEAM#team-1');
  });

  it('getTeam reads by ORG#/TEAM# key', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { pk: 'ORG#org-1', sk: 'TEAM#team-1', teamId: 'team-1', orgId: 'org-1', name: 'X', createdAt: 't', createdBy: 'a' },
    });
    const r = repo();
    const team = await r.getTeam('org-1', 'team-1');
    expect(team?.teamId).toBe('team-1');

    const key = ddbMock.commandCalls(GetCommand)[0].args[0].input.Key as { pk: string; sk: string };
    expect(key.pk).toBe('ORG#org-1');
    expect(key.sk).toBe('TEAM#team-1');
  });

  it('listTeams queries ORG# partition scoped to begins_with TEAM#', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ teamId: 'team-1', orgId: 'org-1', name: 'X', createdAt: 't', createdBy: 'a' }],
    });
    const r = repo();
    const teams = await r.listTeams('org-1');
    expect(teams).toHaveLength(1);

    const q = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ExpressionAttributeValues).toMatchObject({ ':pk': 'ORG#org-1', ':sk': 'TEAM#' });
  });

  it('renameTeam updates the name attribute', async () => {
    const r = repo();
    await r.renameTeam('org-1', 'team-1', 'New-Name');
    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    const key = upd.Key as { pk: string; sk: string };
    expect(key.pk).toBe('ORG#org-1');
    expect(key.sk).toBe('TEAM#team-1');
  });

  it('deleteTeam removes the ORG#/TEAM# item', async () => {
    const r = repo();
    await r.deleteTeam('org-1', 'team-1');
    const key = ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key as { pk: string; sk: string };
    expect(key.pk).toBe('ORG#org-1');
    expect(key.sk).toBe('TEAM#team-1');
  });
});

describe('TeamRepository — OperationalUnit registry (US-013)', () => {
  it('createOperationalUnit writes an ORG#/OU# item', async () => {
    const r = repo(['ou-1']);
    const ou = await r.createOperationalUnit({ orgId: 'org-1', name: 'Payments Platform', source: 'manual' });
    expect(ou.id).toBe('ou-1');
    expect(ou.orgId).toBe('org-1');
    expect(ou.source).toBe('manual');
    expect(ou.active).toBe(true);

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as { pk: string; sk: string };
    expect(item.pk).toBe('ORG#org-1');
    expect(item.sk).toBe('OU#ou-1');
  });

  it('listOperationalUnits queries ORG# partition scoped to begins_with OU#', async () => {
    const r = repo();
    await r.listOperationalUnits('org-1');
    const q = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ExpressionAttributeValues).toMatchObject({ ':pk': 'ORG#org-1', ':sk': 'OU#' });
  });
});

describe('TeamRepository — M:N mapping (US-013)', () => {
  it('mapTeamToOperationalUnit writes an adjacency item with GSI1 inverse keys', async () => {
    const r = repo();
    const m = await r.mapTeamToOperationalUnit({ orgId: 'org-1', teamId: 'team-1', operationalUnitId: 'ou-1' });
    expect(m.teamId).toBe('team-1');
    expect(m.operationalUnitId).toBe('ou-1');

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as {
      pk: string; sk: string; GSI1PK: string; GSI1SK: string;
    };
    expect(item.pk).toBe('TEAM#team-1');
    expect(item.sk).toBe('OU#ou-1');
    expect(item.GSI1PK).toBe('OU#ou-1');
    expect(item.GSI1SK).toBe('TEAM#team-1');
  });

  it('listTeamsForOperationalUnit queries GSI1 by OU# (auto-join reverse lookup)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'TEAM#team-1', sk: 'OU#ou-1', teamId: 'team-1', operationalUnitId: 'ou-1', orgId: 'org-1' }] });
    const r = repo();
    const teamIds = await r.listTeamsForOperationalUnit('ou-1');
    expect(teamIds).toContain('team-1');

    const q = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.IndexName).toBe('GSI1');
    expect(q.ExpressionAttributeValues).toMatchObject({ ':pk': 'OU#ou-1' });
  });

  it('unmapTeamFromOperationalUnit deletes the adjacency item (no dangling ref)', async () => {
    const r = repo();
    await r.unmapTeamFromOperationalUnit('team-1', 'ou-1');
    const key = ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key as { pk: string; sk: string };
    expect(key.pk).toBe('TEAM#team-1');
    expect(key.sk).toBe('OU#ou-1');
  });

  it('PB1: mapping add is idempotent — a ConditionalCheckFailed is swallowed, no throw', async () => {
    ddbMock.on(PutCommand).rejects(conditionalFail());
    const r = repo();
    await expect(
      r.mapTeamToOperationalUnit({ orgId: 'org-1', teamId: 'team-1', operationalUnitId: 'ou-1' }),
    ).resolves.toMatchObject({ teamId: 'team-1', operationalUnitId: 'ou-1' });
  });

  it('PB1 (property): N maps then unmap leaves no dangling adjacency and never throws', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => !s.includes('#')),
        fc.string({ minLength: 1 }).filter((s) => !s.includes('#')),
        fc.integer({ min: 1, max: 5 }),
        async (teamId, ouId, n) => {
          ddbMock.reset();
          // First write succeeds, subsequent duplicate writes fail conditionally (idempotent).
          let first = true;
          ddbMock.on(PutCommand).callsFake(() => {
            if (first) { first = false; return {}; }
            throw conditionalFail();
          });
          ddbMock.on(DeleteCommand).resolves({});
          const r2 = repo();
          for (let i = 0; i < n; i++) {
            await r2.mapTeamToOperationalUnit({ orgId: 'org-1', teamId, operationalUnitId: ouId });
          }
          await r2.unmapTeamFromOperationalUnit(teamId, ouId);
          const del = ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key as { pk: string; sk: string };
          expect(del.pk).toBe(`TEAM#${teamId}`);
          expect(del.sk).toBe(`OU#${ouId}`);
        },
      ),
    );
  });
});

describe('TeamRepository — Membership (US-014, US-006b)', () => {
  it('addTeamMember writes a MEMBER# item with GSI1 user reverse keys', async () => {
    const r = repo();
    const m = await r.addTeamMember({ orgId: 'org-1', teamId: 'team-1', userSub: 'user-1', joinedBy: 'admin-1' });
    expect(m.teamId).toBe('team-1');
    expect(m.userSub).toBe('user-1');
    expect(m.joinedBy).toBe('admin-1');
    expect(m.joinedAt).toBe('2026-07-03T00:00:00.000Z');

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as {
      pk: string; sk: string; GSI1PK: string; GSI1SK: string;
    };
    expect(item.pk).toBe('TEAM#team-1');
    expect(item.sk).toBe('MEMBER#user-1');
    expect(item.GSI1PK).toBe('USER#user-1');
    expect(item.GSI1SK).toBe('TEAM#team-1');
  });

  it('listTeamMembers queries TEAM# partition scoped to begins_with MEMBER#', async () => {
    const r = repo();
    await r.listTeamMembers('team-1');
    const q = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ExpressionAttributeValues).toMatchObject({ ':pk': 'TEAM#team-1', ':sk': 'MEMBER#' });
  });

  it('listTeamsForUser queries GSI1 by USER#', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'TEAM#team-1', sk: 'MEMBER#user-1', teamId: 'team-1', userSub: 'user-1', orgId: 'org-1' }] });
    const r = repo();
    const teamIds = await r.listTeamsForUser('user-1');
    expect(teamIds).toContain('team-1');
    const q = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.IndexName).toBe('GSI1');
    expect(q.ExpressionAttributeValues).toMatchObject({ ':pk': 'USER#user-1' });
  });

  it('removeTeamMember deletes the MEMBER# item', async () => {
    const r = repo();
    await r.removeTeamMember('team-1', 'user-1');
    const key = ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key as { pk: string; sk: string };
    expect(key.pk).toBe('TEAM#team-1');
    expect(key.sk).toBe('MEMBER#user-1');
  });

  it('PB2: membership add is idempotent — duplicate add does not throw', async () => {
    ddbMock.on(PutCommand).rejects(conditionalFail());
    const r = repo();
    await expect(
      r.addTeamMember({ orgId: 'org-1', teamId: 'team-1', userSub: 'user-1', joinedBy: 'system' }),
    ).resolves.toMatchObject({ teamId: 'team-1', userSub: 'user-1' });
  });

  it('PB2 (property): N adds of the same member issue a conditional put and never duplicate', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => !s.includes('#')),
        fc.string({ minLength: 1 }).filter((s) => !s.includes('#')),
        fc.integer({ min: 1, max: 5 }),
        async (teamId, userSub, n) => {
          ddbMock.reset();
          let first = true;
          ddbMock.on(PutCommand).callsFake(() => {
            if (first) { first = false; return {}; }
            throw conditionalFail();
          });
          const r2 = repo();
          for (let i = 0; i < n; i++) {
            await r2.addTeamMember({ orgId: 'org-1', teamId, userSub, joinedBy: 'system' });
          }
          // Every add must use a conditional (attribute_not_exists) put — no unconditional overwrite.
          for (const call of ddbMock.commandCalls(PutCommand)) {
            expect(call.args[0].input.ConditionExpression).toContain('attribute_not_exists');
          }
        },
      ),
    );
  });
});

describe('TeamRepository — org-scoping (PB4)', () => {
  it('PB4 (property): team reads/writes are physically keyed by the caller orgId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => !s.includes('#')),
        fc.string({ minLength: 1 }).filter((s) => !s.includes('#')),
        async (orgA, teamId) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});
          ddbMock.on(QueryCommand).resolves({ Items: [] });
          const r2 = repo([teamId]);
          await r2.createTeam({ orgId: orgA, name: 'T', createdBy: 'a' });
          await r2.listTeams(orgA);

          const put = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as { pk: string };
          expect(put.pk).toBe(`ORG#${orgA}`);
          const q = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
          expect(q.ExpressionAttributeValues).toMatchObject({ ':pk': `ORG#${orgA}` });
        },
      ),
    );
  });
});

describe('TeamRepository — lookups & edge cases (coverage)', () => {
  it('listOperationalUnitsForTeam queries TEAM# partition scoped to begins_with OU#', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ pk: 'TEAM#team-1', sk: 'OU#ou-1', teamId: 'team-1', operationalUnitId: 'ou-1', orgId: 'org-1' }],
    });
    const r = repo();
    const ouIds = await r.listOperationalUnitsForTeam('team-1');
    expect(ouIds).toContain('ou-1');
    const q = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ExpressionAttributeValues).toMatchObject({ ':pk': 'TEAM#team-1', ':sk': 'OU#' });
  });

  it('getTeam returns undefined when the item is absent', async () => {
    ddbMock.on(GetCommand).resolves({});
    const r = repo();
    await expect(r.getTeam('org-1', 'missing')).resolves.toBeUndefined();
  });

  it('listOperationalUnits projects an active op-unit with lastSyncedAt', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ id: 'ou-1', name: 'X', source: 'connector', orgId: 'org-1', active: true, lastSyncedAt: '2026-07-03T00:00:00.000Z' }],
    });
    const r = repo();
    const [ou] = await r.listOperationalUnits('org-1');
    expect(ou.active).toBe(true);
    expect(ou.lastSyncedAt).toBe('2026-07-03T00:00:00.000Z');
  });

  it('rethrows non-conditional errors from an idempotent put (mapping)', async () => {
    const boom = new Error('throttled');
    boom.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(PutCommand).rejects(boom);
    const r = repo();
    await expect(
      r.mapTeamToOperationalUnit({ orgId: 'org-1', teamId: 'team-1', operationalUnitId: 'ou-1' }),
    ).rejects.toThrow('throttled');
  });
});

describe('TeamRepository — default options (coverage)', () => {
  it('works with injected defaults: generates a uuid teamId and an ISO createdAt', async () => {
    const r = new TeamRepository(docClient(), TABLE);
    const team = await r.createTeam({ orgId: 'org-1', name: 'Defaults', createdBy: 'admin-1' });
    expect(team.teamId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(() => new Date(team.createdAt).toISOString()).not.toThrow();

    const ou = await r.createOperationalUnit({ orgId: 'org-1', name: 'OU', source: 'manual' });
    expect(ou.id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('TeamRepository — membership projection (coverage)', () => {
  it('listTeamMembers projects returned MEMBER# items into TeamMembership', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        pk: 'TEAM#team-1', sk: 'MEMBER#user-1',
        teamId: 'team-1', userSub: 'user-1', orgId: 'org-1',
        joinedAt: '2026-07-03T00:00:00.000Z', joinedBy: 'admin-1',
      }],
    });
    const r = repo();
    const [m] = await r.listTeamMembers('team-1');
    expect(m).toEqual({
      teamId: 'team-1', userSub: 'user-1', orgId: 'org-1',
      joinedAt: '2026-07-03T00:00:00.000Z', joinedBy: 'admin-1',
    });
  });
});

describe('TeamRepository — empty query results (coverage)', () => {
  it('listTeams returns [] when the base-table query yields no Items key', async () => {
    ddbMock.on(QueryCommand).resolves({});
    const r = repo();
    await expect(r.listTeams('org-1')).resolves.toEqual([]);
  });

  it('listTeamsForUser returns [] when the GSI1 query yields no Items key', async () => {
    ddbMock.on(QueryCommand).resolves({});
    const r = repo();
    await expect(r.listTeamsForUser('user-1')).resolves.toEqual([]);
  });
});
