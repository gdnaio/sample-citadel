/**
 * Tests for team-resolver (C4) — admin-gated team / operational-unit resolvers
 * with audit-before-auth (US-012/013/014/015).
 *
 * TeamRepository, the Foundation AuditWriter, auth-event, and the Cognito client
 * (elevateRole) are mocked. fast-check drives PB3 (non-admin mutation is denied
 * AND audited). Mirrors the mocking style of agent-import-resolver.test.ts.
 *
 * Contract (defines task 4.2):
 *  - `handler(event)` dispatches on `event.info.fieldName`.
 *  - Every mutation is admin-only: the resolver records an audit ATTEMPT
 *    (writeAttempt, before-auth) BEFORE checking `isAdminFromEvent`, then
 *    records the outcome (writeOutcome allowed|denied) after the decision.
 *  - Org-scoping (PB4): the caller's orgId comes from the token
 *    (extractOrgFromEvent); an `orgId` argument that disagrees is denied.
 *  - A denied mutation throws and performs NO repository/Cognito write.
 */
import * as fc from 'fast-check';

// ── Mock TeamRepository ─────────────────────────────────────────────────
const mockRepo = {
  createTeam: jest.fn(),
  getTeam: jest.fn(),
  listTeams: jest.fn(),
  renameTeam: jest.fn(),
  deleteTeam: jest.fn(),
  createOperationalUnit: jest.fn(),
  listOperationalUnits: jest.fn(),
  mapTeamToOperationalUnit: jest.fn(),
  unmapTeamFromOperationalUnit: jest.fn(),
  listTeamsForOperationalUnit: jest.fn(),
  addTeamMember: jest.fn(),
  removeTeamMember: jest.fn(),
  listTeamMembers: jest.fn(),
};
jest.mock('../../identity/teams/team-repository', () => ({
  TeamRepository: jest.fn().mockImplementation(() => mockRepo),
}));

// ── Mock Foundation AuditWriter ─────────────────────────────────────────
const mockWriteAttempt = jest.fn();
const mockWriteOutcome = jest.fn();
jest.mock('../../identity/audit/audit-writer', () => ({
  AuditWriter: jest.fn().mockImplementation(() => ({
    writeAttempt: mockWriteAttempt,
    writeOutcome: mockWriteOutcome,
  })),
}));

// ── Mock auth-event ─────────────────────────────────────────────────────
const mockIsAdminFromEvent = jest.fn(() => false);
const mockExtractOrgFromEvent = jest.fn(async () => 'org-1');
jest.mock('../../utils/auth-event', () => ({
  isAdminFromEvent: (...args: unknown[]) => mockIsAdminFromEvent(...args),
  extractOrgFromEvent: (...args: unknown[]) => mockExtractOrgFromEvent(...args),
}));

// ── Mock Cognito (elevateRole → AdminAddUserToGroup) ────────────────────
const mockCognitoSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({ send: mockCognitoSend })),
  AdminAddUserToGroupCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

process.env.TEAMS_TABLE = 'citadel-teams-test';
process.env.IDENTITY_AUDIT_TABLE = 'citadel-identity-audit-test';
process.env.USER_POOL_ID = 'pool-test';

// Import AFTER mocks are registered.
import { handler } from '../team-resolver';

interface EvtOpts {
  admin?: boolean;
  orgId?: string;
  sub?: string;
}

function evt(fieldName: string, args: Record<string, unknown>, opts: EvtOpts = {}): any {
  const { orgId = 'org-1', sub = 'admin-1' } = opts;
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { 'custom:organization': orgId } },
    request: { headers: { 'x-amzn-trace-id': 'trace-1' } },
  };
}

/** The 9 admin mutations + the effectful mock each must guard. */
const MUTATIONS: Array<{ field: string; args: Record<string, unknown>; effect: jest.Mock }> = [
  { field: 'createTeam', args: { orgId: 'org-1', name: 'T' }, effect: mockRepo.createTeam },
  { field: 'renameTeam', args: { teamId: 't1', name: 'T2' }, effect: mockRepo.renameTeam },
  { field: 'deleteTeam', args: { teamId: 't1' }, effect: mockRepo.deleteTeam },
  { field: 'createOperationalUnit', args: { orgId: 'org-1', name: 'OU', source: 'manual' }, effect: mockRepo.createOperationalUnit },
  { field: 'mapTeamToOperationalUnit', args: { teamId: 't1', ouId: 'ou1' }, effect: mockRepo.mapTeamToOperationalUnit },
  { field: 'unmapTeamFromOperationalUnit', args: { teamId: 't1', ouId: 'ou1' }, effect: mockRepo.unmapTeamFromOperationalUnit },
  { field: 'addTeamMember', args: { teamId: 't1', userSub: 'u2' }, effect: mockRepo.addTeamMember },
  { field: 'removeTeamMember', args: { teamId: 't1', userSub: 'u2' }, effect: mockRepo.removeTeamMember },
  { field: 'elevateRole', args: { userSub: 'u2', group: 'architect' }, effect: mockCognitoSend },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAdminFromEvent.mockReturnValue(false);
  mockExtractOrgFromEvent.mockResolvedValue('org-1');
});

