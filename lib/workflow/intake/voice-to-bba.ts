/**
 * lib/workflow/intake/voice-to-bba.ts
 *
 * Voice intake for a Buyer Broker Agreement (NAR 2024 settlement requirement).
 *
 * When the AI cockpit detects that a buyer doesn't yet have an active BBA AND
 * the agent is drafting an offer for them, the AI captures BBA terms in the
 * same call. The agent reviews + sends the BBA for signature FIRST; once
 * signed, the staged offer can be dispatched.
 *
 * Structure mirrors voice-to-offer.ts so the AI cockpit has a consistent
 * conversation pattern. Output feeds createBBADraftAction (Commit H).
 */

import "server-only"
import { generateTextRouted } from "@/lib/ai/models"

// ─── Confidence scoring (shared shape with voice-to-offer) ─────────────────

export type Confidence = "high" | "medium" | "low" | "missing"

export interface IntakeField<T> {
  value: T | null
  confidence: Confidence
  sourceSpan?: string
  note?: string
}

// ─── BBA intake shape ──────────────────────────────────────────────────────

export interface BBAIntake {
  // Buyer (the agreement subject — resolved from contact_id passed alongside)
  buyerLegalName:      IntakeField<string>

  // Agreement type
  agreementType:       IntakeField<"exclusive" | "non_exclusive" | "showing_only" | "open">

  // Commission — at least ONE of percentage/flat must be set
  commissionPercentage: IntakeField<number>          // e.g. 2.5 = 2.5% of purchase
  commissionFlatAmount: IntakeField<number>          // alternative to percentage
  commissionPayer:     IntakeField<"seller" | "buyer" | "split" | "either">
  commissionNotes:     IntakeField<string>           // e.g. "Buyer covers gap above 2.5%"

  // Scope
  geographicScope:     IntakeField<string>           // e.g. "Travis County, TX"
  propertyTypeScope:   IntakeField<string[]>         // ["residential", "condo"]

  // Dates
  effectiveDate:       IntakeField<string>           // ISO YYYY-MM-DD, defaults to today
  expirationDate:      IntakeField<string>           // ISO YYYY-MM-DD, default +90d

  // Free-form
  agentNotes:          IntakeField<string>
}

export interface VoiceToBBAResult {
  intake: BBAIntake
  /** REQUIRED_FIELDS that are still missing/low-confidence — AI must ask before drafting. */
  missingQuestions: Array<{ field: keyof BBAIntake; question: string; severity: "must_ask" | "verify" }>
  /** True when all REQUIRED_FIELDS are high-confidence — safe to call stage_bba_packet. */
  readyToDraft: boolean
}

function emptyField<T>(): IntakeField<T> {
  return { value: null, confidence: "missing" }
}

function emptyIntake(): BBAIntake {
  return {
    buyerLegalName:       emptyField(),
    agreementType:        emptyField(),
    commissionPercentage: emptyField(),
    commissionFlatAmount: emptyField(),
    commissionPayer:      emptyField(),
    commissionNotes:      emptyField(),
    geographicScope:      emptyField(),
    propertyTypeScope:    emptyField(),
    effectiveDate:        emptyField(),
    expirationDate:       emptyField(),
    agentNotes:           emptyField(),
  }
}

// ─── Required fields (must be high-confidence to draft) ────────────────────

const REQUIRED_FIELDS: Array<keyof BBAIntake> = [
  "buyerLegalName",
  "agreementType",
  "commissionPayer",
  // Note: at least ONE of commissionPercentage / commissionFlatAmount required —
  // checked separately because either satisfies. AI asks for both, the schema
  // CHECK enforces at-least-one.
]

const FIELD_QUESTIONS: Partial<Record<keyof BBAIntake, string>> = {
  buyerLegalName:       "Buyer's legal full name as on their driver's license?",
  agreementType:        "Is this an exclusive agreement, non-exclusive, showing-only, or open?",
  commissionPercentage: "What's the commission percentage you're charging — typically 2.5% or 3%?",
  commissionFlatAmount: "Or if it's a flat fee instead of a percentage, what's the dollar amount?",
  commissionPayer:      "Who pays the buyer's broker commission — seller, buyer, split, or either party?",
  commissionNotes:      "Any commission notes — concessions, gaps, or special terms?",
  geographicScope:      "What's the geographic scope — county, city, or specific area?",
  propertyTypeScope:    "What property types — residential, condo, land, commercial, multi-family?",
  effectiveDate:        "When does this agreement start? Defaults to today if not specified.",
  expirationDate:       "When does it expire? Most BBAs are 90 days.",
}

