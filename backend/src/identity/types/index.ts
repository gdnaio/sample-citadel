/**
 * Shared identity types for the cognito-sso-team-management feature.
 *
 * Foundation shared kernel (Unit 0) — the canonical type definitions consumed by
 * Unit A (Identity & Provisioning), Unit B (Team & Operational-Unit Management),
 * and Unit C (External Ingestion & De-provisioning).
 *
 * Only `AuditRecord` is persisted by Foundation itself; the other entities are
 * defined here but owned/persisted by their respective units.
 */

/** Cognito user-pool RBAC groups (platform roles), highest to lowest privilege. */
export type PlatformGroup = 'admin' | 'project_manager' | 'architect' | 'developer';

/** Tenant scope key, pervasive across the Citadel platform. */
export type OrgId = string;

export type UserStatus = 'active' | 'pending' | 'un-provisioned' | 'inactive';
export type IdentitySource = 'federated' | 'native';

/** A provisioned Citadel user record (owned by Unit A, table `citadel-users-{env}`). */
export interface User {
  /** Cognito subject — primary key. */
  sub: string;
  email: string;
  givenName?: string;
  familyName?: string;
  orgId: OrgId;
  status: UserStatus;
  /** Resolved least-privilege group; never `admin` via auto-mapping (US-008). */
  platformGroup: PlatformGroup;
  source: IdentitySource;
  linkedProviders: string[];
  /** ISO-8601. */
  provisionedAt?: string;
  /** ISO-8601. */
  lastLoginAt?: string;
}

/** An operational unit configured in an external system (owned by Unit B registry, fed by Unit C). */
export interface OperationalUnit {
  id: string;
  name: string;
  /** Identifier of the external source system. */
  source: string;
  orgId: OrgId;
  active: boolean;
  /** ISO-8601. */
  lastSyncedAt?: string;
}

/** A Citadel-managed team (owned by Unit B). */
export interface Team {
  teamId: string;
  name: string;
  orgId: OrgId;
  /** ISO-8601. */
  createdAt: string;
  /** Actor sub. */
  createdBy: string;
}

/** Many-to-many mapping between a team and operational units (owned by Unit B). */
export interface TeamOperationalUnitMapping {
  teamId: string;
  operationalUnitId: string;
  orgId: OrgId;
}

/** A user's membership in a team (owned by Unit B). */
export interface TeamMembership {
  teamId: string;
  userSub: string;
  orgId: OrgId;
  /** ISO-8601. */
  joinedAt: string;
  /** Actor sub, or `system` for auto-join. */
  joinedBy: string;
}

export type AuditOutcome = 'attempted' | 'allowed' | 'denied';
export type AuditDecisionPhase = 'before-auth' | 'after-auth';

/**
 * An immutable audit record (owned and persisted by Foundation, table
 * `citadel-identity-audit-{env}`). Append-only; supports write-before-auth
 * (non-repudiation) for admin actions.
 */
export interface AuditRecord {
  /** uuid. */
  auditId: string;
  /** Cognito sub or `system`. */
  actor: string;
  /** e.g. `USER_PROVISIONED`, `TEAM_MAP_UPDATED`, `ROLE_ELEVATED`. */
  action: string;
  /** e.g. `USER`, `TEAM`, `OPERATIONAL_UNIT`. */
  targetType: string;
  targetId: string;
  orgId: OrgId;
  outcome: AuditOutcome;
  decisionPhase: AuditDecisionPhase;
  /** Correlation id for trace linkage. */
  correlationId: string;
  /** ISO-8601. */
  timestamp: string;
  detail?: Record<string, unknown>;
}
