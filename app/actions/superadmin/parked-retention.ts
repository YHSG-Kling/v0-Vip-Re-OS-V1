"use server"

// app/actions/superadmin/parked-retention.ts
// ─────────────────────────────────────────────────────────────────────────────
// PARKED-LEAD RETENTION — the superadmin side of the round-40 governance
// (lib/lead-pipeline/parked-retention.ts): read the tiered posture report, and
// execute the STALE anonymized archival as a PROPOSED-then-approved action.
//
//   • Superadmin-gated (the platform-controls requireSuperadmin idiom) — the
//     stale purge touches cross-tenant platform data no tenant role may reach.
//   • The purge action re-derives its target set at execution time (never
//     trusts a client-supplied id list) and anonymizes IN PLACE: PII columns
//     nulled, zip-level row retained with a purged_at marker. Rows are never
//     deleted.
//   • Every execution is ledgered to superadmin_audit_log with the exact
//     receipt (count + zip breakdown + who/IP/UA) — the audit idiom.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import {
  loadParkedRetention,
  executeStaleParkedPurge,
  type ParkedRetentionReport,
  type PurgeExecutionResult,
} from "@/lib/lead-pipeline/parked-retention"

async function requireSuperadmin(): Promise<
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const isSuper = (data as any)?.user_type === "superadmin" || (data as any)?.platform_role === "superadmin"
  if (!isSuper) return { ok: false, error: "Forbidden — superadmin only" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

/** The tiered retention report + the exact stale-purge preview (read-only). */
export async function getParkedRetentionAction(): Promise<
  | { ok: true; report: ParkedRetentionReport }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const { report, error } = await loadParkedRetention(createServiceClient() as any)
  if (!report) return { ok: false, error: error ?? "parked retention load failed" }
  return { ok: true, report }
}

/**
 * Execute the stale anonymized archival (PII purge, zip-level row retained).
 * Gate → re-derived preview → execute → audit ledger. Batch-capped; the result
 * says when more stale rows remain (re-run to continue — each run is audited).
 */
export async function purgeStaleParkedLeadsAction(): Promise<
  | { ok: true; result: PurgeExecutionResult }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // The preview the ledger records is recomputed HERE — the audit entry always
  // carries what the executor was actually looking at, never a stale UI count.
  const { report } = await loadParkedRetention(svc as any)
  const preview = report?.stalePreview ?? null

  const result = await executeStaleParkedPurge(svc as any)
  if (!result.ok) return { ok: false, error: result.error ?? "purge failed" }

  // Audit — cross-tenant PII destruction is exactly what this ledger exists for.
  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: auth.userId, actor_email: auth.email,
      action: "parked_leads.stale_pii_purged", target_type: "leads", target_id: null,
      details: {
        preview: preview ? { count: preview.count, zips: preview.zips } : null,
        purged: result.purged,
        zips: result.zips,
        more_remaining: result.moreRemaining,
        columns_purged: preview?.columnsPurged ?? null,
        columns_retained: preview?.columnsRetained ?? null,
      },
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[parked-retention] audit write failed:", err)
  }

  return { ok: true, result }
}

/** Form-action wrapper so the server-rendered coverage board can mount the
 *  archival as a plain <form> button (no client JS). Same gate + ledger. */
export async function purgeStaleParkedLeadsFormAction(_formData: FormData): Promise<void> {
  const res = await purgeStaleParkedLeadsAction()
  if (!res.ok) console.error("[parked-retention] purge action refused/failed:", res.error)
  revalidatePath("/dashboard/superadmin/platform")
}
