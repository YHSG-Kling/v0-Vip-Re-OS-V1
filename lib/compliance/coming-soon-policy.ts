/**
 * lib/compliance/coming-soon-policy.ts — THE MLS COMING-SOON POLICY (wave 144, lane 144A; handed over by lane
 * 144B, Outside-lane 4, and the coordinator: "a jurisdiction-scoped, versioned tenant/MLS policy key … values
 * require compliance approval and an official MLS source citation (never invented); defaults are unknown/closed,
 * not permissive").
 *
 * WHY IT IS NOT A CONSTANT. Whether a listing may sit in "coming soon", for how long, whether it may be shown,
 * and how many business days after public marketing it must be submitted to the MLS are the LOCAL MLS's rules
 * (its own published rules and regulations, under its association's adoption of policies such as Clear
 * Cooperation). There is no universal rule to hard-code, and the platform does not guess one.
 *
 * WHERE IT LIVES. One more versioned tenant policy key, `coming_soon_policy` (lib/kernel/tenant-policy.ts), in
 * brokerage_settings.settings: { mls: { "<mls_slug>": entry } }. An entry names its MLS, the states it covers,
 * the four values, and the SOURCE (the MLS's published rule: URL + rule reference). It changes ONLY through the
 * same proposal path as the adaptive vocabulary (lib/compliance/vocabulary-healing.ts: report → validated
 * `policy` proposal → a COMPLIANCE APPROVER approves → promoteProposal → attestation → verification).
 *
 * DEFAULT CLOSED. No entry, an entry without a compliance attestation, or an unreadable policy → status
 * "unknown": the readiness answer is NOT ready, with the reason. "Nobody recorded the MLS's rule" never renders
 * as "coming soon is allowed" (CLAUDE.md §4).
 *
 * THE SOURCE TEST. An MLS is a private organisation, so the .gov / .us test the state-law terms use cannot apply.
 * The deterministic part checks that the citation is an https URL naming the MLS and the rule section; the human
 * part — that the URL is that MLS's own published rules — is the compliance approver's attestation. That split is
 * published, not hidden (blind spot).
 *
 * Pure + one async loader (takes the caller's client).
 */

export const COMING_SOON_POLICY_KEY = "coming_soon_policy"

export interface ComingSoonPolicyEntry {
  mls_slug: string
  mls_name: string
  state_codes: string[]
  /** Does this MLS allow a coming-soon status at all? */
  permitted: boolean
  /** Longest a listing may stay in coming soon (days); null = the rule states no limit. */
  max_days: number | null
  /** May the property be SHOWN while coming soon? */
  showings_permitted: boolean
  /** Business days after PUBLIC marketing by which the listing must be submitted to the MLS; null = the rule states none. */
  mls_submission_within_business_days: number | null
  /**
   * May PUBLIC Coming Soon advertising show the STREET ADDRESS (with the seller's signed authorization)? Wave 145, lane
   * 145B — owner ruling 1: "You can advertise a coming soon only if you don't disclose the street address, unless
   * otherwise." true = this MLS rule / the brokerage's approved policy permits it once the seller authorizes it;
   * false = never; null = the recorded rule does not say → treated as NOT permitted (the closed default). Entries
   * recorded before wave 145 carry no value and read null.
   */
  street_address_disclosure_permitted: boolean | null
  source: { url: string; rule_ref: string; title: string | null; verified_on: string | null }
  attestation: { user_id: string; user_type: string; at: string } | null
  updated_at: string | null
}

export interface ComingSoonPolicy {
  entries: Record<string, ComingSoonPolicyEntry>
  rejected: Array<{ id: string; why: string }>
}

const SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/
const STATE_RE = /^[A-Z]{2}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const intOrNull = (v: unknown, max: number): number | null | false => {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isInteger(n) && n >= 0 && n <= max ? n : false
}

/** PURE — the deterministic half of the source test (the human half is the attestation). */
function comingSoonSourceProblems(source: { url?: unknown; rule_ref?: unknown } | null | undefined, mlsName: unknown): string[] {
  const out: string[] = []
  const url = str(source?.url)
  let ok = false
  try { ok = !!url && new URL(url).protocol === "https:" } catch { ok = false }
  if (!ok) out.push("cite the MLS's published rule as an https URL")
  if (!str(source?.rule_ref)) out.push("name the rule section (e.g. the coming-soon / Clear Cooperation section number)")
  if (!str(mlsName)) out.push("name the MLS whose rule it is")
  return out
}

