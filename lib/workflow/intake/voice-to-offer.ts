/**
 * lib/workflow/intake/voice-to-offer.ts
 *
 * Structures a voice transcript / text summary / pasted email into a
 * canonical OfferIntake object with per-field confidence scoring.
 *
 * Input: free-form text (voice transcript, agent's typed summary, forwarded
 * email, screenshot OCR result — all flow through here).
 *
 * Output: structured OfferIntake + per-field confidence + missing-field
 * questions the assistant should ask next (conversational mode).
 *
 * The assistant calls this iteratively:
 *   1. Initial dump → extract what's clear, flag what's missing
 *   2. Ask follow-up questions
 *   3. Re-extract from accumulated conversation
 *   4. Until packet is complete OR agent says "good enough, draft it"
 *
 * Then the structured OfferIntake feeds the existing generateOfferDraft +
 * AI form-fill engine.
 */

import "server-only"
import { generateTextRouted } from "@/lib/ai/models"
import { ALL_US_STATES } from "@/lib/state-forms/registry"

// ─── Confidence scoring ────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low" | "missing"

export interface IntakeField<T> {
  value: T | null
  confidence: Confidence
  /** Source span in the original transcript (for audit trail) */
  sourceSpan?: string
  /** Why low/medium — surfaced to the agent for verification */
  note?: string
}

// ─── Canonical offer intake shape ──────────────────────────────────────────

export interface OfferIntake {
  // Property
  propertyAddress:    IntakeField<string>
  propertyCity:       IntakeField<string>
  propertyState:      IntakeField<string>
  propertyZip:        IntakeField<string>
  listingId:          IntakeField<string>          // resolved if it's an in-house listing

  // Buyer
  buyerLegalName:     IntakeField<string>          // MUST match driver's license
  buyerEmail:         IntakeField<string>
  buyerPhone:         IntakeField<string>
  coBuyerLegalName:   IntakeField<string>          // for spouses / co-purchasers
  buyerEntity:        IntakeField<"individual" | "joint" | "llc" | "trust">

  // Offer terms
  offerPrice:         IntakeField<number>
  earnestMoneyAmount: IntakeField<number>
  earnestMoneyPercent: IntakeField<number>          // computed if % was spoken
  downPaymentPercent: IntakeField<number>
  financingType:      IntakeField<"conventional" | "fha" | "va" | "cash" | "usda" | "other">
  /**
   * Contract template the agent specified. Required for form selection —
   * the state-forms registry has multiple variants per state (as-is vs
   * standard residential vs new-construction etc.) and the agent MUST
   * speak which one during the call. Without this, the AI can't pick
   * the correct contract template.
   *   - residential       : standard buyer's contract (most common)
   *   - as_is             : seller-as-is variant — buyer waives most repair contingencies
   *   - new_construction  : builder contract (separate state form usually)
   *   - land              : raw-land variant
   *   - commercial        : commercial real estate contract
   */
  contractType:       IntakeField<"residential" | "as_is" | "new_construction" | "land" | "commercial">
  closeDate:          IntakeField<string>            // ISO date
  inspectionDays:     IntakeField<number>
  appraisalDays:      IntakeField<number>
  financingDays:      IntakeField<number>

  // Concessions / addenda
  sellerConcessionAmount: IntakeField<number>
  escalationEnabled:  IntakeField<boolean>
  escalationCap:      IntakeField<number>
  escalationIncrement: IntakeField<number>
  contingencies:      IntakeField<string[]>
  addendaRequested:   IntakeField<string[]>         // names like "HOA", "lead-paint"

  // Free-form
  agentNotes:         IntakeField<string>
}

export interface VoiceToOfferResult {
  intake: OfferIntake
  /** Fields that are missing or low-confidence — assistant should ask these next */
  followUpQuestions: Array<{ field: keyof OfferIntake; question: string }>
  /** True when the intake is complete enough to draft the packet */
  readyToDraft: boolean
  /** Raw AI extraction trace for audit */
  extractionTrace: {
    inputLength: number
    extractedAt: string
    modelFeature: string
  }
}

// ─── Empty starter intake ──────────────────────────────────────────────────

function emptyField<T>(): IntakeField<T> {
  return { value: null, confidence: "missing" }
}

function emptyIntake(): OfferIntake {
  return {
    propertyAddress:    emptyField(),
    propertyCity:       emptyField(),
    propertyState:      emptyField(),
    propertyZip:        emptyField(),
    listingId:          emptyField(),
    buyerLegalName:     emptyField(),
    buyerEmail:         emptyField(),
    buyerPhone:         emptyField(),
    coBuyerLegalName:   emptyField(),
    buyerEntity:        emptyField(),
    offerPrice:         emptyField(),
    earnestMoneyAmount: emptyField(),
    earnestMoneyPercent: emptyField(),
    downPaymentPercent: emptyField(),
    financingType:      emptyField(),
    contractType:       emptyField(),
    closeDate:          emptyField(),
    inspectionDays:     emptyField(),
    appraisalDays:      emptyField(),
    financingDays:      emptyField(),
    sellerConcessionAmount: emptyField(),
    escalationEnabled:  emptyField(),
    escalationCap:      emptyField(),
    escalationIncrement: emptyField(),
    contingencies:      emptyField(),
    addendaRequested:   emptyField(),
    agentNotes:         emptyField(),
  }
}

