/**
 * lib/transactions/participant-populator.ts
 *
 * Auto-populate transaction_participants on transaction creation — ONLY for
 * the people the brokerage actually knows from the offer + listing.
 *
 * Sources (real data only):
 *   1. BUYER         — offers.contact_id  →  contacts row (name/email/phone)
 *   2. BUYER_AGENT   — offers.agent_id    →  agents → users (name/email/phone, license)
 *   3. SELLER        — listings.seller_contact_id  →  contacts row (when in-house listing)
 *   4. SELLER_AGENT  — listings.agent_id           →  agents → users (when in-house listing)
 *
 * DELIBERATELY NOT AUTO-POPULATED:
 *   - LENDER   — comes from the buyer's pre-approval letter, not from any
 *                brokerage preference. Agent / lender-doc parser fills this
 *                in once the PAL is uploaded.
 *   - TITLE    — comes from the contract itself (the offer dictates the title
 *                company). Agent fills from contract text or contract-parsing.
 *   - INSPECTOR — there may be several preferred inspectors; we don't pick
 *                 one for the agent. Filled in when the inspection is
 *                 scheduled.
 *
 * Brokerage preferred-vendor list still drives the UI typeahead when the
 * agent is filling those fields — but we never auto-insert them as
 * participants. Honors "no stubs / never assume the transaction team".
 *
 * Idempotent: safe to call multiple times. Skips entirely if the transaction
 * already has any participants.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export interface PopulateResult {
  inserted_count: number
  roles_inserted: string[]
  skipped_existing: boolean
}

interface PendingParticipant {
  role:           string
  name:           string
  company?:       string | null
  email?:         string | null
  phone?:         string | null
  license_number?: string | null
  notes?:         string | null
}

/**
 * Populate transaction_participants for a freshly-created transaction.
 *
 * @param supabase     Service client (this runs from server-side webhook /
 *                     server-action context — no RLS guarantees from the caller).
 * @param transactionId The transaction whose participants we're seeding.
 * @param brokerageId   Brokerage scope for vendor_directory lookups.
 */