/** PURE — the stored value as readers may use it; malformed entries are rejected (named), never used. */
function resolveComingSoonPolicy(raw: unknown): ComingSoonPolicy {
  const out: ComingSoonPolicy = { entries: {}, rejected: [] }
  if (!isObj(raw) || !isObj(raw.mls)) return out
  for (const [id, e] of Object.entries(raw.mls)) {
    if (!isObj(e)) { out.rejected.push({ id, why: "not an entry" }); continue }
    const slug = str(e.mls_slug), name = str(e.mls_name)
    const states = Array.isArray(e.state_codes) ? e.state_codes.map((s) => String(s ?? "").trim().toUpperCase()) : []
    const maxDays = intOrNull(e.max_days, 365), within = intOrNull(e.mls_submission_within_business_days, 60)
    const addressRule = e.street_address_disclosure_permitted
    const src = isObj(e.source) ? e.source : null
    const problems = comingSoonSourceProblems(src as any, name)
    if (!slug || !SLUG_RE.test(slug) || slug !== id) { out.rejected.push({ id, why: "the MLS slug does not match its id" }); continue }
    if (!states.length || !states.every((s) => STATE_RE.test(s))) { out.rejected.push({ id, why: "state_codes must be two-letter state codes" }); continue }
    if (typeof e.permitted !== "boolean" || typeof e.showings_permitted !== "boolean" || maxDays === false || within === false) { out.rejected.push({ id, why: "permitted / showings_permitted must be stated; max_days and the submission window are whole numbers or null" }); continue }
    if (addressRule !== undefined && addressRule !== null && typeof addressRule !== "boolean") { out.rejected.push({ id, why: "street_address_disclosure_permitted is yes, no, or unstated" }); continue }
    if (problems.length) { out.rejected.push({ id, why: problems.join("; ") }); continue }
    const at = isObj(e.attestation) && str(e.attestation.user_id) && str(e.attestation.user_type) && str(e.attestation.at)
      ? { user_id: str(e.attestation.user_id)!, user_type: str(e.attestation.user_type)!, at: str(e.attestation.at)! } : null
    out.entries[id] = {
      mls_slug: slug, mls_name: name!, state_codes: [...new Set(states)].sort(), permitted: e.permitted, max_days: maxDays, showings_permitted: e.showings_permitted,
      mls_submission_within_business_days: within,
      street_address_disclosure_permitted: typeof addressRule === "boolean" ? addressRule : null,
      source: { url: str(src!.url)!, rule_ref: str(src!.rule_ref)!, title: str(src!.title), verified_on: str(src!.verified_on) },
      attestation: at, updated_at: str(e.updated_at),
    }
  }
  return out
}

// Module scope (wave 144, lane 144Z — test:opposite-missing category 3): the answer of the module-private comingSoonPolicyFor;
// no importer and no exported signature carries it, so it is not part of this module's surface.
type ComingSoonPolicyAnswer =
  | { status: "attested"; entry: ComingSoonPolicyEntry }
  | { status: "unknown"; why: string }

/**
 * PURE — the policy for one listing: by its MLS when known, else the ONE attested entry covering its state.
 * Two entries for one state and no MLS named = unknown (the platform does not pick between two MLSs' rules).
 */
function comingSoonPolicyFor(policy: ComingSoonPolicy | null, at: { mlsSlug?: string | null; stateCode?: string | null }): ComingSoonPolicyAnswer {
  if (!policy) return { status: "unknown", why: "the brokerage's coming-soon policy could not be read" }
  const attested = Object.values(policy.entries).filter((e) => !!e.attestation)
  if (at.mlsSlug) {
    const e = policy.entries[at.mlsSlug]
    if (!e) return { status: "unknown", why: `no coming-soon rule is on file for MLS "${at.mlsSlug}"` }
    return e.attestation ? { status: "attested", entry: e } : { status: "unknown", why: `${e.mls_name}'s coming-soon rule waits for a compliance approver's attestation` }
  }
  const state = at.stateCode ? at.stateCode.toUpperCase() : null
  if (!state) return { status: "unknown", why: "the listing names neither its MLS nor its state" }
  const covering = attested.filter((e) => e.state_codes.includes(state))
  if (covering.length === 1) return { status: "attested", entry: covering[0] }
  return { status: "unknown", why: covering.length ? `${covering.length} MLSs' rules cover ${state} — name the listing's MLS` : `no attested coming-soon rule covers ${state}` }
}

export interface ComingSoonReadiness { ready: boolean; status: "attested" | "unknown"; blockers: string[]; source: { url: string; rule_ref: string } | null }

