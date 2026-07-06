/**
 * Tests for team-auto-join (C5) — event-driven team membership on
 * `citadel.identity.UserProvisioned` (US-006b).
 *
 * TDD (red). Uses the injected-deps factory pattern (mirrors
 * provision-reconciler): `createTeamAutoJoin(deps)` returns an `autoJoin(event)`
 * consumer. Deps (TeamRepository, DomainEventPublisher) are plain mocks — no
 * module mocking needed. fast-check drives PB5 (re-processing UserProvisioned
 * yields no duplicate memberships).
 *
 * Contract (defines task 5.2):
 *  - Reads the EventBridge envelope's inner business payload (`event.detail.detail`).
 *  - When `operationalUnits` is absent/empty → graceful no-op (skipped:true), no writes.
 *  - Otherwise resolves each op-unit → team ids (GSI1 via listTeamsForOperationalUnit),
 *    de-dupes, and writes an idempotent membership per team with joinedBy='system'.
 *  - Emits a single `citadel.team.MembershipChanged` event when ≥1 team joined.
 */
import * as fc from 'fast-check';
import { createTeamAutoJoin } from '../team-auto-join';

interface RepoMock {
  listTeamsForOperationalUnit: jest.Mock;
  addTeamMember: jest.Mock;
}

function makeRepo(map: Record<string, string[]> = {}): RepoMock {
  return {
    listTeamsForOperationalUnit: jest.fn(async (ouId: string) => map[ouId] ?? []),
    addTeamMember: jest.fn(async (input: Record<string, unknown>) => ({ ...input, joinedAt: 't' })),
  };
}

function makePublisher(): { publish: jest.Mock } {
  return { publish: jest.fn(async () => ({})) };
}

/** Build the wrapped EventBridge event the DomainEventPublisher produces. */
function provisionedEvent(payload: Record<string, unknown>): any {
  return {
    source: 'citadel.identity',
    'detail-type': 'UserProvisioned',
    detail: {
      version: '1',
      correlationId: 'corr-1',
      occurredAt: '2026-07-03T00:00:00.000Z',
      detail: payload,
    },
  };
}

