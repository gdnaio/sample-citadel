/**
 * Cognito pre-signup trigger — federated account linking (US-005).
 *
 * Thin adapter over the tested `pre-signup-linker`: on an external-provider signup that
 * matches an existing account by email, link the federated identity so the user isn't
 * duplicated. Linking is best-effort and never blocks signup.
 */
import type { PreSignUpTriggerEvent } from 'aws-lambda';
import {
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CognitoIdentityLinker,
  CognitoUserLookup,
  createPreSignUpLinker,
} from '../identity/provisioning/pre-signup-linker';

export const handler = async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
  const cognito = new CognitoIdentityProviderClient({});

  const lookup: CognitoUserLookup = {
    findUserByEmail: async ({ email }) => {
      // Escape quotes to keep the ListUsers filter expression safe.
      const safeEmail = email.replace(/"/g, '\\"');
      const res = await cognito.send(
        new ListUsersCommand({
          UserPoolId: event.userPoolId,
          Filter: `email = "${safeEmail}"`,
          Limit: 1,
        }),
      );
      const user = res.Users?.[0];
      return user?.Username ? { username: user.Username } : undefined;
    },
  };

  const linker: CognitoIdentityLinker = {
    linkProvider: async ({ destinationUsername, providerName, providerAttributeValue }) => {
      await cognito.send(
        new AdminLinkProviderForUserCommand({
          UserPoolId: event.userPoolId,
          DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: destinationUsername },
          SourceUser: {
            ProviderName: providerName,
            ProviderAttributeName: 'Cognito_Subject',
            ProviderAttributeValue: providerAttributeValue,
          },
        }),
      );
    },
  };

  const link = createPreSignUpLinker({ lookup, linker });
  await link({
    triggerSource: event.triggerSource,
    email: event.request.userAttributes?.email,
    federatedUsername: event.userName,
    correlationId: event.userName,
  });

  // Cognito continues the signup flow; we don't auto-confirm here.
  return event;
};
