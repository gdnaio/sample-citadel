# Identity Shared Kernel (Foundation)

Shared building blocks for the **cognito-sso-team-management** feature, consumed by
Unit A (Identity & Provisioning), Unit B (Team & Operational-Unit Management), and
Unit C (External Ingestion & De-provisioning).

> Build/deploy Foundation before the units that depend on it.

## What's here

| Path | Export | Use it for |
|------|--------|-----------|
| `types/index.ts` | `User`, `Team`, `OperationalUnit`, `TeamOperationalUnitMapping`, `TeamMembership`, `AuditRecord`, `PlatformGroup`, `OrgId` | Canonical types — import instead of redefining |
| `policy/least-privilege.ts` | `resolveRole`, `DEFAULT_GROUP`, `PRIVILEGED_GROUPS`, `isPrivilegedGroup` | Role resolution + the US-008 privilege-escalation guard |
| `audit/audit-writer.ts` | `AuditWriter` | Append-only audit trail (US-018), write-before-auth |
| `events/publisher.ts` | `DomainEventPublisher`, `EVENT_SCHEMA_VERSION` | Publish `citadel.identity.*` / `citadel.team.*` events |
| `observability/logger.ts` | `createLogger`, `redact` | Correlation-aware structured logging with PII redaction |
| `../../lib/constructs/identity-foundation.ts` | `IdentityFoundation` | Audit table + `grantTriggerGroupManagement()` (US-020) + governance ADR |

## Role mapping (US-007/008)

```ts
import { resolveRole } from '@/identity/policy/least-privilege';
// Never returns `admin` from external mapping; defaults to least-privilege `developer`.
const group = resolveRole(idpGroupsFromAssertion);
```

## Audit (US-018)

```ts
import { AuditWriter } from '@/identity/audit/audit-writer';
const audit = new AuditWriter(docClient, process.env.AUDIT_TABLE!);
await audit.writeAttempt({ actor, action: 'TEAM_MAP_UPDATED', targetType: 'TEAM', targetId, orgId, correlationId });
// ...perform the authorization check + mutation...
await audit.writeOutcome({ actor, action: 'TEAM_MAP_UPDATED', targetType: 'TEAM', targetId, orgId, correlationId, outcome: 'allowed' });
```

## Events (US-018)

```ts
import { DomainEventPublisher } from '@/identity/events/publisher';
const events = new DomainEventPublisher(ebClient, process.env.EVENT_BUS_NAME!);
await events.publish({ source: 'citadel.identity', detailType: 'UserProvisioned', detail: { sub }, correlationId });
```

## Safe trigger IAM (US-020)

In CDK, grant a Cognito trigger Lambda group-management permissions **without** creating
a UserPool↔trigger circular dependency:

```ts
const foundation = new IdentityFoundation(this, 'IdentityFoundation', { environment });
foundation.grantTriggerGroupManagement(preTokenFn);
```

## Notes for Unit A/B/C

- Provisioning must default to `DEFAULT_GROUP`; elevation into `PRIVILEGED_GROUPS` is manual-only (admin), and audited.
- Metrics/alarms (Standard observability) are wired per-Lambda in the consuming unit; use `createLogger` for correlation-aware logs.
- The governance ADR is recorded at deploy under `/citadel/governance/adr/team-management-{env}`.
