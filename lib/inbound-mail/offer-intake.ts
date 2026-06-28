// lib/inbound-mail/offer-intake.ts
// ─────────────────────────────────────────────────────────────────────────────
// EMAIL → OFFER auto-intake (server). The listing agent's email lookout: when an inbound email is an
// offer for an in-house listing, AUTO-create the offer (when the buyer is a known sender contact) and
// kick AI extraction — which, on completion, hands off to the Listing Concierge for the net-sheet
// comparison. When the buyer is unknown, surface a one-tap "confirm" notification to the listing agent
// instead of fabricating an offer. Documents land in Supabase Storage (offer-documents). Best-effort;
// never throws into the webhook.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { looksLikeOffer, matchListingByAddress, assessOfferIntake, type ListingLite } from "./offer-detect"

type Svc = ReturnType<typeof createServiceClient>

export interface InboundOfferAttachment { fileName: string; mime: string; contentB64: string | null }

export interface OfferIntakeResult { handled: boolean; outcome?: "auto" | "confirm"; offerId?: string; listingId?: string }

export async function tryIngestInboundOffer(
  input: {
    brokerageId: string
    subject: string | null
    bodyText: string | null
    fromEmail: string | null
    /** The resolved buyer contact when the SENDER is a known contact (null for outside agents). */
    senderContactId: string | null
    attachments: InboundOfferAttachment[]
  },
  client?: Svc,
): Promise<OfferIntakeResult> {
  const svc = client ?? createServiceClient()
  const pdfs = input.attachments.filter((a) => a.mime === "application/pdf" && a.contentB64)
  if (pdfs.length === 0) return { handled: false }

  // In-house listings in the active pipeline to match the address against.
  const { data: lst } = await svc
    .from("listings")
    .select("id, address, agent_id")
    .eq("brokerage_id", input.brokerageId)
    .in("status", ["active", "coming_soon", "pending"])
    .limit(300)
  const listings = (lst ?? []) as ListingLite[]
  if (listings.length === 0) return { handled: false }

  const fileNames = pdfs.map((p) => p.fileName).join(" ")
  const text = [input.subject, input.bodyText, fileNames].filter(Boolean).join(" \n ")
  const match = matchListingByAddress(text, listings)
  const isOffer = looksLikeOffer(input.subject, fileNames, input.bodyText)
  const decision = assessOfferIntake({
    looksLikeOffer: isOffer,
    listingMatched: !!match,
    senderIsKnownContact: !!input.senderContactId,
  })
  if (decision === "skip" || !match) return { handled: false }

  // CONFIRM — surface to the listing agent to review + ingest (we lack the buyer to auto-create).
  if (decision === "confirm") {
    try {
      const agentUserId = await resolveListingAgentUser(svc, match.agent_id ?? null)
      if (agentUserId) {
        await svc.from("notifications").insert({
          user_id: agentUserId, brokerage_id: input.brokerageId, type: "offer_intake_review",
          title: "📨 Possible offer received by email",
          body: `An email${input.fromEmail ? ` from ${input.fromEmail}` : ""} looks like an offer for ${match.address}. Review and upload it to start the seller net-sheet comparison.`,
          entity_type: "listing", entity_id: match.id, priority: "high", is_read: false,
        })
      }
    } catch (e) { console.error("[offer-intake] confirm notify failed:", e) }
    return { handled: true, outcome: "confirm", listingId: match.id }
  }

  // AUTO — store the offer PDF, create the offer (buyer = known sender contact), kick extraction.
  try {
    const pdf = pdfs[0]
    const buf = Buffer.from(pdf.contentB64 as string, "base64")
    const safe = pdf.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
    const path = `${input.brokerageId}/${match.id}/${Date.now()}-${safe}`
    const { data: up, error: upErr } = await svc.storage
      .from("offer-documents").upload(path, buf, { contentType: "application/pdf", upsert: false })
    if (upErr || !up) return { handled: false }
    const { data: pub } = svc.storage.from("offer-documents").getPublicUrl(up.path)
    const publicUrl = pub.publicUrl
    if (!publicUrl) return { handled: false }

    const { data: offer } = await svc.from("offers").insert({
      listing_id: match.id, contact_id: input.senderContactId, brokerage_id: input.brokerageId,
      agent_id: match.agent_id ?? null,
      offer_price: 0, offer_document_url: publicUrl, offer_document_name: pdf.fileName,
      ai_extraction_status: "pending", offer_type: "standard", current_round: 1,
      status: "submitted", submitted_at: new Date().toISOString(),
    }).select("id").maybeSingle()
    const offerId = (offer as { id: string } | null)?.id
    if (!offerId) return { handled: false }

    // Kick AI extraction — on completion it hands off (data_steward → listing_concierge) the
    // comparison-ready offer for the net sheet.
    const { extractOfferFromPdf } = await import("@/lib/offers/offer-extractor")
    void extractOfferFromPdf({ offerId, brokerageId: input.brokerageId, pdfUrl: publicUrl, listingId: match.id }).catch(() => {})
    return { handled: true, outcome: "auto", offerId, listingId: match.id }
  } catch (e) {
    console.error("[offer-intake] auto-create failed:", e)
    return { handled: false }
  }
}

async function resolveListingAgentUser(svc: Svc, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const { data } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  return (data as { user_id: string | null } | null)?.user_id ?? null
}
