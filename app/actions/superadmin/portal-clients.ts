"use server"

// app/actions/superadmin/portal-clients.ts
// ─────────────────────────────────────────────────────────────────────────────
// PORTAL CLIENTS on the god console — the identity correction made real for the
// roster: portal clients ARE users (user_type='contact', users.id === auth.uid).
// Two surfaces here, both platform-staff gated via the canonical capability gate:
//
//   • listPortalClientsAction   — the tenant's portal state: accepted invites /
//     contacts with portal access (+ whether their users row exists), pending
//     invites, and last portal activity from EXISTING streams (portal_event_stream
//     + site_activity — reused, no new table).
//
//   • backfillPortalClientUsersAction — the retro-fix: sweeps contacts who ALREADY
//     authenticated (accepted invite / stamped contact_user_id / has_login) but
//     predate the ensure hook, and creates their missing public.users row via the
//     SAME core (ensureContactPortalUser) the live portal hook uses. Honest
//     counters {created, alreadyExisted, noAuthUser} — never claims more than the
//     DB accepted. requireWrite + superadmin_audit_log entry.

import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { ensureContactPortalUser } from "@/lib/portal/portal-invite-core"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

async function audit(actorUserId: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { data: actor } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: (actor as any)?.email ?? null, action,
      target_type: "brokerage", target_id: targetId, details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[portal-clients audit] failed:", err) }
}

// ─── LIST — the tenant's portal-client state ─────────────────────────────────
// Composition extracted to lib/portal/portal-clients-read.ts (keep-one) so the
// tenant's own roster (app/actions/portal-invites.ts) can never drift from this
// staff view. This action keeps the platform capability gate.

export type { PortalClientRow, PendingPortalInviteRow } from "@/lib/portal/portal-clients-read"
import { composePortalClientsRead, type PortalClientRow, type PendingPortalInviteRow } from "@/lib/portal/portal-clients-read"

export async function listPortalClientsAction(brokerageId: string): Promise<
  | { ok: true; clients: PortalClientRow[]; pending: PendingPortalInviteRow[] }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!brokerageId) return { ok: false, error: "Brokerage required" }
  const svc = createServiceClient()
  const { clients, pending } = await composePortalClientsRead(svc, brokerageId)
  return { ok: true, clients, pending }
}

// ─── BACKFILL — create missing users rows for already-authenticated clients ──

export interface PortalClientBackfillResult {
  ok: boolean
  /** users rows this run actually created (DB-confirmed). */
  created: number
  /** Auth user existed AND the users row was already there. */
  alreadyExisted: number
  /** Contact has portal access markers but NO auth user — nothing to link yet. */
  noAuthUser: number
  /** Ensure ran but the insert was rejected (ledgered by the write sentinel). */
  failed: number
  error?: string
}

/** Build email(lowercased) → auth uid + the full auth-uid set, via admin listUsers. */
async function loadAuthIndex(svc: ReturnType<typeof createServiceClient>): Promise<{ byEmail: Map<string, string>; ids: Set<string> }> {
  const byEmail = new Map<string, string>()
  const ids = new Set<string>()
  const perPage = 1000
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage })
    if (error) break
    const users = data?.users ?? []
    for (const u of users) {
      ids.add(u.id)
      if (u.email) byEmail.set(u.email.toLowerCase(), u.id)
    }
    if (users.length < perPage) break
  }
  return { byEmail, ids }
}

export async function backfillPortalClientUsersAction(
  brokerageId: string,
): Promise<PortalClientBackfillResult> {
  const gate = await requirePlatformCapability("tenants", { requireWrite: true })
  if (!gate.ok || !gate.userId) {
    return { ok: false, created: 0, alreadyExisted: 0, noAuthUser: 0, failed: 0, error: gate.error ?? "Forbidden" }
  }
  if (!brokerageId) return { ok: false, created: 0, alreadyExisted: 0, noAuthUser: 0, failed: 0, error: "Brokerage required" }
  const svc = createServiceClient()

  // Candidates = contacts with evidence of portal access: an ACCEPTED invite,
  // a stamped contact_user_id, or has_login. Deduped by contact id.
  const [{ data: accepted }, { data: linked }] = await Promise.all([
    svc.from("portal_contact_invites")
      .select("contact_id").eq("brokerage_id", brokerageId).eq("status", "accepted").limit(500),
    svc.from("contacts")
      .select("id").eq("brokerage_id", brokerageId).is("deleted_at", null)
      .or("contact_user_id.not.is.null,has_login.eq.true").limit(500),
  ])
  const candidateIds = [...new Set([
    ...((accepted ?? []) as any[]).map((r) => r.contact_id).filter(Boolean),
    ...((linked ?? []) as any[]).map((r) => r.id),
  ])] as string[]

  if (candidateIds.length === 0) {
    return { ok: true, created: 0, alreadyExisted: 0, noAuthUser: 0, failed: 0 }
  }

  const { data: contacts } = await svc.from("contacts")
    .select("id, first_name, last_name, email, brokerage_id, contact_user_id")
    .in("id", candidateIds)

  // Resolve each candidate's AUTH identity: the stamped link when it is a real
  // auth uid, else the invite/contact email against the auth admin index.
  const authIndex = await loadAuthIndex(svc)

  let created = 0, alreadyExisted = 0, noAuthUser = 0, failed = 0
  for (const c of (contacts ?? []) as any[]) {
    let authUserId: string | null = null
    if (c.contact_user_id && authIndex.ids.has(c.contact_user_id)) authUserId = c.contact_user_id
    if (!authUserId && c.email) authUserId = authIndex.byEmail.get(String(c.email).toLowerCase()) ?? null
    if (!authUserId) { noAuthUser++; continue }

    const { data: existing } = await svc.from("users").select("id").eq("id", authUserId).maybeSingle()
    if (existing) {
      alreadyExisted++
      // Still heal a missing link stamp — same core, idempotent.
      await ensureContactPortalUser({
        authUserId, authEmail: c.email ?? null,
        contact: { id: c.id, email: c.email, first_name: c.first_name, last_name: c.last_name, brokerage_id: c.brokerage_id },
      })
      continue
    }

    const res = await ensureContactPortalUser({
      authUserId, authEmail: c.email ?? null,
      contact: { id: c.id, email: c.email, first_name: c.first_name, last_name: c.last_name, brokerage_id: c.brokerage_id },
    })
    if (res.created) created++
    else failed++
  }

  await audit(gate.userId, "portal_clients.users_backfill", brokerageId, {
    candidates: candidateIds.length, created, already_existed: alreadyExisted, no_auth_user: noAuthUser, failed,
  })
  revalidatePath(`/dashboard/superadmin/brokerages/${brokerageId}`)
  return { ok: true, created, alreadyExisted, noAuthUser, failed }
}
