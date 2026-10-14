// lib/identity/orphan-reconciliation.ts
//
// BATCH identity reconciliation — the missing half of the per-request orphan
// merge already wired at lib/kernel/users.ts::mergeOrphan (called from
// resolveEmailHolder during invite/signup, m266's per-collision path).
//
// m266 also shipped public.reconcile_orphaned_users(), a SECURITY DEFINER RPC
// that scans the WHOLE public.users table for rows whose id does not exist in
// auth.users but whose email DOES match a real auth.users row (the same
// collision mergeOrphan resolves one-at-a-time at invite time), and repoints
// every child row via public.repoint_user_identity() for each. Hidden-wire
// census (d) wave 57: this batch RPC had a migration definition and ZERO
// callers anywhere in the tree — not app/, not lib/, not scripts/. The
// per-request path only catches a collision AT THE MOMENT of a fresh invite;
// a historical orphan (seeded before m266, created by a signup that never hit
// resolveEmailHolder, or left behind by a partial migration) sits unrepointed
// forever with nothing that would ever call the sweep that exists for exactly
// that case. BUILT per orphan doctrine §1.2 (no duplicate existed, capability
// wanted — data_steward owns tenancy/identity integrity, CLAUDE.md §4).
//
// SERVICE CLIENT, DELIBERATELY — same posture as lib/storage/orphan-sweeper.ts.
// A cron has no session; reconcile_orphaned_users() is itself SECURITY DEFINER
// and EXECUTE-revoked from anon/authenticated (m266 grants service_role only),
// so this can only ever run from a server context holding the service key.

import type { createServiceClient } from "@/lib/supabase/service"

export interface OrphanReconciliationDetail {
  email: string
  from: string
  to: string
  children_moved: number
}

export type OrphanReconciliationResult =
  | { outcome: "reconciled"; reconciled: number; detail: OrphanReconciliationDetail[] }
  | { outcome: "refused"; error: string }

/**
 * Run the batch orphan-identity sweep. Destructures { data, error } and reads
 * the error (CLAUDE.md §3 — supabase-js resolves refusals) rather than
 * trusting a thrown exception; reconcile_orphaned_users() itself never
 * throws for "found nothing" (it returns reconciled:0), so a refusal here is
 * always a real refusal (permission, connection, or the function missing),
 * never an empty result dressed as one.
 */
export async function reconcileOrphanedIdentities(
  service: ReturnType<typeof createServiceClient>,
): Promise<OrphanReconciliationResult> {
  const { data, error } = await service.rpc("reconcile_orphaned_users")
  if (error) return { outcome: "refused", error: error.message }
  const reconciled = typeof data?.reconciled === "number" ? data.reconciled : 0
  const detail = Array.isArray(data?.detail) ? (data.detail as OrphanReconciliationDetail[]) : []
  return { outcome: "reconciled", reconciled, detail }
}
