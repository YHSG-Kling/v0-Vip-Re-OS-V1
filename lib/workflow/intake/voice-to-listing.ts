/**
 * lib/workflow/intake/voice-to-listing.ts
 *
 * Same pattern as voice-to-offer but for listing agreements.
 * Extracts seller details, listing terms, marketing obligations from voice
 * or text input.
 */

import "server-only"
import { generateTextRouted } from "@/lib/ai/models"
import { ALL_US_STATES } from "@/lib/state-forms/registry"
import type { Confidence, IntakeField } from "./voice-to-offer"

export interface ListingIntake {
  // Property
  propertyAddress:        IntakeField<string>
  propertyCity:           IntakeField<string>
  propertyState:          IntakeField<string>
  propertyZip:            IntakeField<string>
  propertyType:           IntakeField<"single_family" | "condo" | "townhouse" | "multi_family" | "land">
  bedrooms:               IntakeField<number>
  bathrooms:              IntakeField<number>
  sqft:                   IntakeField<number>
  yearBuilt:              IntakeField<number>

  // Seller
  sellerLegalName:        IntakeField<string>
  coSellerLegalName:      IntakeField<string>
  sellerEmail:            IntakeField<string>
  sellerPhone:            IntakeField<string>
  sellerEntity:           IntakeField<"individual" | "joint" | "llc" | "trust">
  sellerMotivation:       IntakeField<"relocation" | "upsize" | "downsize" | "investment_exit" | "estate" | "other">

  // Listing terms
  listPrice:              IntakeField<number>
  commissionTotalPercent: IntakeField<number>
  commissionToBuyerAgent: IntakeField<number>
  listingTermDays:        IntakeField<number>
  goLiveDate:             IntakeField<string>            // ISO date
  expirationDate:         IntakeField<string>

  // Marketing obligations
  professionalPhotos:     IntakeField<boolean>
  videoTour:              IntakeField<boolean>
  openHousePlan:          IntakeField<string>            // free-form, e.g. "first weekend after MLS live"
  comingSoonPeriod:       IntakeField<number>            // days before MLS live
  stagingPlan:            IntakeField<"existing" | "professional_stager" | "virtual" | "vacant" | "owner_decluttering">

  // Seller responsibilities + disclosures
  knownDefects:           IntakeField<string[]>
  recentRepairs:          IntakeField<string[]>
  hoaInfo:                IntakeField<string>
  septicSystem:           IntakeField<boolean>
  solarLeased:            IntakeField<boolean>
  leadPaintEra:           IntakeField<boolean>           // built before 1978
  showingInstructions:    IntakeField<string>

  // Free-form
  agentNotes:             IntakeField<string>
}

export interface VoiceToListingResult {
  intake: ListingIntake
  followUpQuestions: Array<{ field: keyof ListingIntake; question: string }>
  readyToDraft: boolean
  extractionTrace: {
    inputLength: number
    extractedAt: string
    modelFeature: string
  }
}

function emptyField<T>(): IntakeField<T> { return { value: null, confidence: "missing" } }

function emptyIntake(): ListingIntake {
  return {
    propertyAddress: emptyField(),     propertyCity: emptyField(),
    propertyState: emptyField(),        propertyZip: emptyField(),
    propertyType: emptyField(),         bedrooms: emptyField(),
    bathrooms: emptyField(),            sqft: emptyField(),
    yearBuilt: emptyField(),
    sellerLegalName: emptyField(),      coSellerLegalName: emptyField(),
    sellerEmail: emptyField(),          sellerPhone: emptyField(),
    sellerEntity: emptyField(),         sellerMotivation: emptyField(),
    listPrice: emptyField(),            commissionTotalPercent: emptyField(),
    commissionToBuyerAgent: emptyField(), listingTermDays: emptyField(),
    goLiveDate: emptyField(),           expirationDate: emptyField(),
    professionalPhotos: emptyField(),   videoTour: emptyField(),
    openHousePlan: emptyField(),        comingSoonPeriod: emptyField(),
    stagingPlan: emptyField(),
    knownDefects: emptyField(),         recentRepairs: emptyField(),
    hoaInfo: emptyField(),              septicSystem: emptyField(),
    solarLeased: emptyField(),          leadPaintEra: emptyField(),
    showingInstructions: emptyField(),  agentNotes: emptyField(),
  }
}

const REQUIRED_FIELDS: Array<keyof ListingIntake> = [
  "propertyAddress", "propertyState", "sellerLegalName",
  "listPrice", "commissionTotalPercent", "listingTermDays", "goLiveDate",
]

