import { bestEffort } from "@/lib/db/best-effort"
import { generateAIResponse } from "@/lib/ai"
import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

// ── Extracted offer shape matching exact offers table columns ─────────────────
export interface ExtractedOfferData {
  offer_price: number | null
  earnest_money: number | null
  closing_date: string | null
  financing_type: string | null
  down_payment_amount: number | null
  down_payment_percent: number | null
  appraisal_contingency_days: number | null
  financing_contingency_days: number | null
  inspection_period_days: number | null
  escalation_clause: boolean
  escalation_cap: number | null
  appraisal_gap: number | null
  closing_cost_contribution: number | null
  due_diligence_fee: number | null
  possession_terms: string | null
  contingencies: string[]
  buyer_notes: string | null
  // ── WHO the offer is from (wave 94, lane 94B). Kept in ai_extracted_data ONLY —
  //    none of these is an offers column, and naming an absent column in the
  //    update below would refuse the WHOLE row (PGRST204). They complete the
  //    outside agent's record and the intake buyer's name, FILL-ONLY
  //    (lib/inbound-mail/offer-intake.ts:afterInboundOfferRead).
  buyer_names?: string[]
  buyer_agent_name?: string | null
  buyer_agent_email?: string | null
  buyer_agent_phone?: string | null
  buyer_agent_brokerage?: string | null
  buyer_agent_license?: string | null
}

// ── Main extractor — called after PDF is stored in Supabase Storage ───────────
export async function extractOfferFromPdf(params: {
  offerId: string
  brokerageId: string
  pdfUrl: string
  listingId: string
  /** CLIENT SEAM (lane 86F): the inbound-mail webhook has no session, and the
   *  cookie client refused its offers update AND its lifecycle_events insert under
   *  RLS. A sessionless caller passes the SERVICE client here; brokerageId is then
   *  the caller's verified tenant and every write below is pinned to it. */
  client?: any
}): Promise<{ success: boolean; error?: string; data?: ExtractedOfferData }> {
  const { offerId, brokerageId, pdfUrl, listingId } = params
  const supabase = params.client ?? await createClient()

  // Mark extraction in progress
  const { error: extractingErr } = await supabase
    .from("offers")
    .update({ ai_extraction_status: "extracting" })
    .eq("id", offerId)
    .eq("brokerage_id", brokerageId)
  if (extractingErr) console.error(`[offer-extractor] extraction-in-progress flag NOT set: ${extractingErr.message}`) // tenant-pinned: the service client (seam above) bypasses RLS

  try {
    // Fetch the PDF as base64 for vision-capable model (gateway url-override download)
    const pdfResp = await callConnector<Buffer>({
      connector: "asset-download", baseUrl: "", path: "", url: pdfUrl,
      method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000,
    })
    if (!pdfResp.ok || !pdfResp.data) throw new Error(`PDF fetch failed: ${pdfResp.status}`)
    const base64Pdf = pdfResp.data.toString("base64")

    const response = await generateAIResponse({
      prompt: `You are a real estate document parser. Extract ONLY the following fields from this offer document.
Return ONLY a valid JSON object. Do not include any explanation, commentary, or markdown.

Required JSON schema:
{
  "offer_price": number or null,
  "earnest_money": number or null,
  "closing_date": "YYYY-MM-DD" or null,
  "financing_type": "conventional" | "fha" | "va" | "cash" | "usda" | "other" or null,
  "down_payment_amount": number or null,
  "down_payment_percent": number or null,
  "appraisal_contingency_days": integer or null,
  "financing_contingency_days": integer or null,
  "inspection_period_days": integer or null,
  "escalation_clause": boolean,
  "escalation_cap": number or null,
  "appraisal_gap": number or null,
  "closing_cost_contribution": number or null,
  "due_diligence_fee": number or null,
  "possession_terms": string or null,
  "contingencies": string[] (list all contingency names),
  "buyer_notes": string or null,
  "buyer_names": string[] (the buyer(s) named on the contract, as written),
  "buyer_agent_name": string or null,
  "buyer_agent_email": string or null,
  "buyer_agent_phone": string or null,
  "buyer_agent_brokerage": string or null,
  "buyer_agent_license": string or null
}`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract offer data from this PDF document"
            },
            {
              type: "file",
              data: base64Pdf,
              mimeType: "application/pdf",
            },
          ],
        },
      ],
      metadata: {
        userId: "system",
        brokerageId: brokerageId,
        feature: "document_parsing",
      },
    })

    // Parse — strip any accidental markdown fences
    const cleaned = response.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
    const extracted: ExtractedOfferData = JSON.parse(cleaned)

    await applyExtractedOfferData(supabase, { offerId, brokerageId, listingId, extracted })
    return { success: true, data: extracted }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    const { error: extractFailedErr } = await supabase
      .from("offers")
      .update({ ai_extraction_status: "failed" })
      .eq("id", offerId)
      .eq("brokerage_id", brokerageId)
    if (extractFailedErr) console.error(`[offer-extractor] extraction failure NOT recorded on the offer (it will read as extracting): ${extractFailedErr.message}`)

    return { success: false, error: message }
  }
}

