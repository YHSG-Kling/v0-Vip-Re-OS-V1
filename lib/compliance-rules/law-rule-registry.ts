// lib/compliance-rules/law-rule-registry.ts
//
// THE LAW-RULE REGISTRY — a VIEW over the compliance-rules survivors (wave 138, lane 138C). PURE: no I/O,
// no model, no server-only import, so the proof and the healing runner (lib/kernel/law-rule-healing.ts)
// both read it directly.
//
// Owner (wave 138): "when a federal or state real-estate law rule is missing or outdated … the system
// researches it (cited primary sources), drafts the rule into the compliance-rules survivor, and resolves
// it: a STRICTER-ONLY addition may auto-enable in warn/flag mode with evidence; anything that LOOSENS a
// rule, blocks money, or is ambiguous goes to the compliance officer (human)."
//
// SURVIVORS — nothing here replaces them; the registry PROJECTS them onto one shape:
//   · code-encoded federal gates (fair-housing patterns, the TCPA / CAN-SPAM consent gates, RESPA §8,
//     the TRID clock, the wire-fraud sentinel, PII redaction, the FTC marketing-claims gate) — declared
//     below as CODE_LAW_RULES, each naming the file that IMPLEMENTS it and the primary citations;
//   · state_protected_classes (scripts/1065-state-protected-classes.sql + m744 registry columns) — the
//     jurisdiction-keyed rows lib/compliance-rules/state-fair-housing.ts evaluates on every content check.
// Every rule declares jurisdiction, citations, effective date, last verified, scope and strictness.
//
// JURISDICTIONS ARE DERIVED, NEVER LISTED: deriveTenantJurisdictions reads the tenant's own state, its
// farm territories and its agents' license states (lib/kernel/law-rule-healing.ts loads them). The
// only literal is the FEDERAL marker.

export const LAW_RULE_SCOPES = ["advertising", "communications", "disclosures", "agency", "wire_fraud", "privacy", "licensing"] as const
type LawRuleScope = (typeof LAW_RULE_SCOPES)[number]

/** The federal jurisdiction marker (a state row carries its two-letter code). */
export const FEDERAL_JURISDICTION = "US"

/** prohibits = flags/blocks conduct; requires = demands an element; permits = an exemption / safe harbor. */
type LawRuleStrictness = "prohibits" | "requires" | "permits"
/** enforce = the evaluator's own severity; warn = flag only (severity capped low — never a fail, never a block). */
const LAW_RULE_ENFORCEMENT = ["enforce", "warn"] as const
type LawRuleEnforcement = (typeof LAW_RULE_ENFORCEMENT)[number]
/** Who put a row there: the seed, the healing loop (warn, stricter-only) or a compliance officer's approval. */
const LAW_RULE_PROVENANCE = ["seed", "law_rule_healing", "compliance_officer"] as const
type LawRuleProvenance = (typeof LAW_RULE_PROVENANCE)[number]

interface LawRuleCitation { title: string; url: string }

export interface LawRule {
  key: string
  jurisdiction: string
  scope: LawRuleScope
  title: string
  citations: LawRuleCitation[]
  /** ISO date the rule took effect; null when not recorded (never invented). */
  effectiveDate: string | null
  /** When the healing loop last confirmed it against a primary source; null = never. */
  lastVerifiedAt: string | null
  strictness: LawRuleStrictness
  enforcement: LawRuleEnforcement
  source: "code" | "state_protected_classes"
  /** The implementing file (code rules) or the table (row rules). */
  file: string
  active: boolean
  /** state_protected_classes.id for a row rule. */
  rowId?: string
  provenance: LawRuleProvenance
  /** The research evidence an auto-enabled / approved row carries (query, excerpt, resolution) — shown to the reviewer. */
  evidence?: Record<string, unknown> | null
}

/** A rule is STALE when never verified or last verified longer ago than this. */
export const LAW_RULE_STALE_DAYS = 365