/**
 * PURE — may this listing be (or stay) COMING SOON under its MLS's attested rule? The reader lane 144B wires at
 * the COMING_SOON_ACTIVE door (lib/listing-lifecycle/readiness-checker.ts). Unknown = NOT ready (closed).
 */
export function evaluateComingSoonReadiness(
  policy: ComingSoonPolicy | null,
  listing: { mlsSlug?: string | null; stateCode?: string | null; daysInComingSoon?: number | null; showingsScheduled?: number | null; businessDaysSincePublicMarketing?: number | null },
): ComingSoonReadiness {
  const p = comingSoonPolicyFor(policy, listing)
  if (p.status === "unknown") return { ready: false, status: "unknown", blockers: [`${p.why} — coming soon stays closed until a compliance approver records the MLS's published rule`], source: null }
  const e = p.entry, blockers: string[] = []
  const cite = `${e.mls_name} ${e.source.rule_ref}`
  if (!e.permitted) blockers.push(`${cite}: this MLS does not permit a coming-soon status`)
  if (e.permitted && e.max_days !== null && (listing.daysInComingSoon ?? 0) > e.max_days) blockers.push(`${cite}: coming soon is limited to ${e.max_days} day(s); this listing is at ${listing.daysInComingSoon}`)
  if (e.permitted && !e.showings_permitted && (listing.showingsScheduled ?? 0) > 0) blockers.push(`${cite}: showings are not permitted while coming soon (${listing.showingsScheduled} scheduled)`)
  if (e.mls_submission_within_business_days !== null && (listing.businessDaysSincePublicMarketing ?? 0) > e.mls_submission_within_business_days) {
    blockers.push(`${cite}: once publicly marketed, the listing must be submitted to the MLS within ${e.mls_submission_within_business_days} business day(s)`)
  }
  return { ready: blockers.length === 0, status: "attested", blockers, source: { url: e.source.url, rule_ref: e.source.rule_ref } }
}

/** Where the seller's Coming Soon street-address instruction stands (read from the executed listing agreement). */
export type SellerAddressAuthorization = "authorized" | "declined" | "not_recorded" | "unreadable"

export interface ComingSoonAddressDecision {
  /** true ONLY when the seller authorized it AND the applicable attested MLS / brokerage rule permits it. */
  disclose: boolean
  /** Every reason the street address stays out of public Coming Soon creative (empty only when disclose is true). */
  withheldBecause: string[]
  sellerAuthorization: SellerAddressAuthorization
  /** The attested rule the answer rests on (null when no rule applies — then the address is withheld). */
  policySource: { mls_name: string; url: string; rule_ref: string } | null
}

/**
 * PURE — may PUBLIC Coming Soon creative show this listing's STREET ADDRESS? (wave 145, lane 145B; owner ruling 1:
 * "You can advertise a coming soon only if you don't disclose the street address, unless otherwise.")
 *
 * DEFAULT: NO. The street address is disclosed only when BOTH hold:
 *   1. the SELLER authorized it in the executed listing agreement (or an executed amendment) —
 *      lib/listings/listing-agreement-terms.ts `coming_soon_street_address_authorized`, never an agent's say-so; and
 *   2. the APPLICABLE approved rule permits it — the brokerage's compliance-attested entry for the listing's MLS (or the
 *      ONE attested entry covering its state), which must also permit Coming Soon at all, with
 *      `street_address_disclosure_permitted === true`. No nationwide constant: an MLS / brokerage with no recorded rule,
 *      an unattested one, or one silent on the address withholds it.
 * Withholding the address does NOT exempt the listing from the MLS's other obligations (submission windows, showings,
 * day limits) — evaluateComingSoonReadiness keeps judging those separately. The full address stays internal (agents,
 * the transaction record, compliance): this answers only what PUBLIC creative may print.
 */
