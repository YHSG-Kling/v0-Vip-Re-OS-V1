/**
 * lib/external/socrata-market-registry.ts
 *
 * Per-market mapping from a brokerage's territory (`state` + `city`) to the local city/county
 * Socrata open-data datasets that surface motivated-seller / off-market signals:
 *
 *   - issued building permits      → renovation/rehab intent (often pre-sale)
 *   - code-violation notices       → seller pressure
 *   - probate filings              → inherited property → very-motivated seller
 *   - property-transfer / deeds    → recent buyer activity for buyer-side outreach
 *
 * Pure data-only module — no I/O. Run `recentPermits()` / `socrataQuery()` (lib/external/
 * socrata-client) against each dataset descriptor on a daily cadence per active brokerage market.
 * Extending: add a new entry to MARKETS keyed by `"<STATE>:<city>"` (lowercase city, 2-letter
 * state). Each entry can hold MULTIPLE datasets; the consumer iterates.
 */

export type SocrataDatasetKind = "permits" | "code_violations" | "probate" | "property_transfers"

export interface SocrataDatasetSpec {
  host:        string          // e.g. "data.austintexas.gov"
  datasetId:   string          // Socrata 4x4 id, e.g. "3syk-w9eu"
  kind:        SocrataDatasetKind
  /** Friendly label for dashboards. */
  label:       string
  /** Column to filter on for "since X date". When unset, callers do their own filtering. */
  dateColumn?: string
  /** Free-form notes — column hints, known quirks, refresh cadence. */
  notes?:      string
}

export interface MarketSpec {
  state: string                 // 2-letter
  city:  string                 // lowercase
  datasets: SocrataDatasetSpec[]
}

const k = (state: string, city: string) => `${state.toUpperCase()}:${city.toLowerCase()}`

/**
 * Curated, EXTENSIBLE map. Dataset IDs are stable for years but verify before depending on them
 * for a new feature — the AI healer can also surface drift via connector_health_log.
 */
export const MARKETS: Readonly<Record<string, MarketSpec>> = Object.freeze({
  [k("TX", "Austin")]: {
    state: "TX", city: "Austin",
    datasets: [
      { host: "data.austintexas.gov", datasetId: "3syk-w9eu", kind: "permits",
        label: "Austin issued construction permits", dateColumn: "issued_date" },
      { host: "data.austintexas.gov", datasetId: "9qy3-hbf9", kind: "code_violations",
        label: "Austin code-enforcement cases" },
    ],
  },
  [k("TX", "Dallas")]: {
    state: "TX", city: "Dallas",
    datasets: [
      { host: "www.dallasopendata.com", datasetId: "e7gq-4sah", kind: "permits",
        label: "Dallas building permits" },
      { host: "www.dallasopendata.com", datasetId: "9ahz-iyrm", kind: "code_violations",
        label: "Dallas code-violation 311 cases" },
    ],
  },
  [k("IL", "Chicago")]: {
    state: "IL", city: "Chicago",
    datasets: [
      { host: "data.cityofchicago.org", datasetId: "ydr8-5enu", kind: "permits",
        label: "Chicago building permits", dateColumn: "issue_date" },
      { host: "data.cityofchicago.org", datasetId: "22u3-xenr", kind: "code_violations",
        label: "Chicago building violations" },
    ],
  },
  [k("CA", "Los Angeles")]: {
    state: "CA", city: "Los Angeles",
    datasets: [
      { host: "data.lacity.org", datasetId: "yv23-pmwf", kind: "permits",
        label: "LA building & safety permit information" },
    ],
  },
  [k("CA", "San Francisco")]: {
    state: "CA", city: "San Francisco",
    datasets: [
      { host: "data.sfgov.org", datasetId: "i98e-djp9", kind: "permits",
        label: "San Francisco building permits", dateColumn: "filed_date" },
    ],
  },
  [k("NY", "New York")]: {
    state: "NY", city: "New York",
    datasets: [
      { host: "data.cityofnewyork.us", datasetId: "ipu4-2q9a", kind: "permits",
        label: "NYC DOB permit issuance", dateColumn: "issuance_date" },
      { host: "data.cityofnewyork.us", datasetId: "wvxf-dwi5", kind: "code_violations",
        label: "NYC HPD housing-maintenance code violations" },
    ],
  },
  [k("AZ", "Phoenix")]: {
    state: "AZ", city: "Phoenix",
    datasets: [
      { host: "www.phoenixopendata.com", datasetId: "ggi7-iuv4", kind: "permits",
        label: "Phoenix building permits" },
    ],
  },
  [k("GA", "Atlanta")]: {
    state: "GA", city: "Atlanta",
    datasets: [
      { host: "opendata.atlantaregional.com", datasetId: "wf5y-bw9p", kind: "permits",
        label: "Atlanta-region issued permits" },
    ],
  },
  [k("FL", "Miami")]: {
    state: "FL", city: "Miami",
    datasets: [
      { host: "opendata.miamigov.com", datasetId: "ucp7-fqyk", kind: "permits",
        label: "Miami building permit applications" },
    ],
  },
  [k("WA", "Seattle")]: {
    state: "WA", city: "Seattle",
    datasets: [
      { host: "data.seattle.gov", datasetId: "76t5-zqzr", kind: "permits",
        label: "Seattle building permits", dateColumn: "issued_date" },
      { host: "data.seattle.gov", datasetId: "skuc-86g2", kind: "code_violations",
        label: "Seattle code compliance violations" },
    ],
  },
  [k("CO", "Denver")]: {
    state: "CO", city: "Denver",
    datasets: [
      { host: "data.colorado.gov", datasetId: "qedt-htee", kind: "permits",
        label: "Denver building permits" },
    ],
  },
})

/** Lookup helper — case-insensitive on city, returns null when the market isn't registered yet
 *  so the caller can fall through to a "configure your local open-data portal" path. */
export function getMarketDatasets(params: { state?: string | null; city?: string | null }): SocrataDatasetSpec[] {
  const st = (params.state ?? "").toUpperCase()
  const ct = (params.city ?? "").trim()
  if (!st || !ct) return []
  const spec = MARKETS[k(st, ct)]
  return spec?.datasets ?? []
}

export function listSupportedMarkets(): Array<{ state: string; city: string; datasetCount: number }> {
  return Object.values(MARKETS).map(m => ({ state: m.state, city: m.city, datasetCount: m.datasets.length }))
}
