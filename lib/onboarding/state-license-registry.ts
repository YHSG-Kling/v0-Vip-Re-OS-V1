// lib/onboarding/state-license-registry.ts
//
// PURE per-state registry of REAL-ESTATE license lookup sources.
//
// There is no free national real-estate license API (NIPR is insurance, not real
// estate), so verification runs against each STATE regulator's public registry.
//
//   method 'scrape'        — the portal answers a plain GET with the record
//                            server-rendered, so ZenRows + AI extraction can read
//                            it. lookupUrl carries {{license}} / {{lastName}}
//                            placeholders.
//   method 'manual_portal' — the portal is POST-only, session-gated, captcha-gated,
//                            or a JS app without a stable GET contract. We never
//                            guess: the reviewer gets a one-click link and the
//                            license goes to the human review queue (the floor of
//                            the ladder).
//
// All 50 states + DC are covered. Jurisdictions not listed (e.g. territories)
// fall to manual review with no link. NO network, NO db in this module.

export interface StateLicenseSource {
  /** Two-letter USPS state code, uppercase. */
  state: string
  /** The regulator that issues real-estate licenses in this state. */
  boardName: string
  /**
   * Public lookup URL. For 'scrape' it may contain {{license}} and/or
   * {{lastName}} placeholders; for 'manual_portal' it is the plain portal link
   * handed to the human reviewer.
   */
  lookupUrl: string
  method: "scrape" | "manual_portal"
}

