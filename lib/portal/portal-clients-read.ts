// lib/portal/portal-clients-read.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE portal-clients roster read — one composition, two callers:
//   • platform staff (god console tenant page, app/actions/superadmin/portal-clients.ts)
//   • the TENANT's own staff (app/actions/portal-invites.ts → /crm/portal-clients)
// Extracted verbatim from the round-31 staff action so the tenant mirror can
// never drift from the staff view. Pure reads over EXISTING streams
// (portal_contact_invites, contacts, portal_event_stream, site_activity) —
// no new tables. Caller is responsible for the auth gate; this function only
// composes for a given brokerageId.

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/**
 * WHO INVITED THIS CLIENT.
 *
 * `portal_contact_invites.invited_by` is stamped on every invite the core issues
 * (lib/portal/portal-invite-core.ts:185-189, bound to the SESSION so it cannot be
 * forged) and was selected by nothing — so a roster of portal clients could say
 * when access was granted but never by whom.
 *
 * IDENTITY CLASS, verified not assumed: scripts/schema-fk-map.ts:588 records
 * `portal_contact_invites.invited_by → users`. It is a users.id; `agents.id` and
 * `users.id` are disjoint id spaces, so it resolves against `users`.
 *
 * The three states are kept distinct everywhere below — a null NAME is not a null
 * ACTOR:
 *   invitedByUserId null            → nobody recorded (link-only access, or an
 *                                     invite predating the column)
 *   id set, invitedByName null      → recorded, but the account does not resolve
 *                                     inside THIS brokerage (platform staff, or a
 *                                     seat that has since left)
 *   both set                        → the inviter's name
 */
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
  /** users.id of the staffer whose invite this client accepted. Null for link-only access. */
  invitedByUserId: string | null
  /** Tenant-anchored display name for invitedByUserId; null when it does not resolve here. */
  invitedByName: string | null
}

export interface PendingPortalInviteRow {
  id: string
  contactId: string
  name: string
  email: string | null
  status: string
  invitedAt: string | null
  expiresAt: string | null
  /** users.id of whoever sent this invite. See the identity-class note above. */
  invitedByUserId: string | null
  invitedByName: string | null
}

export async function composePortalClientsRead(
  svc: Svc,
  brokerageId: string,
): Promise<{ clients: PortalClientRow[]; pending: PendingPortalInviteRow[] }> {
  const [{ data: invites }, { data: linkedContacts }] = await Promise.all([
    svc.from("portal_contact_invites")
      .select("id, contact_id, email, status, invited_at, accepted_at, expires_at, invited_by")
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
  if (ids.length === 0) return { clients: [], pending: [] }

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
  const invitedByContact = new Map<string, string | null>()
  for (const i of acceptedInvites) {
    if (!i.contact_id) continue
    acceptedAtByContact.set(i.contact_id, i.accepted_at ?? null)
    invitedByContact.set(i.contact_id, i.invited_by ?? null)
  }

  // INVITER NAMES — one batched `.in()` over users, ANCHORED TO THIS BROKERAGE
  // (the command-center name-map pattern). Anchoring is deliberate: this composition
  // serves a tenant surface as well as the god console, so it must never reach a
  // name out of another tenant. An id that does not resolve here is reported as
  // unresolved, not as absent.
  const inviterIds = Array.from(new Set(
    inviteRows.map((i) => i.invited_by).filter((v): v is string => typeof v === "string" && v.length > 0),
  ))
  const inviterNames = new Map<string, string>()
  if (inviterIds.length > 0) {
    const { data: inviters, error: inviterErr } = await svc
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", inviterIds)
      .eq("brokerage_id", brokerageId)
    if (inviterErr) {
      // Additive column: log and fall through with an empty map so every inviter
      // reads "not resolved", never "nobody invited them".
      console.error("[portal-clients-read] inviter name resolution failed:", inviterErr.message)
    }
    for (const u of (inviters ?? []) as any[]) {
      const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
      inviterNames.set(u.id, full || u.email || "Staff member")
    }
  }

  const clientIds = new Set<string>([
    ...acceptedInvites.map((i) => i.contact_id).filter(Boolean),
    ...((linkedContacts ?? []) as any[]).map((c) => c.id),
  ])

  const clients: PortalClientRow[] = [...clientIds].map((cid) => {
    const c = byId.get(cid)
    const inviterId = invitedByContact.get(cid) ?? null
    return {
      contactId: cid,
      name: c ? ([c.first_name, c.last_name].filter(Boolean).join(" ") || "—") : "—",
      email: c?.email ?? null,
      acceptedAt: acceptedAtByContact.get(cid) ?? null,
      userLinked: !!(c?.contact_user_id && linkedSet.has(c.contact_user_id)),
      lastActivityAt: lastActivity.get(cid) ?? null,
      invitedByUserId: inviterId,
      invitedByName: inviterId ? (inviterNames.get(inviterId) ?? null) : null,
    }
  }).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))

  const pending: PendingPortalInviteRow[] = pendingInvites.map((i) => {
    const c = i.contact_id ? byId.get(i.contact_id) : null
    const inviterId = (i.invited_by ?? null) as string | null
    return {
      id: i.id,
      contactId: i.contact_id,
      name: c ? ([c.first_name, c.last_name].filter(Boolean).join(" ") || "—") : "—",
      email: i.email ?? c?.email ?? null,
      status: i.status,
      invitedAt: i.invited_at ?? null,
      expiresAt: i.expires_at ?? null,
      invitedByUserId: inviterId,
      invitedByName: inviterId ? (inviterNames.get(inviterId) ?? null) : null,
    }
  })

  return { clients, pending }
}
