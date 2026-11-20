// lib/providers/dormant-adapters.ts
//
// THE DORMANT ADAPTERS (wave 150, lane 150HIAB — directive 150H / 150I, owner ruling R9). PURE: response MAPPING only.
// There is deliberately NO transport here — no fetch, no SDK, no credential read, no vendor host. A dormant provider has
// nothing to call until its activation evidence is recorded (lib/providers/provider-scorecard.ts PROVIDER_ACTIVATION /
// activationVerdict); building the transport is part of that reviewed activation change, together with its route row in
// CONTACT_PROVIDER_ROUTES and its ADAPTER_FACTS declaration. What CAN be built and proven before any contract is the
// MAPPING: given a response shaped as the vendor DOCUMENTS it, which of OUR fields does it fill, in which unit — and
// which keys we do not map because the documentation read did not name them (kept as `unmappedKeys`, never guessed).
//
// "Verified response MAPPING per provider (documented fields only)" — the documented fields, by source:
//   · Tracerfy skip trace: `hit`, `credits_deducted` (tracerfy.com/skip-tracing-api-documentation, comparison §10.1). The
//     phone / email array keys are not named in the pages read → unmapped until the free mock sandbox's schema is read
//     (WAITING_EXTERNAL). A skip trace carries NO seller score — a score-looking key on a trace is never promoted to one.
//   · Tracerfy Lead Builder / TraceAI: a delivered record with five propensity scores (sell, refinance, roof, HVAC, solar);
//     only the SELL score is a seller signal (stored as tracerfy_lead_builder_seller_score, Tracerfy's own scale) — but
//     the JSON key that carries it is NOT named in the pages read, so this mapper labels nothing until the schema is
//     read (the pilot simulation models the VALUE through labelSellerSignal, never a guessed wire shape).
//   · DataZapp Demography Append: the 41 documented columns (knowledgebase.datazapp.com/apis/demography-append-api); this
//     adapter maps only what the requested capability needs (LOR, Home_Owner, Dwelling_Type, Home_Value, and the 0x–4x
//     Signal_Seller_Score). Other columns are not fetched-and-stored by this adapter ("ask only for the missing field") —
//     research attributes, when wanted, belong to the protected research store (R3), not here.
//   · DataZapp Email Append API: batch `Data` array, `Matched` flag, `OrderAmount` (the per-row email key inside `Data`
//     is not named in the page read → not mapped).
//   · PropertyRadar: `results`, `resultCount`, `totalResultCount`, `quantityFreeRemaining`; per result `RadarID`,
//     `DistressScore` (0–100) — the installed playbook's references/endpoints.md. `Purchase=0` is a free preview.
//   · Data Axle: no field-level documentation was read → no mapper (refused with its reason).

import { labelSellerSignal, type LabelledSellerSignal, type ScoreField, type ScorecardProvider } from "@/lib/providers/provider-scorecard"
import type { SourcePreview } from "@/lib/lead-pipeline/source-discovery-planner"

export type DormantProduct =
  | "tracerfy_skip_trace" | "tracerfy_lead_builder"
  | "datazapp_demographic" | "datazapp_email_append"
  | "propertyradar_search_preview" | "propertyradar_property"
  | "data_axle_people"

export interface MappedDormantResponse {
  provider: ScorecardProvider
  product: DormantProduct
  /** OUR fields this response filled (values verbatim from documented keys). */
  fields: Partial<Record<ScoreField, unknown>>
  sellerSignals: LabelledSellerSignal[]
  /** What the vendor says it billed, from documented keys only (null = the response does not say). */
  billing: { hit: boolean | null; creditsDeducted: number | null; amountUsd: number | null }
  /** A free preview count (PropertyRadar Purchase=0) in the planner's SourcePreview shape. */
  preview: SourcePreview | null
  /** Keys present in the response that the documentation read did NOT name — kept out of every field. */
  unmappedKeys: string[]
  refusals: string[]
}

const PRODUCT_PROVIDER: Readonly<Record<DormantProduct, ScorecardProvider>> = Object.freeze({
  tracerfy_skip_trace: "tracerfy", tracerfy_lead_builder: "tracerfy",
  datazapp_demographic: "datazapp", datazapp_email_append: "datazapp",
  propertyradar_search_preview: "propertyradar", propertyradar_property: "propertyradar",
  data_axle_people: "data_axle",
})

