/**
 * lib/documents/contact-legal-writeback.ts
 *
 * SCANNED DATA → THE CONTACT (owner rule: "scanned document data pulled
 * and added into contact"). The scan already fills the deal (deadlines,
 * provenance); this closes the CONTACT half for the highest-value fact a
 * contract holds: the parties' LEGAL NAMES (contacts.legal_first_name /
 * legal_last_name — columns that existed with a legal_name_source
 * provenance field and no scan writer). Discipline, doc-kernel strict:
 * only from the per-field ledger (parties_signed), only when the
 * extraction is HUMAN-VERIFIED or high-confidence, only into EMPTY
 * fields (additive — a recorded legal name is never overwritten by a
 * scan), and only when the party plausibly IS the contact (pure name
 * match: the contact's first+last both appear in the party string —
 * "Bill Chen" never fills from "Robert Smith Jr"). Every write stamps
 * legal_name_source='document_scan'. data_steward owns identity.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/** PURE: does this signed-party string plausibly name this contact? */
export function partyMatchesContact(party: string, contact: { firstName: string | null; lastName: string | null }): boolean {
  const p = party.trim().toLowerCase()
  const first = (contact.firstName ?? "").trim().toLowerCase()
  const last = (contact.lastName ?? "").trim().toLowerCase()
  if (!p || !first || !last) return false
  return p.includes(first) && p.includes(last)
}

/** PURE: split a legal party string around the matched contact name.
 *  "William Robert Chen" for contact Bill/Chen → first "William Robert", last "Chen". */
export function splitLegalName(party: string, lastName: string): { legalFirst: string; legalLast: string } | null {
  const clean = party.trim().replace(/\s+/g, " ")
  const idx = clean.toLowerCase().lastIndexOf(lastName.trim().toLowerCase())
  if (idx <= 0) return null
  const legalFirst = clean.slice(0, idx).trim().replace(/,$/, "")
  const legalLast = clean.slice(idx).trim()
  if (!legalFirst || !legalLast) return null
  return { legalFirst, legalLast }
}

/** LIVE: after a signed-contract scan (or a verification), pull the parties
 *  from the per-field ledger and fill the deal contacts' EMPTY legal names. */
export async function writebackLegalNames(svc: Svc, input: {
  documentId: string
  transactionId: string | null
  brokerageId: string
}): Promise<{ filled: number }> {
  if (!input.transactionId) return { filled: 0 }

  const { data: fieldRow } = await svc.from("document_field_extractions")
    .select("field_value_json, confidence, verified_at")
    .eq("document_id", input.documentId)
    .eq("field_key", "parties_signed")
    .maybeSingle()
  if (!fieldRow) return { filled: 0 }
  const trusted = (fieldRow as any).verified_at != null || (fieldRow as any).confidence === "high"
  if (!trusted) return { filled: 0 }

  let parties: string[] = []
  const raw = (fieldRow as any).field_value_json
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    parties = (Array.isArray(parsed) ? parsed : [parsed]).map((x: any) => String(x ?? "")).filter(Boolean)
  } catch {
    if (typeof raw === "string" && raw.trim()) parties = [raw.trim()]
  }
  if (parties.length === 0) return { filled: 0 }

  const { data: tx } = await svc.from("transactions")
    .select("buyer_contact_id, contact_id, seller_contact_id")
    .eq("id", input.transactionId).maybeSingle()
  const contactIds = Array.from(new Set([
    (tx as any)?.buyer_contact_id, (tx as any)?.contact_id, (tx as any)?.seller_contact_id,
  ].filter(Boolean))) as string[]
  if (contactIds.length === 0) return { filled: 0 }

  const { data: contacts } = await svc.from("contacts")
    .select("id, first_name, last_name, legal_first_name, legal_last_name")
    .in("id", contactIds).eq("brokerage_id", input.brokerageId)

  let filled = 0
  for (const c of ((contacts ?? []) as any[])) {
    if (c.legal_first_name || c.legal_last_name) continue // additive-only, never overwrite
    const party = parties.find((p) => partyMatchesContact(p, { firstName: c.first_name, lastName: c.last_name }))
    if (!party) continue
    const split = splitLegalName(party, c.last_name ?? "")
    if (!split) continue
    const { error } = await svc.from("contacts").update({
      legal_first_name: split.legalFirst,
      legal_last_name: split.legalLast,
      legal_name_source: "document_scan",
      ...((fieldRow as any).verified_at ? { legal_name_verified_at: new Date().toISOString() } : {}),
    }).eq("id", c.id)
    if (!error) filled++
  }
  return { filled }
}