/**
 * Scopes every jurisdiction the tenant operates in is EXPECTED to carry ≥1 rule for. Federal law
 * governs advertising, consent-based communications, settlement disclosures, wire/data safeguards and
 * consumer financial privacy; agency and licensing are STATE law (a federal gap there is not a gap).
 */
const FEDERAL_EXPECTED_SCOPES: readonly LawRuleScope[] = ["advertising", "communications", "disclosures", "wire_fraud", "privacy"]
const STATE_EXPECTED_SCOPES: readonly LawRuleScope[] = ["advertising", "licensing", "agency", "disclosures"]

const USC = (title: number, section: string) => `https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title${title}-section${section}&num=0&edition=prelim`

/** The federal gates the OS already enforces in code — each names its file and its primary citations. */
export const CODE_LAW_RULES: readonly LawRule[] = Object.freeze([
  code("federal.fair_housing.advertising", "advertising", "Fair Housing Act — discriminatory advertising", "prohibits", "lib/compliance-rules/fair-housing-patterns.ts", "1968-04-11", [
    { title: "42 U.S.C. §3604(c)", url: USC(42, "3604") },
    { title: "24 CFR Part 100", url: "https://www.ecfr.gov/current/title-24/subtitle-B/chapter-I/subchapter-A/part-100" },
  ]),
  code("federal.ftc.marketing_claims", "advertising", "FTC Act §5 — deceptive claims; Endorsement Guides", "prohibits", "lib/kernel/compliance.ts", null, [
    { title: "15 U.S.C. §45", url: USC(15, "45") },
    { title: "16 CFR Part 255", url: "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255" },
  ]),
  code("federal.tcpa.consent", "communications", "TCPA — prior express consent, quiet hours, do-not-call", "requires", "lib/compliance/phone-scrub.ts", "1991-12-20", [
    { title: "47 U.S.C. §227", url: USC(47, "227") },
    { title: "47 CFR §64.1200", url: "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200" },
  ]),
  code("federal.can_spam.email", "communications", "CAN-SPAM — opt-out, sender identity, postal address", "requires", "lib/compliance/contact-channel-gate.ts", "2004-01-01", [
    { title: "15 U.S.C. §7704", url: USC(15, "7704") },
    { title: "16 CFR Part 316", url: "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-316" },
  ]),
  code("federal.respa.section8", "disclosures", "RESPA §8 — referral fees, kickbacks, affiliated business disclosure", "prohibits", "lib/compliance/vendor-respa.ts", "1974-12-22", [
    { title: "12 U.S.C. §2607", url: USC(12, "2607") },
    { title: "12 CFR §1024.14", url: "https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-A/section-1024.14" },
  ]),
  code("federal.trid.timing", "disclosures", "TRID — Loan Estimate / Closing Disclosure timing", "requires", "lib/compliance/trid-disclosure-clock.ts", "2015-10-03", [
    { title: "12 CFR §1026.19", url: "https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-C/section-1026.19" },
  ]),
  code("federal.wire_fraud.safeguards", "wire_fraud", "Wire fraud — safeguarding customer information and payment instructions", "requires", "lib/wire-fraud/wire-fraud-sentinel.ts", "2023-06-09", [
    { title: "18 U.S.C. §1343", url: USC(18, "1343") },
    { title: "16 CFR Part 314", url: "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-314" },
  ]),
  code("federal.glba.privacy", "privacy", "GLBA — consumer financial privacy", "requires", "lib/privacy/contact-pii-redaction.ts", null, [
    { title: "15 U.S.C. §6802", url: USC(15, "6802") },
    { title: "12 CFR Part 1016", url: "https://www.ecfr.gov/current/title-12/chapter-X/part-1016" },
  ]),
])

