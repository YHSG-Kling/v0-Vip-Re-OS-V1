// ─── CDA FIELD AUTO-BINDING CLASSIFIER (the autonomous-AI step) ──────────────
// A brokerage uploads its OWN CDA PDF. Its AcroForm field names ("Agent
// Commission $", "Sale Price", "Split %", "Notes") tell us nothing on their own —
// each must be BOUND to a source the OS can fill: the live commission waterfall,
// the transaction, an agent input, or a static value. Doing that by hand for every
// brokerage form is exactly the manual config that makes "AI OS" a marketing word.
//
// This classifier turns extracted AcroForm field names into SUGGESTED bindings the
// broker confirms in one click. Two layers:
//   • suggestCdaFieldBindings()  — PURE, deterministic heuristic floor (this file's
//     unit-tested core; never invents a source_key outside the catalog).
//   • aiClassifyCdaFields()      — AI-augmented (Vercel AI Gateway) that REFINES the
//     floor; every AI binding is validated against the same catalog, so a
//     hallucinated source_key is dropped back to the heuristic. No floor regression:
//     with no AI key, or on any AI error, you get the deterministic result.
//
// The resolver that actually FILLS these bindings lives in cda-template-fields.ts.

import type { CdaFieldDef, CdaFieldSource, CdaFieldType } from "./cda-template-fields"

// ── The catalog: the ONLY source_keys a binding may reference (grounding) ─────
// Keys mirror cdaWaterfallContext() (waterfall) and buildContext() (transaction)
// in the resolver/action — keep them in sync.
export const CDA_WATERFALL_KEYS: Record<string, { label: string; field_type: CdaFieldType }> = {
  gross_commission: { label: "Gross Commission", field_type: "currency" },
  agent_net: { label: "Agent Net Commission", field_type: "currency" },
  brokerage_net: { label: "Brokerage Net Commission", field_type: "currency" },
  agent_split_percent: { label: "Agent Split %", field_type: "percent" },
  fees: { label: "Fees", field_type: "currency" },
  team_split: { label: "Team Split", field_type: "currency" },
  revenue_share: { label: "Revenue Share", field_type: "currency" },
}

export const CDA_TRANSACTION_KEYS: Record<string, { label: string; field_type: CdaFieldType }> = {
  property_address: { label: "Property Address", field_type: "text" },
  close_date: { label: "Closing Date", field_type: "date" },
  sale_price: { label: "Sale Price", field_type: "currency" },
}

export interface SuggestedBinding extends CdaFieldDef {
  /** the raw AcroForm field name this binding came from (broker sees both). */
  pdf_field: string
  /** 0..1 — heuristic/AI confidence; the UI can sort/flag low-confidence rows. */
  confidence: number
  /** short human reason for the suggestion (shown in the review UI). */
  reason: string
}

// ── source_key validation (shared by the heuristic AND the AI validator) ──────
export function isValidBinding(source: CdaFieldSource, sourceKey: string | null | undefined): boolean {
  if (source === "waterfall") return !!sourceKey && sourceKey in CDA_WATERFALL_KEYS
  if (source === "transaction") return !!sourceKey && sourceKey in CDA_TRANSACTION_KEYS
  // agent_input / static carry no catalog key.
  return true
}

function fieldTypeForKey(source: CdaFieldSource, sourceKey: string | null): CdaFieldType | null {
  if (source === "waterfall") return CDA_WATERFALL_KEYS[sourceKey ?? ""]?.field_type ?? null
  if (source === "transaction") return CDA_TRANSACTION_KEYS[sourceKey ?? ""]?.field_type ?? null
  return null
}

// ── normalization helpers ────────────────────────────────────────────────────
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9%$]+/g, " ").trim()
}

function toFieldKey(name: string): string {
  const k = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return k || "field"
}

const has = (n: string, ...kw: string[]) => kw.some((k) => n.includes(k))
const PERCENT_HINT = (n: string, raw: string) => raw.includes("%") || has(n, "percent", "pct")
const AGENT_KW = (n: string) => has(n, "agent", "salesperson", "associate", "licensee", "realtor")
const BROKER_KW = (n: string) => has(n, "broker", "brokerage", "company", "firm", " office")
const MONEY_KW = (n: string) => has(n, "commission", "net", "amount", "due", "earning", "payout", "disburse", "proceeds", "check", "compensation", "$")

