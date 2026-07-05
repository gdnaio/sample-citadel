// Virtual mock: the frontend dependency tree (aws-amplify) is not installed in this
// environment, so we stub the module without requiring the real package.
jest.mock(
  'aws-amplify/auth',
  () => ({
    signInWithRedirect: jest.fn(),
  }),
  { virtual: true },
);

import { signInWithRedirect } from 'aws-amplify/auth';
import { buildOAuthConfig, loginWithSSO, SSO_PROVIDER_NAME } from '../sso';

describe('sso', () => {
  afterEach(() => jest.clearAllMocks());

  it('loginWithSSO redirects to the custom OIDC provider', async () => {
    await loginWithSSO();
    expect(signInWithRedirect).toHaveBeenCalledWith({ provider: { custom: SSO_PROVIDER_NAME } });
  });

  it('loginWithSSO honours a custom provider name', async () => {
    await loginWithSSO('AcmeSSO');
    expect(signInWithRedirect).toHaveBeenCalledWith({ provider: { custom: 'AcmeSSO' } });
  });

  it('buildOAuthConfig produces an authorization-code Hosted UI config', () => {
    const cfg = buildOAuthConfig({
      hostedUiDomain: 'citadel-test.auth.us-east-1.amazoncognito.com',
      redirectSignIn: 'https://app.example.com/',
      redirectSignOut: 'https://app.example.com/logout',
    });
    expect(cfg.responseType).toBe('code');
    expect(cfg.providers).toEqual([SSO_PROVIDER_NAME]);
    expect(cfg.scopes).toEqual(['openid', 'email', 'profile']);
    expect(cfg.redirectSignIn).toEqual(['https://app.example.com/']);
    expect(cfg.redirectSignOut).toEqual(['https://app.example.com/logout']);
  });
});
