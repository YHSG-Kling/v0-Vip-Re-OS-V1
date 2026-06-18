"use server"

/**
 * Repair Negotiation Co-Pilot — the second negotiation peak in every deal.
 *
 *   After inspection, the buyer typically submits a repair request (10-30
 *   items). The seller responds. Most deals that fall apart between
 *   "under contract" and "closing" fall apart HERE — over a $4k credit
 *   delta nobody coached either side through.
 *
 *   This action mirrors the negotiation-copilot pattern: one Advise click
 *   returns strategy + per-item recommendations + draft response, all
 *   routed through canonical infrastructure.
 *
 * Reuses (audit-confirmed real):
 *   - transaction_repair_negotiations table (per-item rows)
 *   - transaction_inspections (findings context)
 *   - transactions (purchase_price, close_date, contact_id)
 *   - sendInboxMessage (compliance-gated send)
 *   - LISTING_REPAIR_REQUIRED / _COMPLETED kernel events
 *
 *   No new tables. No parallel actions.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { generateObjectRouted } from "@/lib/ai/models"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { z } from "zod"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RepairItemRec {
  id:               string
  itemDescription:  string
  estimatedCost:    number | null
  priority:         string | null
  status:           string
  requestedBy:      string | null
  /** AI categorization: safety > structural > system > code > cosmetic */
  category:         "safety" | "structural" | "system" | "code" | "cosmetic" | "other"
  /** AI recommendation for THIS side (the side calling the copilot) */
  recommendation:   "accept" | "credit" | "decline" | "counter"
  recommendationReason: string
  /** When recommendation === "credit": the suggested dollar credit for this item */
  suggestedCredit:  number | null
}

export interface RepairStrategy {
  recommendedApproach:
    | "accept_all"           // seller accepts every item; deal closes clean
    | "accept_safety_only"   // seller fixes safety items, declines cosmetic
    | "credit"               // seller offers a lump credit instead of repairs
    | "subset_with_credit"   // mixed: do some repairs, credit the rest
    | "counter_partial"      // counter with reduced repair list
    | "walk"                 // ask seems unreasonable — risk losing deal preferred
  suggestedTotalCredit:    number | null
  riskOfBuyerWalking:      number   // 0–100
  riskOfSellerWalking:     number   // 0–100
  totalEstimatedRepairCost: number
  reasoning:               string
  tactics:                 string[]
  /** "Typical buyer in this market gets 60-70% of asking repair credit" */
  marketContext:           string
}

export interface RepairCoPilotResult {
  success: boolean
  error?: string
  strategy?:    RepairStrategy
  items?:       RepairItemRec[]
  draftResponse?: {
    subject?: string
    body:     string
  }
  transactionSnapshot?: {
    purchasePrice:   number
    propertyAddress: string
    daysToClose:     number | null
    /** contact_id we'd route a "Send draft" through */
    contactId:       string | null
    /** count of inspection rows available — UI uses this for a "Findings"
     *  badge / link */
    inspectionCount: number
  }
}

// ─── Action ──────────────────────────────────────────────────────────────────

