/**
 * lib/offers/public-record-preload.ts
 *
 * PUBLIC-RECORD PRELOAD for the seller net sheet — the OS arrives with the
 * tax line already REAL instead of a 0.5%-of-price default. When the property
 * record resolves with a tax bill, the county tax amount lands with source
 * 'public_record'; when it doesn't (unset key, budget paused, no usable
 * figure), the template default STANDS and the provenance says so — never a
 * fabricated "verified".
 *
 * WAVE 92 (lane 92B) — RIDES RENTCAST, NOT BATCHDATA. Owner (2026-10-01): "use
 * rentcast as much as possible regarding property listings, market, comparable,
 * home values … also can use it for a simple property lookup" · "batchdata is to
 * be used more for scrapping leads." The tax bill, its year and the county's
 * assessed value are fields of RentCast's property RECORD
 * (lib/property/rentcast.ts::getRentcastPropertyRecord — the same reader the
 * public calculators' tax line rides, gated + metered + cached 30 days).
 * TOMBSTONE (§1.3): the BatchData leg (resolveBatchDataAccess purpose "valuation"
 * → batchDataPreferMcp("lookup_property") → the tolerant `extractTaxFigures`
 * parser over BatchData's per-tier assessment shapes) is deleted — the survivor
 * is the RentCast record reader, whose normalizer (normalizeRentcastPropertyRecord)
 * already reads the latest taxAssessments / propertyTaxes year.
 *
 * NOT server-only (simulator-driven, like the rest of the kernel runners).
 */

export interface PublicRecordCosts {
  /** annual county/city tax amount, when a real figure was found. */
  annualTaxAmount: number | null
  assessedValue: number | null
  taxYear: number | null
  /** "rest" = the RentCast REST record; "skipped" = nothing adopted ("mcp" is historical — the
   *  retired BatchData MCP leg). */
  via: "mcp" | "rest" | "skipped"
  /** why nothing was adopted (unconfigured / no balance / no figure). */
  skipReason: string | null
}

export async function preloadPublicRecordCosts(address: {
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
}, opts: {
  /** The listing's tenant (never a body value) — RentCast is metered per tenant; a tenant-less
   *  read is refused (§4). */
  brokerageId?: string | null
} = {}): Promise<PublicRecordCosts> {
  const none = (reason: string): PublicRecordCosts =>
    ({ annualTaxAmount: null, assessedValue: null, taxYear: null, via: "skipped", skipReason: reason })

  if (!address.street || !address.city || !address.state || !address.zip) {
    return none("address incomplete — need street + city + state + zip for a records lookup")
  }
  if (!opts.brokerageId) return none("no tenant on the request — a tenant-less property-record read is refused (§4)")

  try {
    const { getRentcastPropertyRecord } = await import("@/lib/property/rentcast")
    const record = await getRentcastPropertyRecord({
      brokerageId: opts.brokerageId,
      systemSource: "offer_net_sheet",
      address: [address.street, address.city, `${address.state} ${address.zip}`].join(", "),
    })
    if (!record) return none("property record unavailable (RentCast not configured, budget paused, or no record for this address)")
    if (record.annualPropertyTax === null) return none("the property record carries no usable tax figure")
    return {
      annualTaxAmount: record.annualPropertyTax,
      assessedValue: record.assessedValue,
      taxYear: record.taxYear,
      via: "rest",
      skipReason: null,
    }
  } catch (e: any) {
    return none(e?.message ?? "records lookup failed")
  }
}
