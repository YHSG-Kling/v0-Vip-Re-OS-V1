import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveContactOwnerAgent } from "@/lib/identity/resolve-contact-owner"

// ─── GET LIFETIME CONTEXT ────────────────────────────────────────────────────
export async function getLifetimeContext(contactId: string) {
  const supabase = await createClient()

  // Get contact (without broken embedded join)
  const { data: contact } = await supabase
    .from("contacts")
    .select(`
      id,
      first_name,
      last_name,
      name,
      buyer_stage,
      agent_id
    `)
    .eq("id", contactId)
    .single()

  if (!contact) return null

  // Resolve agent via kernel identity function
  const agentInfo = contact.agent_id
    ? await resolveContactOwnerAgent(supabase, contact.agent_id)
    : null

  // Get closed transaction
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      status,
      close_date,
      sale_price,
      offer_price,
      created_at
    `)
    .eq("contact_id", contactId)
    .eq("status", "closed")
    .order("close_date", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Get latest home value estimate
  const { data: homeValueEstimate } = await supabase
    .from("home_value_estimates")
    .select("*")
    .eq("contact_id", contactId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Get recent touchpoints
  const { data: touchpoints } = await supabase
    .from("past_client_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .order("sent_at", { ascending: false })
    .limit(5)

  // Get referrals submitted by this contact
  const { data: referrals } = await supabase
    .from("referrals")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // Get preferred vendors from agent's brokerage
  let preferredVendors: any[] = []
  if (agentInfo?.brokerage_id) {
    const { data: vendors } = await supabase
      .from("vendor_directory")
      .select(`
        id,
        category,
        is_featured,
        vendors:vendor_id(id, business_name, vendor_type, phone, email, website_url, rating_avg)
      `)
      .eq("brokerage_id", agentInfo.brokerage_id)
      .eq("is_featured", true)
      .limit(3)
    
    preferredVendors = vendors || []
  }

  return {
    contact,
    agent: agentInfo,
    transaction,
    homeValueEstimate,
    touchpoints: touchpoints || [],
    referrals: referrals || [],
    preferredVendors,
  }
}

// ─── SUBMIT REFERRAL ─────────────────────────────────────────────────────────
export async function submitReferral(data: {
  contactId: string
  referredName: string
  referredContact: string
  relationship?: string
}) {
  const supabase = await createClient()

  // Get contact's agent
  const { data: contact } = await supabase
    .from("contacts")
    .select("agent_id")
    .eq("id", data.contactId)
    .single()

  if (!contact?.agent_id) throw new Error("Contact not found")

  // Create referral record
  const { data: referral, error: referralError } = await supabase
    .from("referrals")
    .insert({
      contact_id: data.contactId,
      referred_name: data.referredName,
      referred_contact: data.referredContact,
      relationship: data.relationship,
      referral_status: "pending",
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (referralError) throw referralError

  // Send notification to agent via client_portal_messages
  await supabase.from("client_portal_messages").insert({
    contact_id: data.contactId,
    direction: "client_to_agent",
    message_type: "referral",
    content: `New referral: ${data.referredName} (${data.referredContact})${data.relationship ? ` - ${data.relationship}` : ""}`,
    read: false,
    created_at: new Date().toISOString(),
  })

  // Emit kernel event - resolve agent via kernel identity function
  const agentData = await resolveContactOwnerAgent(supabase, contact.agent_id)
  await supabase.from("lifecycle_events").insert({
    brokerage_id: agentData?.brokerage_id,
    event_type: KernelEvent.REFERRAL_ASK_SENT,
    entity_type: "referral",
    entity_id: referral.id,
    metadata: {
      contact_id: data.contactId,
      referred_name: data.referredName,
      agent_id: contact.agent_id,
    },
    created_at: new Date().toISOString(),
  })

  return referral
}

// ─── GET REFERRAL HISTORY ────────────────────────────────────────────────────
export async function getReferralHistory(contactId: string) {
  const supabase = await createClient()

  const { data: referrals } = await supabase
    .from("referrals")
    .select(`
      id,
      referred_name,
      referred_contact,
      relationship,
      referral_status,
      created_at,
      referred_contacts:referred_contact_id(id, first_name, last_name, buyer_stage)
    `)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  return referrals || []
}

// ─── GET TRANSACTION HISTORY ─────────────────────────────────────────────────
export async function getTransactionHistory(contactId: string) {
  const supabase = await createClient()

  // Get closed transaction with milestones
  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      status,
      close_date,
      sale_price,
      offer_price,
      offer_date,
      created_at,
      transaction_milestones(
        id,
        milestone_name,
        status,
        completed_date,
        due_date
      )
    `)
    .eq("contact_id", contactId)
    .eq("status", "closed")
    .order("close_date", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!transaction) return null

  // Get transaction documents
  const { data: documents } = await supabase
    .from("transaction_documents")
    .select("id, document_type, file_name, file_url, created_at")
    .eq("transaction_id", transaction.id)
    .order("created_at", { ascending: false })

  return {
    ...transaction,
    documents: documents || [],
  }
}

// ─── GET MARKET UPDATES ──────────────────────────────────────────────────────
export async function getMarketUpdates(contactId: string) {
  const supabase = await createClient()

  // Get home value estimates history
  const { data: estimates } = await supabase
    .from("home_value_estimates")
    .select("*")
    .eq("contact_id", contactId)
    .order("generated_at", { ascending: true })

  // Get market update touchpoints
  const { data: touchpoints } = await supabase
    .from("past_client_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .in("touchpoint_type", ["market_update", "anniversary"])
    .order("sent_at", { ascending: false })

  return {
    estimates: estimates || [],
    touchpoints: touchpoints || [],
  }
}

// ─── REQUEST VALUE UPDATE ────────────────────────��───────────────────────────
export async function requestValueUpdate(contactId: string) {
  const supabase = await createClient()

  // Get contact's agent
  const { data: contact } = await supabase
    .from("contacts")
    .select("agent_id, first_name, last_name")
    .eq("id", contactId)
    .single()

  if (!contact?.agent_id) throw new Error("Contact not found")

  // Send message to agent
  await supabase.from("client_portal_messages").insert({
    contact_id: contactId,
    direction: "client_to_agent",
    message_type: "request",
    content: `${contact.first_name || "Client"} requested an updated home value estimate.`,
    read: false,
    created_at: new Date().toISOString(),
  })

  return { success: true }
}

// ─── GET VENDOR RESOURCES ────────────────────────────────────────────────────
export async function getVendorResources(contactId: string) {
  const supabase = await createClient()

  // Get contact's agent_id
  const { data: contact } = await supabase
    .from("contacts")
    .select("agent_id")
    .eq("id", contactId)
    .single()

  if (!contact?.agent_id) return []

  // Resolve agent via kernel identity function
  const agentInfo = await resolveContactOwnerAgent(supabase, contact.agent_id)
  const brokerageId = agentInfo?.brokerage_id
  if (!brokerageId) return []

  const { data: vendors } = await supabase
    .from("vendor_directory")
    .select(`
      id,
      category,
      is_featured,
      vendors:vendor_id(id, business_name, vendor_type, phone, email, website_url, rating_avg, is_verified)
    `)
    .eq("brokerage_id", brokerageId)
    .order("is_featured", { ascending: false })

  return vendors || []
}