const FIELD_QUESTIONS: Partial<Record<keyof ListingIntake, string>> = {
  propertyAddress:        "What's the property address?",
  propertyState:          "Which state is the property in?",
  sellerLegalName:        "Seller's legal full name as it appears on the deed?",
  coSellerLegalName:      "Anyone selling with them — spouse, partner, co-owner?",
  sellerEntity:           "Are they listing as individuals, jointly, or through an LLC/trust?",
  sellerMotivation:       "What's driving the sale — relocation, upsizing, downsizing, estate?",
  listPrice:              "Target list price?",
  commissionTotalPercent: "Total commission percent — and what's offered to the buyer's agent?",
  listingTermDays:        "Listing term — typically 90 or 180 days?",
  goLiveDate:             "When should we go active on the MLS?",
  comingSoonPeriod:       "How many days of 'Coming Soon' before MLS live?",
  professionalPhotos:     "Professional photography included?",
  videoTour:              "Video tour included?",
  openHousePlan:          "When and how often will we hold open houses?",
  stagingPlan:            "Staging — existing furniture, professional stager, virtual, or vacant?",
  knownDefects:           "Any known defects to disclose — roof, foundation, plumbing, etc.?",
  recentRepairs:          "Any recent repairs or upgrades worth highlighting?",
  hoaInfo:                "Is there an HOA? What are the dues and rules?",
  showingInstructions:    "How should buyers book showings — appointment only, lockbox, etc.?",
}

export async function extractListingIntake(input: {
  text:  string
  prior?: ListingIntake
}): Promise<VoiceToListingResult> {
  const intake = input.prior ? structuredClone(input.prior) : emptyIntake()

  const stateList = ALL_US_STATES.join(", ")
  const priorSummary = input.prior
    ? `\n\nPRIOR INTAKE (preserve high-confidence fields, only update where new input contradicts):\n${summarizeIntake(input.prior)}`
    : ""

  const prompt = `You are a listing transaction coordinator extracting listing-agreement details from an agent's input.

For each field provide: value, confidence ("high"|"medium"|"low"|"missing"), and sourceSpan (exact phrase from input).
Valid US state codes: ${stateList}.
Valid propertyType: single_family | condo | townhouse | multi_family | land.
Valid sellerMotivation: relocation | upsize | downsize | investment_exit | estate | other.
Valid stagingPlan: existing | professional_stager | virtual | vacant | owner_decluttering.

Return ONLY valid JSON with the exact ListingIntake shape (no prose, no markdown).${priorSummary}

INPUT:
${input.text}

JSON ONLY:`

  let extracted: Partial<ListingIntake> = {}
  try {
    const { text } = await generateTextRouted({
      feature: "listing_intake_extraction",
      messages: [{ role: "user", content: prompt }],
    })
    extracted = JSON.parse(text.replace(/```json|```/g, "").trim())
  } catch {
    return {
      intake,
      followUpQuestions: REQUIRED_FIELDS.map(field => ({
        field,
        question: FIELD_QUESTIONS[field] ?? `Please provide ${field}`,
      })),
      readyToDraft: false,
      extractionTrace: { inputLength: input.text.length, extractedAt: new Date().toISOString(), modelFeature: "listing_intake_extraction" },
    }
  }

  for (const key of Object.keys(intake) as Array<keyof ListingIntake>) {
    const newField = extracted[key]
    if (!newField) continue
    const oldRank = confidenceRank(intake[key].confidence)
    const newRank = confidenceRank((newField as IntakeField<unknown>).confidence)
    if (newRank > oldRank || (newField as IntakeField<unknown>).value !== null) {
      ;(intake as any)[key] = newField
    }
  }

  // Auto-detect leadPaintEra from yearBuilt
  if (intake.leadPaintEra.value == null && intake.yearBuilt.value != null) {
    intake.leadPaintEra = {
      value: intake.yearBuilt.value < 1978,
      confidence: "high",
      note: "Computed from yearBuilt",
    }
  }

  const followUpQuestions: Array<{ field: keyof ListingIntake; question: string }> = []
  for (const field of REQUIRED_FIELDS) {
    const f = intake[field]
    if (f.confidence === "missing" || f.confidence === "low") {
      const q = FIELD_QUESTIONS[field]
      if (q) followUpQuestions.push({ field, question: q })
    }
  }
  for (const field of REQUIRED_FIELDS) {
    const f = intake[field]
    if (f.confidence === "medium" && f.value != null) {
      followUpQuestions.push({
        field,
        question: `I heard ${field} = ${JSON.stringify(f.value)}. Confirm?`,
      })
    }
  }

  const readyToDraft = REQUIRED_FIELDS.every(f => {
    const c = intake[f].confidence
    return c === "high" || c === "medium"
  })

  return {
    intake,
    followUpQuestions,
    readyToDraft,
    extractionTrace: { inputLength: input.text.length, extractedAt: new Date().toISOString(), modelFeature: "listing_intake_extraction" },
  }
}

function confidenceRank(c: Confidence): number {
  return c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0
}

function summarizeIntake(intake: ListingIntake): string {
  const lines: string[] = []
  for (const [key, field] of Object.entries(intake) as Array<[keyof ListingIntake, IntakeField<unknown>]>) {
    if (field.value !== null) {
      lines.push(`${key}: ${JSON.stringify(field.value)} [${field.confidence}]`)
    }
  }
  return lines.join("\n")
}

export function intakeToListingDraftParams(input: {
  intake:       ListingIntake
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
  if (!state) throw new Error("Cannot draft listing agreement — propertyState is missing")
  return {
    brokerageId:     input.brokerageId,
    contactId:       input.contactId,
    agentUserId:     input.agentUserId,
    state,
    documentId:      input.documentId,
    propertyAddress: input.intake.propertyAddress.value ?? undefined,
    listingId:       null,
  }
}
