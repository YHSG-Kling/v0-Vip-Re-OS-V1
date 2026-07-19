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

export interface PortalClientRow {
  contactId: string
  name: string
  email: string | null
  /** portal_contact_invites.accepted_at when an invite row exists; null for link-only access. */
  acceptedAt: string | null
  /** The identity correction is DONE for this client: a users row exists for their auth uid. */
  userLinked: boolean
  /** Latest portal_event_stream / site_activity timestamp, if any. */
  lastActivityAt: string | null
}

export interface PendingPortalInviteRow {
  id: string
  contactId: string
  name: string
  email: string | null
  status: string
  invitedAt: string | null
  expiresAt: string | null
}

export async function listPortalClientsAction(brokerageId: string): Promise<
  | { ok: true; clients: PortalClientRow[]; pending: PendingPortalInviteRow[] }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!brokerageId) return { ok: false, error: "Brokerage required" }
  const svc = createServiceClient()

  const [{ data: invites }, { data: linkedContacts }] = await Promise.all([
    svc.from("portal_contact_invites")
      .select("id, contact_id, email, status, invited_at, accepted_at, expires_at")
      .eq("brokerage_id", brokerageId)
      .order("invited_at", { ascending: false })
      .limit(200),
    // Contacts with portal access but no invite row (link-shared / legacy).
    svc.from("contacts")
      .select("id, first_name, last_name, email, contact_user_id, has_login")
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)
      .or("contact_user_id.not.is.null,has_login.eq.true")
      .limit(300),
  ])

  const inviteRows = (invites ?? []) as any[]
  const acceptedInvites = inviteRows.filter((i) => i.status === "accepted")
  const pendingInvites = inviteRows.filter((i) => i.status === "pending" || i.status === "sent")

  // Union of portal-client contact ids: accepted invites + link-stamped contacts.
  const contactIds = new Set<string>()
  for (const i of acceptedInvites) if (i.contact_id) contactIds.add(i.contact_id)
  for (const c of (linkedContacts ?? []) as any[]) contactIds.add(c.id)
  for (const i of pendingInvites) if (i.contact_id) contactIds.add(i.contact_id)
  const ids = [...contactIds]
  if (ids.length === 0) return { ok: true, clients: [], pending: [] }

  const [{ data: contacts }, { data: events }, { data: visits }] = await Promise.all([
    svc.from("contacts")
      .select("id, first_name, last_name, email, contact_user_id")
      .in("id", ids),
    // Last portal activity — cheap reads over EXISTING streams, newest-first,
    // reduced to latest-per-contact below.
    svc.from("portal_event_stream")
      .select("contact_id, occurred_at")
      .eq("brokerage_id", brokerageId)
      .order("occurred_at", { ascending: false })
      .limit(500),
    svc.from("site_activity")
      .select("contact_id, occurred_at")
      .eq("brokerage_id", brokerageId)
      .order("occurred_at", { ascending: false })
      .limit(500),
  ])

  const byId = new Map<string, any>()
  for (const c of (contacts ?? []) as any[]) byId.set(c.id, c)

  const lastActivity = new Map<string, string>()
  for (const rows of [(events ?? []) as any[], (visits ?? []) as any[]]) {
    for (const e of rows) {
      if (!e.contact_id || !e.occurred_at) continue
      const prev = lastActivity.get(e.contact_id)
      if (!prev || e.occurred_at > prev) lastActivity.set(e.contact_id, e.occurred_at)
    }
  }

  // Which portal clients already have their users row? (contact_user_id → users.id)
  const linkedUserIds = [...new Set(
    (contacts ?? []).map((c: any) => c.contact_user_id).filter(Boolean) as string[],
  )]
  const linkedSet = new Set<string>()
  if (linkedUserIds.length > 0) {
    const { data: userRows } = await svc.from("users").select("id").in("id", linkedUserIds)
    for (const u of (userRows ?? []) as any[]) linkedSet.add(u.id)
  }

  const acceptedAtByContact = new Map<string, string | null>()
  for (const i of acceptedInvites) if (i.contact_id) acceptedAtByContact.set(i.contact_id, i.accepted_at ?? null)

  const clientIds = new Set<string>([
    ...acceptedInvites.map((i) => i.contact_id).filter(Boolean),
    ...((linkedContacts ?? []) as any[]).map((c) => c.id),
  ])

  const clients: PortalClientRow[] = [...clientIds].map((cid) => {
    const c = byId.get(cid)
    return {
      contactId: cid,
      name: c ? ([c.first_name, c.last_name].filter(Boolean).join(" ") || "—") : "—",
      email: c?.email ?? null,
      acceptedAt: acceptedAtByContact.get(cid) ?? null,
      userLinked: !!(c?.contact_user_id && linkedSet.has(c.contact_user_id)),
      lastActivityAt: lastActivity.get(cid) ?? null,
    }
  }).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))

  const pending: PendingPortalInviteRow[] = pendingInvites.map((i) => {
    const c = i.contact_id ? byId.get(i.contact_id) : null
    return {
      id: i.id,
      contactId: i.contact_id,
      name: c ? ([c.first_name, c.last_name].filter(Boolean).join(" ") || "—") : "—",
      email: i.email ?? c?.email ?? null,
      status: i.status,
      invitedAt: i.invited_at ?? null,
      expiresAt: i.expires_at ?? null,
    }
  })

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
