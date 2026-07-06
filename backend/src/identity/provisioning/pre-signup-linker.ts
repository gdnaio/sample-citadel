import { AuditWriter } from '../audit/audit-writer';

export interface ExistingUser {
  username: string;
}

/** Abstraction over looking up an existing user by email (Cognito ListUsers / index). */
export interface CognitoUserLookup {
  findUserByEmail(input: { email: string }): Promise<ExistingUser | undefined>;
}

/** Abstraction over `AdminLinkProviderForUser`. */
export interface CognitoIdentityLinker {
  linkProvider(input: {
    destinationUsername: string;
    providerName: string;
    providerAttributeValue: string;
  }): Promise<void>;
}

export type PreSignUpReason =
  | 'linked'
  | 'already-linked'
  | 'link-failed'
  | 'no-existing-user'
  | 'not-external'
  | 'no-email';

export interface PreSignUpInput {
  triggerSource: string;
  email?: string;
  /** Federated username, formatted `<ProviderName>_<providerAttributeValue>`. */
  federatedUsername: string;
  correlationId: string;
}

export interface PreSignUpResult {
  linked: boolean;
  reason: PreSignUpReason;
}

export interface PreSignUpDeps {
  lookup: CognitoUserLookup;
  linker: CognitoIdentityLinker;
  audit?: Pick<AuditWriter, 'writeOutcome'>;
}

const EXTERNAL_TRIGGER = 'PreSignUp_ExternalProvider';

/** Split a federated username `Provider_value` into its provider name + attribute value. */
export function parseFederatedProvider(
  federatedUsername: string,
): { providerName: string; providerAttributeValue: string } | undefined {
  const idx = federatedUsername.indexOf('_');
  if (idx <= 0 || idx === federatedUsername.length - 1) {
    return undefined;
  }
  return {
    providerName: federatedUsername.slice(0, idx),
    providerAttributeValue: federatedUsername.slice(idx + 1),
  };
}

/**
 * Pre-signup account linking for federated logins (US-005, PA3).
 *
 * When a federated sign-up matches an existing (native) account by email, link the
 * federated identity to it so the user isn't duplicated. Idempotent for
 * already-linked identities, and non-fatal on failure (sign-in still proceeds).
 */
export function createPreSignUpLinker(deps: PreSignUpDeps) {
  return async function link(input: PreSignUpInput): Promise<PreSignUpResult> {
    if (input.triggerSource !== EXTERNAL_TRIGGER) {
      return { linked: false, reason: 'not-external' };
    }
    if (!input.email) {
      return { linked: false, reason: 'no-email' };
    }

    const provider = parseFederatedProvider(input.federatedUsername);
    if (!provider) {
      return { linked: false, reason: 'no-existing-user' };
    }

    const existing = await deps.lookup.findUserByEmail({ email: input.email });
    if (!existing) {
      // New federated user — let Cognito create it.
      return { linked: false, reason: 'no-existing-user' };
    }

    let result: PreSignUpResult;
    try {
      await deps.linker.linkProvider({
        destinationUsername: existing.username,
        providerName: provider.providerName,
        providerAttributeValue: provider.providerAttributeValue,
      });
      result = { linked: true, reason: 'linked' };
    } catch (err) {
      if (err instanceof Error && (err.name === 'AlreadyLinkedException' || /already.?linked/i.test(err.message))) {
        result = { linked: false, reason: 'already-linked' };
      } else {
        // US-005: non-fatal — do not block sign-in.
        result = { linked: false, reason: 'link-failed' };
      }
    }

    await deps.audit
      ?.writeOutcome({
        actor: existing.username,
        action: 'IDENTITY_LINKED',
        targetType: 'USER',
        targetId: existing.username,
        orgId: 'unknown',
        correlationId: input.correlationId,
        outcome: result.linked ? 'allowed' : 'denied',
        detail: { reason: result.reason, providerName: provider.providerName },
      })
      .catch(() => undefined);

    return result;
  };
}
