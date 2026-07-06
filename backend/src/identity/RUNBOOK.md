# Runbook — Cognito SSO & Team-Management (Unit A: Identity & Provisioning)

Operational guide for enabling, verifying, operating, and rolling back the SSO +
first-login-provisioning feature. The feature is **opt-in**: with no `oidcConfig` the
stack and auth behave exactly as before.

## 1. Enable SSO (deploy-time)

1. **Create the OIDC client secret** in Secrets Manager (name-only reference — the value
   never appears in code/CloudFormation):
   ```
   aws secretsmanager create-secret \
     --name citadel/oidc/client-secret-<env> \
     --secret-string '<oidc-client-secret>'
   ```
2. **Pass `oidcConfig`** to `BackendStack` (e.g. from CDK context/env in `bin/app.ts`):
   ```ts
   new BackendStack(app, 'BackendStack', {
     environment,
     oidcConfig: {
       issuerUrl: 'https://<idp-issuer>',
       clientId: '<oidc-client-id>',
       clientSecretName: `citadel/oidc/client-secret-${environment}`,
       hostedUiDomainPrefix: `citadel-<env>`,
       callbackUrls: ['https://<app-domain>/'],
       logoutUrls: ['https://<app-domain>/logout'],
     },
   });
   ```
3. **IdP setup**: register the Cognito Hosted UI callback (`https://citadel-<env>.auth.<region>.amazoncognito.com/oauth2/idpresponse`) with the IdP; map the IdP claims `email`, `given_name`, `family_name`, and a comma-separated groups claim to the Cognito attribute `custom:idp_groups` (read by the pre-token trigger — never a user-writable field).
4. **Build + deploy**: `npm run build:lambda` (bundles the new handlers) then `npx cdk deploy` the backend stack.
5. **Frontend**: supply `ssoHostedUiDomain`, `ssoRedirectSignIn`, `ssoRedirectSignOut` (and optional `ssoProviderName`) to `serverService.configure(...)`; the "Continue with SSO" button appears automatically.

## 2. Manual smoke test (task 7.2 — requires a deployed sandbox IdP)

1. Open the app; click **Continue with SSO** → redirected to the IdP.
2. Authenticate as a **brand-new** user. Expect: redirected back signed-in.
3. Verify a record exists in `citadel-user-profiles-<env>` keyed `USER#<sub>` with
   `status=active`, `platformGroup=developer` (least-privilege default), `source=federated`.
4. Decode the id token: expect `custom:organization`, `custom:role`, and `givenRole` claims;
   `givenRole` must **never** be `admin` from mapping.
5. Confirm an audit row in `citadel-identity-audit-<env>` (`action=USER_PROVISIONED`).
6. **Account linking**: pre-create a native user with the same email, then SSO-login — verify
   no duplicate is created (identity linked).
7. **Native login still works**: sign in with email/password (regression check for US-003).

## 3. Operations

- **Alarms** (CloudWatch): `PreTokenErrorsAlarm`, `PreTokenDurationAlarm` (p99 ≥ 4s — Cognito
  hard-limits the trigger at 5s), `PreSignUpErrorsAlarm`, `ProvisionReconcilerErrorsAlarm`,
  `ProvisionReconcilerDlqAlarm`.
- **DLQ**: `citadel-provision-reconciler-dlq-<env>`. Non-empty ⇒ provisioning is permanently
  failing for some users. Inspect messages, fix the root cause (table perms, throttling), then
  redrive. Provisioning is idempotent, so redriving is safe.
- **Graceful degradation**: if provisioning fails at login, the user still signs in at
  least-privilege and a `ProvisionRetry` event is emitted for the reconciler — logins are
  never blocked.

## 4. Rollback / disable

- **Disable the feature**: remove `oidcConfig` and redeploy. The OIDC provider, users table,
  audit table, extra triggers, and alarms are removed; the pre-token trigger reverts to its
  original org/role claim promotion (the provisioning path is only active when `USERS_TABLE`
  is set, which happens only inside the gated block).
- **Data safety**: `citadel-user-profiles-<env>` and `citadel-identity-audit-<env>` are
  `RETAIN` + deletion-protected, so disabling the feature does not delete identity/audit data.
- **Privilege guard**: `admin` is never auto-assigned via IdP mapping (US-008); elevate to
  `admin` manually via the Cognito console / admin tooling, which is audited.