// ─── Required fields (must be high-confidence to draft) ────────────────────

const REQUIRED_FIELDS: Array<keyof OfferIntake> = [
  "propertyAddress",
  "propertyState",
  "buyerLegalName",
  "offerPrice",
  "closeDate",
  "financingType",
  // Contract template is required for form selection — state-forms registry
  // resolves the wrong form bundle without this. Agent must speak it.
  "contractType",
]

// ─── Field-specific question templates for conversational follow-up ────────

const FIELD_QUESTIONS: Partial<Record<keyof OfferIntake, string>> = {
  propertyAddress:        "What's the property address?",
  propertyState:          "Which state is the property in?",
  buyerLegalName:         "Buyer's legal full name as it appears on their driver's license?",
  coBuyerLegalName:       "Is anyone purchasing with them — spouse, partner, or co-buyer?",
  buyerEntity:            "Are they buying as individuals, jointly, or through an LLC/trust?",
  offerPrice:             "What's the offer price?",
  earnestMoneyAmount:     "Earnest money — dollar amount or percent?",
  downPaymentPercent:     "How much down — and is that conventional, FHA, VA, or cash?",
  financingType:          "Cash or financed? If financed, what loan type — FHA, VA, conventional, or USDA?",
  contractType:           "Is this an as-is contract, a standard residential purchase, new construction, land, or commercial?",
  closeDate:              "Target close date?",
  inspectionDays:         "Inspection contingency window — how many days?",
  appraisalDays:          "Appraisal contingency window?",
  financingDays:          "Financing contingency window?",
  sellerConcessionAmount: "Are we asking the seller to cover any closing costs?",
  escalationEnabled:      "Do you want an escalation clause? If so, max price and increment?",
  contingencies:          "Any other contingencies — sale of buyer's current home, HOA review, etc.?",
  addendaRequested:       "Any specific addenda you want — HOA, coastal, lead paint, septic, etc.?",
}

// ─── Main extraction function ──────────────────────────────────────────────

/**
 * Pass 1: extract everything we can from the input text.
 * Pass 2 (next call with accumulated conversation): refine + fill gaps.
 *
 * The function is idempotent — call it again with the latest conversation
 * including the agent's answers to follow-up questions, and it re-extracts.
 *
 * @param input    Free text (voice transcript, summary, email, etc.)
 * @param prior    Optional prior intake from a previous pass — fields with
 *                 high confidence are preserved unless the new input
 *                 explicitly contradicts them.
 */