// Each matcher inspects (normalized name, raw name) and returns a partial binding or null.
// Ordered most-specific → least; first hit wins.
type Match = { source: CdaFieldSource; source_key: string | null; field_type: CdaFieldType; confidence: number; reason: string } | null
const MATCHERS: Array<(n: string, raw: string) => Match> = [
  // Transaction facts (very specific nouns).
  (n) => has(n, "property", "premises") || has(n, "address") || has(n, "subject property")
    ? { source: "transaction", source_key: "property_address", field_type: "text", confidence: 0.85, reason: "names the property/address" } : null,
  (n) => has(n, "closing date", "close date", "settlement date", "date of closing", "escrow close", "coe") || (has(n, "date") && has(n, "clos", "settl"))
    ? { source: "transaction", source_key: "close_date", field_type: "date", confidence: 0.85, reason: "names the closing/settlement date" } : null,
  (n) => has(n, "sale price", "sales price", "purchase price", "contract price", "selling price", "contract sales price")
    ? { source: "transaction", source_key: "sale_price", field_type: "currency", confidence: 0.85, reason: "names the sale/purchase price" } : null,

  // Split percent — needs a percent hint so a "split $" line isn't mis-typed.
  (n, raw) => (has(n, "split", "commission") && PERCENT_HINT(n, raw))
    ? { source: "waterfall", source_key: "agent_split_percent", field_type: "percent", confidence: 0.8, reason: "split/commission with a % hint" } : null,

  // Gross / total commission before per-side nets.
  (n) => has(n, "gross", "total commission", "total due") || (has(n, "total") && has(n, "commission"))
    ? { source: "waterfall", source_key: "gross_commission", field_type: "currency", confidence: 0.82, reason: "gross/total commission" } : null,

  // Fees (franchise/E&O/admin/royalty/processing or a generic 'fee').
  (n) => has(n, "franchise fee", "transaction fee", "admin fee", "compliance fee", "processing fee", "royalty", "e&o", "e o ", " eo ") || has(n, "fee")
    ? { source: "waterfall", source_key: "fees", field_type: "currency", confidence: 0.65, reason: "a fee line" } : null,

  (n) => has(n, "team")
    ? { source: "waterfall", source_key: "team_split", field_type: "currency", confidence: 0.65, reason: "a team split line" } : null,
  (n) => has(n, "revenue share", "rev share", "profit share")
    ? { source: "waterfall", source_key: "revenue_share", field_type: "currency", confidence: 0.65, reason: "a revenue/profit share line" } : null,

  // Per-side nets.
  (n) => (AGENT_KW(n) && MONEY_KW(n))
    ? { source: "waterfall", source_key: "agent_net", field_type: "currency", confidence: 0.75, reason: "agent's commission/net amount" } : null,
  (n) => (BROKER_KW(n) && MONEY_KW(n))
    ? { source: "waterfall", source_key: "brokerage_net", field_type: "currency", confidence: 0.72, reason: "brokerage's commission/net amount" } : null,

  // Bare "commission" with no side → gross, low confidence.
  (n) => has(n, "commission")
    ? { source: "waterfall", source_key: "gross_commission", field_type: "currency", confidence: 0.5, reason: "an unqualified commission amount" } : null,
]

function guessAgentInputType(n: string, raw: string): CdaFieldType {
  if (has(n, "date")) return "date"
  if (PERCENT_HINT(n, raw)) return "percent"
  if (has(n, "amount", "price", "fee", "commission", "net", "gross", "total", "dollar", "$")) return "currency"
  return "text"
}

/**
 * PURE heuristic floor: map each extracted AcroForm field name → a suggested binding.
 * Deterministic, no I/O, no network — this is the unit-tested core and the floor the
 * AI layer can only refine, never drop below. field_keys are made unique.
 */
