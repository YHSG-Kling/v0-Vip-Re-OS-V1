/**
 * lib/contacts/resolve-mailing-address.ts
 *
 * Wave 36 — single source of truth for "what address do we mail this
 * contact at". Contacts can hold a mailing_address directly (m146) OR
 * inherit one from the lead row they were promoted from. Callers that
 * need to physically mail a contact should always read through here so
 * the precedence is consistent and the verification flag is honored.
 *
 * Precedence:
 *   1. contacts.mailing_address (+ city/state/zip_code) when
 *      mailing_address_verified=true
 *   2. The most recent lead row this contact promoted from, when its
 *      mailing_address_verified=true
 *   3. null — caller must not mail, address is unverified
 *
 * Returns null on tenant mismatch (caller must pass the tenant scope
 * so we never leak an address across brokerages).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface ResolvedMailingAddress {
  street:  string
  city:    string
  state:   string
  zip:     string
  source:  "contact_direct" | "linked_lead"
  /** Tag we record on the direct_mail_campaigns row so the analytics
   *  cohort can tell direct vs lead-inherited addresses apart. */
  contactId: string
  leadId:    string | null
}

export async function resolveMailingAddressForContact(args: {
  contactId:   string
  brokerageId: string
}): Promise<ResolvedMailingAddress | null> {
  const svc = createServiceClient()

  // 1. Direct from contacts — preferred path.
  const { data: contact } = await svc
    .from("contacts")
    .select("id, brokerage_id, mailing_address, mailing_address_verified, city, state, zip_code")
    .eq("id", args.contactId)
    .maybeSingle()
  const c = contact as {
    id: string
    brokerage_id: string | null
    mailing_address: string | null
    mailing_address_verified: boolean | null
    city: string | null
    state: string | null
    zip_code: string | null
  } | null
  if (!c) return null
  if (c.brokerage_id !== args.brokerageId) return null

  if (
    c.mailing_address_verified === true &&
    c.mailing_address && c.city && c.state && c.zip_code
  ) {
    return {
      street: c.mailing_address,
      city:   c.city,
      state:  c.state,
      zip:    c.zip_code,
      source: "contact_direct",
      contactId: args.contactId,
      leadId:    null,
    }
  }

  // 2. Inherit from the linked lead (leads.contact_id = this contact).
  //    Pick the most recently updated lead whose address is verified.
  const { data: lead } = await svc
    .from("leads")
    .select("id, mailing_address, mailing_address_verified, mailing_city, mailing_state, mailing_zip, updated_at")
    .eq("contact_id", args.contactId)
    .eq("brokerage_id", args.brokerageId)
    .eq("mailing_address_verified", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const l = lead as {
    id: string
    mailing_address: string | null
    mailing_address_verified: boolean | null
    mailing_city: string | null
    mailing_state: string | null
    mailing_zip: string | null
  } | null
  if (l && l.mailing_address && l.mailing_city && l.mailing_state && l.mailing_zip) {
    return {
      street: l.mailing_address,
      city:   l.mailing_city,
      state:  l.mailing_state,
      zip:    l.mailing_zip,
      source: "linked_lead",
      contactId: args.contactId,
      leadId:    l.id,
    }
  }

  return null
}
