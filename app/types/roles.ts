// app/types/roles.ts
// Canonical definitions live in lib/security/types.ts — re-exported here for
// backward compatibility with any app-layer code that imports from this path.
export type { UserRole, CanonicalRole, LegacyRole, RawRole, RoleConfig, UserContext } from '@/lib/security'
export {
  toCanonicalRole,
  toCanonicalRoleOrDefault,
  toCanonicalRoles,
  isCanonicalRole,
  CANONICAL_ROLE_CONFIG,
} from '@/lib/security'

// TOMBSTONE (§1.1 + §6, 2026-08-31, lane M4): `ROLE_CONFIG` deleted — a
// near-verbatim second copy of the role config map that no file ever imported.
// SURVIVOR: CANONICAL_ROLE_CONFIG, lib/security/types.ts:244 (re-exported
// above), which is keyed by CanonicalRole and already carries the corrected
// wording this copy lacked ("Brokerage system administrator"). Nothing merged:
// this copy's only difference was restating each entry's key as a `role`
// field, which Record keys already provide. (app/components/portal/
// DealTeamCard.tsx has its own local ROLE_CONFIG — deal-team display
// labels+colors, a different capability that happens to share the name.)