function code(key: string, scope: LawRuleScope, title: string, strictness: LawRuleStrictness, file: string, effectiveDate: string | null, citations: LawRuleCitation[]): LawRule {
  return { key, jurisdiction: FEDERAL_JURISDICTION, scope, title, citations, effectiveDate, lastVerifiedAt: null, strictness, enforcement: "enforce", source: "code", file, active: true, provenance: "seed" }
}

/** A state_protected_classes row as read with select("*") — the m744 columns are optional until applied. */
export interface StateRuleRow {
  id: string
  state_code: string
  protected_class: string
  regulation_reference: string | null
  severity_default?: string | null
  patterns?: string[] | null
  is_active?: boolean | null
  rule_scope?: string | null
  source_citations?: unknown
  effective_date?: string | null
  last_verified_at?: string | null
  enforcement_mode?: string | null
  provenance?: string | null
  evidence?: Record<string, unknown> | null
}

function isScope(v: unknown): v is LawRuleScope { return typeof v === "string" && (LAW_RULE_SCOPES as readonly string[]).includes(v) }

/** PURE — the citations a row carries: its source_citations, else its regulation_reference (cited by name only). */
function citationsOfRow(row: Pick<StateRuleRow, "source_citations" | "regulation_reference">): LawRuleCitation[] {
  const raw = Array.isArray(row.source_citations) ? row.source_citations : []
  const out = raw.filter((c): c is LawRuleCitation => !!c && typeof c === "object" && typeof (c as LawRuleCitation).url === "string" && typeof (c as LawRuleCitation).title === "string")
  if (out.length) return out
  return row.regulation_reference ? [{ title: row.regulation_reference, url: "" }] : []
}

/** PURE — one state_protected_classes row as a registry rule (proved through buildLawRuleRegistry). */
function projectStateRuleRow(row: StateRuleRow): LawRule {
  const scope = isScope(row.rule_scope) ? row.rule_scope : "advertising"
  return {
    key: lawRuleKey(row.state_code, scope, row.protected_class),
    jurisdiction: String(row.state_code ?? "").toUpperCase(),
    scope,
    title: row.protected_class,
    citations: citationsOfRow(row),
    effectiveDate: row.effective_date ?? null,
    lastVerifiedAt: row.last_verified_at ?? null,
    strictness: "prohibits",
    enforcement: row.enforcement_mode === "warn" ? "warn" : "enforce",
    source: "state_protected_classes",
    file: "state_protected_classes",
    active: row.is_active !== false,
    rowId: row.id,
    provenance: (LAW_RULE_PROVENANCE as readonly string[]).includes(String(row.provenance)) ? (row.provenance as LawRuleProvenance) : "seed",
    evidence: row.evidence && typeof row.evidence === "object" ? row.evidence : null,
  }
}

/** PURE — the rule key: jurisdiction.scope.slug (lower-case). */
function lawRuleKey(jurisdiction: string, scope: LawRuleScope, name: string): string {
  const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "rule"
  return `${String(jurisdiction).toLowerCase()}.${scope}.${slug}`
}

/**
 * PURE — the registry: the code rules plus the jurisdiction rows, with verification evidence
 * (rule key → ISO timestamp, from the ledger) laid over each rule's own last_verified_at (the later wins).
 */
export function buildLawRuleRegistry(rows: readonly StateRuleRow[], verifiedAt: Readonly<Record<string, string>> = {}): LawRule[] {
  const later = (a: string | null, b: string | undefined) => (!b ? a : !a ? b : (Date.parse(b) > Date.parse(a) ? b : a))
  return [...CODE_LAW_RULES.map((r) => ({ ...r })), ...rows.map(projectStateRuleRow)].map((r) => ({ ...r, lastVerifiedAt: later(r.lastVerifiedAt, verifiedAt[r.key]) }))
}

/**
 * PURE — the jurisdictions a tenant operates in: federal, plus every two-letter state its own row, its
 * active farm territories and its agents' licenses name. Nothing else (a tenant is wherever its data says).
 */
