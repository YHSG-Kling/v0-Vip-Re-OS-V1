// ─── CDA TEMPLATE FIELD RESOLVER (the waterfall → the brokerage's own CDA form) ──
// Brokerages use DIFFERENT CDA forms. Each form's fillable fields are bound to a
// SOURCE (the commission waterfall, the transaction, an agent input, or a static
// value). This pure resolver takes a brokerage's field definitions + the live
// context and produces the FILLED, FORMATTED field values for that brokerage's
// form — so the OS auto-fills the brokerage's actual CDA, not a generic tally.
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
  /** Only agent_input fields are editable; waterfall/transaction/static are locked. */
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
    let value: string | number | null = null
    let editable = false

    switch (def.source) {
      case "waterfall": {
        const raw = def.source_key ? ctx.waterfall[def.source_key] : undefined
        value = typeof raw === "number" && Number.isFinite(raw) ? raw : null
        break
      }
      case "transaction": {
        const raw = def.source_key ? ctx.transaction[def.source_key] : undefined
        value = raw == null ? null : raw
        break
      }
      case "static": {
        value = def.static_value ?? null
        break
      }
      case "agent_input": {
        editable = true
        const raw = ctx.agentInputs[def.field_key]
        value = raw == null || raw === "" ? null : raw
        if (def.required && (value == null || String(value).trim() === "")) {
          missingRequired.push(def.field_key)
        }
        break
      }
    }

    fields.push({
      field_key: def.field_key,
      label: def.label ?? def.field_key,
      source: def.source,
      value,
      formatted: format(value, def.field_type),
      editable,
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