describe('team-resolver — queries (org-scoped, any authenticated caller)', () => {
  it('listTeams routes to repo.listTeams for the caller org', async () => {
    mockRepo.listTeams.mockResolvedValue([{ teamId: 't1' }]);
    const res = await handler(evt('listTeams', { orgId: 'org-1' }));
    expect(mockRepo.listTeams).toHaveBeenCalledWith('org-1');
    expect(res).toEqual([{ teamId: 't1' }]);
  });

  it('getTeam routes to repo.getTeam scoped to the caller org', async () => {
    mockRepo.getTeam.mockResolvedValue({ teamId: 't1' });
    await handler(evt('getTeam', { teamId: 't1' }));
    expect(mockRepo.getTeam).toHaveBeenCalledWith('org-1', 't1');
  });

  it('listOperationalUnits routes to repo.listOperationalUnits for the caller org', async () => {
    mockRepo.listOperationalUnits.mockResolvedValue([]);
    await handler(evt('listOperationalUnits', { orgId: 'org-1' }));
    expect(mockRepo.listOperationalUnits).toHaveBeenCalledWith('org-1');
  });

  it('listTeamMembers routes to repo.listTeamMembers', async () => {
    mockRepo.listTeamMembers.mockResolvedValue([]);
    await handler(evt('listTeamMembers', { teamId: 't1' }));
    expect(mockRepo.listTeamMembers).toHaveBeenCalledWith('t1');
  });

  it('listTeamsForOperationalUnit resolves op-unit → team ids then hydrates teams', async () => {
    mockRepo.listTeamsForOperationalUnit.mockResolvedValue(['t1']);
    mockRepo.getTeam.mockResolvedValue({ teamId: 't1' });
    const res = await handler(evt('listTeamsForOperationalUnit', { ouId: 'ou1' }));
    expect(mockRepo.listTeamsForOperationalUnit).toHaveBeenCalledWith('ou1');
    expect(res).toEqual([{ teamId: 't1' }]);
  });

  it('denies a query whose orgId argument disagrees with the caller org (PB4)', async () => {
    await expect(handler(evt('listTeams', { orgId: 'other-org' }))).rejects.toThrow();
    expect(mockRepo.listTeams).not.toHaveBeenCalled();
  });
});

describe('team-resolver — admin mutations (happy path, audited)', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('createTeam: audits before + after and writes via the repository', async () => {
    mockRepo.createTeam.mockResolvedValue({ teamId: 't1', name: 'T', orgId: 'org-1' });
    const res = await handler(evt('createTeam', { orgId: 'org-1', name: 'T' }));

    // audit-before-auth ordering: attempt recorded before the repo write.
    expect(mockWriteAttempt).toHaveBeenCalledTimes(1);
    expect(mockWriteAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'admin-1', orgId: 'org-1' }),
    );
    expect(mockWriteAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      mockRepo.createTeam.mock.invocationCallOrder[0],
    );
    expect(mockRepo.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', name: 'T', createdBy: 'admin-1' }),
    );
    expect(mockWriteOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'allowed', orgId: 'org-1' }),
    );
    expect(res).toMatchObject({ teamId: 't1' });
  });

  it('mapTeamToOperationalUnit: writes the mapping under the caller org', async () => {
    mockRepo.mapTeamToOperationalUnit.mockResolvedValue({ teamId: 't1', operationalUnitId: 'ou1', orgId: 'org-1' });
    await handler(evt('mapTeamToOperationalUnit', { teamId: 't1', ouId: 'ou1' }));
    expect(mockRepo.mapTeamToOperationalUnit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', teamId: 't1', operationalUnitId: 'ou1' }),
    );
    expect(mockWriteOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'allowed' }));
  });

  it('addTeamMember: writes membership with joinedBy = actor', async () => {
    mockRepo.addTeamMember.mockResolvedValue({ teamId: 't1', userSub: 'u2', orgId: 'org-1' });
    await handler(evt('addTeamMember', { teamId: 't1', userSub: 'u2' }));
    expect(mockRepo.addTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', teamId: 't1', userSub: 'u2', joinedBy: 'admin-1' }),
    );
  });

  it('elevateRole: adds the user to the requested Cognito group and audits', async () => {
    mockCognitoSend.mockResolvedValue({});
    await handler(evt('elevateRole', { userSub: 'u2', group: 'architect' }));
    expect(mockCognitoSend).toHaveBeenCalledTimes(1);
    expect(mockWriteOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'allowed' }));
  });

  it('denies an admin mutation whose orgId argument crosses orgs (PB4)', async () => {
    await expect(
      handler(evt('createTeam', { orgId: 'other-org', name: 'T' })),
    ).rejects.toThrow();
    expect(mockRepo.createTeam).not.toHaveBeenCalled();
    expect(mockWriteOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
  });
});

