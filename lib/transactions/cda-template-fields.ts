// ─── CDA TEMPLATE FIELD RESOLVER (the brokerage's own CDA form — AGENT-FILLED) ──
// Brokerages use DIFFERENT CDA forms. Each form's fillable fields are bound to a
// SOURCE (the commission waterfall, the transaction, an agent input, or a static
// value). This pure resolver takes a brokerage's field definitions + the live
// context and produces the field values for that brokerage's form.
//
// THE AGENT FILLS THE CDA IN — no autofill of the money. Waterfall (commission/split/net)
// fields are NOT pre-filled from the computed value; the agent types them in and e-signs.
// The computed value is retained per-field as `expected`, the baseline the AI audits the
// agent's entry against (the contract + outstanding-fee check surfaces mismatches to
// compliance at submit). Objective transaction facts (property address, close date) and
// static template constants still pre-fill as a convenience.
//
// Pure (no I/O) → unit-testable (scripts/cda-template-fields-simulator.ts). The
// server action loads the defs + builds the context from commission_distributions
// and the transaction, then persists the result to closing_disclosure_agreement.field_values.

export type CdaFieldSource = "waterfall" | "transaction" | "agent_input" | "static"
export type CdaFieldType = "currency" | "percent" | "date" | "text"

export interface CdaFieldDef {
  field_key: string
  label?: string | null
  source: CdaFieldSource
  /** which key in the waterfall/transaction context this field pulls (null for agent_input/static). */
  source_key?: string | null
  field_type: CdaFieldType
  static_value?: string | null
  required?: boolean | null
  display_order?: number | null
  /** the exact AcroForm field name on the brokerage PDF this binding fills (null = no PDF target). */
  pdf_field?: string | null
}

export interface CdaResolveContext {
  /** Numbers from the commission waterfall, keyed by source_key (e.g. agent_net). */
  waterfall: Record<string, number | null | undefined>
  /** Transaction facts, keyed by source_key (e.g. property_address, close_date). */
  transaction: Record<string, string | number | null | undefined>
  /** Values the agent typed into the form, keyed by field_key. */
  agentInputs: Record<string, string | number | null | undefined>
}

export interface ResolvedCdaField {
  field_key: string
  label: string
  source: CdaFieldSource
  /** Raw resolved value (number for currency/percent, string otherwise), or null. */
  value: string | number | null
  /** Display-formatted value for the form. */
  formatted: string
  /**
   * The computed/source-derived value (waterfall/transaction/static) — the AI's EXPECTED
   * baseline the agent's entry is audited against. For money (waterfall) fields this is NOT
   * auto-filled into `value`: the agent must type the number in. Shown as a hint / used for the
   * contract+fee audit. For transaction/static fields it equals the pre-filled convenience value.
   */
  expected: string | number | null
  /** Display-formatted expected baseline (for the "expected $X" hint next to a blank money field). */
  expectedFormatted: string
  /** Every field is editable — the agent fills/confirms it before e-signing. */
  editable: boolean
  field_type: CdaFieldType
  /** the AcroForm field name this resolves into on the brokerage PDF (for fill). */
  pdf_field: string | null
}

export interface CdaFieldResolution {
  fields: ResolvedCdaField[]
  /** field_keys of REQUIRED agent inputs that are still empty (block submission). */
  missingRequired: string[]
}