export function comingSoonStreetAddressDecision(
  policy: ComingSoonPolicy | null,
  listing: { mlsSlug?: string | null; stateCode?: string | null },
  seller: SellerAddressAuthorization,
): ComingSoonAddressDecision {
  const withheldBecause: string[] = []
  if (seller === "unreadable") withheldBecause.push("the listing agreement could not be read, so the seller's instruction is unknown")
  else if (seller === "not_recorded") withheldBecause.push("the executed listing agreement records no seller authorization to show the street address in Coming Soon advertising")
  else if (seller === "declined") withheldBecause.push("the seller's executed listing agreement withholds the street address from Coming Soon advertising")
  const p = comingSoonPolicyFor(policy, listing)
  let policySource: ComingSoonAddressDecision["policySource"] = null
  if (p.status === "unknown") withheldBecause.push(`${p.why} — without an attested rule permitting it, the street address stays out of Coming Soon advertising`)
  else {
    const e = p.entry
    policySource = { mls_name: e.mls_name, url: e.source.url, rule_ref: e.source.rule_ref }
    if (!e.permitted) withheldBecause.push(`${e.mls_name} ${e.source.rule_ref}: this MLS does not permit a coming-soon status`)
    else if (e.street_address_disclosure_permitted !== true) {
      withheldBecause.push(e.street_address_disclosure_permitted === false
        ? `${e.mls_name} ${e.source.rule_ref}: the street address may not appear in Coming Soon advertising`
        : `${e.mls_name} ${e.source.rule_ref}: the recorded rule does not say the street address may appear in Coming Soon advertising — record it through the coming-soon policy report (a compliance approver attests)`)
    }
  }
  return { disclose: withheldBecause.length === 0, withheldBecause, sellerAuthorization: seller, policySource }
}

export interface ComingSoonPolicyReport {
  mlsName: string
  stateCodes: string[]
  permitted: boolean | null
  maxDays: number | string | null
  showingsPermitted: boolean | null
  mlsSubmissionWithinBusinessDays: number | string | null
  sourceUrl: string | null
  ruleRef: string | null
  sourceTitle?: string | null
  /** Wave 145 (lane 145B): may public Coming Soon advertising show the street address, per this rule? Unstated = null = NOT permitted. */
  streetAddressDisclosurePermitted?: boolean | null
}

/** PURE — a report → the entry it proposes, or every problem (nothing invented: an unstated value is refused). */
export function validateComingSoonPolicyReport(report: ComingSoonPolicyReport, at: string): { ok: true; entry: ComingSoonPolicyEntry } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const name = str(report.mlsName)
  const slug = name ? name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) : ""
  const states = (report.stateCodes ?? []).map((s) => String(s ?? "").trim().toUpperCase()).filter(Boolean)
  const maxDays = intOrNull(report.maxDays, 365), within = intOrNull(report.mlsSubmissionWithinBusinessDays, 60)
  if (!name || !SLUG_RE.test(slug)) errors.push("name the MLS")
  if (!states.length || !states.every((s) => STATE_RE.test(s))) errors.push("name the state(s) the MLS covers")
  if (typeof report.permitted !== "boolean") errors.push("say whether the MLS permits coming soon (the rule's answer — never assumed)")
  if (typeof report.showingsPermitted !== "boolean") errors.push("say whether showings are permitted while coming soon")
  if (maxDays === false) errors.push("max days is a whole number (or blank when the rule states no limit)")
  if (within === false) errors.push("the submission window is a whole number of business days (or blank when the rule states none)")
  const addr = report.streetAddressDisclosurePermitted
  if (addr !== undefined && addr !== null && typeof addr !== "boolean") errors.push("say whether the rule permits the street address in Coming Soon advertising (yes / no), or leave it unstated")
  errors.push(...comingSoonSourceProblems({ url: report.sourceUrl, rule_ref: report.ruleRef }, name))
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    entry: {
      mls_slug: slug, mls_name: name!, state_codes: [...new Set(states)].sort(), permitted: report.permitted as boolean, max_days: maxDays as number | null,
      showings_permitted: report.showingsPermitted as boolean, mls_submission_within_business_days: within as number | null,
      street_address_disclosure_permitted: typeof report.streetAddressDisclosurePermitted === "boolean" ? report.streetAddressDisclosurePermitted : null,
      source: { url: String(report.sourceUrl).trim(), rule_ref: String(report.ruleRef).trim().slice(0, 120), title: str(report.sourceTitle)?.slice(0, 200) ?? null, verified_on: at.slice(0, 10) },
      attestation: null, updated_at: at,
    },
  }
}

type Svc = { from: (t: string) => any }

/** The brokerage's coming-soon policy. FAIL CLOSED: a refused read is ok:false (callers answer "unknown"). */
export async function loadComingSoonPolicy(svc: Svc, brokerageId: string): Promise<{ ok: true; policy: ComingSoonPolicy } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no brokerage — the coming-soon policy cannot be read" }
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `the coming-soon policy could not be read: ${error.message}` }
  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings
  return { ok: true, policy: resolveComingSoonPolicy(isObj(settings) ? settings[COMING_SOON_POLICY_KEY] : null) }
}