/**
 * EVERYTHING AFTER THE MODEL — write the read onto the offer, record it, fan it
 * out, and hand the comparison-ready offer to the Listing Concierge. Split out
 * of extractOfferFromPdf (wave 94, lane 94B) so the half that touches the
 * database is one function whatever produced the read; extractOfferFromPdf is
 * still its only production caller. Throws on a refused offers update (the
 * caller records the failure).
 * @proofSeam exported so the run-vip-re-os bridge walk (journey-wave94.ts S6) applies a stubbed model read through the real write path; used in-file by extractOfferFromPdf.
 */
export async function applyExtractedOfferData(
  supabase: any,
  params: { offerId: string; brokerageId: string; listingId: string; extracted: ExtractedOfferData },
): Promise<void> {
  const { offerId, brokerageId, listingId, extracted } = params
  {
    // UPDATE offers row with all extracted columns
    const extractedUpdate = {
      ai_extraction_status: "completed",
      ai_extracted_data: extracted,
      // Write individual columns from live schema
      offer_price: extracted.offer_price,
      earnest_money: extracted.earnest_money,
      closing_date: extracted.closing_date,
      financing_type: extracted.financing_type,
      down_payment_amount: extracted.down_payment_amount,
      down_payment_percent: extracted.down_payment_percent,
      appraisal_contingency_days: extracted.appraisal_contingency_days,
      financing_contingency_days: extracted.financing_contingency_days,
      inspection_period_days: extracted.inspection_period_days,
      escalation_clause: extracted.escalation_clause,
      escalation_cap: extracted.escalation_cap,
      appraisal_gap: extracted.appraisal_gap,
      closing_cost_contribution: extracted.closing_cost_contribution,
      due_diligence_fee: extracted.due_diligence_fee,
      possession_terms: extracted.possession_terms,
      contingencies: extracted.contingencies,
      buyer_notes: extracted.buyer_notes,
      updated_at: new Date().toISOString(),
    }
    // tenant anchor (scope burn-down): the update is pinned to the caller's
    // offer id AND its brokerage.
    const { error: updateError } = await supabase
      .from("offers")
      .update(extractedUpdate)
      .eq("id", offerId)
      .eq("brokerage_id", brokerageId)

    if (updateError) throw new Error(updateError.message)

    // lifecycle_events insert + kernel event
    // ONE EMIT (wave 101C): this row and its fan-out were two calls (an auditOnly emit, then a bare
    // processKernelEvent). One emitKernelEvent now — the reactor gets the lifecycleEventId. Equivalent:
    // same event/tenant/entity, and the reactor's reader for this event uses no metadata; agentUserId: null keeps the reactor's attribution as the bare fan-out had it.
    await bestEffort(import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
      brokerageId: brokerageId,
      entityType: "offer",
      entityId: offerId,
      event: KernelEvent.OFFER_AI_EXTRACTED,
      actorUserId: null,
      metadata: {
        listing_id: listingId,
        offer_price: extracted.offer_price,
        financing_type: extracted.financing_type,
        fields_extracted: Object.keys(extracted).filter(
          (k) => extracted[k as keyof ExtractedOfferData] !== null
        ).length,
      },
      agentUserId: null,
    }).then(k.asWriteResult)), "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped")


    // EVENT-DRIVEN net-sheet: the offer is now COMPARISON-READY (real price extracted). The Data
    // Steward (which owns extraction/normalization of the incoming doc) hands the clean offer to the
    // Listing Concierge to run the net-sheet comparison for the seller — single or multi — instead
    // of waiting on the */15 safety-net cron. Only fires for offers ON an in-house listing (listingId
    // present); the runner self-filters + is idempotent per offer set. dedupe:false so each newly
    // extracted offer triggers a fresh comparison. Best-effort.
    if (listingId) {
      try {
        const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
        await publishManagerSignal({
          brokerageId, fromManager: "data_steward", toManager: "listing_concierge",
          signalType: "offers_compare_handoff", entityType: "listing", entityId: listingId,
          message: `An offer was received and read for an in-house listing — run the net-sheet comparison.`,
          dedupe: false,
        }, supabase)
      } catch (e) {
        console.error("[offer-extractor] offers_compare_handoff failed (non-fatal):", e)
      }
    }
  }
}
