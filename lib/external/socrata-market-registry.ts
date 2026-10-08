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
 *
 * ── 2026-08-20: A FOURTH SHAPE — COLUMNS RIGHT, DATA FROZEN ──────────────────
 * Verifying a row proves the COLUMNS. It does not prove the FEED. Dallas `e7gq-4sah` passed the
 * column check last wave (street_address, permit_number, work_description, value all readable) and
 * was registered as merely "un-boundable". It is not un-boundable — it is DEAD: the Socrata catalog
 * reports data_updated_at 2020-08-30, the newest row carries issued_date "12/31/19", and the
 * dataset's own description now opens "ATTENTION: This permit data set is historical and no longer
 * updated. Active permit tracking has migrated to the Dallas Accela Citizen Access Portal."
 * Fixing the date column would have bought a perfectly-formed query returning 2020. So freshness is
 * now part of verification, and a frozen feed is `unavailable` with its last data date stated.
 *
 * ── 2026-08-20 (second pass): A FIFTH SHAPE — BOUND VALID, SELECTIVITY ZERO ──
 * Every shape above is about whether a query is WELL-FORMED. This one is about whether it
 * SELECTS anything. NYC DOB's `ipu4-2q9a` was registered bound on `dobrundate` because that is its
 * only Calendar date, with `issuance_date` re-filtering the rows afterwards. Both facts are still
 * true. What nobody measured is how much `dobrundate >= <7 days ago>` actually excludes:
 *
 *     $select=count(*)                                   → 3,989,981   (whole dataset)
 *     $where=dobrundate >= '2026-08-13'                  → 3,897,421   (97.7% of it)
 *     $where=issuance_date like '%/2026'                 →     4,940   (0.12% of it)
 *
 * DOB re-runs essentially the entire table every week, so the "recent" bound returns the entire
 * table, `MAX_PERMITS_PER_DATASET = 1000` truncates it to an arbitrary thousandth of a percent, and
 * the event-date filter then drops nearly all of those as out-of-window. The query is well-formed,
 * the columns are right, the feed is live, the freshness is fine — and the expected yield is ~0
 * permits per run while the market reports `covered`. A bound whose selectivity is 2.3% is not a
 * bound. So `ipu4-2q9a` is now `unavailable` with those three counts stated, and New York is served
 * by `rbx6-tga4` (DOB NOW: Build – Approved Permits), whose `issued_date` IS the event date and IS
 * a Calendar date: 2,743 permits in the same 7-day window. Verification now has to ask "how many
 * rows does the bound exclude", not only "does the bound parse".
 *
 * ── 2026-08-20 (third pass): A SIXTH SHAPE — NOT DEAD, JUST UNSPOKEN ─────────
 * Every shape above is a way a dataset can fail. This one is a way THIS FILE can fail. Three
 * markets — Miami, Atlanta, Denver — were marked `unavailable` with reasons that all reduce to
 * the same sentence: "this host is ArcGIS, not Socrata; needs an ArcGIS FeatureServer adapter."
 * Read as coverage that is EXACTLY what it looks like: a dead market. It was not. The permits
 * were live the entire time at an endpoint the OS had no client for, and `unavailable` had no way
 * to say "the feed is fine, WE are the missing piece" — so a TODO wore the costume of a fact.
 *
 * `provider` fixes that, and lib/external/arcgis-permits.ts is the adapter. Miami is repointed
 * and verified live 2026-08-20 (Miami-Dade County, 1,161 permits in a 7-day window off 139,711
 * rows). Atlanta and Denver are NOT repointed in this pass and stay `unavailable` — with the
 * adapter now existing, that marking finally means what it says: nobody has verified a live
 * layer for them yet. Registering one is a data edit, not a code change.
 *
 * A WARNING FOR WHOEVER DOES IT. Verify by ID, never by catalog SEARCH. `q=Santa Rosa County`
 * against the Socrata catalog returns SONOMA COUNTY, CALIFORNIA as its top hit (checked
 * 2026-08-20) — a confident, well-formed, entirely wrong dataset for a Florida territory. A fuzzy
 * name match is how a market gets registered to another state's data and then reports permits
 * that will never touch a single one of the tenant's leads.
 *
 * AND ARCGIS FAILS DIFFERENTLY. A FeatureServer answers its OWN errors with HTTP 200 and puts the
 * failure in the body, so on that provider an invalid field and a deleted layer both look like an
 * empty week unless the body is checked. arcgis-permits.ts::readArcgisError is that check, and it
 * is the reason a second provider needed a real adapter rather than a second fetch call.
 *
 * ── WHY THIS FILE SHOULD NOT STAY A HAND-KEPT CONSTANT ───────────────────────
 * Everything above is the same defect wearing four hats: a hand-maintained file asserting facts
 * about a system it cannot see. Socrata publishes those facts itself, live, on every dataset:
 *
 *   https://api.us.socrata.com/api/catalog/v1?ids=<4x4>
 *     → columns_field_name[] · columns_datatype[] ("Calendar date" vs "Text") · data_updated_at
 *
 * That single document answers every question this file currently answers from memory: does the
 * column exist, is it a real timestamp or lexicographic text, and is the feed still moving. The
 * recommendation (see the lane report; deliberately NOT half-built here) is to keep this file as
 * the DISCOVERY SEED — the (state, city) → (host, datasetId) binding, which is the one fact the
 * catalog cannot infer — and to derive dateColumn / eventDateColumn / staleness from the catalog on
 * a scheduled probe that writes `connector_health_log`, rather than from these literals.
 */

