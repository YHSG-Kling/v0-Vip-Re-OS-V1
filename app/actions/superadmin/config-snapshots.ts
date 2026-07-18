"use server"

// app/actions/superadmin/config-snapshots.ts
// ─────────────────────────────────────────────────────────────────────────────
// GoHighLevel-style tenant config snapshots from the god console — capture a tenant's
// brand + voice + feature enablement as a reusable template, apply it to other tenants.
// requireSuperadmin-gated, audited (superadmin_audit_log), service-client writes. The
// capture layer is allow-list-based, so a snapshot can never carry a secret.

import { createServiceClient } from "@/lib/supabase/service"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { buildSnapshotPayload, applySnapshotPayload, payloadLeaksSecret, type SnapshotPayload } from "@/lib/platform/config-snapshots"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const h = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "brokerage", target_id: targetId,
      details, ip_address: h.get("x-forwarded-for") ?? h.get("x-real-ip"), user_agent: h.get("user-agent"),
    })
  } catch (err) { console.error("[config-snapshots audit] failed:", err) }
}

export interface SnapshotRow {
  id: string
  name: string
  description: string | null
  sourceBrokerageId: string | null
  createdAt: string
  /** Tier hint for "provision new subscriber from this snapshot" (payload metadata). */
  recommendedTier: string | null
  counts: { global: number; brand: number; voice: number; site: number; features: number }
}

function counts(payload: SnapshotPayload) {
  return {
    global: Object.keys(payload.global ?? {}).length,
    brand: Object.keys(payload.brand ?? {}).length,
    voice: Object.keys(payload.voice ?? {}).length,
    site: Object.keys(payload.site ?? {}).length,
    features: (payload.features ?? []).length,
  }
}

/** Capture a snapshot from a source tenant. */
export async function captureSnapshotAction(params: { sourceBrokerageId: string; name: string; description?: string; recommendedTier?: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!params.sourceBrokerageId || !params.name?.trim()) return { ok: false, error: "Source brokerage + name required" }
  const svc = createServiceClient()

  const payload = await buildSnapshotPayload(params.sourceBrokerageId, svc)
  if (params.recommendedTier?.trim()) payload.recommendedTier = params.recommendedTier.trim()
  // Defence-in-depth: refuse to persist if a secret ever slipped past the allow-list.
  if (payloadLeaksSecret(payload)) return { ok: false, error: "Refused: snapshot would contain a secret field" }

  const { data, error } = await svc.from("platform_config_snapshots").insert({
    name: params.name.trim(), description: params.description ?? null,
    source_brokerage_id: params.sourceBrokerageId, captured_by: auth.userId, payload,
  }).select("id").single()
  if (error || !data) return { ok: false, error: error?.message ?? "Capture failed" }

  await audit(auth.userId, auth.email, "snapshot.capture", params.sourceBrokerageId, { snapshot_id: (data as any).id, name: params.name.trim(), recommended_tier: payload.recommendedTier ?? null, counts: counts(payload) })
  return { ok: true, id: (data as any).id }
}

/** List all snapshots (with a per-layer field count). */
export async function listSnapshotsAction(): Promise<{ ok: true; snapshots: SnapshotRow[] } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data } = await svc.from("platform_config_snapshots").select("id, name, description, source_brokerage_id, payload, created_at").order("created_at", { ascending: false }).limit(100)
  return {
    ok: true,
    snapshots: ((data ?? []) as any[]).map((s) => ({
      id: s.id, name: s.name, description: s.description, sourceBrokerageId: s.source_brokerage_id, createdAt: s.created_at,
      recommendedTier: ((s.payload ?? {}) as SnapshotPayload).recommendedTier ?? null,
      counts: counts((s.payload ?? {}) as SnapshotPayload),
    })),
  }
}

/** Apply a snapshot to a target tenant. */
export async function applySnapshotAction(params: { snapshotId: string; targetBrokerageId: string }): Promise<{ ok: boolean; applied?: string[]; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!params.snapshotId || !params.targetBrokerageId) return { ok: false, error: "Snapshot + target brokerage required" }
  const svc = createServiceClient()

  const { data: snap } = await svc.from("platform_config_snapshots").select("payload, name").eq("id", params.snapshotId).maybeSingle()
  if (!snap) return { ok: false, error: "Snapshot not found" }
  const { data: brk } = await svc.from("brokerages").select("id").eq("id", params.targetBrokerageId).maybeSingle()
  if (!brk) return { ok: false, error: "Target brokerage not found" }

  const { applied } = await applySnapshotPayload((snap as any).payload as SnapshotPayload, params.targetBrokerageId, auth.userId, svc)
  await audit(auth.userId, auth.email, "snapshot.apply", params.targetBrokerageId, { snapshot_id: params.snapshotId, name: (snap as any).name, applied })
  revalidatePath(`/dashboard/superadmin/brokerages/${params.targetBrokerageId}`)
  return { ok: true, applied }
}

/** Delete a snapshot. */
export async function deleteSnapshotAction(snapshotId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { error } = await svc.from("platform_config_snapshots").delete().eq("id", snapshotId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "snapshot.delete", snapshotId, {})
  return { ok: true }
}