export async function repairNegotiationCoPilot(params: {
  transactionId: string
  /** Which side we're advising:
   *    "buyer"  — we represent the buyer; advise on what to ask for
   *    "seller" — we represent the seller; advise on how to respond */
  side:          "buyer" | "seller"
}): Promise<RepairCoPilotResult> {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction id" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // ─── Load transaction + repairs + inspections in parallel ──────────────
  const [txRes, repairsRes, inspectionsRes] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, brokerage_id, contact_id, property_address, property_city, property_state, property_zip, purchase_price, close_date, status, stage")
      .eq("id", params.transactionId)
      .maybeSingle(),
    supabase
      .from("transaction_repair_negotiations")
      .select("id, item_description, estimated_cost, priority, status, requested_by, response_note, actual_cost, created_at")
      .eq("transaction_id", params.transactionId)
      .order("created_at", { ascending: true }),
    supabase
      .from("transaction_inspections")
      .select("id, inspection_type, status, issues_found, cost, completed_date, notes")
      .eq("transaction_id", params.transactionId)
      .order("created_at", { ascending: true }),
  ])

  const tx = txRes.data
  if (!tx) return { success: false, error: "Transaction not found" }

  const rawRepairs = (repairsRes.data ?? []) as Array<{
    id: string
    item_description: string
    estimated_cost: number | null
    priority: string | null
    status: string
    requested_by: string | null
    response_note: string | null
    actual_cost: number | null
  }>

  if (rawRepairs.length === 0) {
    return {
      success: true,
      transactionSnapshot: {
        purchasePrice:   Number(tx.purchase_price ?? 0),
        propertyAddress: tx.property_address ?? "",
        daysToClose:     daysFromNowTo(tx.close_date),
        contactId:       tx.contact_id ?? null,
        inspectionCount: inspectionsRes.data?.length ?? 0,
      },
      strategy: undefined,
      items: [],
      draftResponse: undefined,
    }
  }

  const totalEstimated = rawRepairs.reduce(
    (sum, r) => sum + Number(r.estimated_cost ?? 0),
    0,
  )
  const purchasePrice = Number(tx.purchase_price ?? 0)
  const repairAsPctOfPrice = purchasePrice > 0 ? (totalEstimated / purchasePrice) * 100 : 0

  // Inspection findings summary (best-effort context for the AI). Live
  // schema: transaction_inspections.issues_found (text), notes (text), cost
  // (numeric). There's no findings_summary or total_estimated_cost column.
  const inspections = (inspectionsRes.data ?? []) as Array<{
    id: string
    inspection_type: string | null
    status: string | null
    issues_found: string | null
    cost: number | null
    notes: string | null
  }>
  const inspectionContext = inspections
    .filter((i) => i.issues_found || i.notes)
    .slice(0, 3)
    .map((i) => `- ${i.inspection_type ?? "Inspection"}: ${i.issues_found ?? i.notes}`)
    .join("\n") || "No inspection findings on record."

  // ─── AI: overall strategy ────────────────────────────────────────────────
  const strategyPrompt = `You are advising a real estate agent on a post-inspection repair negotiation.

Side we represent: ${params.side.toUpperCase()}
Property: ${tx.property_address ?? "—"}
Purchase price: $${purchasePrice.toLocaleString()}
Days to close: ${daysFromNowTo(tx.close_date) ?? "?"}
Total requested repair cost: $${totalEstimated.toLocaleString()} (${repairAsPctOfPrice.toFixed(2)}% of price)

Inspection context:
${inspectionContext}

Repair items requested (${rawRepairs.length}):
${rawRepairs.map((r, i) => `${i + 1}. ${r.item_description} — est $${Number(r.estimated_cost ?? 0).toLocaleString()} (priority ${r.priority ?? "?"})`).join("\n")}

Recommend the negotiation approach for the ${params.side} side. Be direct.`

  let strategy: RepairStrategy | undefined
  try {
    const r = await generateObjectRouted({
      feature: "repair_negotiation_strategy",
      schema: z.object({
        recommendedApproach: z.enum([
          "accept_all",
          "accept_safety_only",
          "credit",
          "subset_with_credit",
          "counter_partial",
          "walk",
        ]),
        suggestedTotalCredit: z.number().nullable(),
        riskOfBuyerWalking:   z.number().min(0).max(100),
        riskOfSellerWalking:  z.number().min(0).max(100),
        reasoning:            z.string(),
        tactics:              z.array(z.string()).max(5),
        marketContext:        z.string(),
      }),
      prompt: strategyPrompt,
    })
    strategy = {
      recommendedApproach:    r.object.recommendedApproach,
      suggestedTotalCredit:   r.object.suggestedTotalCredit,
      riskOfBuyerWalking:     Math.round(r.object.riskOfBuyerWalking),
      riskOfSellerWalking:    Math.round(r.object.riskOfSellerWalking),
      totalEstimatedRepairCost: totalEstimated,
      reasoning:              r.object.reasoning,
      tactics:                r.object.tactics ?? [],
      marketContext:          r.object.marketContext,
    }
  } catch {
    // Deterministic fallback when AI is unavailable
    strategy = {
      recommendedApproach:
        repairAsPctOfPrice < 0.5 ? "accept_all"
        : repairAsPctOfPrice < 1.5 ? "subset_with_credit"
        : "counter_partial",
      suggestedTotalCredit:   Math.round(totalEstimated * 0.65),
      riskOfBuyerWalking:     repairAsPctOfPrice > 1.5 ? 40 : 15,
      riskOfSellerWalking:    repairAsPctOfPrice > 2 ? 25 : 10,
      totalEstimatedRepairCost: totalEstimated,
      reasoning:              "Heuristic fallback (AI unavailable). Typical resolution clears ~65% of asking credit.",
      tactics:                [],
      marketContext:          "Most markets resolve 50–75% of buyer-asked repair credit.",
    }
  }

  // ─── AI: per-item categorization + recommendation ───────────────────────
  let items: RepairItemRec[] = []
  try {
    const r = await generateObjectRouted({
      feature: "repair_negotiation_items",
      schema: z.object({
        items: z.array(z.object({
          id:                   z.string(),
          category:             z.enum(["safety", "structural", "system", "code", "cosmetic", "other"]),
          recommendation:       z.enum(["accept", "credit", "decline", "counter"]),
          recommendationReason: z.string(),
          suggestedCredit:      z.number().nullable(),
        })),
      }),
      prompt: `For each repair item below, categorize and recommend a response from the ${params.side} side.
Categories (in priority order): safety, structural, system (HVAC/electrical/plumbing), code, cosmetic, other.
${params.side === "seller"
  ? "Seller side guidance: accept safety+structural without resistance; credit systems; decline cosmetic; counter on overstated estimates."
  : "Buyer side guidance: hold firm on safety+structural; accept credit on cosmetic if seller pushes back; flag overstated declines for counter."}

Items:
${rawRepairs.map((r) => `${r.id} | ${r.item_description} | est $${Number(r.estimated_cost ?? 0).toLocaleString()} | priority ${r.priority ?? "?"}`).join("\n")}

Return strictly the items array with one entry per id.`,
    })
    const byId = new Map(r.object.items.map((i) => [i.id, i]))
    items = rawRepairs.map((rr) => {
      const ai = byId.get(rr.id)
      return {
        id:                   rr.id,
        itemDescription:      rr.item_description,
        estimatedCost:        rr.estimated_cost,
        priority:             rr.priority,
        status:               rr.status,
        requestedBy:          rr.requested_by,
        category:             ai?.category ?? "other",
        recommendation:       ai?.recommendation ?? (params.side === "seller" ? "credit" : "accept"),
        recommendationReason: ai?.recommendationReason ?? "Heuristic default.",
        suggestedCredit:      ai?.suggestedCredit ?? (rr.estimated_cost != null ? Math.round(Number(rr.estimated_cost) * 0.65) : null),
      }
    })
  } catch {
    // Heuristic categorization fallback
    items = rawRepairs.map((rr) => {
      const desc = (rr.item_description ?? "").toLowerCase()
      const category: RepairItemRec["category"] =
        /safety|carbon monoxide|smoke detector|electrical|gas leak|fire/.test(desc) ? "safety"
        : /foundation|roof|structural|beam|joist|load-bearing/.test(desc) ? "structural"
        : /hvac|furnace|ac|water heater|plumb|pipe|septic|sewer/.test(desc) ? "system"
        : /code|permit|grandfather/.test(desc) ? "code"
        : /paint|finish|cosmetic|caulk|stain|scratch/.test(desc) ? "cosmetic"
        : "other"
      const recommendation: RepairItemRec["recommendation"] =
        params.side === "seller"
          ? (category === "safety" || category === "structural" ? "accept" : category === "cosmetic" ? "decline" : "credit")
          : (category === "cosmetic" ? "credit" : "accept")
      return {
        id:                   rr.id,
        itemDescription:      rr.item_description,
        estimatedCost:        rr.estimated_cost,
        priority:             rr.priority,
        status:               rr.status,
        requestedBy:          rr.requested_by,
        category,
        recommendation,
        recommendationReason: "Heuristic fallback (AI unavailable).",
        suggestedCredit:      rr.estimated_cost != null ? Math.round(Number(rr.estimated_cost) * 0.65) : null,
      }
    })
  }

  // ─── AI: draft response message ─────────────────────────────────────────
  const draftResponse = await draftRepairResponse({
    side: params.side,
    propertyAddress: tx.property_address ?? "the property",
    strategy,
    items,
  })

  return {
    success: true,
    strategy,
    items,
    draftResponse,
    transactionSnapshot: {
      purchasePrice,
      propertyAddress: tx.property_address ?? "",
      daysToClose:     daysFromNowTo(tx.close_date),
      contactId:       tx.contact_id ?? null,
      inspectionCount: inspections.length,
    },
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function daysFromNowTo(date: string | null | undefined): number | null {
  if (!date) return null
  const d = new Date(date).getTime()
  if (Number.isNaN(d)) return null
  return Math.floor((d - Date.now()) / 86_400_000)
}

async function draftRepairResponse(input: {
  side:            "buyer" | "seller"
  propertyAddress: string
  strategy:        RepairStrategy | undefined
  items:           RepairItemRec[]
}): Promise<{ subject?: string; body: string } | undefined> {
  if (!input.strategy) return undefined

  const acceptItems  = input.items.filter((i) => i.recommendation === "accept")
  const creditItems  = input.items.filter((i) => i.recommendation === "credit")
  const declineItems = input.items.filter((i) => i.recommendation === "decline")
  const counterItems = input.items.filter((i) => i.recommendation === "counter")

  const sellerSidePrompt = `Draft the seller's response to the buyer's agent re: post-inspection repair requests on ${input.propertyAddress}.

Approach: ${input.strategy.recommendedApproach}
${input.strategy.suggestedTotalCredit ? `Total credit offer: $${input.strategy.suggestedTotalCredit.toLocaleString()}` : ""}

Will accept and repair (${acceptItems.length}):
${acceptItems.slice(0, 8).map((i) => `- ${i.itemDescription}`).join("\n") || "  (none)"}

Will offer credit instead of repair (${creditItems.length}):
${creditItems.slice(0, 8).map((i) => `- ${i.itemDescription} (~$${i.suggestedCredit?.toLocaleString() ?? "?"})`).join("\n") || "  (none)"}

Declining (${declineItems.length}):
${declineItems.slice(0, 8).map((i) => `- ${i.itemDescription} — ${i.recommendationReason}`).join("\n") || "  (none)"}

Audience: BUYER's agent. Tone: professional, collaborative, them-first, no high-pressure language, no investment claims, no fair-housing language. Keep under 150 words.

Respond with JSON only: { "subject": "<email subject ≤ 60 chars>", "body": "<message body>" }`

  const buyerSidePrompt = `Draft the buyer's agent's message to the listing agent re: post-inspection findings on ${input.propertyAddress}.

Approach: ${input.strategy.recommendedApproach}
${input.strategy.suggestedTotalCredit ? `Asking for credit total: $${input.strategy.suggestedTotalCredit.toLocaleString()}` : ""}

Asking seller to repair (${acceptItems.length}):
${acceptItems.slice(0, 8).map((i) => `- ${i.itemDescription}`).join("\n") || "  (none)"}

Open to credit on (${creditItems.length}):
${creditItems.slice(0, 8).map((i) => `- ${i.itemDescription} (~$${i.suggestedCredit?.toLocaleString() ?? "?"})`).join("\n") || "  (none)"}

Will accept as-is or counter further on (${counterItems.length + declineItems.length}):
${[...counterItems, ...declineItems].slice(0, 5).map((i) => `- ${i.itemDescription}`).join("\n") || "  (none)"}

Audience: LISTING agent. Tone: professional, collaborative, them-first, no high-pressure language, no investment claims, no fair-housing language. Keep under 150 words.

Respond with JSON only: { "subject": "<email subject ≤ 60 chars>", "body": "<message body>" }`

  try {
    const result = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: input.side === "buyer" ? buyerSidePrompt : sellerSidePrompt,
      maxOutputTokens: 500,
    })
    const jsonMatch = result.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return undefined
    const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; body?: string }
    if (!parsed.body) return undefined
    return { subject: parsed.subject, body: parsed.body }
  } catch {
    return undefined
  }
}

