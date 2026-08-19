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
 *
 * ── WHY EVERY ENTRY NOW CARRIES `verifiedOn` OR `unavailable` ────────────────
 * This registry was written from documentation, not from rows, and eleven markets that looked
 * registered delivered permits for two. The three shapes a wrong entry takes, all of them found
 * live in this file:
 *
 *   1. A dateColumn that DOES NOT EXIST. Socrata answers `$where=issued_date >= …` on a dataset
 *      whose column is `issue_date` with **HTTP 400**, every day, forever. (Austin, Seattle.)
 *   2. A dateColumn that exists but is TEXT, not a Calendar date. `$where=issuance_date >=
 *      '2026-08-01'` on NYC's `"06/17/2020"` strings is a STRING comparison — every month starts
 *      '0' or '1', so it is always < '2026…' and the portal answers **HTTP 200 with `[]`**. A city
 *      of eight million reads as a quiet market. This is the dangerous one: it does not error.
 *   3. A host that is not a Socrata portal at all. Phoenix is CKAN, Atlanta and Miami are ArcGIS
 *      Hub, Denver's id 404s. `resource/{id}.json` cannot ever work there.
 *
 * So a dateColumn is now only registered when a live row proved BOTH that the column exists and
 * that it is a floating timestamp, and `verifiedOn` records the day that row was read. A dataset
 * that cannot serve is marked `unavailable` with the reason — it is COUNTED and REPORTED by the
 * sweep rather than queried into a daily 400 or a daily silent zero.
 */

export type SocrataDatasetKind = "permits" | "code_violations" | "probate" | "property_transfers"

