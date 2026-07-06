/**
 * Schema contract for the Unit B (Team & Operational-Unit management) additions
 * — US-012/013/014/015. Test-after guard (D4-B-2): asserts the new object types,
 * queries, and admin mutations are declared in schema.graphql with the expected
 * shapes. Full GraphQL validity is exercised at `cdk synth` (task 6.2); this
 * test is a fast regression guard on the contract text (matching the existing
 * proposed-manifest-schema.test.ts convention).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

function schema(): string {
  return readFileSync(join(__dirname, '..', 'schema.graphql'), 'utf8');
}

/** Extract a flat `type Name { ... }` block (no nested braces in these types). */
function typeBlock(name: string): string {
  const match = schema().match(new RegExp(`type ${name} \\{[^}]*\\}`));
  if (!match) {
    throw new Error(`type ${name} not found in schema.graphql`);
  }
  return match[0];
}

describe('schema.graphql — Unit B object types', () => {
  it('Team exposes the Foundation-aligned fields', () => {
    const t = typeBlock('Team');
    expect(t).toMatch(/\bteamId:\s*ID!/);
    expect(t).toMatch(/\bname:\s*String!/);
    expect(t).toMatch(/\borgId:\s*String!/);
    expect(t).toMatch(/\bcreatedAt:\s*AWSDateTime!/);
    expect(t).toMatch(/\bcreatedBy:\s*String!/);
  });

  it('OperationalUnit exposes id/source/active with optional lastSyncedAt', () => {
    const t = typeBlock('OperationalUnit');
    expect(t).toMatch(/\bid:\s*ID!/);
    expect(t).toMatch(/\bsource:\s*String!/);
    expect(t).toMatch(/\bactive:\s*Boolean!/);
    expect(t).toMatch(/\blastSyncedAt:\s*AWSDateTime\b/);
  });

  it('TeamMembership exposes userSub + joinedBy (system for auto-join)', () => {
    const t = typeBlock('TeamMembership');
    expect(t).toMatch(/\bteamId:\s*ID!/);
    expect(t).toMatch(/\buserSub:\s*String!/);
    expect(t).toMatch(/\bjoinedAt:\s*AWSDateTime!/);
    expect(t).toMatch(/\bjoinedBy:\s*String!/);
  });

  it('TeamOperationalUnitMapping exposes the M:N key fields', () => {
    const t = typeBlock('TeamOperationalUnitMapping');
    expect(t).toMatch(/\bteamId:\s*ID!/);
    expect(t).toMatch(/\boperationalUnitId:\s*ID!/);
    expect(t).toMatch(/\borgId:\s*String!/);
  });

  it('TeamMutationResult is a success/message envelope', () => {
    const t = typeBlock('TeamMutationResult');
    expect(t).toMatch(/\bsuccess:\s*Boolean!/);
    expect(t).toMatch(/\bmessage:\s*String\b/);
  });
});

describe('schema.graphql — Unit B queries', () => {
  const s = schema();
  it('declares the 5 team/op-unit queries', () => {
    expect(s).toMatch(/listTeams\(orgId:\s*String!\):\s*\[Team!\]!/);
    expect(s).toMatch(/getTeam\(teamId:\s*ID!\):\s*Team\b/);
    expect(s).toMatch(/listOperationalUnits\(orgId:\s*String!\):\s*\[OperationalUnit!\]!/);
    expect(s).toMatch(/listTeamMembers\(teamId:\s*ID!\):\s*\[TeamMembership!\]!/);
    expect(s).toMatch(/listTeamsForOperationalUnit\(ouId:\s*ID!\):\s*\[Team!\]!/);
  });
});

describe('schema.graphql — Unit B mutations', () => {
  const s = schema();
  it('declares the 9 admin mutations with expected return types', () => {
    expect(s).toMatch(/createTeam\(orgId:\s*String!,\s*name:\s*String!\):\s*Team!/);
    expect(s).toMatch(/renameTeam\(teamId:\s*ID!,\s*name:\s*String!\):\s*Team!/);
    expect(s).toMatch(/deleteTeam\(teamId:\s*ID!\):\s*TeamMutationResult!/);
    expect(s).toMatch(/createOperationalUnit\(orgId:\s*String!,\s*name:\s*String!,\s*source:\s*String!\):\s*OperationalUnit!/);
    expect(s).toMatch(/mapTeamToOperationalUnit\(teamId:\s*ID!,\s*ouId:\s*ID!\):\s*TeamOperationalUnitMapping!/);
    expect(s).toMatch(/unmapTeamFromOperationalUnit\(teamId:\s*ID!,\s*ouId:\s*ID!\):\s*TeamMutationResult!/);
    expect(s).toMatch(/addTeamMember\(teamId:\s*ID!,\s*userSub:\s*String!\):\s*TeamMembership!/);
    expect(s).toMatch(/removeTeamMember\(teamId:\s*ID!,\s*userSub:\s*String!\):\s*TeamMutationResult!/);
    expect(s).toMatch(/elevateRole\(userSub:\s*String!,\s*group:\s*String!\):\s*UserManagementResponse!/);
  });
});

describe('schema.graphql — structural sanity', () => {
  it('has balanced braces after the Unit B additions', () => {
    const s = schema();
    const open = (s.match(/\{/g) ?? []).length;
    const close = (s.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });
});