/** The documented keys each product's mapper reads — everything else is `unmappedKeys`. */
const DOCUMENTED_KEYS: Readonly<Record<DormantProduct, readonly string[]>> = Object.freeze({
  tracerfy_skip_trace: ["hit", "credits_deducted"],
  tracerfy_lead_builder: ["hit", "credits_deducted"],
  datazapp_demographic: ["Home_Owner", "LOR", "Dwelling_Type", "Home_Value", "Signal_Seller_Score"],
  datazapp_email_append: ["Data", "Matched", "OrderAmount"],
  propertyradar_search_preview: ["results", "resultCount", "totalResultCount", "quantityFreeRemaining"],
  propertyradar_property: ["RadarID", "DistressScore"],
  data_axle_people: [],
})

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * @proofSeam the dormant providers have no transport until activation (R9) — scripts/provider-waterfall-guard.ts holds
 * the documented-fields mapping until the activation change wires a transport to it
 * PURE — map ONE documented-shape response of a dormant provider. Never calls anything and never throws. The `at`
 * timestamp is the observation time the caller records (the simulation's clock in a proof).
 */
export function mapDormantProviderResponse(product: DormantProduct, raw: unknown, at: string): MappedDormantResponse {
  const provider = PRODUCT_PROVIDER[product]
  const out: MappedDormantResponse = { provider, product, fields: {}, sellerSignals: [], billing: { hit: null, creditsDeducted: null, amountUsd: null }, preview: null, unmappedKeys: [], refusals: [] }
  if (product === "data_axle_people") { out.refusals.push("Data Axle: no field-level documentation was read — no mapping exists (only for a proven market-level gap, R9)"); return out }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { out.refusals.push(`${product}: response is not an object`); return out }
  const r = raw as Record<string, unknown>
  const documented = new Set(DOCUMENTED_KEYS[product])
  out.unmappedKeys = Object.keys(r).filter((k) => !documented.has(k)).sort()
  const signal = (name: Parameters<typeof labelSellerSignal>[0], value: unknown) => {
    if (value === undefined || value === null || value === "") return
    const l = labelSellerSignal(name, value, at)
    if (l.ok) out.sellerSignals.push(l.signal)
    else out.refusals.push(l.reason)
  }

  switch (product) {
    case "tracerfy_skip_trace": {
      out.billing.hit = typeof r.hit === "boolean" ? r.hit : null
      out.billing.creditsDeducted = num(r.credits_deducted)
      // A skip trace is CONTACT data, never a score: nothing here becomes a seller signal (canary 9).
      break
    }
    case "tracerfy_lead_builder": {
      out.billing.hit = typeof r.hit === "boolean" ? r.hit : null
      out.billing.creditsDeducted = num(r.credits_deducted)
      if (out.unmappedKeys.length > 0) out.refusals.push("tracerfy_lead_builder: the key carrying the SELL propensity score is not documented in the pages read — nothing labelled until the schema is read")
      break
    }
    case "datazapp_demographic": {
      if (r.LOR !== undefined) out.fields.length_of_residence = r.LOR
      if (r.Home_Value !== undefined) out.fields.home_value = r.Home_Value
      signal("datazapp_signal_seller_score", r.Signal_Seller_Score)
      break
    }
    case "datazapp_email_append": {
      out.billing.hit = typeof r.Matched === "boolean" ? r.Matched : null
      out.billing.amountUsd = num(r.OrderAmount)
      // DataZapp: "the matched emails are not verified"; the per-row email key inside `Data` is undocumented → not mapped.
      if (Array.isArray(r.Data) && r.Data.length > 0) out.refusals.push("datazapp_email_append: the email key inside `Data` is not documented in the page read — not mapped")
      break
    }
    case "propertyradar_search_preview": {
      const total = num(r.totalResultCount)
      if (total === null) out.refusals.push("propertyradar_search_preview: no totalResultCount — not a preview count")
      else out.preview = { count: total, at, via: "propertyradar:Purchase=0 totalResultCount" }
      out.billing.creditsDeducted = 0
      break
    }
    case "propertyradar_property": {
      signal("propertyradar_distress_score", r.DistressScore)
      break
    }
  }
  return out
}