export function deriveTenantJurisdictions(input: { brokerageState?: string | null; territoryStates?: ReadonlyArray<string | null | undefined>; licenseStates?: ReadonlyArray<string | null | undefined> }): string[] {
  const states = new Set<string>()
  for (const s of [input.brokerageState, ...(input.territoryStates ?? []), ...(input.licenseStates ?? [])]) {
    const v = String(s ?? "").trim().toUpperCase()
    if (/^[A-Z]{2}$/.test(v) && v !== FEDERAL_JURISDICTION) states.add(v)
  }
  return [FEDERAL_JURISDICTION, ...[...states].sort()]
}

export interface LawRuleFinding {
  kind: "missing" | "stale"
  jurisdiction: string
  scope: LawRuleScope
  /** The stale rule (absent for a missing scope). */
  ruleKey?: string
  why: string
}

/** PURE — per tenant jurisdiction: expected scopes with no active rule (missing) and active rules past LAW_RULE_STALE_DAYS (stale). */
export function detectLawRuleGaps(registry: readonly LawRule[], jurisdictions: readonly string[], now: Date = new Date()): LawRuleFinding[] {
  const out: LawRuleFinding[] = []
  const staleBefore = now.getTime() - LAW_RULE_STALE_DAYS * 86_400_000
  for (const j of jurisdictions) {
    const mine = registry.filter((r) => r.jurisdiction === j && r.active)
    const expected = j === FEDERAL_JURISDICTION ? FEDERAL_EXPECTED_SCOPES : STATE_EXPECTED_SCOPES
    for (const scope of expected) {
      if (!mine.some((r) => r.scope === scope)) out.push({ kind: "missing", jurisdiction: j, scope, why: `no active ${scope} rule for ${j}` })
    }
    for (const r of mine) {
      const at = r.lastVerifiedAt ? Date.parse(r.lastVerifiedAt) : NaN
      if (!Number.isFinite(at) || at < staleBefore) out.push({ kind: "stale", jurisdiction: j, scope: r.scope, ruleKey: r.key, why: r.lastVerifiedAt ? `last verified ${r.lastVerifiedAt.slice(0, 10)} (> ${LAW_RULE_STALE_DAYS} days)` : "never verified against a primary source" })
    }
  }
  return out
}

/** PURE — the research query for a finding (jurisdiction marker + scope; no place literal). */
export function researchQueryFor(f: LawRuleFinding): string {
  const where = f.jurisdiction === FEDERAL_JURISDICTION ? "United States federal" : `state ${f.jurisdiction}`
  const what: Record<LawRuleScope, string> = {
    advertising: "real estate advertising fair housing protected classes statute",
    communications: "telemarketing text message email consent law real estate",
    disclosures: "real estate seller disclosure settlement disclosure statute regulation",
    agency: "real estate brokerage agency relationship disclosure statute",
    wire_fraud: "real estate wire fraud escrow payment instructions safeguards law",
    privacy: "consumer data privacy law real estate brokerage",
    licensing: "real estate license law advertising requirements commission rule",
  }
  return `${where} ${what[f.scope]} current text effective date`
}

/** PURE — a PRIMARY source: a government publisher (.gov / .us). Commentary, blogs and vendors are not. */
export function isPrimarySourceUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol !== "https:" && u.protocol !== "http:") return false
    const h = u.hostname.toLowerCase()
    return h.endsWith(".gov") || h.endsWith(".us")
  } catch { return false }
}

/** Protected-class terms a jurisdiction may add beyond the federal seven (matched in PRIMARY text only). */
const STATE_PROTECTED_CLASS_TERMS: readonly string[] = [
  "source of income", "sexual orientation", "gender identity", "gender expression", "marital status", "age",
  "ancestry", "military status", "veteran status", "citizenship status", "immigration status", "arrest record",
  "lawful occupation", "genetic information", "creed", "familial status", "housing status",
]

type LawRuleChange = "add" | "verify" | "loosen"