export async function populateInitialParticipants(
  supabase: SupabaseClient,
  transactionId: string,
  brokerageId: string,
): Promise<PopulateResult> {
  // Skip if any participants already exist for this transaction — idempotency
  // guard for webhook retries.
  const { count: existingCount } = await supabase
    .from("transaction_participants")
    .select("id", { count: "exact", head: true })
    .eq("transaction_id", transactionId)
  if ((existingCount ?? 0) > 0) {
    return { inserted_count: 0, roles_inserted: [], skipped_existing: true }
  }

  // Look up the transaction + offer + listing fan-out in one round
  const { data: tx } = await supabase
    .from("transactions")
    .select("id, brokerage_id, offer_id, listing_id, buyer_contact_id, seller_contact_id, agent_id")
    .eq("id", transactionId)
    .maybeSingle()
  if (!tx) return { inserted_count: 0, roles_inserted: [], skipped_existing: false }

  // Pull offer for buyer fields. We deliberately do NOT read financing_type
  // here — lender is sourced from the buyer's pre-approval letter, not from
  // a brokerage preferred-vendor list. Agent fills lender after PAL upload.
  let offer: any = null
  if (tx.offer_id) {
    const { data } = await supabase
      .from("offers")
      .select("id, contact_id, agent_id")
      .eq("id", tx.offer_id)
      .maybeSingle()
    offer = data ?? null
  }

  // Pull listing for seller-side participants when in-house listing
  let listing: any = null
  if (tx.listing_id) {
    const { data } = await supabase
      .from("listings")
      .select("id, agent_id, seller_contact_id")
      .eq("id", tx.listing_id)
      .maybeSingle()
    listing = data ?? null
  }

  const pending: PendingParticipant[] = []

  // ── BUYER ─────────────────────────────────────────────────────────────────
  const buyerContactId = (tx.buyer_contact_id as string | null) ?? (offer?.contact_id as string | null) ?? null
  if (buyerContactId) {
    const { data: buyer } = await supabase
      .from("contacts")
      .select("first_name, last_name, email, phone")
      .eq("id", buyerContactId)
      .maybeSingle()
    if (buyer) {
      const name = [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim()
      if (name) {
        pending.push({
          role:  "buyer",
          name,
          email: buyer.email ?? null,
          phone: buyer.phone ?? null,
        })
      }
    }
  }

  // ── BUYER_AGENT ───────────────────────────────────────────────────────────
  const buyerAgentId = (tx.agent_id as string | null) ?? (offer?.agent_id as string | null) ?? null
  if (buyerAgentId) {
    const buyerAgent = await resolveAgent(supabase, buyerAgentId)
    if (buyerAgent) pending.push({ role: "buyer_agent", ...buyerAgent })
  }

  // ── SELLER ────────────────────────────────────────────────────────────────
  const sellerContactId = (tx.seller_contact_id as string | null) ?? (listing?.seller_contact_id as string | null) ?? null
  if (sellerContactId) {
    const { data: seller } = await supabase
      .from("contacts")
      .select("first_name, last_name, email, phone")
      .eq("id", sellerContactId)
      .maybeSingle()
    if (seller) {
      const name = [seller.first_name, seller.last_name].filter(Boolean).join(" ").trim()
      if (name) {
        pending.push({
          role:  "seller",
          name,
          email: seller.email ?? null,
          phone: seller.phone ?? null,
        })
      }
    }
  }

  // ── SELLER_AGENT (a.k.a. listing agent) ──────────────────────────────────
  if (listing?.agent_id) {
    const sellerAgent = await resolveAgent(supabase, listing.agent_id as string)
    if (sellerAgent) pending.push({ role: "seller_agent", ...sellerAgent })
  }

  // ── LENDER (from buyer's most-recent PAL on file) ────────────────────────
  // No brokerage preferred-vendor fallback — lender comes from the actual
  // pre-approval letter the buyer's lender issued. The universal scanner
  // already extracted lender_name + loan_type + max_loan_amount when the
  // PAL was uploaded.
  if (buyerContactId) {
    const { data: palDoc } = await supabase
      .from("documents")
      .select("extracted_fields")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", buyerContactId)
      .eq("classification", "pre_approval_letter")
      .order("scanned_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    const lenderName = (palDoc?.extracted_fields as any)?.lender_name?.toString().trim()
    if (lenderName) {
      const ef = palDoc?.extracted_fields as any
      pending.push({
        role:    "lender",
        name:    lenderName,
        company: lenderName,
        notes: [
          ef?.loan_type        ? `Loan type: ${ef.loan_type}`         : null,
          ef?.max_loan_amount  ? `Max loan: $${ef.max_loan_amount}`   : null,
          ef?.borrower_name    ? `Borrower: ${ef.borrower_name}`      : null,
          ef?.expires_at       ? `PAL expires: ${ef.expires_at}`      : null,
        ].filter(Boolean).join(" · ") || null,
      })
    }
  }

  // ── TITLE_COMPANY (from the executed signed contract on file) ────────────
  // Title is dictated by the contract — scanner extracts title_company when
  // the signed contract is uploaded.
  if (buyerContactId) {
    const { data: contractDoc } = await supabase
      .from("documents")
      .select("extracted_fields")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", buyerContactId)
      .eq("classification", "signed_contract")
      .order("scanned_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    const titleCompany = (contractDoc?.extracted_fields as any)?.title_company?.toString().trim()
    if (titleCompany) {
      const ef = contractDoc?.extracted_fields as any
      pending.push({
        role:    "title_company",
        name:    titleCompany,
        company: titleCompany,
        notes:   ef?.title_officer ? `Officer: ${ef.title_officer}` : null,
      })
    }
  }

  // INSPECTOR is still NOT auto-populated — agent picks per deal, multiple
  // preferred inspectors exist, and we don't have a single source of truth
  // for which one this deal will use.

  // Insert all collected participants in one statement
  if (pending.length === 0) {
    return { inserted_count: 0, roles_inserted: [], skipped_existing: false }
  }

  const rows = pending.map(p => ({
    transaction_id:  transactionId,
    brokerage_id:    brokerageId,
    role:            p.role,
    name:            p.name,
    company:         p.company ?? null,
    email:           p.email ?? null,
    phone:           p.phone ?? null,
    license_number:  p.license_number ?? null,
    notes:           p.notes ?? null,
  }))

  const { error: insertErr } = await supabase
    .from("transaction_participants")
    .insert(rows)
  if (insertErr) {
    console.error("[participant-populator] insert failed:", insertErr.message)
    return { inserted_count: 0, roles_inserted: [], skipped_existing: false }
  }

  return {
    inserted_count: rows.length,
    roles_inserted: pending.map(p => p.role),
    skipped_existing: false,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve an agent's display name + email + phone + license by joining
 * agents → users. Returns null when the agent / user rows are missing.
 */
async function resolveAgent(
  supabase: SupabaseClient,
  agentId: string,
): Promise<{ name: string; email?: string | null; phone?: string | null; license_number?: string | null } | null> {
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, user_id, license_number")
    .eq("id", agentId)
    .maybeSingle()
  if (!agentRow?.user_id) return null

  const { data: user } = await supabase
    .from("users")
    .select("first_name, last_name, email, phone")
    .eq("id", agentRow.user_id)
    .maybeSingle()
  if (!user) return null

  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim()
  if (!name) return null

  return {
    name,
    email:          user.email ?? null,
    phone:          (user as any).phone ?? null,
    license_number: agentRow.license_number ?? null,
  }
}

