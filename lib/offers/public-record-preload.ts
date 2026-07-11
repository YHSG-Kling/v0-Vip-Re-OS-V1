/**
 * lib/offers/public-record-preload.ts
 *
 * PUBLIC-RECORD PRELOAD for the seller net sheet — the OS arrives with the
 * tax line already REAL instead of a 0.5%-of-price default. Rides the
 * EXISTING BatchData rail (batchDataPreferMcp → lookup_property, the same
 * provider-gated seam the phone scrub uses): when the account is configured
 * and funded, the county tax amount lands with source 'public_record'; when
 * it isn't (unset env, out of balance, no usable figure), the template
 * default STANDS and the provenance says so — never a fabricated "verified".
 *
 * Parser is deliberately tolerant across BatchData's documented property
 * shapes (assessment/tax sections vary by dataset tier); a figure is only
 * adopted when it parses to a positive finite number.
 *
 * NOT server-only (simulator-driven, like the rest of the kernel runners).
 */

export interface PublicRecordCosts {
  /** annual county/city tax amount, when a real figure was found. */
  annualTaxAmount: number | null
  assessedValue: number | null
  taxYear: number | null
  via: "mcp" | "rest" | "skipped"
  /** why nothing was adopted (unconfigured / no balance / no figure). */
  skipReason: string | null
}

/** Tolerant extraction across the shapes BatchData ships per dataset tier. */
export function extractTaxFigures(payload: unknown): { tax: number | null; assessed: number | null; year: number | null } {
  const out = { tax: null as number | null, assessed: null as number | null, year: null as number | null }
  const num = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 6) return
    const o = node as Record<string, unknown>
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase()
      if (out.tax === null && (key === "taxamount" || key === "annualtaxamount" || key === "taxbilledamount" || (key === "amount" && "taxyear" in o))) {
        out.tax = num(v)
      }
      if (out.assessed === null && (key === "assessedvalue" || key === "totalassessedvalue")) out.assessed = num(v)
      if (out.year === null && (key === "taxyear" || key === "assessmentyear")) {
        const y = Number(v)
        if (Number.isFinite(y) && y > 1900 && y < 2200) out.year = y
      }
      if (typeof v === "object" && v !== null) visit(v, depth + 1)
    }
  }
  visit(payload, 0)
  return out
}

export async function preloadPublicRecordCosts(address: {
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
}): Promise<PublicRecordCosts> {
  const none = (reason: string): PublicRecordCosts =>
    ({ annualTaxAmount: null, assessedValue: null, taxYear: null, via: "skipped", skipReason: reason })

  if (!address.street || !address.city || !address.state || !address.zip) {
    return none("address incomplete — need street + city + state + zip for a records lookup")
  }

  try {
    const { batchDataPreferMcp } = await import("@/lib/external/batchdata-mcp")
    const r = await batchDataPreferMcp<unknown>(
      "lookup_property",
      {
        property_street: address.street,
        property_city: address.city,
        property_state: address.state,
        property_zip: address.zip,
      },
      // No REST twin for property lookup yet — the MCP lane is the rail; a
      // null here is a clean skip, never a fabricated figure.
      async () => null,
    )
    if (!r.data) return none(r.error ?? "records lookup unavailable")
    const figures = extractTaxFigures(r.data)
    if (figures.tax === null) return none("lookup returned no usable tax figure")
    return { annualTaxAmount: figures.tax, assessedValue: figures.assessed, taxYear: figures.year, via: r.via, skipReason: null }
  } catch (e: any) {
    return none(e?.message ?? "records lookup failed")
  }
}