describe('team-resolver — PB3 (non-admin mutation denied AND audited)', () => {
  it.each(MUTATIONS.map((m) => m.field))('denies + audits non-admin %s', async (field) => {
    const m = MUTATIONS.find((x) => x.field === field)!;
    mockIsAdminFromEvent.mockReturnValue(false);
    await expect(handler(evt(field, m.args))).rejects.toThrow();
    // Audited before-auth AND the denial recorded.
    expect(mockWriteAttempt).toHaveBeenCalledTimes(1);
    expect(mockWriteOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
    // No effectful write performed.
    expect(m.effect).not.toHaveBeenCalled();
  });

  it('PB3 (property): any mutation by a non-admin is denied, audited, and has no side effect', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...MUTATIONS.map((m) => m.field)), async (field) => {
        jest.clearAllMocks();
        mockIsAdminFromEvent.mockReturnValue(false);
        mockExtractOrgFromEvent.mockResolvedValue('org-1');
        const m = MUTATIONS.find((x) => x.field === field)!;
        await expect(handler(evt(field, m.args))).rejects.toThrow();
        expect(mockWriteAttempt).toHaveBeenCalledTimes(1);
        expect(mockWriteOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
        expect(m.effect).not.toHaveBeenCalled();
      }),
    );
  });
});

describe('team-resolver — remaining admin mutations (coverage)', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('renameTeam renames then returns the refreshed team', async () => {
    mockRepo.renameTeam.mockResolvedValue(undefined);
    mockRepo.getTeam.mockResolvedValue({ teamId: 't1', name: 'T2' });
    const res = await handler(evt('renameTeam', { teamId: 't1', name: 'T2' }));
    expect(mockRepo.renameTeam).toHaveBeenCalledWith('org-1', 't1', 'T2');
    expect(res).toMatchObject({ teamId: 't1', name: 'T2' });
    expect(mockWriteOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'allowed' }));
  });

  it('deleteTeam deletes and returns a success envelope', async () => {
    mockRepo.deleteTeam.mockResolvedValue(undefined);
    const res = await handler(evt('deleteTeam', { teamId: 't1' }));
    expect(mockRepo.deleteTeam).toHaveBeenCalledWith('org-1', 't1');
    expect(res).toMatchObject({ success: true });
  });

  it('createOperationalUnit writes under the caller org', async () => {
    mockRepo.createOperationalUnit.mockResolvedValue({ id: 'ou1', orgId: 'org-1' });
    await handler(evt('createOperationalUnit', { orgId: 'org-1', name: 'OU', source: 'manual' }));
    expect(mockRepo.createOperationalUnit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', name: 'OU', source: 'manual' }),
    );
  });

  it('unmapTeamFromOperationalUnit removes the mapping and returns success', async () => {
    mockRepo.unmapTeamFromOperationalUnit.mockResolvedValue(undefined);
    const res = await handler(evt('unmapTeamFromOperationalUnit', { teamId: 't1', ouId: 'ou1' }));
    expect(mockRepo.unmapTeamFromOperationalUnit).toHaveBeenCalledWith('t1', 'ou1');
    expect(res).toMatchObject({ success: true });
  });

  it('removeTeamMember removes membership and returns success', async () => {
    mockRepo.removeTeamMember.mockResolvedValue(undefined);
    const res = await handler(evt('removeTeamMember', { teamId: 't1', userSub: 'u2' }));
    expect(mockRepo.removeTeamMember).toHaveBeenCalledWith('t1', 'u2');
    expect(res).toMatchObject({ success: true });
  });
});

describe('team-resolver — caller/field edge cases (coverage)', () => {
  it('rejects a caller with no organization scope', async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);
    await expect(handler(evt('listTeams', { orgId: 'org-1' }))).rejects.toThrow();
    expect(mockRepo.listTeams).not.toHaveBeenCalled();
  });

  it('throws on an unknown field', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    await expect(handler(evt('bogusField', {}))).rejects.toThrow(/Unknown field/);
  });
});

describe('team-resolver — actor/correlation fallbacks (coverage)', () => {
  it('falls back to anonymous actor and generated correlationId when absent', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockRepo.createTeam.mockResolvedValue({ teamId: 't1' });
    const bare: any = {
      info: { fieldName: 'createTeam' },
      arguments: { orgId: 'org-1', name: 'T' },
      identity: {},
      request: {},
    };
    await handler(bare);
    expect(mockRepo.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'anonymous' }),
    );
    expect(mockWriteAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'anonymous', correlationId: expect.any(String) }),
    );
  });
});