export async function extractOfferIntake(input: {
  text:  string
  prior?: OfferIntake
  /** Tenant + actor for the AI cost ledger. Every caller resolves both
   *  server-side — the assistant tool-call route from its session row, the
   *  voice-assistant actions and the workflow route from `users.brokerage_id`
   *  for the authenticated user. Never a request body (CLAUDE.md §4). */
  brokerageId?: string | null
  userId?: string | null
}): Promise<VoiceToOfferResult> {
  const intake = input.prior ? structuredClone(input.prior) : emptyIntake()

  // Build the AI extraction prompt
  const stateList = ALL_US_STATES.join(", ")
  const priorSummary = input.prior
    ? `\n\nPRIOR INTAKE (preserve high-confidence fields, only update where new input contradicts):\n${summarizeIntake(input.prior)}`
    : ""

  const prompt = `You are an expert real estate transaction coordinator extracting offer details from an agent's input.

Extract every field you can with appropriate confidence. Use:
- "high"    when the value is unambiguous and explicit
- "medium"  when inferred but reasonable (e.g. "30 days" → close date is today + 30)
- "low"     when there's ambiguity (e.g. "around 800" → price might be 800K or 800,000)
- "missing" when not mentioned at all

For each field, also extract the SOURCE SPAN — the exact phrase from input that justified the value.
Valid US state codes: ${stateList}.

Return ONLY valid JSON matching this exact shape (no prose, no markdown):
{
  "propertyAddress": { "value": "string|null", "confidence": "high|medium|low|missing", "sourceSpan": "..." },
  "propertyCity": ...,
  "propertyState": { "value": "2-letter code|null", ... },
  "propertyZip": ...,
  "buyerLegalName": ...,
  "coBuyerLegalName": ...,
  "buyerEmail": ...,
  "buyerPhone": ...,
  "buyerEntity": { "value": "individual|joint|llc|trust|null", ... },
  "offerPrice": { "value": number|null, ... },
  "earnestMoneyAmount": { "value": number|null, ... },
  "earnestMoneyPercent": { "value": number|null, ... },
  "downPaymentPercent": { "value": number|null, ... },
  "financingType": { "value": "conventional|fha|va|cash|usda|other|null", ... },
  "contractType":  { "value": "residential|as_is|new_construction|land|commercial|null", ... },
  "closeDate": { "value": "YYYY-MM-DD|null", ... },
  "inspectionDays": { "value": number|null, ... },
  "appraisalDays": { "value": number|null, ... },
  "financingDays": { "value": number|null, ... },
  "sellerConcessionAmount": { "value": number|null, ... },
  "escalationEnabled": { "value": boolean|null, ... },
  "escalationCap": { "value": number|null, ... },
  "escalationIncrement": { "value": number|null, ... },
  "contingencies": { "value": ["string"]|null, ... },
  "addendaRequested": { "value": ["string"]|null, ... },
  "agentNotes": { "value": "string|null", ... }
}${priorSummary}

INPUT:
${input.text}

JSON ONLY:`

  let extracted: Partial<OfferIntake> = {}
  try {
    const { text } = await generateTextRouted({
      brokerageId: input.brokerageId ?? null,
      userId: input.userId ?? null,
      feature: "offer_intake_extraction",
      messages: [{ role: "user", content: prompt }],
    })
    const cleaned = text.replace(/```json|```/g, "").trim()
    extracted = JSON.parse(cleaned)
  } catch {
    // Extraction failed — return empty intake with a marker
    return {
      intake,
      followUpQuestions: REQUIRED_FIELDS.map(field => ({
        field,
        question: FIELD_QUESTIONS[field] ?? `Please provide ${field}`,
      })),
      readyToDraft: false,
      extractionTrace: { inputLength: input.text.length, extractedAt: new Date().toISOString(), modelFeature: "offer_intake_extraction" },
    }
  }

  // Merge extracted fields into intake — preserve prior high-confidence values
  for (const key of Object.keys(intake) as Array<keyof OfferIntake>) {
    const newField = extracted[key]
    const oldField = intake[key]
    if (!newField) continue

    // Only overwrite if (a) we had nothing, OR (b) the new field is higher confidence
    const oldRank = confidenceRank(oldField.confidence)
    const newRank = confidenceRank((newField as IntakeField<unknown>).confidence)
    if (newRank > oldRank || (newField as IntakeField<unknown>).value !== null) {
      ;(intake as any)[key] = newField
    }
  }

  // Compute earnestMoneyAmount from percent if needed
  if (intake.earnestMoneyAmount.value == null && intake.earnestMoneyPercent.value && intake.offerPrice.value) {
    intake.earnestMoneyAmount = {
      value: Math.round(intake.offerPrice.value * (intake.earnestMoneyPercent.value / 100)),
      confidence: "medium",
      note: "Computed from earnest money percent × offer price",
    }
  }

  // Determine follow-up questions for missing/low-confidence required fields
  const followUpQuestions: Array<{ field: keyof OfferIntake; question: string }> = []
  for (const field of REQUIRED_FIELDS) {
    const f = intake[field]
    if (f.confidence === "missing" || f.confidence === "low") {
      const q = FIELD_QUESTIONS[field]
      if (q) followUpQuestions.push({ field, question: q })
    }
  }

  // Also flag medium-confidence required fields as "verify" prompts
  const verifyPrompts: Array<{ field: keyof OfferIntake; question: string }> = []
  for (const field of REQUIRED_FIELDS) {
    const f = intake[field]
    if (f.confidence === "medium" && f.value != null) {
      verifyPrompts.push({
        field,
        question: `I heard ${field} = ${JSON.stringify(f.value)}. Confirm?`,
      })
    }
  }
  followUpQuestions.push(...verifyPrompts)

  const readyToDraft = REQUIRED_FIELDS.every(f => {
    const c = intake[f].confidence
    return c === "high" || c === "medium"
  })

  return {
    intake,
    followUpQuestions,
    readyToDraft,
    extractionTrace: {
      inputLength: input.text.length,
      extractedAt: new Date().toISOString(),
      modelFeature: "offer_intake_extraction",
    },
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function confidenceRank(c: Confidence): number {
  return c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0
}

function summarizeIntake(intake: OfferIntake): string {
  const lines: string[] = []
  for (const [key, field] of Object.entries(intake) as Array<[keyof OfferIntake, IntakeField<unknown>]>) {
    if (field.value !== null) {
      lines.push(`${key}: ${JSON.stringify(field.value)} [${field.confidence}]`)
    }
  }
  return lines.join("\n")
}

/**
 * Convert a finalized OfferIntake into the parameters expected by
 * generateOfferDraft (which stages the packet to documents row).
 */
export function intakeToOfferDraftParams(input: {
  intake:       OfferIntake
  brokerageId:  string
  contactId?:   string | null
  agentUserId?: string | null
  documentId?:  string | null
}): {
  brokerageId:    string
  contactId?:     string | null
  agentUserId?:   string | null
  state:          string
  documentId?:    string | null
  propertyAddress?: string
  listingId?:     string | null
} {
  const state = input.intake.propertyState.value
  if (!state) throw new Error("Cannot draft offer — propertyState is missing")
  return {
    brokerageId:     input.brokerageId,
    contactId:       input.contactId,
    agentUserId:     input.agentUserId,
    state,
    documentId:      input.documentId,
    propertyAddress: input.intake.propertyAddress.value ?? undefined,
    listingId:       input.intake.listingId.value ?? null,
  }
}