export type SocrataDatasetKind = "permits" | "code_violations" | "probate" | "property_transfers"

/**
 * Which adapter can read this dataset.
 *
 * ADDED 2026-08-20, and it is the reason three of the `unavailable` reasons below could finally
 * be acted on. This registry marked Miami, Atlanta and Denver dead with, in effect, one sentence:
 * "needs an ArcGIS FeatureServer adapter". They were never dead — their data was live at an
 * endpoint the OS could not speak to, which the coverage taxonomy could not express because
 * `unavailable` conflates "this feed stopped" with "we lack the client". Naming the provider
 * splits those apart: a market is now dark only when NO registered provider can read it.
 *
 * Absent means "socrata" — every entry predating this field is a Socrata entry.
 */
export type SignalProvider = "socrata" | "arcgis"

export interface PermitDatasetSpec {
  /** Socrata portal host, or the ArcGIS service host. Identity + connector attribution. */
  host:        string          // e.g. "data.austintexas.gov"
  /** Socrata 4x4 id, or — for ArcGIS — the AGOL item id. STABLE, and load-bearing: it is the
   *  first segment of `permitDedupeKey`, so it must not change when a service is re-hosted. */
  datasetId:   string          // Socrata 4x4 id, e.g. "3syk-w9eu"
  /** Defaults to "socrata" when absent. */
  provider?:   SignalProvider
  /**
   * ArcGIS ONLY, and REQUIRED when provider is "arcgis": the full FeatureServer LAYER url,
   * `.../FeatureServer/<n>`. There is no 4x4-style short id on ArcGIS — the URL is the address —
   * so `host`/`datasetId` stay identity and this stays the locator.
   */
  serviceUrl?: string
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

/**
 * The name this interface carried when Socrata was the only provider. Kept as an alias rather
 * than renamed at every call site: the type is structurally identical, and a rename touching
 * permit-signals.ts, the cron and the simulator in the same pass would hide the one-field change
 * that actually happened inside a diff of noise.
 */
export type SocrataDatasetSpec = PermitDatasetSpec

/** PURE. The adapter that can read this dataset. Absent `provider` means Socrata. */
export function providerOf(spec: PermitDatasetSpec): SignalProvider {
  return spec.provider ?? "socrata"
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
      // Re-measured 2026-08-20 — the bound SELECTS, which is the check the fifth failure shape
      // added: $where=issue_date >= '2026-08-13' → count 1,086 of 2,371,355 rows (0.05%),
      // max(issue_date) 2026-08-18, catalog data_updated_at 2026-08-19. Working.
      { host: "data.austintexas.gov", datasetId: "3syk-w9eu", kind: "permits",
        label: "Austin issued construction permits", dateColumn: "issue_date", verifiedOn: "2026-08-20",
        notes: "Single address column (original_address1). description + permit_type_desc + work_class." },
      { host: "data.austintexas.gov", datasetId: "9qy3-hbf9", kind: "code_violations",
        label: "Austin code-enforcement cases",
        unavailable: "404 on 2026-08-19 — dataset id retired by data.austintexas.gov" },
    ],
  },
  [k("TX", "Dallas")]: {
    state: "TX", city: "Dallas",
    datasets: [
      // WAS registered as merely "un-boundable" (issued_date is TEXT 'MM/DD/YY', a two-digit year
      // that cannot be compared OR parsed). True, and beside the point: the feed STOPPED. Verified
      // 2026-08-20 — `$order=issued_date DESC` returns permit_number "1912173019" /
      // issued_date "12/31/19" / street_address "2911 CLYDEDALE DR"; the Socrata catalog reports
      // data_updated_at 2020-08-30; and the dataset description says so itself. A right date column
      // here would return 2020 permits forever, which is the silent-zero failure with extra steps.
      { host: "www.dallasopendata.com", datasetId: "e7gq-4sah", kind: "permits",
        label: "Dallas building permits", verifiedOn: "2026-08-20",
        unavailable: "historical — data_updated_at 2020-08-30, newest issued_date '12/31/19'; the " +
                     "dataset states permit tracking migrated to the Dallas Accela Citizen Access " +
                     "Portal, which is not Socrata",
        notes: "street_address + permit_number + work_description + value are all readable; the " +
               "columns were never the problem." },
      // Never verified, and it does not exist: two live fetches 404'd and an `ids=9ahz-iyrm` lookup
      // against the Socrata catalog returns zero results on 2026-08-20.
      { host: "www.dallasopendata.com", datasetId: "9ahz-iyrm", kind: "code_violations",
        label: "Dallas code-violation 311 cases", verifiedOn: "2026-08-20",
        unavailable: "dataset id absent from the Socrata catalog (ids=9ahz-iyrm → 0 results) and " +
                     "404 on fetch, 2026-08-20 — the id was written from documentation" },
    ],
  },
  // ── The two live tenants of this OS are in Pensacola FL and Pace FL (Escambia / Santa Rosa
  // County). There is NO registered market for either, and there cannot be one: the Socrata
  // catalog returns ZERO datasets for q=Pensacola and ZERO for q=Escambia (checked 2026-08-20).
  // That is not a gap this file can close by trying harder — the Florida panhandle does not
  // publish permits through Socrata. It is registered NOWHERE on purpose, so the sweep reports
  // "FL:Pensacola — UNREGISTERED" by name rather than "0 permits", which is the whole point of
  // the coverage taxonomy below. Closing it needs a non-Socrata adapter, not another entry here.
  [k("IL", "Chicago")]: {
    state: "IL", city: "Chicago",
    datasets: [
      // Live row 2026-08-19: permit_ "101046020" · issue_date "2024-09-18T00:00:00.000" ·
      // street_number "7529" · street_direction "N" · street_name "CLARK ST" · work_description ·
      // reported_cost. One of the two markets that worked before this audit.
      // Re-measured 2026-08-20: $where=issue_date >= '2026-08-13' → count 771, max 2026-08-19,
      // catalog data_updated_at 2026-08-20T12:16Z. The healthiest feed in the registry.
      { host: "data.cityofchicago.org", datasetId: "ydr8-5enu", kind: "permits",
        label: "Chicago building permits", dateColumn: "issue_date", verifiedOn: "2026-08-20",
        notes: "Composite address (number/direction/name). Permit id is `permit_` (label 'PERMIT#'). " +
               "`work_type` ('Masonry Work') is a second, sparsely-populated work-text column." },
      // Re-verified live 2026-08-20 (`$order=violation_date DESC`): violation_date
      // "2026-08-18T00:00:00.000" · address "3830 W 63RD ST" · violation_description
      // "REPAIR DOOR, INT." · violation_status "OPEN" · violation_code "CN105015".
      // NOTE: this dataset publishes no violation-number column — its unique handle is the bare
      // `id`, which is a row id, not a case id. `id` is deliberately NOT a readPermitId candidate
      // (a row id that changes on republish would file a fresh signal every single day), so
      // Chicago violations dedupe on (address, violation date, dataset, lead) instead.
      { host: "data.cityofchicago.org", datasetId: "22u3-xenr", kind: "code_violations",
        label: "Chicago building violations", dateColumn: "violation_date", verifiedOn: "2026-08-20",
        notes: "Single `address` column, `violation_description`, `violation_status` OPEN/CLOSED, " +
               "real timestamp on violation_date." },
    ],
  },
  [k("CA", "Los Angeles")]: {
    state: "CA", city: "Los Angeles",
    datasets: [
      // LADBS DID NOT STOP PUBLISHING — IT MOVED. Last wave marked the old feed stale and left the
      // market dark, which is the honest half of the answer and only half. Re-probed 2026-08-20:
      // the catalog search on data.lacity.org for "building permit" returns THIS dataset, and
      //   $where=issue_date >= '2026-08-13' → count 502, max(issue_date) 2026-08-15
      // with catalog data_updated_at 2026-08-17. Live row read the same day:
      //   permit_nbr "23016-10000-02499" · primary_address "7006 W GREELEY ST" ·
      //   issue_date "2023-07-06T00:00:00.000" (Calendar date) · permit_type "Bldg-Addition" ·
      //   permit_sub_type "1 or 2 Family Dwelling" · valuation "10000" · work_desc "ADDITION TO
      //   (E) SINGLE FMAILY DWELLING PER WFPP." · status_desc "Permit Expired"
      // Single address column (`primary_address`), so no composite assembly is needed here.
      { host: "data.lacity.org", datasetId: "pi9x-tg5x", kind: "permits",
        label: "LA building & safety permits issued 2020–present",
        dateColumn: "issue_date", verifiedOn: "2026-08-20",
        notes: "Single `primary_address`. Permit id is `permit_nbr`; valuation is `valuation`; " +
               "work text is `work_desc` + `permit_type` + `permit_sub_type`." },
      // The retired feed. The id is real (it is the parent of the published view xnhu-aczu) but it
      // is now ABSENT from the Socrata catalog outright (`ids=yv23-pmwf` → 0 results, 2026-08-20),
      // and its published view proves where the data stopped: xnhu-aczu holds 375,150 rows with
      // max(issue_date) 2023-05-19. Kept, marked, and counted rather than deleted — a market that
      // was once served and is not any more is a fact the sweep should keep reporting.
      // Its column names stay recorded because they are a DIFFERENT vocabulary from pi9x-tg5x's
      // (address_start · street_direction · street_name · street_suffix · pcis_permit) and
      // permit-signals still reads them.
      { host: "data.lacity.org", datasetId: "yv23-pmwf", kind: "permits",
        label: "LA building & safety permit information (retired)",
        dateColumn: "issue_date", eventDateFormat: "iso", verifiedOn: "2026-08-20",
        unavailable: "retired — absent from the Socrata catalog (ids=yv23-pmwf → 0 results) on " +
                     "2026-08-20; its published view xnhu-aczu stops at max(issue_date) 2023-05-19. " +
                     "LADBS now publishes pi9x-tg5x, registered above.",
        notes: "House number is `address_start`; permit id is `pcis_permit`." },
    ],
  },
  [k("CA", "San Francisco")]: {
    state: "CA", city: "San Francisco",
    datasets: [
      // Live row 2026-08-19: permit_number "201806293452" · filed_date "2018-06-29T15:36:37.000"
      // · street_number "930" · street_name "Sutter" · street_suffix "St" · estimated_cost "40000.0".
      // Re-measured 2026-08-20: $where=filed_date >= '2026-08-13' → count 436,
      // max(filed_date) 2026-08-19T22:15:53. Working.
      // NOTE: some rows carry a NULL filed_date and Socrata sorts those FIRST on `$order … DESC`,
      // so `$order=filed_date DESC&$limit=1` reads back `{}` and looks like a dead feed. It is not;
      // `>=` excludes nulls, so the sweep's own query is unaffected. Use max()/IS NOT NULL when
      // probing this one by hand.
      { host: "data.sfgov.org", datasetId: "i98e-djp9", kind: "permits",
        label: "San Francisco building permits", dateColumn: "filed_date", verifiedOn: "2026-08-20",
        notes: "filed_date is the FILING date (issued_date also exists and is also a timestamp)." },
    ],
  },
  [k("NY", "New York")]: {
    state: "NY", city: "New York",
    datasets: [
      // THE LIVE NEW YORK FEED (registered 2026-08-20). DOB NOW is where NYC permitting actually
      // happens now, and unlike its BIS-era sibling below its date column is the EVENT date and a
      // real Calendar date, so the query bound needs no re-publish workaround at all:
      //   $where=issued_date >= '2026-08-13' → count 2,743, max(issued_date) 2026-08-18
      // catalog data_updated_at 2026-08-19. Live rows read the same day:
      //   job_filing_number "M01301984-S1" · issued_date "2026-08-17T00:00:00.000" · house_no "315"
      //   · street_name "WEST 29 STREET" · work_type "Plumbing" · estimated_job_costs "8000"
      //   · permit_status "Permit Issued" · borough "Manhattan"
      // NOTE ON WHAT IS NOT READ: this dataset also publishes `owner_name`, `owner_street_address`,
      // `owner_city`/`owner_zip_code` and the applicant's name and licence number. None of those
      // are in any reader list in permit-signals.ts and none reach `signal_details`, which is
      // assembled from named fields rather than from the raw row. A permit is an address here on
      // purpose; adding an owner-name reader would turn this lane into people-sourcing.
      { host: "data.cityofnewyork.us", datasetId: "rbx6-tga4", kind: "permits",
        label: "NYC DOB NOW: Build – approved permits",
        dateColumn: "issued_date", verifiedOn: "2026-08-20",
        notes: "house_no + street_name compose the address; permit id is `job_filing_number`; " +
               "valuation is `estimated_job_costs`; work text is work_type + job_description." },
      // THE BIS-ERA FEED — well-formed, live, fresh, and USELESS AS A BOUND. See the fifth failure
      // shape in the header. It was registered bound on `dobrundate` because `issuance_date` is
      // TEXT "06/17/2020" (a lexicographic comparison that answered 200-with-[] forever), and that
      // reasoning was right as far as it went. Measured 2026-08-20, it does not go far enough:
      //   count(*)                          3,989,981
      //   dobrundate  >= '2026-08-13'       3,897,421   ← the "recent" bound excludes 2.3% of rows
      //   issuance_date like '%/2026'           4,940   ← every 2026 permit in the whole dataset
      // A 1000-row page off a 3.9M-row match cannot contain this week's permits except by accident.
      { host: "data.cityofnewyork.us", datasetId: "ipu4-2q9a", kind: "permits",
        label: "NYC DOB permit issuance (BIS era)",
        eventDateColumn: "issuance_date", eventDateFormat: "mdy",
        verifiedOn: "2026-08-20",
        unavailable: "unboundable in practice — `dobrundate` is the only Calendar date and DOB " +
                     "re-publishes the whole table weekly: 3,897,421 of 3,989,981 rows carry a " +
                     "dobrundate inside a 7-day window (2026-08-20), while only 4,940 rows in the " +
                     "entire dataset carry a 2026 issuance_date. The 1000-row page samples the " +
                     "re-publish, not the week. Superseded by rbx6-tga4, registered above.",
        notes: "house__ + street_name compose the address; permit id is job__. Rows with no " +
               "issuance_date are applications that were never issued and are skipped." },
      // Verified live 2026-08-20 with `$where=novissueddate > '2026-08-01'` — which returns rows,
      // so unlike its permit sibling this dataset's date column really is a Calendar date:
      // novissueddate "2026-08-03T00:00:00.000" · violationid "19075125" · housenumber "116" ·
      // streetname "LENOX ROAD" · class "B" · violationstatus "Open" · novdescription
      // "§ 27-2005 ADM CODE FIRE ESCAPE DEFECTIVE…". `inspectiondate` is when the inspector
      // called; `novissueddate` is when the notice of violation was ISSUED to the owner, which is
      // the day the pressure starts, so that is the bound.
      { host: "data.cityofnewyork.us", datasetId: "wvxf-dwi5", kind: "code_violations",
        label: "NYC HPD housing-maintenance code violations",
        dateColumn: "novissueddate", verifiedOn: "2026-08-20",
        notes: "housenumber + streetname compose the address; violationid is the stable handle; " +
               "violationstatus is Open/Close; class A/B/C is HPD's hazard tier." },
    ],
  },
  // ── MONTGOMERY COUNTY, MARYLAND (new 2026-08-20) ───────────────────────────
  // The county publishes ONE permit dataset covering every municipality in it, so the same
  // descriptor is registered under each city a brokerage would name as its territory. That is the
  // registry's key shape (state:city) meeting the publisher's shape (county), and duplicating the
  // descriptor is correct: `ingestPermitSignals` dedupes datasets by host/id, so a tenant farming
  // three of these cities queries the dataset once.
  //
  // Verified live 2026-08-20 with `$where=issueddate >= '2026-08-01'` → rows:
  //   permitno "1167770" · issueddate "2026-08-18T12:08:57.000" · stno "7721" · stname "POLARA"
  //   · suffix "PL" · city "ROCKVILLE" · declaredvaluation "8263" · worktype "ALTER"
  //   · description " Interior work only,Modify existing attached garage roof framing…"
  //   · usecode "SINGLE FAMILY DWELLING"
  // and a second row at 18014 COACHMANS RD, GERMANTOWN the same day. Residential-only by
  // construction — this is DPS's "Residential Permit" dataset, which is exactly the population a
  // seller signal is about (the county's Commercial Permits dataset is deliberately NOT registered).
  ...((): Record<string, MarketSpec> => {
    const dataset: SocrataDatasetSpec = {
      host: "data.montgomerycountymd.gov", datasetId: "m88u-pqki", kind: "permits",
      label: "Montgomery County MD residential permits",
      dateColumn: "issueddate", verifiedOn: "2026-08-20",
      notes: "Composite address stno + predir + stname + suffix. Permit id is `permitno`; " +
             "valuation is `declaredvaluation`; description + worktype carry the work. " +
             "Selectivity measured 2026-08-20: issueddate >= '2026-08-13' → 133 rows, " +
             "max 2026-08-19T12:08:49.",
    }
    const cities = [
      "Rockville", "Silver Spring", "Bethesda", "Gaithersburg", "Germantown",
      "Takoma Park", "Wheaton", "Potomac", "Chevy Chase", "Olney",
    ]
    return Object.fromEntries(
      cities.map((city) => [k("MD", city), { state: "MD", city, datasets: [dataset] }]),
    )
  })(),
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
  // ── MIAMI — THE FIRST MARKET SERVED BY A NON-SOCRATA PROVIDER (2026-08-20) ──
  // This market was marked `unavailable` with the reason "Needs an ArcGIS FeatureServer adapter".
  // That reason was correct and it was also a TODO nobody had picked up, so the market read as
  // dead when its data was live the whole time. lib/external/arcgis-permits.ts is that adapter;
  // this is the repoint it unlocks. The Socrata entry is KEPT and marked, per this file's rule
  // that a market which was once wrong should keep saying so.
  [k("FL", "Miami")]: {
    state: "FL", city: "Miami",
    datasets: [
      // Miami-Dade County's own permit feed, verified live 2026-08-20 against all five checks
      // this file's failure taxonomy demands:
      //   1. the column exists      → PermitIssuedDate, esriFieldTypeDateOnly
      //   2. it is a real date      → publishes "2026-08-18", not a lexicographic text date
      //   3. the feed is moving     → max(PermitIssuedDate) 2026-08-18, item modified 2026-08-18
      //   4. the bound SELECTS      → PermitIssuedDate >= DATE '2026-08-13' → 1,161 of 139,711
      //                               rows (0.83%) — a real bound, not NYC ipu4-2q9a's 97.7%
      //   5. the columns are read   → live row: PermitNumber "2026065888" · PropertyAddress
      //                               "2960 SW 109 CT" · PermitType "ELEC" ·
      //                               ApplicationTypeDescription "ALTER - EXTERIOR" ·
      //                               DetailDescriptionComments "ELEC PANEL" · EstimatedValue
      //                               "1800" · ResidentialCommercial "R"
      // SINGLE address column (PropertyAddress), so no composite assembly is needed.
      // NOTE ON WHAT IS NOT READ: this layer also publishes OwnerName, ContractorName,
      // ContractorAddress and ContractorPhone. None of them are in any reader list in
      // permit-signals.ts and none reach `signal_details`. A permit is an ADDRESS in this lane,
      // deliberately — reading OwnerName would turn a structure signal into people-sourcing,
      // which belongs to the scraping spine and its consent gates, not here.
      { host: "services.arcgis.com", datasetId: "6db5f56e886446df88313ca279e59120",
        provider: "arcgis",
        serviceUrl: "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0",
        kind: "permits",
        label: "Miami-Dade County issued building permits",
        dateColumn: "PermitIssuedDate", verifiedOn: "2026-08-20",
        notes: "ArcGIS FeatureServer, not Socrata — field names are CamelCase and CASE-SENSITIVE. " +
               "Permit id is `PermitNumber`; valuation is `EstimatedValue` (a STRING on the wire); " +
               "work text is DetailDescriptionComments + ApplicationTypeDescription + PermitType. " +
               "maxRecordCount is 1000 and the 7-day window is ~1,161 rows, so this layer NEEDS " +
               "the pager in recentArcgisPermits — one page is not one week." },
      // The City of Miami Socrata id this file was written with. Kept and marked: the host is an
      // ArcGIS Hub site and `resource/{id}.json` can never work there, and it is a CITY feed where
      // the entry above is the COUNTY's, which is the broader population a territory named "Miami"
      // means. Superseded rather than deleted, so the wrong id cannot be re-registered from the
      // same document it came from.
      { host: "opendata.miamigov.com", datasetId: "ucp7-fqyk", kind: "permits",
        label: "Miami building permit applications (City of Miami, retired id)",
        unavailable: "opendata.miamigov.com is an ArcGIS Hub site, not Socrata — resource/{id}.json " +
                     "cannot serve it. Superseded 2026-08-20 by Miami-Dade County's ArcGIS " +
                     "FeatureServer, registered above and read by lib/external/arcgis-permits.ts." },
    ],
  },
  [k("WA", "Seattle")]: {
    state: "WA", city: "Seattle",
    datasets: [
      // WAS `issued_date`; the column is `issueddate` (no underscore) and the sweep took an
      // HTTP 400 every day. Live row 2026-08-19: permitnum "7107265-CN" ·
      // issueddate "2026-08-01T00:00:00.000" · originaladdress1 "4027 46TH AVE S".
      // Re-verified live 2026-08-20 with `$where=issueddate >= '2026-08-01'`: permitnum
      // "7107265-CN" · issueddate "2026-08-01T00:00:00.000" · originaladdress1 "4027 46TH AVE S"
      // · estprojectcost "160000.0000" · description "Construct addition and alterations to
      // one-family dwelling per plan."
      // Selectivity re-measured 2026-08-20: $where=issueddate >= '2026-08-13' → count 104,
      // max(issueddate) 2026-08-18. Working. (Same null-sorts-first quirk as San Francisco:
      // `$order=issueddate DESC&$limit=1` reads back `{}`; `>=` is unaffected.)
      { host: "data.seattle.gov", datasetId: "76t5-zqzr", kind: "permits",
        label: "Seattle building permits", dateColumn: "issueddate", verifiedOn: "2026-08-20",
        notes: "Single address column (originaladdress1). estprojectcost + permittypedesc." },
      // Never verified, and it does not exist: two live fetches 404'd and an `ids=skuc-86g2`
      // lookup against the Socrata catalog returns zero results on 2026-08-20. Same defect as
      // Dallas's violations id — an id copied out of a document nobody checked.
      { host: "data.seattle.gov", datasetId: "skuc-86g2", kind: "code_violations",
        label: "Seattle code compliance violations", verifiedOn: "2026-08-20",
        unavailable: "dataset id absent from the Socrata catalog (ids=skuc-86g2 → 0 results) and " +
                     "404 on fetch, 2026-08-20 — the id was written from documentation" },
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
  return listQueryableDatasets("permits")
}

/** The kinds this lane knows how to turn into a motivated-seller signal. Registered datasets of any
 *  OTHER kind (probate, property_transfers) are counted as `not_yet_ingestible` — registered, real,
 *  and honestly reported as not wired, rather than quietly dropped by a `!==` filter. */
export const INGESTIBLE_KINDS: readonly SocrataDatasetKind[] = ["permits", "code_violations"]

/**
 * PURE. The ONE definition of "the sweep can query this dataset today", used by both
 * `listQueryableDatasets` and `classifyMarketCoverage` so a coverage count and a sweep can never
 * disagree about the same entry — which they would the moment two copies of this predicate drift.
 *
 * Three requirements, and the third arrived with the second provider: an ArcGIS entry carries its
 * locator in `serviceUrl`, not in `host`/`datasetId`, so an arcgis spec WITHOUT one is not a
 * queryable dataset — it is an incomplete descriptor. Without this clause such an entry would be
 * counted as covered and then refused by the adapter on every single run, which is precisely the
 * "registered and serving are not the same thing" gap this registry exists to close.
 */
export function isQueryableDataset(spec: PermitDatasetSpec): boolean {
  if (!spec.dateColumn || spec.unavailable) return false
  if (providerOf(spec) === "arcgis" && !spec.serviceUrl) return false
  return true
}

/**
 * Same rule as `listQueryablePermitDatasets`, for any kind — DEDUPED BY host/datasetId.
 *
 * The dedupe is not cosmetic. One publisher can serve many markets (Montgomery County MD's single
 * dataset is registered under ten of its cities), and a coverage count that reported that as ten
 * datasets would overstate what this OS can actually read by a factor of ten. The sweep dedupes on
 * the same key before querying, so this is the same number the sweep would report.
 */
export function listQueryableDatasets(kind?: SocrataDatasetKind): SocrataDatasetSpec[] {
  const byId = new Map<string, SocrataDatasetSpec>()
  for (const d of Object.values(MARKETS).flatMap((m) => m.datasets)) {
    if (kind ? d.kind !== kind : !INGESTIBLE_KINDS.includes(d.kind)) continue
    if (!isQueryableDataset(d)) continue
    const id = `${d.host}/${d.datasetId}`
    if (!byId.has(id)) byId.set(id, d)
  }
  return [...byId.values()]
}

// ─────────────────────────────────────────────────────────────────────────────
// COVERAGE — the gap taxonomy
// ─────────────────────────────────────────────────────────────────────────────
//
// THE OWNER RULING THIS EXISTS FOR: "all markets from the active tenant territories for
// motivational sellers." A sweep that can only see the cities somebody happened to type into
// MARKETS does not obey that ruling — it obeys the registry. So the sweep now walks the TENANT'S
// territories and every one of them comes back with a verdict, including the ones this file has
// never heard of. A market that cannot be read must never be indistinguishable from a market with
// nothing happening in it; that is the same sentence as last wave's NYC bug, one level up.

export type MarketCoverageStatus =
  /** At least one dataset is verified, bounded and serving. This market is genuinely swept. */
  | "covered"
  /** The (state, city) is not in MARKETS at all. THE NAMED GAP — nobody has ever registered it. */
  | "unregistered"
  /** Registered, but every dataset for it is marked `unavailable` (dead id, non-Socrata host,
   *  frozen feed). The registry knows about this market and cannot serve it. */
  | "unavailable"
  /** Registered and reachable, but no dataset carries a verified query bound, so "recent" cannot
   *  be expressed. Distinct from `unavailable`: the portal is alive, our descriptor is incomplete. */
  | "unboundable"

export interface MarketCoverage {
  /** As the tenant configured it, verbatim — this is what the operator has to recognize. */
  state: string | null
  city: string | null
  /** `"TX:Austin"`-style label for logs and gap lists. */
  market: string
  status: MarketCoverageStatus
  /** Every registered dataset of an ingestible kind for this market — queryable or not. The sweep
   *  counts its exclusions off this list, so "how many datasets did we skip and why" is answered
   *  from the same place "is this market covered" is. */
  ingestible: SocrataDatasetSpec[]
  /** Datasets that will actually be queried for this market. */
  queryable: SocrataDatasetSpec[]
  /** Stated reasons for everything excluded, verbatim from the registry. Never empty when the
   *  status is `unavailable`. */
  reasons: string[]
}

/**
 * PURE. The verdict for ONE tenant territory. No I/O, no network — this is the registry answering
 * "can I see this market at all", which is the question the cron has to report per territory.
 */
export function classifyMarketCoverage(params: {
  state?: string | null
  city?: string | null
}): MarketCoverage {
  const state = params.state ?? null
  const city = params.city ?? null
  const market = `${(state ?? "??").toUpperCase()}:${(city ?? "??").trim()}`

  const datasets = getMarketDatasets({ state, city })
  if (datasets.length === 0) {
    return { state, city, market, status: "unregistered", ingestible: [], queryable: [], reasons: [] }
  }

  const ingestible = datasets.filter((d) => INGESTIBLE_KINDS.includes(d.kind))
  const queryable = ingestible.filter(isQueryableDataset)
  const reasons: string[] = []
  for (const d of ingestible) {
    if (d.unavailable) reasons.push(`${d.label} (${d.host}/${d.datasetId}): ${d.unavailable}`)
    else if (!d.dateColumn) reasons.push(`${d.label} (${d.host}/${d.datasetId}): no verified date column to bound "recent" on`)
    else if (!isQueryableDataset(d)) reasons.push(`${d.label} (${d.host}/${d.datasetId}): registered as an ArcGIS dataset but carries no serviceUrl to query`)
  }
  for (const d of datasets) {
    if (!INGESTIBLE_KINDS.includes(d.kind)) {
      reasons.push(`${d.label} (${d.host}/${d.datasetId}): kind "${d.kind}" is registered but this lane does not ingest it yet`)
    }
  }

  if (queryable.length > 0) {
    return { state, city, market, status: "covered", ingestible, queryable, reasons }
  }
  const anyUnavailable = ingestible.some((d) => !!d.unavailable)
  return {
    state, city, market,
    status: anyUnavailable ? "unavailable" : "unboundable",
    ingestible,
    queryable: [],
    reasons,
  }
}
