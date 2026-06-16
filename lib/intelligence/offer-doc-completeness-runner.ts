// lib/intelligence/offer-doc-completeness-runner.ts
//
// Live side of OFFER DOC COMPLETENESS — when an offer envelope finishes signing, scan the packet
// (required forms present? all signed?) and, only when it's genuinely complete, hand it to the Deal
// Coordinator on the bus + notify the agent the docs are verified and READY TO SEND TO THE LISTING
// AGENT. If it's incomplete, surface exactly what's missing instead of a false "ready". Idempotent
// per offer. Best-effort; never throws into the webhook.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { scanOfferDocCompleteness, type RequiredForm, type PresentDoc } from "./offer-doc-completeness"

type Svc = ReturnType<typeof createServiceClient>

/** Pull the offer's required forms from its stored selection (best-effort; unknown → not ready). */
function requiredFormsFromOffer(meta: Record<string, unknown> | null): RequiredForm[] {
  const raw = (meta?.selected_form_ids ?? meta?.selected_forms ?? null) as unknown
  if (!Array.isArray(raw)) return []
  const out: RequiredForm[] = []
  for (const f of raw) {
    if (typeof f === "string") out.push({ key: f, label: f })
    else if (f && typeof f === "object") {
      const id = (f as any).id ?? (f as any).key ?? (f as any).name
      if (id) out.push({ key: String(id), label: String((f as any).name ?? id) })
    }
  }
  return out
}

export interface VerifyOfferDocsResult {
  scanned: boolean
  readyForListingAgent: boolean
  missingForms: string[]
  unsignedForms: string[]
}

export async function verifyOfferDocsReady(envelopeId: string, client?: Svc): Promise<VerifyOfferDocsResult> {
  const svc = client ?? createServiceClient()
  const none: VerifyOfferDocsResult = { scanned: false, readyForListingAgent: false, missingForms: [], unsignedForms: [] }
  if (!envelopeId) return none

  // The offer this envelope belongs to.
  const { data: offer } = await svc.from("offers")
    .select("id, brokerage_id, contact_id, listing_id, property_address, metadata, provider_envelope_id")
    .eq("provider_envelope_id", envelopeId).maybeSingle()
  if (!offer) return none
  const o = offer as any

  // Required forms (the agent's selection) + present documents tied to this envelope.
  const required = requiredFormsFromOffer(o.metadata ?? null)
  const { data: docs } = await svc.from("documents")
    .select("document_type, status, metadata")
    .filter("metadata->>signature_request_id", "eq", envelopeId)
  const present: PresentDoc[] = ((docs ?? []) as any[]).map((d) => ({
    key: String(d.metadata?.form_id ?? d.metadata?.form_key ?? d.document_type ?? ""),
    status: String(d.status ?? ""),
  }))

  const scan = scanOfferDocCompleteness(required, present)

  // Idempotent — one readiness handoff per offer.
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", o.brokerage_id)
    .eq("signal_type", "offer_docs_ready").eq("entity_id", o.id).limit(1).maybeSingle()

  if (scan.readyForListingAgent && !prior) {
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      await publishManagerSignal({
        brokerageId: o.brokerage_id, fromManager: "deal_coordinator", toManager: "deal_coordinator",
        signalType: "offer_docs_ready",
        message: `Offer packet verified for ${o.property_address ?? "a property"} — all required forms present and signed. Ready to send to the listing agent.`,
        entityType: "offer", entityId: o.id, contactId: o.contact_id ?? null,
        payload: { listingId: o.listing_id ?? null, formCount: required.length },
      }, svc)
    } catch { /* best-effort */ }

    // Notify the agent the docs are verified + ready to forward.
    try {
      const agentUserId = await resolveAgentUser(svc, o)
      if (agentUserId) {
        await svc.from("notifications").insert({
          user_id: agentUserId, brokerage_id: o.brokerage_id,
          title: "✅ Offer docs verified — ready for the listing agent",
          body: `The signed offer packet for ${o.property_address ?? "your buyer"} passed the completeness check (all required forms present and signed). You can forward it to the listing agent.`,
          type: "offer_docs_ready", entity_type: "offer", entity_id: o.id, priority: "high", is_read: false,
        })
      }
    } catch { /* best-effort */ }
  } else if (scan.knownRequirements && !scan.complete) {
    // Incomplete — surface exactly what's missing rather than a false "ready".
    try {
      const agentUserId = await resolveAgentUser(svc, o)
      if (agentUserId) {
        await svc.from("notifications").insert({
          user_id: agentUserId, brokerage_id: o.brokerage_id,
          title: "⚠️ Offer packet not complete yet",
          body: `Before forwarding ${o.property_address ?? "this offer"} to the listing agent: ${scan.reasons.join("; ")}.`,
          type: "offer_docs_incomplete", entity_type: "offer", entity_id: o.id, priority: "high", is_read: false,
        })
      }
    } catch { /* best-effort */ }
  }

  return { scanned: true, readyForListingAgent: scan.readyForListingAgent, missingForms: scan.missingForms, unsignedForms: scan.unsignedForms }
}

/** Resolve a users.id to notify — the listing's agent, else the contact's agent. Best-effort. */
async function resolveAgentUser(svc: Svc, o: any): Promise<string | null> {
  if (o.listing_id) {
    const { data: l } = await svc.from("listings").select("agent_id").eq("id", o.listing_id).maybeSingle()
    const agentId = (l as any)?.agent_id
    if (agentId) {
      const { data: a } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
      if ((a as any)?.user_id) return (a as any).user_id
    }
  }
  if (o.contact_id) {
    const { data: c } = await svc.from("contacts").select("agent_id").eq("id", o.contact_id).maybeSingle()
    const agentId = (c as any)?.agent_id
    if (agentId) {
      const { data: a } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
      if ((a as any)?.user_id) return (a as any).user_id
    }
  }
  return null
}