describe('team-auto-join — graceful no-op (stubbed A contract)', () => {
  it('no-ops when operationalUnits is absent', async () => {
    const repo = makeRepo();
    const publisher = makePublisher();
    const autoJoin = createTeamAutoJoin({ repo: repo as any, publisher: publisher as any });

    const res = await autoJoin(provisionedEvent({ sub: 'u1', orgId: 'org-1' }));

    expect(res.skipped).toBe(true);
    expect(repo.addTeamMember).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('no-ops when operationalUnits is an empty array', async () => {
    const repo = makeRepo();
    const autoJoin = createTeamAutoJoin({ repo: repo as any });
    const res = await autoJoin(provisionedEvent({ sub: 'u1', orgId: 'org-1', operationalUnits: [] }));
    expect(res.skipped).toBe(true);
    expect(repo.addTeamMember).not.toHaveBeenCalled();
  });
});

describe('team-auto-join — resolve op-units → teams and join', () => {
  it('writes an idempotent membership (joinedBy=system) per resolved team', async () => {
    const repo = makeRepo({ ou1: ['t1', 't2'] });
    const publisher = makePublisher();
    const autoJoin = createTeamAutoJoin({ repo: repo as any, publisher: publisher as any });

    const res = await autoJoin(provisionedEvent({ sub: 'u1', orgId: 'org-1', operationalUnits: ['ou1'] }));

    expect(repo.listTeamsForOperationalUnit).toHaveBeenCalledWith('ou1');
    expect(repo.addTeamMember).toHaveBeenCalledTimes(2);
    expect(repo.addTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', teamId: 't1', userSub: 'u1', joinedBy: 'system' }),
    );
    expect(repo.addTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', teamId: 't2', userSub: 'u1', joinedBy: 'system' }),
    );
    expect(res.joined).toBe(2);
    expect(res.teams.sort()).toEqual(['t1', 't2']);
  });

  it('de-dupes teams shared across multiple operational units', async () => {
    const repo = makeRepo({ ou1: ['t1'], ou2: ['t1', 't2'] });
    const autoJoin = createTeamAutoJoin({ repo: repo as any });
    const res = await autoJoin(provisionedEvent({ sub: 'u1', orgId: 'org-1', operationalUnits: ['ou1', 'ou2'] }));

    expect(repo.addTeamMember).toHaveBeenCalledTimes(2); // t1 once, t2 once
    expect(res.teams.sort()).toEqual(['t1', 't2']);
  });

  it('emits a single citadel.team.MembershipChanged when ≥1 team joined', async () => {
    const repo = makeRepo({ ou1: ['t1'] });
    const publisher = makePublisher();
    const autoJoin = createTeamAutoJoin({ repo: repo as any, publisher: publisher as any });

    await autoJoin(provisionedEvent({ sub: 'u1', orgId: 'org-1', operationalUnits: ['ou1'] }));

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'citadel.team',
        detailType: 'MembershipChanged',
        detail: expect.objectContaining({ sub: 'u1', orgId: 'org-1', teams: ['t1'] }),
      }),
    );
  });

  it('does not emit an event when no team resolves', async () => {
    const repo = makeRepo({ ou1: [] });
    const publisher = makePublisher();
    const autoJoin = createTeamAutoJoin({ repo: repo as any, publisher: publisher as any });
    const res = await autoJoin(provisionedEvent({ sub: 'u1', orgId: 'org-1', operationalUnits: ['ou1'] }));
    expect(res.joined).toBe(0);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('works without a publisher (memberships still written)', async () => {
    const repo = makeRepo({ ou1: ['t1'] });
    const autoJoin = createTeamAutoJoin({ repo: repo as any });
    await expect(
      autoJoin(provisionedEvent({ sub: 'u1', orgId: 'org-1', operationalUnits: ['ou1'] })),
    ).resolves.toMatchObject({ joined: 1 });
  });
});

describe('team-auto-join — PB5 (idempotent re-processing)', () => {
  it('PB5 (property): re-processing the same event requests the same membership set, never throws', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.uniqueArray(fc.string({ minLength: 1 }).filter((s) => !s.includes('#')), { minLength: 1, maxLength: 4 }),
        async (times, teamIds) => {
          const repo = makeRepo({ ou1: teamIds });
          const autoJoin = createTeamAutoJoin({ repo: repo as any });
          const event = provisionedEvent({ sub: 'u1', orgId: 'org-1', operationalUnits: ['ou1'] });

          for (let i = 0; i < times; i++) {
            const res = await autoJoin(event);
            expect(res.teams.sort()).toEqual([...teamIds].sort());
          }

          // The distinct membership keys requested are exactly the resolved teams
          // (idempotency is enforced downstream by the repository's conditional put).
          const requestedTeams = new Set(
            repo.addTeamMember.mock.calls.map((c) => (c[0] as { teamId: string }).teamId),
          );
          expect([...requestedTeams].sort()).toEqual([...teamIds].sort());
        },
      ),
    );
  });
});

describe('team-auto-join — payload extraction fallbacks (coverage)', () => {
  it('tolerates a flattened envelope (payload directly under detail)', async () => {
    const repo = makeRepo({ ou1: ['t1'] });
    const autoJoin = createTeamAutoJoin({ repo: repo as any });
    const res = await autoJoin({ detail: { sub: 'u1', orgId: 'org-1', operationalUnits: ['ou1'] } } as any);
    expect(res.joined).toBe(1);
    expect(repo.addTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 't1', userSub: 'u1', joinedBy: 'system' }),
    );
  });

  it('tolerates a raw payload (no detail wrapper)', async () => {
    const repo = makeRepo({ ou1: ['t1'] });
    const autoJoin = createTeamAutoJoin({ repo: repo as any });
    const res = await autoJoin({ sub: 'u1', orgId: 'org-1', operationalUnits: ['ou1'] } as any);
    expect(res.joined).toBe(1);
  });
});
