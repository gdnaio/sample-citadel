/**
 * Tests for the SSO extension of the pre-token-generation trigger.
 * The base-behaviour tests live in pre-token-generation.test.ts and remain unchanged.
 */
import { buildPreTokenInput, createHandler } from '../pre-token-generation';

function makeEvent(overrides: any = {}): any {
  return {
    version: '1',
    triggerSource: 'TokenGeneration_HostedAuth',
    region: 'us-east-1',
    userPoolId: 'us-east-1_test',
    userName: 'user-123',
    callerContext: { awsSdkVersion: '1', clientId: 'client-1' },
    request: {
      userAttributes: { sub: 'user-123', email: 'u@example.com', ...(overrides.request?.userAttributes || {}) },
      groupConfiguration: {
        groupsToOverride: overrides.request?.groupConfiguration?.groupsToOverride ?? [],
        iamRolesToOverride: [],
        preferredRole: null,
      },
    },
    response: overrides.response ?? {},
  };
}

describe('pre-token-generation SSO extension', () => {
  describe('buildPreTokenInput', () => {
    it('maps identity attributes and IdP groups', () => {
      const event = makeEvent({
        request: {
          userAttributes: {
            sub: 's1',
            email: 'e@x.com',
            given_name: 'Ada',
            family_name: 'Lovelace',
            'custom:organization': 'org-9',
            'custom:idp_groups': 'architect, developer',
          },
        },
      });
      expect(buildPreTokenInput(event)).toMatchObject({
        sub: 's1',
        email: 'e@x.com',
        givenName: 'Ada',
        familyName: 'Lovelace',
        orgId: 'org-9',
        idpGroups: ['architect', 'developer'],
      });
    });

    it('treats admin group membership as a manual override', () => {
      const event = makeEvent({ request: { userAttributes: {}, groupConfiguration: { groupsToOverride: ['admin'] } } });
      expect(buildPreTokenInput(event).existingPlatformGroup).toBe('admin');
    });

    it('has no manual override for a plain user', () => {
      const event = makeEvent();
      expect(buildPreTokenInput(event).existingPlatformGroup).toBeUndefined();
    });
  });

  it('adds a givenRole claim when enabled', async () => {
    const handler = createHandler({
      enabled: true,
      orchestrate: async () => ({
        resolvedGroup: 'architect',
        provisioned: true,
        degraded: false,
        extraClaims: { givenRole: 'architect' },
      }),
    });
    const event = makeEvent({ request: { userAttributes: { 'custom:organization': 'org-1' } } });
    const result = await handler(event);
    expect(result.response.claimsOverrideDetails.claimsToAddOrOverride).toMatchObject({
      'custom:organization': 'org-1',
      givenRole: 'architect',
    });
  });

  it('never blocks login when orchestration throws (PA6)', async () => {
    const handler = createHandler({
      enabled: true,
      orchestrate: async () => {
        throw new Error('ddb down');
      },
    });
    const event = makeEvent({ request: { userAttributes: { 'custom:organization': 'org-1', 'custom:role': 'developer' } } });
    const result = await handler(event);
    // Base claims intact, no givenRole — login proceeds.
    expect(result.response.claimsOverrideDetails.claimsToAddOrOverride).toEqual({
      'custom:organization': 'org-1',
      'custom:role': 'developer',
    });
  });

  it('is inert when disabled (backward compatible)', async () => {
    const handler = createHandler({ enabled: false });
    const event = makeEvent({ request: { userAttributes: { 'custom:organization': 'org-1' } } });
    const result = await handler(event);
    expect(result.response.claimsOverrideDetails.claimsToAddOrOverride).toEqual({ 'custom:organization': 'org-1' });
  });
});
