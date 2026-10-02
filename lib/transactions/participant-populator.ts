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
 * Idempotent: safe to call multiple times. Fills only the roles the transaction
 * does not already hold (wave 96 — it used to skip entirely on ANY row).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveOutsideAgentForDeal } from "@/lib/offers/outside-agent-record"

export interface PopulateResult {
  inserted_count: number
  roles_inserted: string[]
  skipped_existing: boolean
  /** Set when a read or the insert was REFUSED — never read as "nobody to add". */
  error?: string
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
  // IDEMPOTENT PER ROLE, NOT PER TRANSACTION (wave 96, lane 96A). This used to skip
  // ENTIRELY when the deal held ANY participant row. A second writer can land first:
  // lib/documents/auto-populate-participants.ts lifts the title company off the
  // executed contract the moment its scan settles — and the contract is uploaded
  // right before the accept (the 95A walk's S9a → S9). One title row then kept the
  // whole roster off the deal: no buyer, no seller, and NO COOPERATING BUYER'S
  // AGENT — so notifyTransactionParties (the accept moment's owner) had nobody
  // outside to email. Each role is now filled only when the deal lacks it, which is
  // the same rule auto-populate-participants already keeps. FAIL CLOSED: a refused
  // read inserts nothing and says so (a retry is safe; a duplicate roster is not).
  const { data: existingRows, error: existingErr } = await supabase
    .from("transaction_participants")
    .select("role")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
  if (existingErr) {
    console.error(`[participant-populator] existing roster read refused for ${transactionId}: ${existingErr.message}`)
    return { inserted_count: 0, roles_inserted: [], skipped_existing: false, error: `existing roster read refused: ${existingErr.message}` }
  }
  const existingRoles = new Set(((existingRows ?? []) as Array<{ role: string | null }>).map((r) => String(r.role ?? "").toLowerCase()))

  // Look up the transaction + offer + listing fan-out in one round
  const { data: tx, error: txErr } = await supabase
    .from("transactions")
    .select("id, brokerage_id, offer_id, listing_id, buyer_contact_id, seller_contact_id, agent_id")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (txErr) return { inserted_count: 0, roles_inserted: [], skipped_existing: false, error: `transaction read refused: ${txErr.message}` }
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
  // THE COOPERATING AGENT FIRST (wave 94, lane 94B). An offer that arrived from
  // an outside buyer's agent carries their outside_agents record
  // (offers.metadata.outside_agent_id, walked up the counter chain). On such a
  // deal `offers.agent_id` / `transactions.agent_id` is OUR listing agent — the
  // old read put the listing agent on the roster TWICE (buyer_agent and
  // seller_agent) and the real buyer's agent nowhere, so notifyTransactionParties
  // could never email them the terms. A refused read is logged, never mistaken
  // for "no outside agent": the in-house fallback below only runs when the
  // chain genuinely names none.
  let cooperating: Awaited<ReturnType<typeof resolveOutsideAgentForDeal>> = { agent: null, offerId: null, error: null }
  if (tx.offer_id) {
    cooperating = await resolveOutsideAgentForDeal(supabase, { brokerageId, offerId: tx.offer_id as string })
    if (cooperating.error) console.error(`[participant-populator] cooperating agent lookup for ${transactionId}: ${cooperating.error}`)
  }
  const outsideAgent = cooperating.agent
  const outsideName = outsideAgent
    ? (outsideAgent.full_name ?? [outsideAgent.first_name, outsideAgent.last_name].filter(Boolean).join(" ")).trim() || outsideAgent.email
    : null
  if (outsideAgent && outsideName) {
    pending.push({
      role:           "buyer_agent",
      name:           outsideName,
      company:        outsideAgent.outside_brokerage_name ?? null,
      email:          outsideAgent.email ?? null,
      phone:          outsideAgent.phone ?? null,
      license_number: outsideAgent.license_number ?? null,
      notes:          "Cooperating buyer's agent (outside brokerage) — copied by email on deal activity.",
    })
  } else if (!cooperating.error) {
    const buyerAgentId = (tx.agent_id as string | null) ?? (offer?.agent_id as string | null) ?? null
    if (buyerAgentId) {
      const buyerAgent = await resolveAgent(supabase, buyerAgentId)
      if (buyerAgent) pending.push({ role: "buyer_agent", ...buyerAgent })
    }
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

  // Insert all collected participants in one statement — only the roles the deal
  // does not already hold (see the per-role rule at the top).
  const missing = pending.filter(p => !existingRoles.has(p.role.toLowerCase()))
  if (missing.length === 0) {
    return { inserted_count: 0, roles_inserted: [], skipped_existing: pending.length > 0 }
  }

  const rows = missing.map(p => ({
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
    return { inserted_count: 0, roles_inserted: [], skipped_existing: false, error: `roster insert refused: ${insertErr.message}` }
  }

  return {
    inserted_count: rows.length,
    roles_inserted: missing.map(p => p.role),
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

