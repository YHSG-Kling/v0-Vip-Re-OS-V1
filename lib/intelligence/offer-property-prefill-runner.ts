// lib/intelligence/offer-property-prefill-runner.ts
//
// Live side of OFFER PROPERTY PREFILL — resolve the KNOWN property/parcel facts for an offer from the
// real records (the linked listing → the transaction → the offer's own property_address), with NO AI
// fabrication: a fact we don't have is returned null so the form field stays blank for the agent.
// Then map those known facts onto the form's fillable fields (pure buildPropertyPrefill). Read-only.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { buildPropertyPrefill, type KnownPropertyFacts, type PropertyPrefillResult } from "./offer-property-prefill"

type Svc = ReturnType<typeof createServiceClient>

export interface ResolvePropertyPrefillArgs {
  listingId?: string | null
  transactionId?: string | null
  offerId?: string | null
  /** a raw property address the agent already typed (used only if no record carries it). */
  propertyAddress?: string | null
}

/**
 * Resolve KNOWN property/parcel facts for an offer. Grounded only — every value traces to a real row;
 * anything not on file stays null (blank for the agent). legal_description lives on the listing /
 * transaction record since m768 (wave 141, lane 141C — written by lib/forms/legal-description.ts from
 * the agent or RentCast's property record, never a model); until that migration is applied the
 * column read is refused (42703), logged, and the fact stays honestly null. Never throws.
 */
export async function resolveKnownPropertyFacts(args: ResolvePropertyPrefillArgs, client?: Svc): Promise<KnownPropertyFacts> {
  const svc = client ?? createServiceClient()
  const facts: KnownPropertyFacts = {
    address: args.propertyAddress?.trim() || null,
    legalDescription: null, // filled from the record's legal_description below when it carries one
    legalDescriptionSource: null,
    apn: null,
    county: null,
    propertyCity: null,
    propertyState: null,
    propertyZip: null,
  }
  const legalOf = (row: Record<string, unknown> | null | undefined): string | null => {
    const v = row?.legal_description
    return typeof v === "string" && v.trim() ? v.trim() : null
  }
  const legalSourceOf = (row: Record<string, unknown> | null | undefined): string | null => {
    const v = row?.legal_description_source
    return typeof v === "string" && v.trim() ? v.trim() : null
  }

  // 1. The linked listing is the most authoritative property record we hold.
  if (args.listingId) {
    const { data: l, error: lErr } = await svc.from("listings").select("address, city, state, zip, legal_description, legal_description_source").eq("id", args.listingId).maybeSingle()
    if (lErr) console.error(`[offer-property-prefill] listings read refused (legal_description needs m768 applied?): ${lErr.message}`)
    if (l) {
      facts.address = facts.address ?? ((l as any).address ?? null)
      facts.propertyCity = (l as any).city ?? null
      facts.propertyState = (l as any).state ?? null
      facts.propertyZip = (l as any).zip ?? null
      facts.legalDescription = legalOf(l as Record<string, unknown>)
      facts.legalDescriptionSource = facts.legalDescription ? legalSourceOf(l as Record<string, unknown>) : null
    }
  }

  // 2. The transaction carries property_address/city/state/zip (e.g. an external-MLS buy).
  if (args.transactionId && (!facts.address || !facts.propertyCity || !facts.legalDescription)) {
    const { data: t, error: tErr } = await svc.from("transactions").select("property_address, property_city, property_state, property_zip, legal_description, legal_description_source").eq("id", args.transactionId).maybeSingle()
    if (tErr) console.error(`[offer-property-prefill] transactions read refused (legal_description needs m768 applied?): ${tErr.message}`)
    if (t) {
      facts.address = facts.address ?? ((t as any).property_address ?? null)
      facts.propertyCity = facts.propertyCity ?? ((t as any).property_city ?? null)
      facts.propertyState = facts.propertyState ?? ((t as any).property_state ?? null)
      facts.propertyZip = facts.propertyZip ?? ((t as any).property_zip ?? null)
      if (!facts.legalDescription) {
        facts.legalDescription = legalOf(t as Record<string, unknown>)
        facts.legalDescriptionSource = facts.legalDescription ? legalSourceOf(t as Record<string, unknown>) : null
      }
    }
  }

  // 3. The offer's own stored property_address, as a last grounded source.
  if (args.offerId && !facts.address) {
    const { data: o } = await svc.from("offers").select("property_address").eq("id", args.offerId).maybeSingle()
    if (o) facts.address = (o as any).property_address ?? null
  }

  return facts
}

/** Resolve known property facts and map them onto the form's fillable fields. Read-only. */
/** @proofSeam a resolve+map convenience combinator; every live caller needs a step BETWEEN the two
 *  (app/actions/buyer-offer/prefill-storage-form.ts calls resolveKnownPropertyFacts alone to merge in
 *  agent-typed city/state before mapping; lib/forms/prefill-property-into-pdf.ts takes facts as an
 *  argument and calls buildPropertyPrefill itself). Both halves ARE wired independently — see
 *  scripts/offer-property-prefill-simulator.ts for the combined-call proof. */
export async function prefillOfferFormProperty(
  formFields: string[], args: ResolvePropertyPrefillArgs, client?: Svc,
): Promise<PropertyPrefillResult & { facts: KnownPropertyFacts }> {
  const facts = await resolveKnownPropertyFacts(args, client)
  return { ...buildPropertyPrefill(formFields, facts), facts }
}
