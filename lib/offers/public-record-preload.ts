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
  /** "rest" = the RentCast REST record; "batchdata_backup" = BatchData answered as the provider
   *  chain's backup after a RentCast miss (wave 93); "skipped" = nothing adopted ("mcp" is
   *  historical — the retired BatchData MCP leg). */
  via: "mcp" | "rest" | "batchdata_backup" | "skipped"
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
    // Wave 93 (lane 93B, owner: "use batchdata as a backup"): THE PROVIDER CHAIN's property lookup —
    // RentCast's record first (the same /properties request getRentcastPropertyRecord makes), and
    // BatchData ONLY as the backup after a named RentCast miss (lib/avm/provider-chain.ts). The
    // record's `provider` says which one answered; the ledger row says so too.
    const { getPropertyRecordWithFallback } = await import("@/lib/avm/provider-chain")
    const { record, note } = await getPropertyRecordWithFallback({
      brokerageId: opts.brokerageId,
      systemSource: "offer_net_sheet",
      address: [address.street, address.city, `${address.state} ${address.zip}`].join(", "),
    })
    if (!record) return none(`property record unavailable (RentCast not configured, budget paused, or no record for this address — ${note})`)
    if (record.annualPropertyTax === null) return none(`the property record (${record.provider}) carries no usable tax figure`)
    return {
      annualTaxAmount: record.annualPropertyTax,
      assessedValue: record.assessedValue,
      taxYear: record.taxYear,
      via: record.provider === "batchdata" ? "batchdata_backup" : "rest",
      skipReason: null,
    }
  } catch (e: any) {
    return none(e?.message ?? "records lookup failed")
  }
}
