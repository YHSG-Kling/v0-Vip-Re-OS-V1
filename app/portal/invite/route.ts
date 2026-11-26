// app/portal/invite/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE INVITE-ACCEPTANCE DOOR — the missing reader for
// `portal_contact_invites.invite_token`.
//
// The token was WRITTEN on every invite (lib/portal/portal-invite-core.ts:188,
// `invite_token: randomUUID()`) and resolved by NOTHING: no route in the tree
// read `?token=`, so the one column that identifies an invite to its holder was
// write-only. This route is that reader, and `portal_view` (written on the same
// row, same line) is read here too — it decides where an accepted invite LANDS.
//
// AN INVITE TOKEN IS A CREDENTIAL. The rules it is held to:
//
//  1. IT IS NOT A SESSION. A token alone never admits anybody. The caller must
//     ALREADY be signed in as the invited email; the token then binds that
//     session to this contact by consuming the invite. Treating a bearer token
//     as proof of identity is exactly the bypass the portal's five-rule gate
//     exists to prevent (app/portal/[contactId]/layout.tsx).
//
//  2. NO ENUMERATION ORACLE. An ANONYMOUS caller is redirected to the login page
//     BEFORE the token is looked at, so a good token and a garbage token are
//     byte-identical to anyone who is not already signed in — and cost the same,
//     because no query runs either way. For a SIGNED-IN caller every failure
//     class (malformed, unknown, revoked, expired, already consumed, wrong
//     email, refused read) collapses to ONE redirect. The server logs which it
//     was; the response never says.
//
//  3. SINGLE USE. Consumption is an UPDATE guarded on `status in (pending,sent)`
//     and the affected rows are COUNTED with `.select()` — CLAUDE.md §3: an
//     UPDATE matching nothing resolves exactly like one that worked, so without
//     the count a raced or already-spent token would read as a fresh success.
//
//  4. EXPIRY IS HONOURED, and an expired invite is never resurrected here.
//
//  5. FAIL CLOSED. Every refused read, missing env and thrown client refuses.
//     "Nobody could check" never renders as "checked and fine".
//
//  6. TENANT FROM THE INVITE ROW, never from the request. The contact is
//     re-read and its `brokerage_id` must equal the invite's, so a token can
//     only ever land its holder on the contact it was issued for.

import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Statuses an unspent invite can be in. Mirrors the live CHECK
 *  (scripts/check-vocabularies.ts:1194 — accepted | expired | pending | revoked | sent). */
const SPENDABLE_STATUSES = ["pending", "sent"] as const

/** Where an accepted invite lands, by the view it was issued for
 *  (`portal_contact_invites.portal_view`, same live CHECK: buyer | lifetime | seller). */
function landingPath(contactId: string, portalView: string | null): string {
  switch (portalView) {
    case "seller":
      // The seller's own listing dashboard. If they have no listing the page
      // sends them back to the portal home itself — no dead end.
      return `/portal/${contactId}/listing`
    case "buyer":
      return `/portal/${contactId}/properties`
    default:
      // 'lifetime', and anything the CHECK grows that this route has not learned:
      // the portal home is correct for every view, so an unknown value degrades
      // to the safe landing rather than to a refusal.
      return `/portal/${contactId}`
  }
}

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin
  /** THE ONE REFUSAL. Every failure class returns exactly this. */
  const refuse = (why: string) => {
    console.warn(`[portal/invite] refused: ${why}`)
    return NextResponse.redirect(new URL("/portal/login?error=invite_invalid", origin))
  }

  const token = request.nextUrl.searchParams.get("token")

  // ── Rule 2: the anonymous branch is decided BEFORE the token is examined ────
  // A caller with no session cannot be admitted by any token, so there is
  // nothing to learn from looking one up — and nothing to leak by not.
  let userEmail: string | null = null
  try {
    const session = await createClient()
    const { data, error } = await session.auth.getUser()
    if (error) {
      // A refused session read is not "signed out"; it is unknown. Fail closed
      // to the same anonymous destination.
      console.warn("[portal/invite] session read refused:", error.message)
    }
    userEmail = data?.user?.email?.toLowerCase() ?? null
  } catch (e) {
    console.warn("[portal/invite] session client unavailable:", (e as Error).message)
  }
  if (!userEmail) {
    return NextResponse.redirect(new URL("/portal/login?from=invite", origin))
  }

  if (!token || !UUID_RE.test(token)) return refuse("token missing or malformed")

  let svc: ReturnType<typeof createServiceClient>
  try {
    svc = createServiceClient()
  } catch (e) {
    // No service credentials → the invite cannot be checked. Refuse.
    return refuse(`service client unavailable: ${(e as Error).message}`)
  }

  const { data: invite, error: inviteErr } = await svc
    .from("portal_contact_invites")
    .select("id, contact_id, brokerage_id, email, status, expires_at, portal_view")
    .eq("invite_token", token)
    .maybeSingle()
  // supabase-js RESOLVES a refusal: without this branch "permission denied" and
  // "no such token" arrive identically, and the second is a decision while the
  // first is an outage. Both refuse the caller; only the log tells them apart.
  if (inviteErr) return refuse(`invite read refused: ${inviteErr.message}`)
  if (!invite) return refuse("no invite carries this token")

  const row = invite as {
    id: string
    contact_id: string | null
    brokerage_id: string | null
    email: string | null
    status: string | null
    expires_at: string | null
    portal_view: string | null
  }

  if (!row.contact_id || !row.brokerage_id) return refuse("invite is not anchored to a contact and tenant")
  if (!SPENDABLE_STATUSES.includes(row.status as (typeof SPENDABLE_STATUSES)[number])) {
    // Covers revoked, already-accepted (single use) and expired alike.
    return refuse(`invite status '${row.status}' is not spendable`)
  }
  if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) {
    return refuse("invite expired")
  }
  if (!row.email || row.email.toLowerCase() !== userEmail) {
    // The token is real but this is not the person it was issued to. Same refusal.
    return refuse("signed-in email does not match the invited address")
  }

  // ── Rule 6: the contact must live in the invite's own tenant ───────────────
  const { data: contact, error: contactErr } = await svc
    .from("contacts")
    .select("id, brokerage_id")
    .eq("id", row.contact_id)
    .maybeSingle()
  if (contactErr) return refuse(`contact read refused: ${contactErr.message}`)
  if (!contact) return refuse("invite points at a contact that no longer exists")
  if ((contact as { brokerage_id: string | null }).brokerage_id !== row.brokerage_id) {
    return refuse("invite tenant and contact tenant disagree")
  }

  // ── Rule 3: consume it, and COUNT what was consumed ────────────────────────
  const { data: consumed, error: consumeErr } = await svc
    .from("portal_contact_invites")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", row.id)
    .in("status", SPENDABLE_STATUSES as unknown as string[])
    .select("id")
  if (consumeErr) return refuse(`invite consume refused: ${consumeErr.message}`)
  if ((consumed ?? []).length !== 1) {
    // Zero rows here is NOT success: the guard predicate refused, which means
    // the token was spent between the read above and this write.
    return refuse(`invite consume matched ${(consumed ?? []).length} rows — already spent or raced`)
  }

  return NextResponse.redirect(new URL(landingPath(row.contact_id, row.portal_view), origin))
}
