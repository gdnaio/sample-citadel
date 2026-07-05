import { mockClient } from 'aws-sdk-client-mock';
import {
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { handler } from '../pre-signup';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

function event(overrides: any = {}): any {
  return {
    triggerSource: 'PreSignUp_ExternalProvider',
    userPoolId: 'us-east-1_test',
    userName: 'CorporateSSO_abc123',
    request: { userAttributes: { email: 'user@corp.com' } },
    response: {},
    ...overrides,
  };
}

beforeEach(() => cognitoMock.reset());

describe('pre-signup handler', () => {
  it('links a federated identity to an existing account matched by email', async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [{ Username: 'native-1' }] as never });
    cognitoMock.on(AdminLinkProviderForUserCommand).resolves({});

    await handler(event());

    const link = cognitoMock.commandCalls(AdminLinkProviderForUserCommand)[0].args[0].input;
    expect(link.DestinationUser).toEqual({ ProviderName: 'Cognito', ProviderAttributeValue: 'native-1' });
    expect(link.SourceUser).toMatchObject({
      ProviderName: 'CorporateSSO',
      ProviderAttributeName: 'Cognito_Subject',
      ProviderAttributeValue: 'abc123',
    });
  });

  it('does not link when no existing account matches', async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
    await handler(event());
    expect(cognitoMock.commandCalls(AdminLinkProviderForUserCommand)).toHaveLength(0);
  });

  it('passes through native signups without a lookup', async () => {
    await handler(event({ triggerSource: 'PreSignUp_SignUp' }));
    expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
  });
});
