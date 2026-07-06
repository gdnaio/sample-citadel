/**
 * SSO login entry (US-001).
 *
 * Redirects to the Cognito Hosted UI for the external OIDC provider using Amplify v6.
 * The `loginWith.oauth` block produced by {@link buildOAuthConfig} must be merged into
 * `Amplify.configure` (integration step) for the redirect to resolve at runtime.
 */
import { signInWithRedirect } from 'aws-amplify/auth';

/** Cognito OIDC provider name — must match the CDK `OidcIdentityProvider` name. */
export const SSO_PROVIDER_NAME = 'CorporateSSO';

export interface OAuthConfig {
  domain: string;
  scopes: string[];
  redirectSignIn: string[];
  redirectSignOut: string[];
  responseType: 'code';
  providers: string[];
}

export interface SsoEnv {
  /** Hosted UI domain, e.g. `citadel-{env}.auth.{region}.amazoncognito.com`. */
  hostedUiDomain: string;
  redirectSignIn: string;
  redirectSignOut: string;
  providerName?: string;
}

/** Build the Amplify v6 `loginWith.oauth` block for Hosted UI SSO (authorization-code flow). */
export function buildOAuthConfig(env: SsoEnv): OAuthConfig {
  return {
    domain: env.hostedUiDomain,
    scopes: ['openid', 'email', 'profile'],
    redirectSignIn: [env.redirectSignIn],
    redirectSignOut: [env.redirectSignOut],
    responseType: 'code',
    providers: [env.providerName ?? SSO_PROVIDER_NAME],
  };
}

/** Initiate SSO login by redirecting to the Hosted UI for the custom OIDC provider. */
export async function loginWithSSO(providerName: string = SSO_PROVIDER_NAME): Promise<void> {
  await signInWithRedirect({ provider: { custom: providerName } });
}
