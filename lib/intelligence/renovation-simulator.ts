// lib/intelligence/renovation-simulator.ts
//
// RENOVATION OUTCOME SIMULATOR (listing_concierge) — the premium
// listing-consult weapon: "what would a kitchen refresh actually do for
// your sale?" answered with HONEST industry cost/effect ranges scaled to
// THIS home's price band — explicitly labeled typical ranges, never a
// promise or an appraisal (fabricated certainty here is a licensing
// exposure). Pure templates + pure composer; the client-facing copy follows
// the charter's client tone (substance in everyday words, one idea per
// card, never scary) and always routes the decision back to the agent —
// who can pull the vendor bench for real quotes in one tap.

export interface RenovationTemplate {
  key: string
  label: string
  /** Cost as a share of home value [lo, hi] — scaled bands beat flat dollars across markets. */
  costPctOfValue: [number, number]
  /** Typical resale-effect share of home value [lo, hi] (industry remodeling-impact ranges). */
  effectPctOfValue: [number, number]
  note: string
}

/** Curated, honest set — each note says who it tends to matter for. */
export const RENOVATION_TEMPLATES: RenovationTemplate[] = [
  { key: "paint_refresh", label: "Fresh paint + deep clean", costPctOfValue: [0.3, 0.8], effectPctOfValue: [1.0, 2.5],
    note: "The highest-leverage dollar in the book — buyers read fresh paint as 'cared for', and it photographs beautifully." },
  { key: "curb_appeal", label: "Curb appeal (landscaping, door, lighting)", costPctOfValue: [0.4, 1.0], effectPctOfValue: [1.0, 3.0],
    note: "The showing starts at the curb — this one shapes every photo and every first impression." },
  { key: "kitchen_refresh", label: "Kitchen refresh (paint cabinets, hardware, counters)", costPctOfValue: [1.5, 4.0], effectPctOfValue: [2.0, 5.0],
    note: "A refresh, not a gut job — kitchens sell homes, and buyers overweight them in every walkthrough." },
  { key: "bath_update", label: "Bathroom update (fixtures, vanity, re-glaze)", costPctOfValue: [1.0, 2.5], effectPctOfValue: [1.5, 3.5],
    note: "Dated baths are a top negotiation excuse — removing the excuse often beats the cost." },
  { key: "flooring", label: "Flooring (replace worn carpet / refinish floors)", costPctOfValue: [1.0, 3.0], effectPctOfValue: [1.5, 4.0],
    note: "Worn floors make buyers start a mental repair list — new floors stop the list before it starts." },
]

export interface RenovationScenario {
  key: string
  label: string
  costRange: [number, number]
  effectRange: [number, number]
  note: string
}

const round500 = (n: number): number => Math.max(500, Math.round(n / 500) * 500)

/** PURE: scale the templates to THIS home's value. Honest null when the value isn't real. */
export function composeRenovationScenarios(homeValue: number | null | undefined, templates: RenovationTemplate[] = RENOVATION_TEMPLATES): RenovationScenario[] {
  const v = Number(homeValue)
  if (!Number.isFinite(v) || v < 50_000) return [] // no real value = no scenarios, never invented
  return templates.map((t) => ({
    key: t.key,
    label: t.label,
    costRange: [round500((t.costPctOfValue[0] / 100) * v), round500((t.costPctOfValue[1] / 100) * v)],
    effectRange: [round500((t.effectPctOfValue[0] / 100) * v), round500((t.effectPctOfValue[1] / 100) * v)],
    note: t.note,
  }))
}

/** PURE: the honesty framing every rendering of this MUST carry (sim-locked). */
export const RENOVATION_DISCLAIMER =
  "These are typical ranges from industry remodeling-impact data, scaled to your home's price — not a promise, an appraisal, or a quote. Your agent can bring in trusted local pros for real numbers."