function fmtCurrency(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return ""
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
}
function fmtPercent(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return ""
  return `${(Math.round(n * 100) / 100).toString()}%`
}
function fmtDate(v: string | number | null | undefined): string {
  if (v == null || v === "") return ""
  const t = Date.parse(String(v))
  if (Number.isNaN(t)) return String(v)
  return new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

// Coerce an agent-typed override back to the field's underlying value. Currency/percent
// inputs may carry "$", ",", "%" or spaces ("$14,500" / "70%") — strip to a clean number so
// the override formats identically to a calculated value. Text/date pass through verbatim.
function coerceTyped(raw: string, type: CdaFieldType): string | number | null {
  if (type === "currency" || type === "percent") {
    const n = Number(raw.replace(/[^0-9.\-]/g, ""))
    return Number.isFinite(n) && raw.replace(/[^0-9.\-]/g, "") !== "" ? n : null
  }
  return raw
}

function format(value: string | number | null, type: CdaFieldType): string {
  if (type === "currency") return fmtCurrency(typeof value === "number" ? value : value == null ? null : Number(value))
  if (type === "percent") return fmtPercent(typeof value === "number" ? value : value == null ? null : Number(value))
  if (type === "date") return fmtDate(value)
  return value == null ? "" : String(value)
}

/** Resolve a brokerage's CDA form fields against the live context. Pure. */
export function resolveCdaTemplateFields(
  defs: CdaFieldDef[],
  ctx: CdaResolveContext,
): CdaFieldResolution {
  const fields: ResolvedCdaField[] = []
  const missingRequired: string[] = []

  const ordered = [...defs].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))

  for (const def of ordered) {
    // 1. The calculated/auto-fill default from the field's source (final transaction money
    //    terms for waterfall/transaction; the static value; nothing for a pure agent input).
    let sourceValue: string | number | null = null
    switch (def.source) {
      case "waterfall": {
        const raw = def.source_key ? ctx.waterfall[def.source_key] : undefined
        sourceValue = typeof raw === "number" && Number.isFinite(raw) ? raw : null
        break
      }
      case "transaction": {
        const raw = def.source_key ? ctx.transaction[def.source_key] : undefined
        sourceValue = raw == null ? null : raw
        break
      }
      case "static": {
        sourceValue = def.static_value ?? null
        break
      }
      case "agent_input":
        sourceValue = null
        break
    }

    // 2. The agent FILLS THE CDA IN — no autofill of the money. A waterfall (commission/split/net)
    //    field is NEVER pre-filled from the computed value: the agent must type it in, and the
    //    computed value is retained only as the EXPECTED baseline the AI audits the entry against.
    //    Objective transaction facts (property address, close date) and static template constants
    //    still pre-fill as a convenience. An agent override always wins. Every field is editable.
    const override = ctx.agentInputs[def.field_key]
    const hasOverride = override != null && String(override).trim() !== ""
    const prefillsFromSource = def.source === "transaction" || def.source === "static"
    const value = hasOverride
      ? coerceTyped(String(override), def.field_type)
      : prefillsFromSource
        ? sourceValue
        : null // waterfall/agent_input: blank until the agent enters it

    // 3. Required fields that end up empty block submission. Money fields are effectively
    //    required-by-entry now: a blank the agent hasn't filled won't fill the PDF (buildCdaFillValues
    //    skips empties) and shows an "expected $X" hint from the baseline below.
    if (def.required && (value == null || String(value).trim() === "")) {
      missingRequired.push(def.field_key)
    }

    fields.push({
      field_key: def.field_key,
      label: def.label ?? def.field_key,
      source: def.source,
      value,
      formatted: format(value, def.field_type),
      expected: sourceValue,
      expectedFormatted: format(sourceValue, def.field_type),
      editable: true,
      field_type: def.field_type,
      pdf_field: def.pdf_field ?? null,
    })
  }

  return { fields, missingRequired }
}

// ── Build the waterfall context from the engine's persisted output ───────────
export interface CdaWaterfallInput {
  gross_commission?: number | null
  agent_net?: number | null
  brokerage_net?: number | null
  /** commission_distributions rows for the transaction (distribution_type + calculated_amount). */
  distributions?: Array<{ distribution_type?: string | null; calculated_amount?: number | null }>
}

/** Derive the named waterfall values a CDA form can bind to. Pure. */
export function cdaWaterfallContext(input: CdaWaterfallInput): Record<string, number | null> {
  const gross = input.gross_commission ?? null
  const agentNet = input.agent_net ?? null
  const brokerageNet = input.brokerage_net ?? null

  // Sum distributions by type so a form can bind a "Fees" or "Team Split" line.
  const byType: Record<string, number> = {}
  for (const d of input.distributions ?? []) {
    const t = (d.distribution_type ?? "other").toLowerCase()
    byType[t] = (byType[t] ?? 0) + (d.calculated_amount ?? 0)
  }

  // Split percent derived from the net vs gross (matches how the dashboard bridge derives it).
  const splitPercent = gross && gross > 0 && agentNet != null ? Math.round((agentNet / gross) * 1000) / 10 : null

  return {
    gross_commission: gross,
    agent_net: agentNet,
    brokerage_net: brokerageNet,
    agent_split_percent: splitPercent,
    fees: byType["fee"] ?? null,
    team_split: byType["team"] ?? null,
    revenue_share: byType["revenue_share"] ?? null,
  }
}
