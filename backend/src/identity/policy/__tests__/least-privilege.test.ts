import fc from 'fast-check';
import {
  DEFAULT_GROUP,
  PRIVILEGED_GROUPS,
  isPrivilegedGroup,
  resolveRole,
} from '../least-privilege';
import { PlatformGroup } from '../../types';

const ASSIGNABLE: PlatformGroup[] = ['developer', 'architect', 'project_manager'];
const PRIORITY: Record<PlatformGroup, number> = {
  developer: 0,
  architect: 1,
  project_manager: 2,
  admin: 99,
};

// Candidate group tokens: the known platform groups (including the privileged
// `admin`) plus arbitrary noise strings that should be ignored.
const groupArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom<PlatformGroup>('developer', 'architect', 'project_manager', 'admin'),
  fc.string(),
);

describe('least-privilege policy', () => {
  describe('resolveRole', () => {
    it('P4: never returns a privileged group for any candidate set', () => {
      fc.assert(
        fc.property(fc.array(groupArb), (candidates) => {
          const result = resolveRole(candidates);
          expect(PRIVILEGED_GROUPS.has(result)).toBe(false);
          expect(result).not.toBe('admin');
        }),
      );
    });

    it('P3: returns the highest-privilege assignable group present in candidates', () => {
      fc.assert(
        fc.property(fc.array(groupArb), (candidates) => {
          const result = resolveRole(candidates);
          const expected = candidates
            .filter((c): c is PlatformGroup => ASSIGNABLE.includes(c as PlatformGroup))
            .reduce<PlatformGroup>(
              (best, c) => (PRIORITY[c] > PRIORITY[best] ? c : best),
              DEFAULT_GROUP,
            );
          expect(result).toBe(expected);
        }),
      );
    });

    it('defaults to least privilege when no assignable candidate is present', () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('admin', 'unknown', 'superuser', '')),
          (candidates) => {
            expect(resolveRole(candidates)).toBe(DEFAULT_GROUP);
          },
        ),
      );
    });

    it('always returns a known platform group', () => {
      const known: PlatformGroup[] = [...ASSIGNABLE, 'admin'];
      fc.assert(
        fc.property(fc.array(groupArb), (candidates) => {
          expect(known).toContain(resolveRole(candidates));
        }),
      );
    });

    it('picks the more privileged of two assignable candidates regardless of order', () => {
      expect(resolveRole(['developer', 'project_manager'])).toBe('project_manager');
      expect(resolveRole(['project_manager', 'developer'])).toBe('project_manager');
      expect(resolveRole(['architect', 'developer'])).toBe('architect');
    });

    it('ignores admin even when it is the only candidate', () => {
      expect(resolveRole(['admin'])).toBe(DEFAULT_GROUP);
      expect(resolveRole(['admin', 'architect'])).toBe('architect');
    });
  });

  describe('isPrivilegedGroup', () => {
    it('flags admin as privileged and assignable/unknown groups as not', () => {
      expect(isPrivilegedGroup('admin')).toBe(true);
      expect(isPrivilegedGroup('developer')).toBe(false);
      expect(isPrivilegedGroup('architect')).toBe(false);
      expect(isPrivilegedGroup('project_manager')).toBe(false);
      expect(isPrivilegedGroup('anything-else')).toBe(false);
    });
  });

  it('DEFAULT_GROUP is least-privilege and not itself privileged', () => {
    expect(DEFAULT_GROUP).toBe('developer');
    expect(PRIVILEGED_GROUPS.has(DEFAULT_GROUP)).toBe(false);
  });
});