// ─── AI extraction ─────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are extracting Buyer Broker Agreement (BBA) terms from a real estate agent's voice transcript or notes. Return ONLY valid JSON matching this exact schema — no markdown, no commentary.

{
  "buyerLegalName": { "value": string|null, "confidence": "high|medium|low|missing", "sourceSpan": string|null, "note": string|null },
  "agreementType":  { "value": "exclusive|non_exclusive|showing_only|open|null", "confidence": "...", ... },
  "commissionPercentage": { "value": number|null, ... },
  "commissionFlatAmount": { "value": number|null, ... },
  "commissionPayer": { "value": "seller|buyer|split|either|null", ... },
  "commissionNotes": { "value": string|null, ... },
  "geographicScope": { "value": string|null, ... },
  "propertyTypeScope": { "value": string[]|null, ... },
  "effectiveDate": { "value": "YYYY-MM-DD|null", ... },
  "expirationDate": { "value": "YYYY-MM-DD|null", ... },
  "agentNotes": { "value": string|null, ... }
}

CONFIDENCE GUIDE:
- high   : the agent stated the value explicitly and unambiguously
- medium : inferred from context, the agent should verify
- low    : guessed from weak signal — surface for verification
- missing: the value isn't in the transcript

NORMALIZATION:
- commissionPercentage: 2.5 not "2.5%"; if agent says "two and a half percent" → 2.5
- commissionFlatAmount: dollars not cents; e.g. 5000 not "$5,000"
- propertyTypeScope: array of normalized strings ["residential"|"condo"|"townhouse"|"multi_family"|"commercial"|"land"]
- agreementType: "exclusive" is the default if the agent doesn't specify

Now extract from this transcript:

`

export async function extractBBAIntake(input: { text: string }): Promise<VoiceToBBAResult> {
  const intake = emptyIntake()

  if (!input.text || input.text.trim().length < 5) {
    return {
      intake,
      missingQuestions: REQUIRED_FIELDS.map(field => ({
        field, question: FIELD_QUESTIONS[field] ?? `What is ${field}?`, severity: "must_ask" as const,
      })),
      readyToDraft: false,
    }
  }

  try {
    const { text } = await generateTextRouted({
      feature: "offer_data_extraction",       // routes to gpt-4o per AI_TASK_ROUTING
      system: "You are a structured-data extraction system for real estate contracts. Output strict JSON only.",
      prompt: EXTRACTION_PROMPT + input.text,
      temperature: 0,
      maxTokens: 1500,
    })

    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
    const parsed = JSON.parse(cleaned) as Partial<BBAIntake>

    // Merge parsed into empty intake — defensive: only overwrite when a field is present + valid
    for (const key of Object.keys(intake) as Array<keyof BBAIntake>) {
      const v = (parsed as any)[key]
      if (v && typeof v === "object" && "value" in v && "confidence" in v) {
        (intake as any)[key] = v
      }
    }
  } catch (err) {
    console.error("[voice-to-bba] AI extraction failed:", err)
    // Fall through with empty intake — AI prompts for everything
  }

  // Required-field check
  const missingQuestions: VoiceToBBAResult["missingQuestions"] = []
  for (const field of REQUIRED_FIELDS) {
    const f = intake[field]
    if (!f.value || f.confidence === "missing" || f.confidence === "low") {
      missingQuestions.push({
        field,
        question: FIELD_QUESTIONS[field] ?? `What's the ${field}?`,
        severity: "must_ask",
      })
    } else if (f.confidence === "medium") {
      missingQuestions.push({
        field,
        question: `I heard ${field} as "${String(f.value)}" — confirm?`,
        severity: "verify",
      })
    }
  }

  // At least one of commissionPercentage / commissionFlatAmount must be set
  if (
    (!intake.commissionPercentage.value || intake.commissionPercentage.confidence === "missing")
    && (!intake.commissionFlatAmount.value || intake.commissionFlatAmount.confidence === "missing")
  ) {
    missingQuestions.push({
      field: "commissionPercentage",
      question: FIELD_QUESTIONS.commissionPercentage ?? "Commission percentage or flat amount?",
      severity: "must_ask",
    })
  }

  const readyToDraft = REQUIRED_FIELDS.every(f => {
    const v = intake[f]
    return v.value !== null && v.value !== undefined && (v.confidence === "high" || v.confidence === "medium")
  }) && (
    (intake.commissionPercentage.value !== null && intake.commissionPercentage.confidence !== "missing")
    || (intake.commissionFlatAmount.value !== null && intake.commissionFlatAmount.confidence !== "missing")
  )

  return { intake, missingQuestions, readyToDraft }
}
