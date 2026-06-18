"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveContactOwnerAgent } from "@/lib/identity/resolve-contact-owner"

// ─── Auth helper ──────────────────────────────────────────────────────────────
// Previously this file was missing "use server" yet was imported from
// client components (referral forms, etc.) — so it was both a build-
// inconsistency AND every function ran without auth, trusting a caller-
// supplied contactId to scope everything. Any signed-in (or unauth'd
// during server render) caller could enumerate any contact's referrals,
// transaction history, home value estimates, brokerage vendor list, and
// even SUBMIT referrals attributed to another tenant's contact.
//
// requireContactAccess() allows the contact themselves (portal session)
// or any agent/admin in the contact's brokerage.
async function requireContactAccess(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string; isContactSelf: boolean }
  | { ok: false }
> {
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { ok: false }

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("brokerage_id, contact_user_id, email")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact || !contact.brokerage_id) return { ok: false }

  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    !!(contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())

  if (isContactSelf) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: true }
  }

  const { data: callerRow } = await svc
    .from("users").select("brokerage_id, user_type").eq("id", authUser.id).maybeSingle()
  if (callerRow?.brokerage_id === contact.brokerage_id && ["agent","team_lead","tc","admin","broker","superadmin"].includes(((callerRow as any)?.user_type) ?? "")) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: false }
  }

  return { ok: false }
}

// ─── GET LIFETIME CONTEXT ────────────────────────────────────────────────────
export async function getLifetimeContext(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return null

  const supabase = createServiceClient()

  // Get contact (without broken embedded join) — scoped to brokerage
  const { data: contact } = await supabase
    .from("contacts")
    .select(`
      id,
      first_name,
      last_name,
      buyer_stage,
      agent_id
    `)
    .eq("id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()

  if (!contact) return null

  // Resolve agent via kernel identity function
  const agentInfo = contact.agent_id
    ? await resolveContactOwnerAgent(supabase, contact.agent_id)
    : null

  // Get closed transaction — scoped to brokerage
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      status,
      close_date,
      sale_price:purchase_price,
      offer_price:purchase_price,
      created_at
    `)
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .eq("status", "closed")
    .order("close_date", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Get latest home value estimate — scoped
  const { data: homeValueEstimate } = await supabase
    .from("home_value_estimates")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Get recent touchpoints — scoped
  const { data: touchpoints } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("sent_date", { ascending: false })
    .limit(5)

  // Get referrals submitted by this contact — scoped (live schema column is referred_by)
  const { data: referrals } = await supabase
    .from("referrals")
    .select("*")
    .eq("referred_by", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("created_at", { ascending: false })

  // Vendors from caller's brokerage (already auth-scoped)
  const { data: vendors } = await supabase
    .from("vendor_directory")
    .select("id, name, category, phone, email, website, rating, preferred")
    .eq("brokerage_id", access.brokerageId)
    .eq("preferred", true)
    .order("rating", { ascending: false })
    .limit(3)
  const preferredVendors = vendors || []

  // Get neighborhood activity (recent listings near same city/address) — scoped
  let neighborhoodListings: any[] = []
  if (transaction?.property_address) {
    // Extract city/zip from address - simple heuristic: last 2 parts after last comma
    const parts = transaction.property_address.split(",").map((p: string) => p.trim())
    const cityState = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    if (cityState) {
      const { data: nearby } = await supabase
        .from("listings")
        .select("id, address, list_price, status, created_at")
        .eq("brokerage_id", access.brokerageId)
        .ilike("address", `%${cityState}%`)
        .in("status", ["active", "sold", "pending"])
        .neq("id", (transaction as any).listing_id ?? "00000000-0000-0000-0000-000000000000")
        .order("created_at", { ascending: false })
        .limit(5)
      neighborhoodListings = nearby ?? []
    }
  }

  return {
    contact,
    agent: agentInfo,
    transaction,
    homeValueEstimate,
    touchpoints: touchpoints || [],
    referrals: referrals || [],
    preferredVendors,
    neighborhoodListings,
  }
}

// ─── SUBMIT REFERRAL ─────────────────────────────────────────────────────────
export async function submitReferral(data: {
  contactId: string
  referredName: string
  referredContact: string
  relationship?: string
}) {
  const access = await requireContactAccess(data.contactId)
  if (!access.ok) throw new Error("Forbidden")

  const supabase = createServiceClient()

  // Get contact's agent. Note: agent_id can legitimately be NULL when the contact came
  // through the public listing page disclosing they're already represented by another
  // agent (NAR Article 16 — we don't auto-poach). Distinguish "contact missing" (real
  // error) from "contact exists but has no in-house agent" (legitimate state — referral
  // is recorded but routed to the brokerage's referral queue instead of a specific
  // agent).
  const { data: contact } = await supabase
    .from("contacts")
    .select("agent_id, brokerage_id")
    .eq("id", data.contactId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()

  if (!contact) throw new Error("Contact not found")

  // Create referral record using actual referrals schema columns
  const { data: referral, error: referralError } = await supabase
    .from("referrals")
    .insert({
      referred_by: data.contactId,
      referral_name: data.referredName,
      source_contact_name: data.referredName,
      notes: data.referredContact + (data.relationship ? ` (${data.relationship})` : ""),
      status: "received", // CHECK: received|contacted|qualified|assigned|under_contract|closed|lost (no 'new')
      agent_id: contact.agent_id,
      brokerage_id: contact.brokerage_id,
    })
    .select("id")
    .maybeSingle()

  if (referralError) throw referralError

  // Skip the agent-side notification when the contact has no assigned in-house agent
  // (represented buyer case). The referral row is still recorded for the brokerage to
  // route from its referrals queue; the portal message to a specific agent would have
  // no valid recipient.
  if (contact.agent_id) {
    await supabase.from("client_portal_messages").insert({
      contact_id: data.contactId,
      agent_id: contact.agent_id,
      brokerage_id: contact.brokerage_id,
      direction: "client_to_agent",
      channel: "portal",
      read: false,
      body: `New referral: ${data.referredName} (${data.referredContact})${data.relationship ? ` - ${data.relationship}` : ""}`,
    })

    // Emit kernel event - resolve agent via kernel identity function
    const agentData = await resolveContactOwnerAgent(supabase, contact.agent_id)
    await supabase.from("lifecycle_events").insert({
      brokerage_id: agentData?.brokerage_id,
      event_type: KernelEvent.MESSAGE_FROM_CONTACT,
      entity_type: "contact",
      entity_id: data.contactId,
      actor_user_id: contact.agent_id,
      metadata: {
        contact_id: data.contactId,
        referred_name: data.referredName,
        agent_id: contact.agent_id,
        referral_id: referral?.id,
        type: "referral_submitted",
      },
    })
  }

  return referral
}

// ─── GET REFERRAL HISTORY ────────────────────────────────────────────────────
export async function getReferralHistory(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return []

  const supabase = createServiceClient()

  const { data: referrals } = await supabase
    .from("referrals")
    .select(`
      id,
      referred_name:referral_name,
      referred_contact:source_contact_name,
      referral_status:status,
      notes,
      created_at
    `)
    .eq("referred_by", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("created_at", { ascending: false })

  return referrals || []
}

// ─── GET TRANSACTION HISTORY ─────────────────────────────────────────────────
export async function getTransactionHistory(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return null

  const supabase = createServiceClient()

  // Get closed transaction with milestones — scoped
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      status,
      close_date,
      sale_price:purchase_price,
      offer_price:purchase_price,
      offer_date:contract_date,
      created_at,
      transaction_milestones(
        id,
        milestone_name,
        status,
        completed_at,
        target_date
      )
    `)
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .eq("status", "closed")
    .order("close_date", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!transaction) return null

  // Get transaction documents — scoped
  const { data: documents } = await supabase
    .from("transaction_documents")
    .select("id, document_type:doc_type, file_name:doc_label, file_url:storage_url, created_at")
    .eq("transaction_id", transaction.id)
    .eq("brokerage_id", access.brokerageId)
    .order("created_at", { ascending: false })

  return {
    ...transaction,
    documents: documents || [],
  }
}