export interface SocrataDatasetSpec {
  host:        string          // e.g. "data.austintexas.gov"
  datasetId:   string          // Socrata 4x4 id, e.g. "3syk-w9eu"
  kind:        SocrataDatasetKind
  /** Friendly label for dashboards. */
  label:       string
  /**
   * Column to filter and order on for "since X date". MUST be a Socrata **Calendar date** (a
   * floating timestamp, `2026-08-17T00:00:00.000`). A TEXT date column here is worse than none:
   * the comparison silently becomes lexicographic and the dataset reports zero rows forever.
   * When unset, callers do their own filtering — the permit sweep counts the dataset as
   * un-boundable and reports it rather than pulling the whole history daily.
   */
  dateColumn?: string
  /**
   * Set ONLY when `dateColumn` is a PUBLICATION date rather than the date of the event.
   *
   * NYC's only real timestamp is `dobrundate`, the day DOB re-published the row — and DOB
   * re-publishes 1998 permits with today's run date. Bounding on it is correct (it is the column
   * the portal can filter) but the rows it returns are not all recent, so the pure layer filters
   * again on THIS column, which carries the date the permit was actually issued.
   */
  eventDateColumn?: string
  /** Wire format of `eventDateColumn`. "mdy" is `MM/DD/YYYY` text; "iso" is a floating timestamp. */
  eventDateFormat?: "iso" | "mdy"
  /**
   * ISO date on which a LIVE row from this dataset was read and the column names below confirmed.
   * An entry with no `verifiedOn` and no `unavailable` has never been checked against real data.
   */
  verifiedOn?: string
  /**
   * Why this dataset cannot currently be queried. Set it instead of deleting the entry: the sweep
   * counts and reports `datasetsUnavailable`, so a broken portal stays visible as a broken portal
   * instead of vanishing into "this market was never registered".
   */
  unavailable?: string
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
 *
 * TO ADD A MARKET: fetch one row first —
 *   curl 'https://<host>/resource/<id>.json?$limit=1'
 * — then register only the columns that row actually contains, and set `verifiedOn` to that day.
 * If the candidate dateColumn's value looks like `"06/17/2020"` rather than
 * `"2020-06-17T00:00:00.000"`, it is TEXT: leave `dateColumn` unset (see failure mode 2 above).
 */
export const MARKETS: Readonly<Record<string, MarketSpec>> = Object.freeze({
  [k("TX", "Austin")]: {
    state: "TX", city: "Austin",
    datasets: [
      // WAS `issued_date`, which is not a column here — the sweep took an HTTP 400 every day.
      // Live row 2026-08-19: permit_number "2026-089992 BP" · issue_date "2026-08-01T00:00:00.000"
      // · original_address1 "1401 PHILOMENA ST UNIT 415".
      { host: "data.austintexas.gov", datasetId: "3syk-w9eu", kind: "permits",
        label: "Austin issued construction permits", dateColumn: "issue_date", verifiedOn: "2026-08-19",
        notes: "Single address column (original_address1). description + permit_type_desc + work_class." },
      { host: "data.austintexas.gov", datasetId: "9qy3-hbf9", kind: "code_violations",
        label: "Austin code-enforcement cases",
        unavailable: "404 on 2026-08-19 — dataset id retired by data.austintexas.gov" },
    ],
  },
  [k("TX", "Dallas")]: {
    state: "TX", city: "Dallas",
    datasets: [
      // Deliberately NO dateColumn. Live row 2026-08-19: issued_date "03/13/20" — TEXT, and a
      // TWO-digit year, so it cannot even be parsed unambiguously, let alone compared. Registering
      // it would produce the silent-zero failure. The sweep counts this as un-boundable and says so.
      { host: "www.dallasopendata.com", datasetId: "e7gq-4sah", kind: "permits",
        label: "Dallas building permits", verifiedOn: "2026-08-19",
        notes: "street_address + permit_number + work_description + value are all readable; " +
               "issued_date is TEXT 'MM/DD/YY' so there is no usable query bound." },
      { host: "www.dallasopendata.com", datasetId: "9ahz-iyrm", kind: "code_violations",
        label: "Dallas code-violation 311 cases" },
    ],
  },
  [k("IL", "Chicago")]: {
    state: "IL", city: "Chicago",
    datasets: [
      // Live row 2026-08-19: permit_ "101046020" · issue_date "2024-09-18T00:00:00.000" ·
      // street_number "7529" · street_direction "N" · street_name "CLARK ST" · work_description ·
      // reported_cost. One of the two markets that worked before this audit.
      { host: "data.cityofchicago.org", datasetId: "ydr8-5enu", kind: "permits",
        label: "Chicago building permits", dateColumn: "issue_date", verifiedOn: "2026-08-19",
        notes: "Composite address (number/direction/name). Permit id is `permit_` (label 'PERMIT#')." },
      { host: "data.cityofchicago.org", datasetId: "22u3-xenr", kind: "code_violations",
        label: "Chicago building violations", dateColumn: "violation_date", verifiedOn: "2026-08-19",
        notes: "Single `address` column, `violation_description`, real timestamp on violation_date." },
    ],
  },
  [k("CA", "Los Angeles")]: {
    state: "CA", city: "Los Angeles",
    datasets: [
      // The id is real (it is the parent of the published view xnhu-aczu) but LADBS stopped
      // feeding it: the Socrata catalog reports data_updated_at 2023-05-22. A daily query would
      // return zero rows forever and read as a quiet Los Angeles. Marked, counted, reported.
      // Its column names ARE recorded so the entry works the day LA resumes publishing:
      // address_start · street_direction · street_name · street_suffix · issue_date (Calendar
      // date) · pcis_permit · work_description · valuation — and permit-signals reads all of them.
      { host: "data.lacity.org", datasetId: "yv23-pmwf", kind: "permits",
        label: "LA building & safety permit information",
        dateColumn: "issue_date", eventDateFormat: "iso", verifiedOn: "2026-08-19",
        unavailable: "stale — Socrata catalog reports data_updated_at 2023-05-22; LADBS stopped feeding it",
        notes: "House number is `address_start`; permit id is `pcis_permit`." },
    ],
  },
  [k("CA", "San Francisco")]: {
    state: "CA", city: "San Francisco",
    datasets: [
      // Live row 2026-08-19: permit_number "201806293452" · filed_date "2018-06-29T15:36:37.000"
      // · street_number "930" · street_name "Sutter" · street_suffix "St" · estimated_cost "40000.0".
      { host: "data.sfgov.org", datasetId: "i98e-djp9", kind: "permits",
        label: "San Francisco building permits", dateColumn: "filed_date", verifiedOn: "2026-08-19",
        notes: "filed_date is the FILING date (issued_date also exists and is also a timestamp)." },
    ],
  },
  [k("NY", "New York")]: {
    state: "NY", city: "New York",
    datasets: [
      // WAS `issuance_date`, which is TEXT "06/17/2020". The daily sweep asked for
      //   $where=issuance_date >= '2026-08-12'
      // and Socrata answered 200 with []: a string comparison where every candidate begins '0'
      // or '1'. New York City reported zero permits every single day and looked idle.
      // `dobrundate` is the one real timestamp — but it is the DOB RE-PUBLISH date, and DOB
      // re-publishes decades-old permits (verified 2026-08-19: dobrundate 2026-08-14 carrying
      // issuance_date "08/14/1998"). So it bounds the QUERY and issuance_date filters the ROWS.
      { host: "data.cityofnewyork.us", datasetId: "ipu4-2q9a", kind: "permits",
        label: "NYC DOB permit issuance",
        dateColumn: "dobrundate", eventDateColumn: "issuance_date", eventDateFormat: "mdy",
        verifiedOn: "2026-08-19",
        notes: "house__ + street_name compose the address; permit id is job__. Rows with no " +
               "issuance_date are applications that were never issued and are skipped." },
      { host: "data.cityofnewyork.us", datasetId: "wvxf-dwi5", kind: "code_violations",
        label: "NYC HPD housing-maintenance code violations" },
    ],
  },
  [k("AZ", "Phoenix")]: {
    state: "AZ", city: "Phoenix",
    datasets: [
      { host: "www.phoenixopendata.com", datasetId: "ggi7-iuv4", kind: "permits",
        label: "Phoenix building permits",
        unavailable: "www.phoenixopendata.com is a CKAN portal, not Socrata — /resource/{id}.json " +
                     "404s. Needs a CKAN datastore_search adapter, not this one." },
    ],
  },
  [k("GA", "Atlanta")]: {
    state: "GA", city: "Atlanta",
    datasets: [
      { host: "opendata.atlantaregional.com", datasetId: "wf5y-bw9p", kind: "permits",
        label: "Atlanta-region issued permits",
        unavailable: "opendata.atlantaregional.com is a RETIRED ArcGIS Hub site ('This site is no " +
                     "longer supported'), never a Socrata portal. Needs an ArcGIS FeatureServer adapter." },
    ],
  },
  [k("FL", "Miami")]: {
    state: "FL", city: "Miami",
    datasets: [
      { host: "opendata.miamigov.com", datasetId: "ucp7-fqyk", kind: "permits",
        label: "Miami building permit applications",
        unavailable: "opendata.miamigov.com is an ArcGIS Hub site, not Socrata. Needs an ArcGIS " +
                     "FeatureServer adapter." },
    ],
  },
  [k("WA", "Seattle")]: {
    state: "WA", city: "Seattle",
    datasets: [
      // WAS `issued_date`; the column is `issueddate` (no underscore) and the sweep took an
      // HTTP 400 every day. Live row 2026-08-19: permitnum "7107265-CN" ·
      // issueddate "2026-08-01T00:00:00.000" · originaladdress1 "4027 46TH AVE S".
      { host: "data.seattle.gov", datasetId: "76t5-zqzr", kind: "permits",
        label: "Seattle building permits", dateColumn: "issueddate", verifiedOn: "2026-08-19",
        notes: "Single address column (originaladdress1). estprojectcost + permittypedesc." },
      { host: "data.seattle.gov", datasetId: "skuc-86g2", kind: "code_violations",
        label: "Seattle code compliance violations" },
    ],
  },
  [k("CO", "Denver")]: {
    state: "CO", city: "Denver",
    datasets: [
      { host: "data.colorado.gov", datasetId: "qedt-htee", kind: "permits",
        label: "Denver building permits",
        unavailable: "404 on 2026-08-19 and absent from the Socrata catalog — Denver publishes " +
                     "permits through denvergov ArcGIS, not data.colorado.gov." },
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

/**
 * The permit datasets that can actually be swept today: a permit kind, a verified query bound, and
 * no `unavailable` marking. Everything excluded here is excluded for a STATED reason the sweep
 * counts — this function is the definition of coverage, not a filter that hides gaps.
 */
export function listQueryablePermitDatasets(): SocrataDatasetSpec[] {
  return Object.values(MARKETS)
    .flatMap((m) => m.datasets)
    .filter((d) => d.kind === "permits" && !!d.dateColumn && !d.unavailable)
}