export interface LawRuleDraft {
  key: string
  jurisdiction: string
  scope: LawRuleScope
  /** The rule's subject (a protected class for an advertising row; the cited title otherwise). */
  name: string
  change: LawRuleChange
  /** Content patterns the evaluator runs (an advertising row also flags its class name). */
  patterns: string[]
  citations: LawRuleCitation[]
  effectiveDate: string | null
  /** True when the evaluator survivor can run it as written (an advertising class row). */
  executable: boolean
  /** True when the rule would hold, delay or block a money movement (escrow, wire, payment, disbursement). */
  touchesMoney: boolean
  /** The rule the draft verifies / loosens (stale findings). */
  targetKey?: string
  targetRowId?: string
  evidence: string
}

interface ResearchHit { title: string | null; url: string | null; snippet: string | null }

const LOOSENING = /\b(repeal(?:ed|s)?|rescind(?:ed|s)?|no longer (?:required|applies|apply)|exempt(?:ion|ed|s)?|vacated|struck down|enjoined|sunset(?:ted)?|withdrawn)\b/
const MONEY = /\b(wire|escrow|earnest money|disburs\w*|payment|funds?|trust account)\b/
const DATE = /\b(?:effective|takes effect|in effect)[^.]{0,40}?(\d{4}-\d{2}-\d{2}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4})/

const MONTH: Record<string, string> = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" }