// ─── One-click "Send draft as repair response" ──────────────────────────────
// Mirrors sendDraftAsCounterResponse from negotiation-copilot.ts but routes
// to the transaction's contact_id. DNC/TCPA remain hard legal stops via
// sendInboxMessage's compliance gate.

export interface SendRepairResponseParams {
  transactionId: string
  body:          string
  subject?:      string
  channel?:      "sms" | "email" | "portal" | "chat"
}

export async function sendRepairResponseAsDraft(params: SendRepairResponseParams): Promise<{
  success:        boolean
  error?:         string
  messageId?:     string
  blocked?:       boolean
  blockedReason?: string
}> {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction id" }
  }
  if (!params.body || params.body.trim().length < 10) {
    return { success: false, error: "Message body is too short to send." }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: tx } = await supabase
    .from("transactions")
    .select("id, contact_id")
    .eq("id", params.transactionId)
    .maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found" }

  const contactId = (tx as { contact_id?: string | null }).contact_id ?? null
  if (!contactId) {
    return { success: false, error: "No contact linked to this transaction — can't route." }
  }

  const channel = params.channel ?? "email"
  const fullBody = channel === "email" && params.subject
    ? `Subject: ${params.subject}\n\n${params.body}`
    : params.body

  const { sendInboxMessage } = await import("./inbox")
  const result = await sendInboxMessage({
    contactId,
    body: fullBody,
    channel,
  })

  if (!result.success) {
    const errStr = result.error ?? ""
    const isBlocked = /block|compliance|tcpa|dnc|fair housing|brand voice|them.first/i.test(errStr)
    return {
      success: false,
      error: errStr || "Send failed",
      blocked: isBlocked,
      blockedReason: isBlocked ? errStr : undefined,
    }
  }
  return { success: true, messageId: result.messageId }
}
