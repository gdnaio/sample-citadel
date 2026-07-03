import { PlatformGroup } from '../types';

/**
 * Least-privilege default assigned to newly provisioned users (US-006a, US-020).
 * `developer` is the lowest-privilege platform group.
 */
export const DEFAULT_GROUP: PlatformGroup = 'developer';

/**
 * Groups that MUST NEVER be assigned automatically via external IdP / operational-unit
 * mapping (US-008 privilege-escalation guard). Elevation into these is manual-only,
 * performed by an existing admin, and audited.
 */
export const PRIVILEGED_GROUPS: ReadonlySet<PlatformGroup> = new Set<PlatformGroup>(['admin']);

/**
 * Auto-assignable platform groups, ascending by privilege.
 * `admin` is intentionally absent — it is privileged and never auto-assigned.
 */
const ASSIGNABLE_PRIORITY: readonly PlatformGroup[] = ['developer', 'architect', 'project_manager'];

/** True when a group is privileged and therefore not eligible for auto-assignment. */
export function isPrivilegedGroup(group: string): boolean {
  return PRIVILEGED_GROUPS.has(group as PlatformGroup);
}

/**
 * Resolve the platform group to auto-assign from a set of candidate groups
 * (already mapped from the user's external IdP groups / operational units).
 *
 * Guarantees:
 *  - Returns the highest-privilege *assignable* group present in the candidates (P3).
 *  - NEVER returns a privileged group such as `admin` (P4) — privileged/unknown
 *    candidates are ignored.
 *  - Falls back to the least-privilege {@link DEFAULT_GROUP} when no assignable
 *    candidate is present.
 */
export function resolveRole(candidateGroups: readonly string[]): PlatformGroup {
  let best: PlatformGroup = DEFAULT_GROUP;
  let bestRank = ASSIGNABLE_PRIORITY.indexOf(DEFAULT_GROUP);

  for (const candidate of candidateGroups) {
    if (isPrivilegedGroup(candidate)) {
      continue; // P4: privileged groups are never auto-assigned.
    }
    const rank = ASSIGNABLE_PRIORITY.indexOf(candidate as PlatformGroup);
    if (rank > bestRank) {
      bestRank = rank;
      best = candidate as PlatformGroup;
    }
  }

  return best;
}