/** PURE — an effective date LITERALLY present in the primary text (never invented). */
function effectiveDateIn(text: string): string | null {
  const m = DATE.exec(text.toLowerCase())
  if (!m) return null
  const d = m[1]
  if (/^\d{4}-/.test(d)) return d
  const p = /^([a-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(d)
  return p && MONTH[p[1]] ? `${p[3]}-${MONTH[p[1]]}-${p[2].padStart(2, "0")}` : null
}

type DraftOutcome = { ok: true; drafts: LawRuleDraft[] } | { ok: false; reason: "uncited" | "nothing_found"; why: string }

/**
 * PURE + deterministic — DRAFT the rule(s) a finding needs from research hits. No model writes a rule:
 * only PRIMARY hits (isPrimarySourceUrl) are read and cited; a finding with none is REFUSED ("uncited").
 *   · stale  → "verify" (the primary text still names the rule) or "loosen" (it reads as repealed /
 *              exempted / vacated) — targeting the stale rule;
 *   · missing advertising in a state → one "add" per protected-class term the primary text names that the
 *              jurisdiction does not already carry (executable: the evaluator flags the class name);
 *   · missing anything else → one "add" naming the cited source (NOT executable — a code gate or a human
 *              writes the rule; the loop never invents patterns for it).
 */
export function draftLawRule(finding: LawRuleFinding, hits: readonly ResearchHit[], registry: readonly LawRule[]): DraftOutcome {
  const primary = hits.filter((h) => isPrimarySourceUrl(h.url))
  if (primary.length === 0) return { ok: false, reason: "uncited", why: `no primary source (.gov / .us) among ${hits.length} research hit(s) — a rule is never drafted uncited` }
  const citations: LawRuleCitation[] = primary.slice(0, 3).map((h) => ({ title: (h.title ?? h.url ?? "").slice(0, 200), url: String(h.url) }))
  const text = primary.map((h) => `${h.title ?? ""} ${h.snippet ?? ""}`).join(" \n ").toLowerCase()
  const effectiveDate = effectiveDateIn(text)
  const touchesMoney = finding.scope === "wire_fraud" || MONEY.test(text)
  const evidence = primary.slice(0, 3).map((h) => `${h.url}: ${(h.snippet ?? "").slice(0, 240)}`).join(" | ")
  if (finding.kind === "stale") {
    const target = registry.find((r) => r.key === finding.ruleKey)
    const change: LawRuleChange = LOOSENING.test(text) ? "loosen" : "verify"
    return { ok: true, drafts: [{ key: finding.ruleKey ?? lawRuleKey(finding.jurisdiction, finding.scope, "rule"), jurisdiction: finding.jurisdiction, scope: finding.scope, name: target?.title ?? finding.ruleKey ?? "rule", change, patterns: [], citations, effectiveDate, executable: target?.source === "state_protected_classes", touchesMoney, targetKey: finding.ruleKey, targetRowId: target?.rowId, evidence }] }
  }
  if (finding.scope === "advertising" && finding.jurisdiction !== FEDERAL_JURISDICTION) {
    const have = new Set(registry.filter((r) => r.jurisdiction === finding.jurisdiction && r.scope === "advertising").map((r) => r.title.toLowerCase()))
    const terms = STATE_PROTECTED_CLASS_TERMS.filter((t) => new RegExp(`\\b${t.replace(/ /g, "\\s+")}\\b`).test(text) && !have.has(t))
    if (terms.length === 0) return { ok: false, reason: "nothing_found", why: "the primary text names no protected class this jurisdiction lacks" }
    return { ok: true, drafts: terms.map((t) => ({ key: lawRuleKey(finding.jurisdiction, "advertising", t), jurisdiction: finding.jurisdiction, scope: "advertising" as const, name: t, change: "add" as const, patterns: [], citations, effectiveDate, executable: true, touchesMoney: false, evidence })) }
  }
  const name = citations[0].title || finding.scope
  return { ok: true, drafts: [{ key: lawRuleKey(finding.jurisdiction, finding.scope, name), jurisdiction: finding.jurisdiction, scope: finding.scope, name, change: "add", patterns: [], citations, effectiveDate, executable: false, touchesMoney, evidence }] }
}

type LawRuleDirection = "stricter" | "looser" | "verification" | "ambiguous"

export type LawRuleResolution =
  | { route: "verify"; direction: "verification"; why: string }
  | { route: "auto_enable_warn"; direction: "stricter"; why: string }
  | { route: "compliance_officer"; direction: LawRuleDirection; why: string }
  | { route: "refused"; direction: LawRuleDirection; why: string }

/**
 * PURE — the owner's resolution rule. ONLY a stricter-only, executable, money-free, cited addition
 * auto-enables, and only in WARN mode. A loosening, a money touch or anything ambiguous goes to the
 * compliance officer. An uncited draft is refused outright.
 */
export function resolveLawRuleDraft(draft: LawRuleDraft, registry: readonly LawRule[]): LawRuleResolution {
  if (draft.citations.length === 0 || !draft.citations.every((c) => isPrimarySourceUrl(c.url))) return { route: "refused", direction: "ambiguous", why: "uncited — every drafted rule cites a primary source" }
  if (draft.change === "loosen") return { route: "compliance_officer", direction: "looser", why: "the primary source reads as a repeal / exemption — a compliance boundary is never relaxed without a human" }
  if (draft.touchesMoney) return { route: "compliance_officer", direction: "ambiguous", why: "the rule touches a money movement (wire / escrow / payment) — financial actions are a human's call" }
  if (draft.change === "verify") return { route: "verify", direction: "verification", why: "the primary source still states the rule — verification recorded" }
  const exists = registry.some((r) => r.key === draft.key && r.active)
  if (exists) return { route: "refused", direction: "ambiguous", why: "already in the registry — nothing to add" }
  if (!draft.executable) return { route: "compliance_officer", direction: "ambiguous", why: `no evaluator can run a ${draft.scope} rule as drafted — a compliance officer decides how it is enforced` }
  if (draft.patterns.some((p) => { try { new RegExp(p); return false } catch { return true } })) return { route: "compliance_officer", direction: "ambiguous", why: "a drafted pattern does not compile" }
  return { route: "auto_enable_warn", direction: "stricter", why: "a stricter-only addition (adds a flag, removes nothing) — enabled in WARN mode with its citations" }
}