// ─── GET MARKET UPDATES ──────────────────────────────────────────────────────
export async function getMarketUpdates(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { estimates: [], touchpoints: [] }

  const supabase = createServiceClient()

  // Get home value estimates history — scoped
  const { data: estimates } = await supabase
    .from("home_value_estimates")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("generated_at", { ascending: true })

  // Get market update touchpoints — scoped
  const { data: touchpoints } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .in("touchpoint_type", ["market_update", "anniversary"])
    .order("sent_date", { ascending: false })

  return {
    estimates: estimates || [],
    touchpoints: touchpoints || [],
  }
}

// ─── REQUEST VALUE UPDATE ────────────────────────��───────────────────────────
export async function requestValueUpdate(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) throw new Error("Forbidden")

  const supabase = createServiceClient()

  // Get contact's agent
  const { data: contact } = await supabase
    .from("contacts")
    .select("agent_id, first_name, last_name")
    .eq("id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .single()

  if (!contact?.agent_id) throw new Error("Contact not found")

  // Send message to agent
  await supabase.from("client_portal_messages").insert({
    contact_id: contactId,
    brokerage_id: access.brokerageId,
    agent_id: contact.agent_id,
    direction: "client_to_agent",
    body: `${contact.first_name || "Client"} requested an updated home value estimate.`,
    channel: "portal",
    read: false,
    created_at: new Date().toISOString(),
  })

  return { success: true }
}

// ─── GET VENDOR RESOURCES ────────────────────────────────────────────────────
export async function getVendorResources(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return []

  const supabase = createServiceClient()

  // vendor_directory is a flat table (no vendor_id FK / vendors embed; no is_featured).
  // Real ranking column is display_priority; portal visibility via visible_in_portal.
  const { data: vendors } = await supabase
    .from("vendor_directory")
    .select("id, category, name, phone, email, website, rating, preferred, display_priority, visible_in_portal")
    .eq("brokerage_id", access.brokerageId)
    .eq("visible_in_portal", true)
    .order("display_priority", { ascending: false })

  return vendors || []
}
