import { generateText } from "ai"
import { createClient } from "@/lib/supabase/server"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"

// ── Extracted offer shape matching exact offers table columns ─────────────────
export interface ExtractedOfferData {
  offer_price: number | null
  earnest_money: number | null
  earnest_money_amount: number | null
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
}

// ── Main extractor — called after PDF is stored in Supabase Storage ───────────
export async function extractOfferFromPdf(params: {
  offerId: string
  brokerageId: string
  pdfUrl: string
  listingId: string
}): Promise<{ success: boolean; error?: string; data?: ExtractedOfferData }> {
  const { offerId, brokerageId, pdfUrl, listingId } = params
  const supabase = await createClient()

  // Mark extraction in progress
  await supabase
    .from("offers")
    .update({ ai_extraction_status: "processing" })
    .eq("id", offerId)

  try {
    // Fetch the PDF as base64 for vision-capable model
    const pdfResp = await fetch(pdfUrl)
    if (!pdfResp.ok) throw new Error(`PDF fetch failed: ${pdfResp.status}`)
    const pdfBuffer = await pdfResp.arrayBuffer()
    const base64Pdf = Buffer.from(pdfBuffer).toString("base64")

    const { text } = await generateText({
      model: "anthropic/claude-opus-4.6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are a real estate document parser. Extract ONLY the following fields from this offer document.
Return ONLY a valid JSON object. Do not include any explanation, commentary, or markdown.

Required JSON schema:
{
  "offer_price": number or null,
  "earnest_money": number or null,
  "earnest_money_amount": number or null,
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
  "buyer_notes": string or null
}`,
            },
            {
              type: "file",
              data: base64Pdf,
              mimeType: "application/pdf",
            },
          ],
        },
      ],
    })

    // Parse — strip any accidental markdown fences
    const cleaned = text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
    const extracted: ExtractedOfferData = JSON.parse(cleaned)

    // UPDATE offers row with all extracted columns
    const { error: updateError } = await supabase
      .from("offers")
      .update({
        ai_extraction_status: "completed",
        ai_extracted_data: extracted,
        // Write individual columns from live schema
        offer_price: extracted.offer_price,
        earnest_money: extracted.earnest_money,
        earnest_money_amount: extracted.earnest_money_amount,
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
      })
      .eq("id", offerId)

    if (updateError) throw new Error(updateError.message)

    // lifecycle_events insert + kernel event
    await supabase.from("lifecycle_events").insert({
      brokerage_id: brokerageId,
      entity_type: "offer",
      entity_id: offerId,
      event_type: KernelEvent.OFFER_AI_EXTRACTED,
      actor_user_id: null,
      metadata: {
        listing_id: listingId,
        offer_price: extracted.offer_price,
        financing_type: extracted.financing_type,
        fields_extracted: Object.keys(extracted).filter(
          (k) => extracted[k as keyof ExtractedOfferData] !== null
        ).length,
      },
    })

    await processKernelEvent({
      event: KernelEvent.OFFER_AI_EXTRACTED,
      brokerageId,
      entityType: "offer",
      entityId: offerId,
    }).catch(() => {})

    return { success: true, data: extracted }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    await supabase
      .from("offers")
      .update({ ai_extraction_status: "failed" })
      .eq("id", offerId)

    return { success: false, error: message }
  }
}
