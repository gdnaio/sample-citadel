import {
  createPreSignUpLinker,
  parseFederatedProvider,
  PreSignUpDeps,
  PreSignUpInput,
} from '../pre-signup-linker';

function fakeDeps(
  existing: { username: string } | undefined,
  linkImpl?: () => Promise<void>,
): { deps: PreSignUpDeps; links: unknown[] } {
  const links: unknown[] = [];
  const deps: PreSignUpDeps = {
    lookup: { findUserByEmail: async () => existing },
    linker: {
      linkProvider: async (i) => {
        links.push(i);
        if (linkImpl) await linkImpl();
      },
    },
    audit: { writeOutcome: async () => ({}) as never },
  };
  return { deps, links };
}

const externalInput: PreSignUpInput = {
  triggerSource: 'PreSignUp_ExternalProvider',
  email: 'user@corp.com',
  federatedUsername: 'CorporateSSO_abc123',
  correlationId: 'corr-1',
};

describe('parseFederatedProvider', () => {
  it('splits provider name and attribute value', () => {
    expect(parseFederatedProvider('CorporateSSO_abc123')).toEqual({
      providerName: 'CorporateSSO',
      providerAttributeValue: 'abc123',
    });
  });
  it('returns undefined for unparseable usernames', () => {
    expect(parseFederatedProvider('nounderscore')).toBeUndefined();
    expect(parseFederatedProvider('_leading')).toBeUndefined();
    expect(parseFederatedProvider('trailing_')).toBeUndefined();
  });
});

describe('pre-signup linker', () => {
  it('links a federated identity to an existing account (PA3)', async () => {
    const { deps, links } = fakeDeps({ username: 'native-user-1' });
    const link = createPreSignUpLinker(deps);
    const result = await link(externalInput);
    expect(result).toEqual({ linked: true, reason: 'linked' });
    expect(links[0]).toEqual({
      destinationUsername: 'native-user-1',
      providerName: 'CorporateSSO',
      providerAttributeValue: 'abc123',
    });
  });

  it('passes through native (non-external) signups without linking', async () => {
    const { deps, links } = fakeDeps({ username: 'x' });
    const link = createPreSignUpLinker(deps);
    const result = await link({ ...externalInput, triggerSource: 'PreSignUp_SignUp' });
    expect(result.reason).toBe('not-external');
    expect(links).toHaveLength(0);
  });

  it('treats a brand-new federated user (no existing account) as no-op', async () => {
    const { deps, links } = fakeDeps(undefined);
    const link = createPreSignUpLinker(deps);
    const result = await link(externalInput);
    expect(result).toEqual({ linked: false, reason: 'no-existing-user' });
    expect(links).toHaveLength(0);
  });

  it('is idempotent when already linked', async () => {
    const alreadyLinked = (): Promise<void> => {
      const e = new Error('provider is already linked');
      e.name = 'AlreadyLinkedException';
      return Promise.reject(e);
    };
    const { deps } = fakeDeps({ username: 'native-user-1' }, alreadyLinked);
    const link = createPreSignUpLinker(deps);
    const result = await link(externalInput);
    expect(result).toEqual({ linked: false, reason: 'already-linked' });
  });

  it('is non-fatal on link failure (US-005) — never throws', async () => {
    const boom = (): Promise<void> => Promise.reject(new Error('service unavailable'));
    const { deps } = fakeDeps({ username: 'native-user-1' }, boom);
    const link = createPreSignUpLinker(deps);
    await expect(link(externalInput)).resolves.toEqual({ linked: false, reason: 'link-failed' });
  });

  it('skips when email is missing', async () => {
    const { deps } = fakeDeps({ username: 'x' });
    const link = createPreSignUpLinker(deps);
    const result = await link({ ...externalInput, email: undefined });
    expect(result.reason).toBe('no-email');
  });
});