export function suggestCdaFieldBindings(fieldNames: string[]): SuggestedBinding[] {
  const usedKeys = new Set<string>()
  const out: SuggestedBinding[] = []

  fieldNames.forEach((rawName, i) => {
    const name = String(rawName ?? "").trim()
    const n = normalize(name)

    let match: Match = null
    for (const m of MATCHERS) {
      match = m(n, name)
      if (match) break
    }

    // Unique field_key (unique(template_id, field_key) in the DB).
    let key = toFieldKey(name)
    while (usedKeys.has(key)) key = `${key}_${usedKeys.size + 1}`
    usedKeys.add(key)

    if (match) {
      out.push({
        field_key: key,
        label: name || match.source_key || key,
        source: match.source,
        source_key: match.source_key,
        field_type: match.field_type,
        required: false,
        display_order: i,
        pdf_field: name,
        confidence: match.confidence,
        reason: match.reason,
      })
    } else {
      out.push({
        field_key: key,
        label: name || key,
        source: "agent_input",
        source_key: null,
        field_type: guessAgentInputType(n, name),
        required: false,
        display_order: i,
        pdf_field: name,
        confidence: 0.3,
        reason: "no waterfall/transaction match — agent fills this in",
      })
    }
  })

  return out
}

// ── AI-augmented refinement (validated against the same catalog) ─────────────
/**
 * Refine the heuristic floor with the AI gateway. Every AI binding is validated:
 * a waterfall/transaction binding whose source_key is not in the catalog is
 * DROPPED back to the heuristic suggestion for that field. With no AI key, or on
 * any error, returns the pure floor unchanged (no stubs, no fabricated data).
 */
export async function aiClassifyCdaFields(fieldNames: string[]): Promise<SuggestedBinding[]> {
  const floor = suggestCdaFieldBindings(fieldNames)
  if (!process.env.AI_GATEWAY_API_KEY || floor.length === 0) return floor

  try {
    const { generateAIObject } = await import("@/lib/ai/generate")
    const { z } = await import("zod")

    const catalog = [
      "waterfall.gross_commission (currency)", "waterfall.agent_net (currency)",
      "waterfall.brokerage_net (currency)", "waterfall.agent_split_percent (percent)",
      "waterfall.fees (currency)", "waterfall.team_split (currency)", "waterfall.revenue_share (currency)",
      "transaction.property_address (text)", "transaction.close_date (date)", "transaction.sale_price (currency)",
      "agent_input (the agent types it; for anything that isn't a known waterfall/transaction value)",
      "static (a fixed value the broker sets later)",
    ].join("\n  - ")

    const schema = z.object({
      bindings: z.array(z.object({
        pdf_field: z.string(),
        source: z.enum(["waterfall", "transaction", "agent_input", "static"]),
        source_key: z.string().nullable(),
        field_type: z.enum(["currency", "percent", "date", "text"]),
      })),
    })

    const prompt = `You map the fillable fields of a real-estate brokerage's Commission Disbursement Authorization (CDA) PDF to the data source that should auto-fill each one.

Allowed sources (use EXACTLY these source_key strings; never invent one):
  - ${catalog}

PDF AcroForm field names:
${fieldNames.map((f, i) => `${i + 1}. "${f}"`).join("\n")}

For each field name, return the best binding. Use waterfall/transaction only when the field clearly corresponds to that value; otherwise use agent_input. For waterfall/transaction, source_key MUST be one of the catalog keys above. For agent_input/static, source_key is null. Return one binding per field, in order.`

    const res = await generateAIObject(prompt, schema, { temperature: 0.1 })
    if (!res.success || !res.object?.bindings) return floor

    // Index AI bindings by pdf_field (fall back to positional if names collide).
    const byField = new Map<string, { source: CdaFieldSource; source_key: string | null; field_type: CdaFieldType }>()
    res.object.bindings.forEach((b) => {
      if (!byField.has(b.pdf_field)) {
        byField.set(b.pdf_field, { source: b.source, source_key: b.source_key ?? null, field_type: b.field_type })
      }
    })

    return floor.map((f) => {
      const ai = byField.get(f.pdf_field)
      if (!ai) return f
      // Validate against the catalog — drop hallucinated keys back to the floor.
      if (!isValidBinding(ai.source, ai.source_key)) return f
      // For known sources, the catalog dictates field_type (keep formatting honest).
      const canonType = fieldTypeForKey(ai.source, ai.source_key)
      const sameAsFloor = ai.source === f.source && (ai.source_key ?? null) === (f.source_key ?? null)
      return {
        ...f,
        source: ai.source,
        source_key: ai.source_key,
        field_type: canonType ?? ai.field_type,
        confidence: sameAsFloor ? Math.max(f.confidence, 0.9) : 0.88,
        reason: sameAsFloor ? `${f.reason} (AI-confirmed)` : "AI-mapped from the field label",
      }
    })
  } catch {
    return floor
  }
}
