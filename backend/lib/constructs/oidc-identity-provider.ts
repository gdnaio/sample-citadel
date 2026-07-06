import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface OidcIdentityProviderProps {
  readonly userPool: cognito.IUserPool;
  readonly environment: string;
  /** OIDC public client id. */
  readonly clientId: string;
  /** Secrets Manager secret NAME holding the OIDC client secret (name-only, US-002). */
  readonly clientSecretName: string;
  /** OIDC issuer URL (used for endpoint discovery). */
  readonly issuerUrl: string;
  /** Hosted UI domain prefix (globally unique within the region). */
  readonly hostedUiDomainPrefix: string;
  /** Provider name; becomes the federated username prefix. Defaults to `CorporateSSO`. */
  readonly providerName?: string;
}

/**
 * External OIDC identity provider + Hosted UI on the existing Cognito user pool (US-001/US-002).
 *
 * The client secret is referenced by **name** via Secrets Manager and resolved by
 * CloudFormation at deploy — it never appears in source or the synthesized template.
 *
 * Standalone: this construct does not modify the app client's supported IdPs; that
 * wiring lives with the live app-client in `backend-stack.ts` (integration step).
 */
export class OidcIdentityProvider extends Construct {
  public readonly provider: cognito.UserPoolIdentityProviderOidc;
  public readonly domain: cognito.UserPoolDomain;
  public readonly providerName: string;

  constructor(scope: Construct, id: string, props: OidcIdentityProviderProps) {
    super(scope, id);
    this.providerName = props.providerName ?? 'CorporateSSO';

    this.provider = new cognito.UserPoolIdentityProviderOidc(this, 'Provider', {
      userPool: props.userPool,
      name: this.providerName,
      clientId: props.clientId,
      // Name-only secret reference (US-002): CloudFormation resolves it at deploy;
      // the plaintext value is never materialised in source or the template.
      clientSecret: cdk.SecretValue.secretsManager(props.clientSecretName).unsafeUnwrap(),
      issuerUrl: props.issuerUrl,
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: cognito.ProviderAttribute.other('email'),
        givenName: cognito.ProviderAttribute.other('given_name'),
        familyName: cognito.ProviderAttribute.other('family_name'),
      },
    });

    this.domain = props.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: props.hostedUiDomainPrefix },
    });
  }
}