const SOURCES: StateLicenseSource[] = [
  // ── Scrapeable (record served on a plain GET) ─────────────────────────────
  {
    state: "CA",
    boardName: "California Department of Real Estate (DRE)",
    // Server-rendered public record page keyed directly by license id.
    lookupUrl: "https://pplinfo2.dre.ca.gov/PPLInfo/PplInfoStart?LicenseID={{license}}",
    method: "scrape",
  },
  {
    state: "TX",
    boardName: "Texas Real Estate Commission (TREC)",
    // The License Holder Search accepts GET params; the "Name or License Number"
    // field is lic_name. If TREC changes the contract the extractor returns
    // found=false and the ladder falls to manual review — never a fabricated pass.
    lookupUrl:
      "https://www.trec.texas.gov/apps/license-holder-search/index.php?lic_name={{license}}&lic_hp=&industry=Real+Estate&license_search=Search",
    method: "scrape",
  },

  // ── Manual portals (POST-only / session / captcha / JS-app search) ────────
  {
    state: "FL",
    boardName: "Florida DBPR — Division of Real Estate",
    lookupUrl: "https://www.myfloridalicense.com/wl11.asp?mode=0&SID=",
    method: "manual_portal",
  },
  {
    state: "NY",
    boardName: "New York Department of State — Division of Licensing Services (eAccessNY)",
    lookupUrl: "https://appext20.dos.ny.gov/nydos/selSearchType.do",
    method: "manual_portal",
  },
  {
    state: "CO",
    boardName: "Colorado Division of Real Estate (DORA)",
    lookupUrl: "https://apps2.colorado.gov/dora/licensing/lookup/licenselookup.aspx",
    method: "manual_portal",
  },
  {
    state: "AZ",
    boardName: "Arizona Department of Real Estate (ADRE)",
    lookupUrl: "https://services.azre.gov/publicdatabase/SearchIndividuals.aspx",
    method: "manual_portal",
  },
  {
    state: "GA",
    boardName: "Georgia Real Estate Commission (GREC)",
    lookupUrl: "https://ata.grec.state.ga.us/",
    method: "manual_portal",
  },
  {
    state: "NC",
    boardName: "North Carolina Real Estate Commission (NCREC)",
    lookupUrl: "https://www.ncrec.gov/BrokerSearch",
    method: "manual_portal",
  },
  {
    state: "WA",
    boardName: "Washington State Department of Licensing (DOL)",
    lookupUrl: "https://professions.dol.wa.gov/s/license-lookup",
    method: "manual_portal",
  },
  {
    state: "IL",
    boardName: "Illinois Department of Financial and Professional Regulation (IDFPR)",
    lookupUrl: "https://online-dfpr.micropact.com/lookup/licenselookup.aspx",
    method: "manual_portal",
  },
  {
    state: "AL",
    boardName: "Alabama Real Estate Commission",
    lookupUrl: "https://arec.alabama.gov/",
    method: "manual_portal",
  },
  {
    state: "AK",
    boardName: "Alaska Real Estate Commission (Dept. of Commerce, CBPL)",
    lookupUrl: "https://www.commerce.alaska.gov/cbp/main/search/professional",
    method: "manual_portal",
  },
  {
    state: "AR",
    boardName: "Arkansas Real Estate Commission",
    lookupUrl: "https://www.arec.arkansas.gov/",
    method: "manual_portal",
  },
  {
    state: "CT",
    boardName: "Connecticut Department of Consumer Protection (eLicense)",
    lookupUrl: "https://www.elicense.ct.gov/lookup/licenselookup.aspx",
    method: "manual_portal",
  },
  {
    state: "DE",
    boardName: "Delaware Real Estate Commission (DELPROS)",
    lookupUrl: "https://delpros.delaware.gov/OH_VerifyLicense",
    method: "manual_portal",
  },
  {
    state: "HI",
    boardName: "Hawaii Real Estate Branch (DCCA Professional & Vocational Licensing)",
    lookupUrl: "https://mypvl.dcca.hawaii.gov/public-license-search/",
    method: "manual_portal",
  },
  {
    state: "ID",
    boardName: "Idaho Division of Occupational and Professional Licenses",
    lookupUrl: "https://dopl.idaho.gov/",
    method: "manual_portal",
  },
  {
    state: "IN",
    boardName: "Indiana Professional Licensing Agency",
    lookupUrl: "https://mylicense.in.gov/everification/",
    method: "manual_portal",
  },
  {
    state: "IA",
    boardName: "Iowa Real Estate Commission (Dept. of Inspections, Appeals & Licensing — Professional Licensing)",
    // DIAL absorbed the Professional Licensing Bureau (incl. real estate) in 2023;
    // its license search is a JS app, so the reviewer gets the agency landing page.
    lookupUrl: "https://dial.iowa.gov/",
    method: "manual_portal",
  },
  {
    state: "KS",
    boardName: "Kansas Real Estate Commission",
    lookupUrl: "https://krec.ks.gov/",
    method: "manual_portal",
  },
  {
    state: "KY",
    boardName: "Kentucky Real Estate Commission",
    lookupUrl: "https://web1.ky.gov/GenSearch/LicenseSearch.aspx?AGY=5",
    method: "manual_portal",
  },
  {
    state: "LA",
    boardName: "Louisiana Real Estate Commission (LREC)",
    lookupUrl: "https://lrec.gov/licensee-search/",
    method: "manual_portal",
  },
  {
    state: "ME",
    boardName: "Maine Office of Professional & Occupational Regulation",
    lookupUrl: "https://www.pfr.maine.gov/ALMSOnline/ALMSQuery/SearchIndividual.aspx",
    method: "manual_portal",
  },
  {
    state: "MD",
    boardName: "Maryland Real Estate Commission (Dept. of Labor)",
    lookupUrl: "https://www.dllr.state.md.us/cgi-bin/ElectronicLicensing/OP_search/OP_search.cgi?calling_app=REC::REC_qselect",
    method: "manual_portal",
  },
  {
    state: "MA",
    boardName: "Massachusetts Board of Registration of Real Estate Brokers & Salespersons",
    lookupUrl: "https://elicensing21.mass.gov/CitizenAccess/",
    method: "manual_portal",
  },
  {
    state: "MI",
    boardName: "Michigan Department of Licensing and Regulatory Affairs (LARA) — Real Estate Brokers & Salespersons",
    // LARA license verification runs on an Accela citizen portal (JS/session app).
    lookupUrl: "https://aca-prod.accela.com/LARA/",
    method: "manual_portal",
  },
  {
    state: "MN",
    boardName: "Minnesota Department of Commerce",
    lookupUrl: "https://mn.gov/commerce/licensing/license-lookup/",
    method: "manual_portal",
  },
  {
    state: "MS",
    boardName: "Mississippi Real Estate Commission",
    lookupUrl: "https://www.mrec.ms.gov/",
    method: "manual_portal",
  },
  {
    state: "MO",
    boardName: "Missouri Division of Professional Registration",
    lookupUrl: "https://pr.mo.gov/licensee-search.asp",
    method: "manual_portal",
  },
  {
    state: "MT",
    boardName: "Montana Board of Realty Regulation",
    lookupUrl: "https://ebizws.mt.gov/PUBLICPORTAL/searchform?mylist=licenses",
    method: "manual_portal",
  },
  {
    state: "NE",
    boardName: "Nebraska Real Estate Commission",
    lookupUrl: "https://www.nrec.ne.gov/",
    method: "manual_portal",
  },
  {
    state: "NV",
    boardName: "Nevada Real Estate Division",
    lookupUrl: "https://red.prod.secure.nv.gov/Lookup/LicenseLookup.aspx",
    method: "manual_portal",
  },
  {
    state: "NH",
    boardName: "New Hampshire Real Estate Commission (OPLC)",
    lookupUrl: "https://www.oplc.nh.gov/real-estate-commission",
    method: "manual_portal",
  },
  {
    state: "NJ",
    boardName: "New Jersey Real Estate Commission (DOBI)",
    lookupUrl: "https://newjersey.mylicense.com/verification/Search.aspx",
    method: "manual_portal",
  },
  {
    state: "NM",
    boardName: "New Mexico Real Estate Commission (RLD)",
    lookupUrl: "https://www.rld.nm.gov/boards-and-commissions/individual-boards-and-commissions/real-estate-commission/",
    method: "manual_portal",
  },
  {
    state: "ND",
    boardName: "North Dakota Real Estate Commission",
    lookupUrl: "https://www.realestatend.org/",
    method: "manual_portal",
  },
  {
    state: "OH",
    boardName: "Ohio Division of Real Estate & Professional Licensing (eLicense)",
    lookupUrl: "https://elicense3.com.ohio.gov/",
    method: "manual_portal",
  },
  {
    state: "OK",
    boardName: "Oklahoma Real Estate Commission",
    lookupUrl: "https://orec.us.thentiacloud.net/webs/orec/register/",
    method: "manual_portal",
  },
  {
    state: "OR",
    boardName: "Oregon Real Estate Agency (eLicense)",
    lookupUrl: "https://orea.elicense.irondata.com/Lookup/LicenseLookup.aspx",
    method: "manual_portal",
  },
  {
    state: "PA",
    boardName: "Pennsylvania State Real Estate Commission (PALS)",
    lookupUrl: "https://www.pals.pa.gov/#/page/search",
    method: "manual_portal",
  },
  {
    state: "RI",
    boardName: "Rhode Island Department of Business Regulation",
    lookupUrl: "https://dbr.ri.gov/online-services/license-lookups",
    method: "manual_portal",
  },
  {
    state: "SC",
    boardName: "South Carolina Real Estate Commission (LLR)",
    lookupUrl: "https://verify.llronline.com/LicLookup/Real/RE.aspx",
    method: "manual_portal",
  },
  {
    state: "SD",
    boardName: "South Dakota Real Estate Commission",
    lookupUrl: "https://dlr.sd.gov/realestate/",
    method: "manual_portal",
  },
  {
    state: "TN",
    boardName: "Tennessee Real Estate Commission",
    lookupUrl: "https://verify.tn.gov/",
    method: "manual_portal",
  },
  {
    state: "UT",
    boardName: "Utah Division of Real Estate (DOPL)",
    lookupUrl: "https://secure.utah.gov/llv/search/index.html",
    method: "manual_portal",
  },
  {
    state: "VT",
    boardName: "Vermont Office of Professional Regulation",
    lookupUrl: "https://sos.vermont.gov/opr/find-a-professional/",
    method: "manual_portal",
  },
  {
    state: "VA",
    boardName: "Virginia DPOR — Real Estate Board",
    lookupUrl: "https://www.dpor.virginia.gov/LicenseLookup/",
    method: "manual_portal",
  },
  {
    state: "WV",
    boardName: "West Virginia Real Estate Commission",
    lookupUrl: "https://rec.wv.gov/",
    method: "manual_portal",
  },
  {
    state: "WI",
    boardName: "Wisconsin Department of Safety and Professional Services",
    lookupUrl: "https://licensesearch.wi.gov/",
    method: "manual_portal",
  },
  {
    state: "WY",
    boardName: "Wyoming Real Estate Commission",
    // The commission's licensee search has no stable GET contract — landing page only.
    lookupUrl: "https://realestate.wyo.gov/",
    method: "manual_portal",
  },
  {
    state: "DC",
    boardName: "DC Real Estate Commission (DLCP)",
    lookupUrl: "https://dlcp.dc.gov/page/real-estate-commission",
    method: "manual_portal",
  },
  // Coverage: all 50 states + DC (51 entries). If a future state portal breaks,
  // prefer flipping it to manual_portal over guessing a new GET pattern.
]

const BY_STATE: ReadonlyMap<string, StateLicenseSource> = new Map(
  SOURCES.map((s) => [s.state, s])
)

/** Resolve the lookup source for a state (case/whitespace tolerant). PURE. */
export function getStateLicenseSource(state: string | null | undefined): StateLicenseSource | null {
  if (!state) return null
  return BY_STATE.get(state.trim().toUpperCase()) ?? null
}

/**
 * Fill {{license}} / {{lastName}} placeholders with URL-encoded values. PURE.
 * Unfilled placeholders (e.g. no lastName supplied) resolve to empty string so
 * the URL stays well-formed.
 */
export function resolveLookupUrl(
  template: string,
  params: { license?: string | null; lastName?: string | null }
): string {
  return template
    .replaceAll("{{license}}", encodeURIComponent((params.license ?? "").trim()))
    .replaceAll("{{lastName}}", encodeURIComponent((params.lastName ?? "").trim()))
}

/** All registry entries (read-only) — used by simulators/audits. PURE.
 *  CENSUS NOTE: guard-consumed — scripts/license-review-simulator.ts:45-46 (guard chain). */
export function listStateLicenseSources(): readonly StateLicenseSource[] {
  return SOURCES
}
