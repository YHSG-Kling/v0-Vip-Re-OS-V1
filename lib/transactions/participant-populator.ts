/**
 * lib/transactions/participant-populator.ts
 *
 * Auto-populate transaction_participants on transaction creation.
 *
 * Sources (in order of confidence):
 *   1. BUYER         — offers.contact_id  →  contacts row (name/email/phone)
 *   2. BUYER_AGENT   — offers.agent_id    →  agents → users (name/email/phone, license)
 *   3. SELLER        — listings.seller_contact_id  →  contacts row (when listing exists)
 *   4. SELLER_AGENT  — listings.agent_id           →  agents → users (when listing exists)
 *   5. LENDER        — vendor_directory.preferred WHERE category='lender' AND
 *                      (audience_tags @> financing_type OR no tags) for this brokerage
 *   6. TITLE_COMPANY — vendor_directory.preferred WHERE category='title'   for this brokerage
 *   7. INSPECTOR     — vendor_directory.preferred WHERE category='inspector' for this brokerage
 *
 * We never insert a placeholder. If a source has no data, that participant row
 * is simply not created — the agent can add it manually from the transaction
 * UI. This honors the "no stubs/mock data" rule.
 *
 * Idempotent: safe to call multiple times. Each role is inserted at most
 * once per transaction (deduped by (transaction_id, role) within this call,
 * and we skip the entire populator if the transaction already has
 * participants from a prior run).
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

  // Pull offer for financing_type (drives lender selection) + buyer fields
  let offer: any = null
  if (tx.offer_id) {
    const { data } = await supabase
      .from("offers")
      .select("id, financing_type, contact_id, agent_id")
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

  // ── LENDER (from preferred vendors, financing-type aware) ────────────────
  if (offer?.financing_type && offer.financing_type !== "cash") {
    const lender = await pickPreferredVendor(supabase, brokerageId, "lender", offer.financing_type as string)
    if (lender) pending.push({ role: "lender", ...lender })
  }

  // ── TITLE_COMPANY ────────────────────────────────────────────────────────
  const title = await pickPreferredVendor(supabase, brokerageId, "title", null)
  if (title) pending.push({ role: "title_company", ...title })

  // ── INSPECTOR ────────────────────────────────────────────────────────────
  const inspector = await pickPreferredVendor(supabase, brokerageId, "inspector", null)
  if (inspector) pending.push({ role: "inspector", ...inspector })

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

/**
 * Pick the brokerage's preferred vendor for a category, optionally filtered
 * by a tag (used by lender selection to match the offer's financing_type).
 * Returns null when no preferred vendor is on file — the agent will populate
 * the transaction participant manually in that case.
 */
async function pickPreferredVendor(
  supabase: SupabaseClient,
  brokerageId: string,
  category: "lender" | "title" | "inspector",
  preferredTag: string | null,
): Promise<{ name: string; company?: string | null; email?: string | null; phone?: string | null } | null> {
  let q = supabase
    .from("vendor_directory")
    .select("id, name, email, phone, website, audience_tags, display_priority, rating, preferred, category")
    .eq("brokerage_id", brokerageId)
    .eq("category", category)
    .eq("preferred", true)
    .order("display_priority", { ascending: false, nullsFirst: false })
    .order("rating",           { ascending: false, nullsFirst: false })

  // Tag-aware match (e.g., financing_type for lenders). Postgres ARRAY ops
  // via PostgREST: `cs` = contains.
  if (preferredTag) {
    // First try a tagged match; if no row, fall back to the untagged top-priority pick.
    const { data: tagged } = await q.contains("audience_tags", [preferredTag]).limit(1).maybeSingle()
    if (tagged) {
      return {
        name:    tagged.name,
        company: tagged.name,
        email:   tagged.email,
        phone:   tagged.phone,
      }
    }
  }

  const { data: fallback } = await q.limit(1).maybeSingle()
  if (!fallback) return null
  return {
    name:    fallback.name,
    company: fallback.name,
    email:   fallback.email,
    phone:   fallback.phone,
  }
}
