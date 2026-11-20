/**
 * lib/kernel/vendor-seat-contact.ts — THE contacts.vendor_id writer (wave 103, lane 103D; owner
 * answer 2, 2026-10-05: "contacts.vendor_id → vendors IS a live FK (contacts_vendor_id_fkey) — build
 * its writer on the vendor survivor (a vendor seat / marketplace vendor links its own contact row)").
 *
 * THE SURVIVOR THIS EXTENDS: the vendor SEAT activation — app/actions/vendor-invite.ts
 * acceptVendorInviteAction, the ONE moment the platform holds the vendor company (vendor_invitations.
 * vendor_id), the tenant (invitation.brokerage_id) and the human's email (the invitation's, which the
 * login must match). Wave 102.1 (lane 102F, R9) published the census: 514 contacts modules, ZERO
 * vendor_id writers — createVendorRecord / business-card vendor creation insert a vendors row and no
 * contact; vendor_bookings is the vendor↔contact booking fact. This is the missing half (§1 case 2):
 * LINK ONLY — the tenant's existing contact row(s) whose email is the seat's email get vendor_id;
 * no contact is ever created here, a row already on ANOTHER vendor is never re-pointed, a vendor
 * outside the tenant is refused. Provenance through THE one writer (stampFieldProvenance, source
 * `vendor_seat`, purpose self_service — the vendor accepted their own seat — actor = the accepting
 * users.id), landed in the same UPDATE as the value (LAW 5: who / what / when on the row).
 *
 * READERS: lib/contacts/contact-brief.ts ("is a vendor: <category>") and the relationship graph's
 * vendorSeatCorroboration (the vendor's vendor_for edges corroborate the seat).
 *
 * Not server-only: proof-driven with an injected client (scripts/relationship-graph-guard.ts). Every
 * read/write destructures `{ data, error }` (§3); the update is `.select()`ed and counted.
 */

import { stampFieldProvenance, withFieldProvenance, fieldProvenanceOf } from "@/lib/lead-pipeline/enrichment-column-map"

type Client = { from: (table: string) => any }

export const VENDOR_SEAT_PROVENANCE_SOURCE = "vendor_seat"

export interface VendorSeatContactCandidate {
  id: string
  email?: string | null
  vendor_id?: string | null
  enrichment_profile?: Record<string, unknown> | null
}

export interface VendorSeatLinkPlan {
  /** Contact ids to link (vendor_id is empty today). */
  link: string[]
  /** Already linked to THIS vendor — nothing to do. */
  already: string[]
  /** Linked to ANOTHER vendor — reported, never re-pointed (a seat does not steal a row). */
  otherVendor: string[]
}

/** PURE — which of the tenant's email-matched contacts get the seat's vendor_id.
 *  @proofSeam scripts/relationship-graph-guard.ts executes the rule directly. */
export function planVendorSeatContactLinks(candidates: readonly VendorSeatContactCandidate[], vendorId: string): VendorSeatLinkPlan {
  const plan: VendorSeatLinkPlan = { link: [], already: [], otherVendor: [] }
  for (const c of candidates) {
    if (!c?.id) continue
    if (!c.vendor_id) plan.link.push(c.id)
    else if (c.vendor_id === vendorId) plan.already.push(c.id)
    else plan.otherVendor.push(c.id)
  }
  return plan
}

/** PostgREST ilike takes `%` / `_` as wildcards — an address is matched literally. */
function ilikeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export interface LinkVendorSeatContactInput {
  /** The tenant — from the caller's EXISTING context (the invitation row), never a request body. */
  brokerageId: string
  vendorId: string
  /** The seat's email (the invitation's; the login matched it). */
  email: string
  /** users.id of the human accepting the seat (the provenance actor). */
  actorUserId: string | null
}

export type LinkVendorSeatContactResult =
  | { ok: true; linked: string[]; already: string[]; otherVendor: string[]; category: string | null; errors: string[] }
  | { ok: false; reason: "no_tenant" | "no_vendor" | "no_email" | "vendor_not_in_tenant" | "read_refused"; error?: string }

/** THE contacts.vendor_id writer — link only, tenant-pinned, counted, provenance-stamped. */
export async function linkVendorSeatContact(client: Client, input: LinkVendorSeatContactInput): Promise<LinkVendorSeatContactResult> {
  if (!input.brokerageId) return { ok: false, reason: "no_tenant" }
  if (!input.vendorId) return { ok: false, reason: "no_vendor" }
  const email = (input.email ?? "").trim().toLowerCase()
  if (!email) return { ok: false, reason: "no_email" }

  // The vendor must be the tenant's own (fail closed: a seat never links a contact to a foreign vendor).
  const { data: vendor, error: vendorErr } = await client
    .from("vendors")
    .select("id, category")
    .eq("id", input.vendorId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (vendorErr) return { ok: false, reason: "read_refused", error: `vendor read refused: ${vendorErr.message}` }
  if (!vendor) return { ok: false, reason: "vendor_not_in_tenant" }

  const { data: candidates, error: contactsErr } = await client
    .from("contacts")
    .select("id, email, vendor_id, enrichment_profile")
    .eq("brokerage_id", input.brokerageId)
    .ilike("email", ilikeLiteral(email))
    .limit(10)
  if (contactsErr) return { ok: false, reason: "read_refused", error: `contacts read refused: ${contactsErr.message}` }

  const rows = (candidates ?? []) as VendorSeatContactCandidate[]
  const plan = planVendorSeatContactLinks(rows, input.vendorId)
  const linked: string[] = []
  const errors: string[] = []
  const stamp = stampFieldProvenance(["vendor_id"], {
    source: VENDOR_SEAT_PROVENANCE_SOURCE, capability: "vendor.seat_link", purpose: "self_service", actor: input.actorUserId ?? null,
  })
  for (const id of plan.link) {
    const row = rows.find((r) => r.id === id)
    const prior = (row?.enrichment_profile ?? {}) as Record<string, unknown>
    const { data: written, error: writeErr } = await client
      .from("contacts")
      .update({ vendor_id: input.vendorId, enrichment_profile: withFieldProvenance(prior, fieldProvenanceOf(prior), stamp), updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("brokerage_id", input.brokerageId)
      .is("vendor_id", null)
      .select("id")
    if (writeErr) { errors.push(`contact ${id}: ${writeErr.message}`); continue }
    // An UPDATE matching nothing also resolves (CLAUDE.md §3): a concurrent link took the row first.
    if (!written || written.length === 0) { errors.push(`contact ${id}: linked concurrently (kept the first link)`); continue }
    linked.push(id)
  }
  return { ok: true, linked, already: plan.already, otherVendor: plan.otherVendor, category: (vendor as { category?: string | null }).category ?? null, errors }
}
