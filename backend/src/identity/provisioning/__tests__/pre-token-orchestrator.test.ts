import * as fc from 'fast-check';
import {
  createPreTokenOrchestrator,
  GroupAssigner,
  PreTokenDeps,
  PreTokenInput,
} from '../pre-token-orchestrator';
import { PRIVILEGED_GROUPS } from '../../policy/least-privilege';

function fakeDeps(overrides: Partial<PreTokenDeps> = {}): {
  deps: PreTokenDeps;
  assigned: Array<{ sub: string; group: string }>;
  published: Array<{ detailType: string }>;
  provisionCalls: unknown[];
} {
  const assigned: Array<{ sub: string; group: string }> = [];
  const published: Array<{ detailType: string }> = [];
  const provisionCalls: unknown[] = [];

  const groupAssigner: GroupAssigner = {
    addUserToGroup: async (i) => {
      assigned.push(i);
    },
  };

  const deps: PreTokenDeps = {
    provisioning: {
      provision: async (input) => {
        provisionCalls.push(input);
        return { user: { ...input } as never, created: true };
      },
    },
    groupAssigner,
    audit: { writeOutcome: async () => ({}) as never },
    publisher: {
      publish: async (e) => {
        published.push({ detailType: e.detailType });
        return {} as never;
      },
    },
    ...overrides,
  };

  return { deps, assigned, published, provisionCalls };
}

const baseInput: PreTokenInput = {
  sub: 'sub-1',
  email: 'a@b.com',
  orgId: 'org-1',
  idpGroups: ['developer'],
  correlationId: 'corr-1',
};

describe('pre-token orchestrator', () => {
  it('PA1: never resolves a privileged group from IdP mapping', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.oneof(fc.constantFrom('admin', 'developer', 'architect', 'project_manager'), fc.string())), async (idpGroups) => {
        const { deps, assigned } = fakeDeps();
        const orchestrate = createPreTokenOrchestrator(deps);
        const result = await orchestrate({ ...baseInput, idpGroups });
        expect(PRIVILEGED_GROUPS.has(result.resolvedGroup)).toBe(false);
        expect(result.resolvedGroup).not.toBe('admin');
        // A privileged group is never pushed to Cognito via mapping.
        expect(assigned.every((a) => a.group !== 'admin')).toBe(true);
      }),
    );
  });

  it('PA4: maps identity attributes into the provisioning call', async () => {
    const { deps, provisionCalls } = fakeDeps();
    const orchestrate = createPreTokenOrchestrator(deps);
    await orchestrate({ ...baseInput, email: 'x@y.com', givenName: 'Ada', orgId: 'org-9', idpGroups: ['architect'] });
    expect(provisionCalls[0]).toMatchObject({ sub: 'sub-1', email: 'x@y.com', givenName: 'Ada', orgId: 'org-9', platformGroup: 'architect' });
  });

  it('PA5: returns givenRole and no claim that overwrites custom:role/custom:organization', async () => {
    const { deps } = fakeDeps();
    const orchestrate = createPreTokenOrchestrator(deps);
    const result = await orchestrate({ ...baseInput, idpGroups: ['project_manager'] });
    expect(Object.keys(result.extraClaims)).toEqual(['givenRole']);
    expect(result.extraClaims.givenRole).toBe('project_manager');
  });

  it('PA6: provisioning failure degrades to least privilege, emits retry, never throws', async () => {
    const { deps, published } = fakeDeps({
      provisioning: {
        provision: async () => {
          throw new Error('ddb down');
        },
      },
    });
    const orchestrate = createPreTokenOrchestrator(deps);

    const result = await orchestrate({ ...baseInput, idpGroups: ['project_manager'] });

    expect(result.degraded).toBe(true);
    expect(result.resolvedGroup).toBe('developer');
    expect(published.map((p) => p.detailType)).toContain('ProvisionRetry');
  });

  it('manual assignment wins and is not re-pushed to Cognito (US-007/US-008)', async () => {
    const { deps, assigned } = fakeDeps();
    const orchestrate = createPreTokenOrchestrator(deps);
    const result = await orchestrate({ ...baseInput, existingPlatformGroup: 'admin', idpGroups: ['developer'] });
    expect(result.resolvedGroup).toBe('admin'); // manual admin preserved
    expect(assigned).toHaveLength(0); // never auto-pushes a manual/privileged group
  });

  it('assigns the mapped non-privileged group to Cognito', async () => {
    const { deps, assigned } = fakeDeps();
    const orchestrate = createPreTokenOrchestrator(deps);
    await orchestrate({ ...baseInput, idpGroups: ['architect'] });
    expect(assigned).toEqual([{ sub: 'sub-1', group: 'architect' }]);
  });
});
