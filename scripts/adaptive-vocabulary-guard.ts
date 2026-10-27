#!/usr/bin/env tsx
/**
 * scripts/adaptive-vocabulary-guard.ts   (npm run test:adaptive-vocabulary — run with --conditions=react-server)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 144, LANE A — owner ruling 1 ("contract subtype, financing and representation must be SELF-HEALING")
 * and ruling 17 (probate / divorce / military relocation are service TOPICS, 55+ keeps its exemption).
 * Proves, with a positive control for every absence it claims:
 *
 *   A. THE CENSUS — every vocabulary the adaptive path reads (lib/compliance/adaptive-vocabulary.ts
 *      VOCABULARY_DIMENSIONS) names its survivor, and each live CHECK it claims EQUALS its platform list in the
 *      generated cache (scripts/check-vocabularies.ts) — or is ABSENT only because m847 moved it onto the
 *      vocabulary trigger. A cache column whose value set equals a platform list but is not claimed is a finding.
 *      The m847 admission arrays equal the code (derived from the .sql). Disagreeing copies are COUNTED.
 *   B. RESOLUTION — stable keys, separators, case, platform aliases ("All Cash" → cash), lineage; an unknown
 *      value is null, never a guess; financingKindFor is never loosened.
 *   C. THE MANAGER'S EVALUATION + DEPENDENCY VALIDATION (pure) — already-resolves, needs-detail, alias vs add,
 *      jurisdiction (state + official source), platform-owned dimensions, every refusal.
 *   D. END TO END in memory, through the REAL controlled-learning kernel: report → proposal (EVALUATED, nothing
 *      written) → one-open-at-a-time → approval by role → promotion (policy version + ledger) → compliance
 *      attestation → verification; the dependents of a new FINANCING type (pre-approval rule, offer strength,
 *      the government-loan addendum set, the state form enum) and of a TEXAS REPRESENTATION term (the
 *      required-document resolver, parent and child rules); retirement keeps history; tenant isolation.
 *   E. A STRIPPED-SOURCE CENSUS — no model call decides anything here; no direct settings write; the pickers
 *      read the vocabulary; the housing-topic table; the preset legal claims are seeded as brokerage policy.
 *
 * BLIND SPOTS (published beside the numbers): the database is in memory — RLS, the m847 trigger and the
 * tenant_adaptive_vocabulary RPC are proven by their SQL text, not executed; the kernel's emitKernelEvent /
 * notifications are best-effort and not asserted; the generated CHECK cache is as fresh as its last regeneration
 * (m847 is not applied, so brd.contract_subtype / representation are still CHECK-pinned there); the scattered
 * financing-option copies outside this lane's files are counted, not fixed (lane notes, Outside-lane).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  ADAPTIVE_VOCABULARY_POLICY_KEY, EMPTY_TENANT_VOCABULARY, HOUSING_TOPIC_TREATMENT, VOCABULARY_DIMENSIONS,
  checklistVocabularyFor, evaluateVocabularyReport, financingTypeResolver, loadTenantVocabulary,
  resolveVocabularyValue, validateVocabularyChange, verifyVocabularyChange, vocabularyOptions, vocabularyPatchFor, vocabularyWriteValue,
  type VocabularyChange, type VocabularyDimension,
} from "../lib/compliance/adaptive-vocabulary"
import {
  CONTRACT_SUBTYPES, FINANCING_TYPES, GOVERNMENT_BACKED_FINANCING_TYPES, PLATFORM_CHECKLIST_VOCABULARY, REPRESENTATIONS,
  financingKindFor, rowApplicability,
} from "../lib/compliance/checklist-dimensions"
import { resolveRequiredDocuments } from "../lib/compliance/required-documents"
import {
  VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES, approveVocabularyProposal, attestVocabularyEntry, listVocabularyProposals, reportVocabularyGap,
} from "../lib/compliance/vocabulary-healing"
import { TENANT_POLICY_SETTINGS_KEYS, parsePolicyKey } from "../lib/kernel/tenant-policy"
import { scoreBuyerStrength } from "../lib/offers/offer-strength"
import { OFFER_FIELD_DEFS } from "../lib/state-forms/field-defs"
import { CAMPAIGN_PERSONAS } from "../lib/campaigns/contact-sources"
import { LEGAL_SOURCE_CLAIM, getRequiredDocPresetsForState, getSupportedPresetStates, uncitedLegalClaims } from "../lib/compliance/required-doc-presets"
import { COMING_SOON_POLICY_KEY, evaluateComingSoonReadiness, loadComingSoonPolicy, validateComingSoonPolicyReport } from "../lib/compliance/coming-soon-policy"
import { reportComingSoonPolicy } from "../lib/compliance/vocabulary-healing"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { memSupabase } from "./in-memory-supabase"
import { blankStrings, stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) } }
const control = (n: string, finder: (s: string) => boolean, specimen: string) => check(`POSITIVE CONTROL — ${n}`, finder(specimen) === true)
const section = (t: string) => console.log(`\n[${t}]`)
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
const code = (p: string) => blankStrings(stripComments(read(p)))
const codeWithStrings = (p: string) => stripComments(read(p))
const sameSet = (a: readonly string[] | null | undefined, b: readonly string[]) => !!a && a.length === b.length && b.every((x) => a.includes(x))

const LANE_FILES = [
  "lib/compliance/adaptive-vocabulary.ts", "lib/compliance/vocabulary-healing.ts", "lib/compliance/checklist-dimensions.ts",
  "app/actions/compliance/vocabulary.ts", "app/actions/compliance/manage-required-docs.ts",
  "app/dashboard/settings/required-documents/vocabulary-panel.tsx", "app/dashboard/settings/required-documents/required-docs-settings-client.tsx",
  "app/dashboard/settings/required-documents/page.tsx", "lib/compliance/coming-soon-policy.ts",
]
const MIGRATION = readdirSync("supabase/migrations").find((f) => /adaptive-vocabulary-admission/.test(f)) ?? ""
const MOVED_BY_M847 = new Set(["brokerage_required_documents.contract_subtype", "brokerage_required_documents.representation"])

async function main() {
  // ═══ A. THE CENSUS ═══════════════════════════════════════════════════════════════════════════════════════
  section("A1 every dimension names its survivor, a non-empty platform list with unique stable keys, a mode and a storage rule")
  const dims = Object.keys(VOCABULARY_DIMENSIONS) as VocabularyDimension[]
  for (const d of dims) {
    const s = VOCABULARY_DIMENSIONS[d]
    const keys = s.platform.map((t) => t.key)
    check(`${d}: ${s.mode}, storage ${s.storage}, ${keys.length} platform terms from ${s.survivor}`,
      keys.length > 0 && new Set(keys).size === keys.length && s.platform.every((t) => t.label.trim().length > 0) && existsSync(s.survivor.split(" ")[0]))
  }
  console.log(`    census: ${dims.length} vocabularies — ${dims.filter((d) => VOCABULARY_DIMENSIONS[d].mode === "extensible").length} extensible, ${dims.filter((d) => VOCABULARY_DIMENSIONS[d].mode === "label_alias_only").length} label/alias only, ${dims.filter((d) => VOCABULARY_DIMENSIONS[d].mode === "platform_only").length} platform-owned`)

  section("A2 each claimed live CHECK equals the platform list in the generated cache (or m847 moved it onto the vocabulary)")
  const m847 = read(join("supabase/migrations", MIGRATION))
  const m847Code = m847.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  for (const d of dims) for (const col of VOCABULARY_DIMENSIONS[d].liveChecks) {
    const [t, c] = col.split(".")
    const cached = CHECK_VOCABULARIES[t]?.[c]
    const keys = VOCABULARY_DIMENSIONS[d].platform.map((x) => x.key)
    if (cached) check(`${col} CHECK = ${d} platform list`, sameSet(cached, keys), `cache [${cached.join(",")}] vs code [${keys.join(",")}]`)
    else check(`${col} has no CHECK in the cache — allowed ONLY because m847 moved it onto the vocabulary trigger`, MOVED_BY_M847.has(col) && new RegExp(`DROP CONSTRAINT IF EXISTS brd_${c}_check`).test(m847Code))
  }
  check("POSITIVE CONTROL — the set comparison sees a drifted list", !sameSet(["standard"], CONTRACT_SUBTYPES) && !sameSet(null, CONTRACT_SUBTYPES))

  section("A3 a cache column whose vocabulary EQUALS a platform list is claimed (an unclaimed pinned copy would reject a brokerage term silently)")
  const claimed = new Set(dims.flatMap((d) => [...VOCABULARY_DIMENSIONS[d].liveChecks]))
  const unclaimedEqual = (cache: Record<string, Record<string, string[]>>) => {
    const out: string[] = []
    for (const [t, cols] of Object.entries(cache)) for (const [c, vals] of Object.entries(cols)) {
      for (const d of dims) {
        if (VOCABULARY_DIMENSIONS[d].platform.length < 3) continue
        if (sameSet(vals, VOCABULARY_DIMENSIONS[d].platform.map((x) => x.key)) && !claimed.has(`${t}.${c}`)) out.push(`${t}.${c}=${d}`)
      }
    }
    return out
  }
  const unclaimed = unclaimedEqual(CHECK_VOCABULARIES)
  check(`no unclaimed CHECK pins a platform vocabulary (found: ${unclaimed.join(", ") || "0"})`, unclaimed.length === 0)
  check("POSITIVE CONTROL — an unclaimed pinned copy is found", unclaimedEqual({ some_table: { subtype: [...CONTRACT_SUBTYPES] } }).length === 1)
  const sameNamed = Object.entries(CHECK_VOCABULARIES).flatMap(([t, cols]) => Object.keys(cols).filter((c) => ["property_type", "contract_subtype", "representation", "financing_type", "financing_kind", "listing_type", "agreement_type", "stage"].includes(c)).map((c) => `${t}.${c}`))
  console.log(`    published: same-named CHECK columns in the cache (${sameNamed.length}) — ${sameNamed.join(", ")}`)
  console.log("    (agreement_type on listing_agreements / buyer_broker_agreements is an AGREEMENT DOCUMENT kind, not the listing-type vocabulary; listing_type on market data is rent|sale — different questions, not copies)")

  section("A4 m847 — line-1 status, the admission arrays equal the code, the trigger, the reader, the citation CHECK, and ONLY the two moved CHECKs dropped")
  check(`the migration exists (${MIGRATION || "missing"})`, !!MIGRATION)
  check("line 1 states its status (the lane stamp until applied; APPLIED LIVE once the integrator applied it)", /^-- (WRITTEN, NOT APPLIED \(wave 144, lane 144A\)|── APPLIED LIVE )/.test(m847.split("\n")[0]))
  const arr = (dim: string) => { const m = new RegExp(`WHEN '${dim}'\\s+THEN ARRAY\\[([^\\]]*)\\]`).exec(m847Code); return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null }
  check("m847 contract_subtype admission array = CONTRACT_SUBTYPES", sameSet(arr("contract_subtype"), CONTRACT_SUBTYPES))
  check("m847 representation admission array = REPRESENTATIONS", sameSet(arr("representation"), REPRESENTATIONS))
  check("the trigger fires on INSERT and on UPDATE OF the two columns, and refuses with 23514", /BEFORE INSERT OR UPDATE OF contract_subtype, representation/.test(m847Code) && (m847Code.match(/ERRCODE = '23514'/g) ?? []).length === 2)
  check("the admission reads THIS brokerage's terms by `<dimension>:<key>` (the key the TS overlay stores)", /bs\.brokerage_id = p_brokerage_id/.test(m847Code) && /\(p_dimension \|\| ':' \|\| p_value\)/.test(m847Code) && /'adaptive_vocabulary'/.test(m847Code))
  check("the vocabulary reader refuses a non-member (42501) and returns ONLY the vocabulary key", /ERRCODE = '42501'/.test(m847Code) && /has_brokerage_access\(p_brokerage_id\)/.test(m847Code) && /RETURN \(SELECT bs\.settings -> 'adaptive_vocabulary'/.test(m847Code))
  check("a state requirement is CHECK-bound to a state, an official (.gov/.us) source and an approver", /brd_state_requirement_cited_check/.test(m847Code) && /state_code IS NOT NULL/.test(m847Code) && /\\\.\(gov\|us\)/.test(m847Code) && /approved_by IS NOT NULL/.test(m847Code))
  const drops = [...m847Code.matchAll(/DROP CONSTRAINT IF EXISTS (\w+)/g)].map((x) => x[1])
  check(`exactly the two moved CHECKs are dropped (${drops.join(", ")}), and no column / index is dropped`, sameSet(drops, ["brd_contract_subtype_check", "brd_representation_check"]) && !/DROP (COLUMN|INDEX)/.test(m847Code))
  control("the array reader sees a drifted SQL list", (s) => !sameSet((() => { const m = /WHEN 'contract_subtype'\s+THEN ARRAY\[([^\]]*)\]/.exec(s); return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null })(), CONTRACT_SUBTYPES), "WHEN 'contract_subtype' THEN ARRAY['standard','short_sale']")

  section("A5 disagreeing copies of a vocabulary, COUNTED (§6 — the finding is the number; fixes are other lanes' files)")
  const fieldFinancing = (OFFER_FIELD_DEFS.financingType?.enum_values ?? []) as readonly string[]
  check("the state form-field financing enum is the SAME six as FINANCING_TYPES (a roll-up value always fits the form)", sameSet(fieldFinancing, FINANCING_TYPES))
  // WAVE 145 (lane 145H): the second contract-type vocabulary this section used to PUBLISH (5 values, 4 not in
  // CONTRACT_SUBTYPES) is MERGED — re-asserted as the rule: the form-field enum and the voice intake ARE the one list.
  const fieldContract = (OFFER_FIELD_DEFS.contractType?.enum_values ?? []) as readonly string[]
  const disagreeing = (list: readonly string[]) => list.filter((v) => !(CONTRACT_SUBTYPES as readonly string[]).includes(v))
  check(`the state form-field contract-type enum IS CONTRACT_SUBTYPES (${fieldContract.length} values, ${disagreeing(fieldContract).length} outside it)`,
    sameSet(fieldContract, CONTRACT_SUBTYPES), disagreeing(fieldContract).join(", "))
  check("POSITIVE CONTROL — the disagreement finder sees the retired second list", disagreeing(["residential", "as_is", "new_construction", "land", "commercial"]).length === 4)
  const intakeSrc = code("lib/workflow/intake/voice-to-offer.ts")
  check("the voice intake types contractType as the ONE list and normalizes what it hears through it",
    /contractType:\s*IntakeField<ContractSubtype>/.test(intakeSrc) && /platformContractSubtype\(spoken\)/.test(intakeSrc)
    && !/"residential\|as_is/.test(codeWithStrings("lib/workflow/intake/voice-to-offer.ts")))
  check("a legacy spoken spelling resolves forever (residential → standard), and the three retired members resolve to nothing",
    resolveVocabularyValue("contract_subtype", "residential")?.key === "standard" && resolveVocabularyValue("contract_subtype", "Standard Residential")?.key === "standard"
    && ["as_is", "land", "commercial"].every((v) => resolveVocabularyValue("contract_subtype", v) === null))
  check("…and every canonical key still resolves to itself (the alias table shadows nothing)",
    CONTRACT_SUBTYPES.every((k) => resolveVocabularyValue("contract_subtype", k)?.key === k))
  const financingListRe = /["'](?:conventional|fha|va|usda)["'][^\n]{0,160}["'](?:conventional|fha|va|usda)["'][^\n]{0,160}["'](?:conventional|fha|va|usda)["']/
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
    }
    return out
  }
  const copies = [...walk("app"), ...walk("lib")].filter((f) => f !== "lib/compliance/checklist-dimensions.ts" && financingListRe.test(codeWithStrings(f)))
  console.log(`    published: ${copies.length} file(s) outside the survivor retype ≥3 financing-type literals on one line: ${copies.join(", ")}`)
  check("…none of them is a file of this lane (the pickers here read the vocabulary)", copies.every((f) => !LANE_FILES.includes(f)))
  control("the copy finder sees a retyped option list", (s) => financingListRe.test(s), `const opts = [{ value: "conventional" }, { value: "fha" }, { value: "va" }]`)

  // ═══ B. RESOLUTION ═══════════════════════════════════════════════════════════════════════════════════════
  section("B resolution — stable keys, separators, case, platform aliases, lineage; unknown is null")
  const r = (d: VocabularyDimension, v: string) => resolveVocabularyValue(d, v)
  check("'Short Sale' → short_sale (separator + case), lineage [short_sale]", r("contract_subtype", "Short Sale")?.key === "short_sale" && JSON.stringify(r("contract_subtype", "Short Sale")?.lineage) === '["short_sale"]')
  check("'under contract' → UNDER_CONTRACT (an upper-case stage key resolves case-insensitively)", r("transaction_stage", "under contract")?.key === "UNDER_CONTRACT")
  check("'All Cash' → cash via a platform alias; 'Multi-Family' → multi_family via canonicalPropertyType", r("financing_type", "All Cash")?.key === "cash" && r("financing_type", "All Cash")?.via === "platform_alias" && r("property_type", "Multi-Family")?.key === "multi_family")
  check("an unknown value is null — never a guess", r("contract_subtype", "wholesale assignment") === null && r("financing_type", "") === null)
  check("financingKindFor: 'all cash' is now CASH (the old rule read it as financed); platform types unchanged; an unknown label stays financed (never loosened); empty is unknown",
    financingKindFor("All Cash") === "cash" && financingKindFor("cash") === "cash" && ["conventional", "fha", "va", "usda", "other"].every((t) => financingKindFor(t) === "financed")
    && financingKindFor("bridge loan") === "financed" && financingKindFor("") === null && financingKindFor(null) === null)
  const oldKind = (t: string) => (t.trim().toLowerCase() === "cash" ? "cash" : "financed")
  check("POSITIVE CONTROL — the pre-144 kind rule misreads 'All Cash' as financed (the defect this fixes)", oldKind("All Cash") === "financed")
  check("PLATFORM_CHECKLIST_VOCABULARY knows only platform values (a brokerage term is uninterpretable without the overlay)", PLATFORM_CHECKLIST_VOCABULARY.lineage("representation", "intermediary") === null && PLATFORM_CHECKLIST_VOCABULARY.lineage("representation", "dual_agency")?.[0] === "dual_agency")
  check("rowApplicability: a stored value the vocabulary cannot read applies as a WARNING (it was a silent wildcard)", (() => { const a = rowApplicability({ representation: "intermediary" }, { representation: "single_agency" }); return a.applies && a.unresolved.includes("representation") })())

  // ═══ C. THE MANAGER'S EVALUATION + VALIDATION (pure) ═════════════════════════════════════════════════════
  section("C the manager's deterministic evaluation of a report, and dependency validation")
  const ev = (o: Record<string, unknown>) => evaluateVocabularyReport({ kind: "missing", ...o } as any, EMPTY_TENANT_VOCABULARY)
  check("'All cash' reported missing → already resolves (answered, nothing proposed)", ev({ dimension: "financing_type", label: "All cash" }).verdict === "already_resolves")
  const fhaBare = ev({ dimension: "financing_type", label: "FHA 203(k)" })
  check("'FHA 203(k)' with no relation → needs detail, FHA among the candidates", fhaBare.verdict === "needs_detail" && fhaBare.candidates.some((c) => c.key === "fha"), JSON.stringify(fhaBare))
  const fhaAdd = ev({ dimension: "financing_type", label: "FHA 203(k)", rollsUpTo: "fha" })
  check("'FHA 203(k)', a kind of FHA → propose ADD fha_203_k rolling up to fha, brokerage-wide", fhaAdd.verdict === "propose" && fhaAdd.change?.op === "add" && (fhaAdd.change as any).key === "fha_203_k" && (fhaAdd.change as any).rollsUpTo === "fha" && (fhaAdd.change as any).stateCodes === null)
  const interNoState = ev({ dimension: "representation", label: "Intermediary", rollsUpTo: "dual_agency" })
  check("a representation (varies by state) with no state → needs the state AND an official source", interNoState.verdict === "needs_detail" && interNoState.needs.includes("stateCode") && interNoState.needs.some((n) => n.startsWith("sourceUrl")))
  const TREC = "https://www.trec.texas.gov/forms/information-about-brokerage-services" // verified 2026-10-25: TREC's IABS page defines "intermediary"
  check("…a commentary source is not official", ev({ dimension: "representation", label: "Intermediary", rollsUpTo: "dual_agency", stateCode: "TX", sourceUrl: "https://www.example-realty-blog.com/intermediary" }).verdict === "needs_detail")
  const interTx = ev({ dimension: "representation", label: "Intermediary", rollsUpTo: "dual_agency", stateCode: "TX", sourceUrl: TREC, kind: "different_in_state" })
  check("…TX + the TREC (.gov) page → propose ADD intermediary, TX-scoped, cited", interTx.verdict === "propose" && (interTx.change as any)?.stateCodes?.[0] === "TX" && (interTx.change as any)?.source?.url === TREC)
  const probate = evaluateVocabularyReport({ dimension: "housing_topic", label: "probate", kind: "missing" }, EMPTY_TENANT_VOCABULARY)
  check("housing topic 'probate' → platform-owned, answered as a SERVICE TOPIC, not an exemption", probate.verdict === "platform_owned" && /service topic/i.test(probate.why) && /Not a fair-housing exemption/.test(probate.why))
  check("closing participants → platform-owned (cited state law, a platform change)", evaluateVocabularyReport({ dimension: "closing_participant", label: "escrow officer", kind: "missing" }, EMPTY_TENANT_VOCABULARY).verdict === "platform_owned")
  check("a transaction stage takes no new value (state machine) — an alias onto an existing stage is proposed instead",
    ev({ dimension: "transaction_stage", label: "Escrow", rollsUpTo: "UNDER_CONTRACT" }).verdict === "needs_detail" && ev({ dimension: "transaction_stage", label: "In escrow", sameAs: "UNDER_CONTRACT" }).change?.op === "alias")
  const v = (c: VocabularyChange) => validateVocabularyChange(c, EMPTY_TENANT_VOCABULARY)
  const base = { dimension: "financing_type" as const, label: "Bridge loan", reason: "t", stateCodes: null, source: null }
  check("validation refuses a term that rolls up to no platform key (every dependent reads the roll-up)", !v({ op: "add", ...base, key: "bridge_loan", rollsUpTo: "bridge" }).ok)
  check("…a key that IS a platform key", !v({ op: "add", ...base, key: "fha", rollsUpTo: "fha" }).ok)
  check("…a label that already reads as another term", !v({ op: "add", ...base, label: "Conventional loan", key: "conv2", rollsUpTo: "conventional" }).ok)
  check("…a state-scoped term without an official source", !v({ op: "add", ...base, key: "bridge_loan", rollsUpTo: "other", stateCodes: ["TX"] }).ok && v({ op: "add", ...base, key: "bridge_loan", rollsUpTo: "other", stateCodes: ["TX"], source: { url: "https://www.tdhca.texas.gov/", title: null } }).requiresCompliance)
  check("…re-pointing an alias that already resolves ('All Cash' → conventional)", !v({ op: "alias", dimension: "financing_type", alias: "All Cash", target: "conventional", reason: "t" }).ok)
  check("…retiring a stage (label/alias only) or anything platform-owned", !v({ op: "deactivate", dimension: "transaction_stage", key: "INSPECTION", reason: "t" }).ok && !v({ op: "add", dimension: "housing_topic", key: "x_y", label: "x", rollsUpTo: "senior", stateCodes: null, source: null, reason: "t" }).ok)
  check("…a valid brokerage-wide add passes, with the 'scope it to the state if law is the reason' warning", (() => { const x = v({ op: "add", ...base, key: "bridge_loan", rollsUpTo: "other" }); return x.ok && !x.requiresCompliance && x.warnings.length === 1 })())

  // ═══ D. END TO END, IN MEMORY, THROUGH THE REAL KERNEL ═══════════════════════════════════════════════════
  const B = "11111111-1111-4111-8111-11111111b144", B2 = "22222222-2222-4222-8222-22222222b144"
  const AGENT = "aaaaaaaa-0000-4000-8000-0000000000a1", LEAD = "aaaaaaaa-0000-4000-8000-0000000000a2", CO = "aaaaaaaa-0000-4000-8000-0000000000a3"
  const rule = (o: Record<string, unknown>) => ({ id: `rule-${Math.random().toString(36).slice(2, 8)}`, brokerage_id: B, scope_type: "brokerage", scope_id: B, deal_type: "buyer", is_required: true, block_on_missing: true, state_code: null, policy_version: 1, ...o })
  const mem = memSupabase({
    improvement_proposals: [], tenant_policy_versions: [], agent_action_ledger: [],
    brokerage_settings: [{ id: "bs-1", brokerage_id: B, settings: {}, updated_at: "2026-10-01T00:00:00.000Z" }, { id: "bs-2", brokerage_id: B2, settings: {}, updated_at: "2026-10-01T00:00:00.000Z" }],
    brokerage_required_documents: [
      rule({ classification: "pre_approval_letter", financing_kind: "financed" }),
      rule({ classification: "agency_disclosure", representation: "dual_agency" }),
      rule({ classification: "disclosure", representation: "intermediary", state_code: "TX" }),
    ],
  }, { stampCreatedAt: true, uuidIds: true })
  const settingsOf = (b: string) => ((mem.tables.brokerage_settings.find((x: any) => x.brokerage_id === b) as any)?.settings ?? {})
  const live = async (b = B) => { const x = await loadTenantVocabulary(mem as any, b); return x.ok ? x.vocabulary : EMPTY_TENANT_VOCABULARY }

  section("D1 a report becomes ONE proposal that writes NOTHING; a different report waits; a non-admin cannot approve")
  const rep1 = await reportVocabularyGap(mem as any, { brokerageId: B, reporterUserId: AGENT, report: { dimension: "financing_type", label: "FHA 203(k)", kind: "missing", rollsUpTo: "fha" } })
  check("the report → proposed, EVALUATED (a human decides), proposer human, subject adaptive_vocabulary; no setting and no version written",
    rep1.ok && rep1.outcome === "proposed" && rep1.status === "EVALUATED" && mem.tables.improvement_proposals.length === 1 && (mem.tables.improvement_proposals[0] as any).proposer === "human"
    && (mem.tables.improvement_proposals[0] as any).subject_key === ADAPTIVE_VOCABULARY_POLICY_KEY && settingsOf(B)[ADAPTIVE_VOCABULARY_POLICY_KEY] === undefined && mem.tables.tenant_policy_versions.length === 0, JSON.stringify(rep1))
  const rep1b = await reportVocabularyGap(mem as any, { brokerageId: B, reporterUserId: AGENT, report: { dimension: "financing_type", label: "Bridge loan", kind: "missing", rollsUpTo: "other" } })
  check("a DIFFERENT report while one is open is refused (it would otherwise ride the open row) — the same report rides it", !rep1b.ok && /another vocabulary change/.test(rep1b.error)
    && (await reportVocabularyGap(mem as any, { brokerageId: B, reporterUserId: AGENT, report: { dimension: "financing_type", label: "FHA 203(k)", kind: "missing", rollsUpTo: "fha" } }) as any).existing === true)
  const pid1 = rep1.ok && rep1.outcome === "proposed" ? rep1.proposalId : ""
  const notAdmin = await approveVocabularyProposal(mem as any, { brokerageId: B, proposalId: pid1, approver: { userId: AGENT, userType: "agent", isTenantAdmin: false } })
  check("an agent cannot approve; nothing written", !notAdmin.ok && settingsOf(B)[ADAPTIVE_VOCABULARY_POLICY_KEY] === undefined)
  const answered = await reportVocabularyGap(mem as any, { brokerageId: B, reporterUserId: AGENT, report: { dimension: "financing_type", label: "All Cash", kind: "missing" } })
  check("a label that already resolves is ANSWERED, not proposed", answered.ok && answered.outcome === "answered" && answered.evaluation.verdict === "already_resolves")

  section("D2 a tenant admin approves → promoted through the kernel (policy version + ledger) → verified")
  const ap1 = await approveVocabularyProposal(mem as any, { brokerageId: B, proposalId: pid1, approver: { userId: LEAD, userType: "team_lead", isTenantAdmin: true } })
  const ledgerPromote = mem.tables.agent_action_ledger.filter((x: any) => x.action === "learning.proposal.promote")
  check("PROMOTED: adaptive_vocabulary@N, one tenant_policy_versions row, one learning.proposal.promote ledger row, verified",
    ap1.ok && ap1.verified && /^adaptive_vocabulary@\d+$/.test(ap1.policyVersionRef ?? "") && mem.tables.tenant_policy_versions.length === 1 && ledgerPromote.length === 1
    && (mem.tables.improvement_proposals[0] as any).status === "PROMOTED", JSON.stringify(ap1))
  const v1 = await live()
  check("the brokerage term resolves: 'FHA 203(k)' → fha_203_k, rolls up to fha, usable, offered in the picker", resolveVocabularyValue("financing_type", "FHA 203(k)", v1)?.key === "fha_203_k" && resolveVocabularyValue("financing_type", "fha_203_k", v1)?.platformKey === "fha" && vocabularyOptions("financing_type", v1).some((o) => o.value === "fha_203_k"))

  section("D3 the new FINANCING type breaks nothing: pre-approval, offer strength, the government-loan addendum, the state form enum, reporting")
  const w = vocabularyWriteValue("financing_type", "FHA 203(k)", v1)
  check("a writer stores the ROLL-UP (fha) and keeps the brokerage term beside it (subtype fha_203_k)", w.value === "fha" && w.subtype === "fha_203_k")
  {
    // WAVE 145 (lane 145Z — m871, the typed column lane 145C decided): the ONE writer / reader of offers|transactions.financing_subtype.
    const fs145 = await import("../lib/offers/financing-subtype")
    const pair = fs145.financingWriteValues("FHA 203(k)", v1)
    const platform = fs145.financingWriteValues("conventional", v1)
    const unknown = fs145.financingWriteValues("seller-carried note", v1)
    check("m871 WRITE VALUES: a brokerage term → financing_type = its roll-up AND financing_subtype = the term; a platform type has no subtype; an unknown label is KEPT as written (never nulled) with no subtype",
      pair.financing_type === "fha" && pair.financing_subtype === "fha_203_k" && platform.financing_type === "conventional" && platform.financing_subtype === null
      && unknown.financing_type === "seller-carried note" && unknown.financing_subtype === null, JSON.stringify({ pair, platform, unknown }))
    const OF = "o-145z", OTHER_B = "b-other-145z"
    const db145: any = memSupabase({ offers: [{ id: OF, brokerage_id: B, financing_type: "fha" }] })
    const wrote = await fs145.persistFinancingSubtype(db145, { table: "offers", id: OF, brokerageId: B, subtype: "fha_203_k" })
    const foreign = await fs145.persistFinancingSubtype(db145, { table: "offers", id: OF, brokerageId: OTHER_B, subtype: "va" })
    const back = await fs145.readFinancingSubtype(db145, { table: "offers", id: OF, brokerageId: B })
    check("m871 ONE WRITER: tenant-pinned and row-counted (another tenant's write matches nothing and is an error, never 'saved'); the ONE reader returns the term beside the roll-up",
      wrote.ok && !foreign.ok && back.ok && back.subtype === "fha_203_k" && back.financingType === "fha", JSON.stringify({ wrote, foreign, back }))
    const missing: any = { from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: null, error: { code: "PGRST204", message: "column financing_subtype not found" } }) }) }) }) }) }
    const notApplied = await fs145.persistFinancingSubtype(missing, { table: "offers", id: OF, brokerageId: B, subtype: "fha_203_k" })
    check("m871 NOT APPLIED is said, never thrown: PGRST204 → { ok:false, notApplied:true } (the offer itself was written without the column)", !notApplied.ok && (notApplied as any).notApplied === true)
    const kindViaTerm = financingKindFor(back.ok ? back.subtype : null, financingTypeResolver(v1))
    check("the checklist resolver's read: the stored term resolves through the brokerage vocabulary to the SAME kind as its roll-up (financed)", kindViaTerm === "financed" && kindViaTerm === financingKindFor("fha"))
    // SOURCE CENSUS (comment-stripped, strings blanked): every financing writer goes through the one writer, every
    // checklist reader through the one reader, and no other file names the column as a write key.
    const code145 = (p: string) => blankStrings(stripComments(read(p)))
    const WRITERS = ["app/actions/buyer-offers.ts", "app/api/agent-assistant/tool-call/route.ts", "lib/offers/offer-extractor.ts", "lib/transactions/offer-bridge.ts"]
    const READERS = ["lib/compliance/required-documents.ts", "lib/transactions/closing-compliance.ts"]
    const writerMissing = WRITERS.filter((f) => !/\bpersistFinancingSubtype\s*\(/.test(code145(f)))
    const readerMissing = READERS.filter((f) => !/\breadFinancingSubtype\s*\(/.test(code145(f)))
    check("m871 WRITERS: createOffer, the assistant's offer tool, the offer extractor and the offer→transaction bridge each call persistFinancingSubtype", writerMissing.length === 0, writerMissing.join(", "))
    check("m871 READERS: the offer checklist (required-documents) and the closing checklist (closing-compliance) each call readFinancingSubtype", readerMissing.length === 0, readerMissing.join(", "))
    const rawKeyRe = /\bfinancing_subtype\s*:/
    const rawWriters: string[] = []
    const walk145 = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); if (e.isDirectory()) { if (e.name !== "node_modules") walk145(f) } else if (/\.(ts|tsx)$/.test(e.name) && f !== "lib/offers/financing-subtype.ts" && rawKeyRe.test(code145(f))) rawWriters.push(f) } }
    walk145("app"); walk145("lib")
    const ctl = blankStrings(stripComments('await svc.from("offers").update({ financing_subtype: "va" }) // financing_subtype: in a comment'))
    check("m871 ONE WRITER (census): no file but lib/offers/financing-subtype.ts writes `financing_subtype:` as a key — control: a raw key IS caught and a commented one is not",
      rawWriters.length === 0 && rawKeyRe.test(ctl) && !rawKeyRe.test(blankStrings(stripComments("// financing_subtype: only in a comment"))), rawWriters.join(", "))
  }
  check("financingKindFor(stored) = financed; and a raw brokerage key read through the vocabulary is financed too", financingKindFor(w.value) === "financed" && financingKindFor("fha_203_k", financingTypeResolver(v1)) === "financed")
  check("offer strength scores it exactly as FHA (the reporting / multi-offer reader keeps its bucket)", scoreBuyerStrength({ financingType: w.value, downPaymentPercent: 10, contingencies: [], emd: 5000, offerPrice: 400000 }) === scoreBuyerStrength({ financingType: "fha", downPaymentPercent: 10, contingencies: [], emd: 5000, offerPrice: 400000 }))
  check("the government-loan amendatory addendum set still matches it, and the state form-field enum admits it", GOVERNMENT_BACKED_FINANCING_TYPES.includes(w.value as any) && fieldFinancing.includes(w.value as string))
  const preApproval = await resolveRequiredDocuments(mem as any, { brokerageId: B, dealType: "buyer", financing: financingKindFor(w.value) } as any)
  check("the brokerage's pre-approval-letter rule (financed deals) applies, fully resolved", preApproval.ok && preApproval.docs.some((d) => d.classification === "pre_approval_letter" && d.block_on_missing && (d.unresolved ?? []).length === 0))
  const scoreOfRaw = scoreBuyerStrength({ financingType: "fha_203_k", downPaymentPercent: 10, contingencies: [], emd: 5000, offerPrice: 400000 })
  check("POSITIVE CONTROL — storing the RAW brokerage key would have broken the platform reader (offer strength loses the FHA points)", scoreOfRaw !== scoreBuyerStrength({ financingType: "fha", downPaymentPercent: 10, contingencies: [], emd: 5000, offerPrice: 400000 }))

  section("D4 a TEXAS representation term: compliance approval, official source, attestation; the resolver's parent and child rules")
  const rep2 = await reportVocabularyGap(mem as any, { brokerageId: B, reporterUserId: LEAD, report: { dimension: "representation", label: "Intermediary", kind: "different_in_state", rollsUpTo: "dual_agency", stateCode: "TX", sourceUrl: TREC, sourceTitle: "TREC — Information About Brokerage Services" } })
  const pid2 = rep2.ok && rep2.outcome === "proposed" ? rep2.proposalId : ""
  check("proposed, flagged as needing a compliance approver", rep2.ok && rep2.outcome === "proposed" && rep2.validation.requiresCompliance, JSON.stringify(rep2))
  const byLead = await approveVocabularyProposal(mem as any, { brokerageId: B, proposalId: pid2, approver: { userId: LEAD, userType: "team_lead", isTenantAdmin: true } })
  check("a team lead (tenant admin, not a compliance approver) is REFUSED; nothing written", !byLead.ok && /compliance approver/.test(byLead.error) && !resolveVocabularyValue("representation", "intermediary", await live()))
  check("the compliance-approver roster is DERIVED (tenant roster minus team_lead and admin) and holds compliance_officer + the broker seats",
    VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has("compliance_officer") && VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has("broker") && !VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has("team_lead") && !VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has("admin") && !VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has("agent"))
  const byCo = await approveVocabularyProposal(mem as any, { brokerageId: B, proposalId: pid2, approver: { userId: CO, userType: "compliance_officer", isTenantAdmin: true } })
  const v2 = await live()
  check("the compliance officer approves → promoted + ATTESTED (ledger compliance.vocabulary.attest, a second policy version) → verified usable in TX",
    byCo.ok && byCo.attested && byCo.verified && mem.tables.agent_action_ledger.some((x: any) => x.action === "compliance.vocabulary.attest") && mem.tables.tenant_policy_versions.length === 3
    && !!resolveVocabularyValue("representation", "intermediary", v2)?.usable, JSON.stringify(byCo))
  check("the picker offers it for TX and not for FL", vocabularyOptions("representation", v2, { stateCode: "TX" }).some((o) => o.value === "intermediary") && !vocabularyOptions("representation", v2, { stateCode: "FL" }).some((o) => o.value === "intermediary"))
  const docsFor = async (rep: string | null, state: string | null, client: any = mem) => resolveRequiredDocuments(client, { brokerageId: B, dealType: "buyer", stateCode: state, representation: rep } as any)
  const txInter = await docsFor("intermediary", "TX")
  const pick = (o: any, cls: string) => o.ok ? o.docs.find((d: any) => d.classification === cls) : undefined
  check("TX deal in INTERMEDIARY: the TX intermediary rule AND the dual-agency parent rule both apply, fully resolved (lineage)", !!pick(txInter, "disclosure") && (pick(txInter, "disclosure").unresolved ?? []).length === 0 && !!pick(txInter, "agency_disclosure") && (pick(txInter, "agency_disclosure").unresolved ?? []).length === 0, JSON.stringify(txInter))
  const txDual = await docsFor("dual_agency", "TX")
  check("a TX deal stated only as DUAL AGENCY: the parent rule applies; the intermediary rule applies as a WARNING (the deal may be either)", !!pick(txDual, "agency_disclosure")?.block_on_missing && pick(txDual, "disclosure")?.block_on_missing === false && (pick(txDual, "disclosure")?.unresolved ?? []).includes("representation"))
  const txSingle = await docsFor("single_agency", "TX")
  check("a single-agency TX deal: neither representation rule applies", !pick(txSingle, "disclosure") && !pick(txSingle, "agency_disclosure"))
  const refused = memSupabase({ brokerage_required_documents: mem.tables.brokerage_required_documents.map((x: any) => ({ ...x })), brokerage_settings: [] }, { refuse: { brokerage_settings: "permission denied for table brokerage_settings" } })
  const blind = await docsFor("intermediary", "TX", refused)
  check("FAIL CLOSED — an unreadable vocabulary leaves the brokerage-term rule APPLYING AS A WARNING (never dropped, never a silent pass)", blind.ok && pick(blind, "disclosure")?.block_on_missing === false && (pick(blind, "disclosure")?.unresolved ?? []).includes("representation"))
  const rpcRefusal = await loadTenantVocabulary({ rpc: async () => ({ data: null, error: { code: "42501", message: "not a member of this brokerage" } }), from: () => { throw new Error("must not fall back past a refusal") } } as any, B)
  const rpcMissing = await loadTenantVocabulary({ rpc: async () => ({ data: null, error: { code: "PGRST202", message: "no function" } }), from: (mem as any).from.bind(mem) } as any, B)
  check("the m847 reader: a refusal is ok:false (never an empty vocabulary); a missing function (pre-m847) falls back to the settings read", !rpcRefusal.ok && rpcMissing.ok && !!resolveVocabularyValue("representation", "intermediary", (rpcMissing as any).vocabulary))

  section("D5 retirement and aliases keep history working; a deactivated term is never deleted")
  const rep3 = await reportVocabularyGap(mem as any, { brokerageId: B, reporterUserId: AGENT, report: { dimension: "financing_type", label: "FHA 203(k)", kind: "obsolete" } })
  const ap3 = rep3.ok && rep3.outcome === "proposed" ? await approveVocabularyProposal(mem as any, { brokerageId: B, proposalId: rep3.proposalId, approver: { userId: LEAD, userType: "team_lead", isTenantAdmin: true } }) : null
  const v3 = await live()
  check("retired: still RESOLVES (fha_203_k → fha, for historical records) but is not offered for new work; the entry is kept", !!ap3?.ok && resolveVocabularyValue("financing_type", "fha_203_k", v3)?.platformKey === "fha" && resolveVocabularyValue("financing_type", "fha_203_k", v3)?.usable === false && !vocabularyOptions("financing_type", v3).some((o) => o.value === "fha_203_k") && !!v3.terms["financing_type:fha_203_k"], JSON.stringify(ap3))
  const rep4 = await reportVocabularyGap(mem as any, { brokerageId: B, reporterUserId: AGENT, report: { dimension: "representation", label: "Intermediary relationship", kind: "missing", sameAs: "intermediary" } })
  const ap4 = rep4.ok && rep4.outcome === "proposed" ? await approveVocabularyProposal(mem as any, { brokerageId: B, proposalId: rep4.proposalId, approver: { userId: CO, userType: "compliance_officer", isTenantAdmin: true } }) : null
  check("an alias onto the state term (compliance-approved, since its target is state-scoped) reads forever as the canonical key", !!ap4?.ok && resolveVocabularyValue("representation", "Intermediary relationship", await live())?.key === "intermediary", JSON.stringify({ rep4, ap4 }))

  section("D6 the reader sanitizes; tenant isolation")
  /** The loader's sanitizer over a raw stored value (resolveTenantVocabulary is module-private). */
  const fromRaw = async (raw: unknown) => { const x = await loadTenantVocabulary(memSupabase({ brokerage_settings: [{ id: "raw", brokerage_id: B, settings: { [ADAPTIVE_VOCABULARY_POLICY_KEY]: raw } }] }) as any, B); return x.ok ? x.vocabulary : EMPTY_TENANT_VOCABULARY }
  const dirty = await fromRaw({
    terms: {
      "financing_type:hard_money": { dimension: "financing_type", key: "hard_money", label: "Hard money", rolls_up_to: "nope" },
      "contract_subtype:short_sale": { dimension: "contract_subtype", key: "short_sale", label: "Short", rolls_up_to: "standard" },
      "representation:x_tx": { dimension: "representation", key: "x_tx", label: "X", rolls_up_to: "single_agency", state_codes: ["TX"], source: { url: "https://blog.example.com" } },
    },
    attestations: { "representation:x_tx": { user_id: CO, user_type: "compliance_officer", at: "2026-10-25", source_url: "https://blog.example.com" } },
  })
  check("a term rolling up to no platform key and a term shadowing a platform key are REJECTED and named; a non-official attestation is rejected (term stays pending)",
    dirty.rejected.length === 3 && !dirty.terms["financing_type:hard_money"] && !dirty.terms["contract_subtype:short_sale"] && resolveVocabularyValue("representation", "x_tx", dirty)?.pendingAttestation === true, JSON.stringify(dirty.rejected))
  check("brokerage B2 sees none of B's terms, and none of B's proposals", !resolveVocabularyValue("representation", "intermediary", await live(B2)) && (await listVocabularyProposals(mem as any, B2) as any).rows.length === 0 && (await listVocabularyProposals(mem as any, B) as any).rows.length === 4)
  const notCo = await attestVocabularyEntry(mem as any, { brokerageId: B, dimension: "representation", key: "intermediary", approver: { userId: LEAD, userType: "team_lead", isTenantAdmin: true } })
  check("only a compliance approver attests", !notCo.ok)
  const patch = vocabularyPatchFor({ op: "deactivate", dimension: "contract_subtype", key: "lease_option", reason: "t" }, EMPTY_TENANT_VOCABULARY, "2026-10-25T00:00:00.000Z")
  const patched = await fromRaw(patch)
  check("retiring a PLATFORM term is a per-brokerage deactivation entry (the platform value never changes) and verifies as retired",
    !!(patch as any).deactivations?.["contract_subtype:lease_option"] && verifyVocabularyChange({ op: "deactivate", dimension: "contract_subtype", key: "lease_option", reason: "t" }, patched).ok
    && resolveVocabularyValue("contract_subtype", "lease_option", patched)?.key === "lease_option")
  check("the checklist matcher reads the brokerage vocabulary (lineage of a term = [term, parent])", JSON.stringify(checklistVocabularyFor(v2).lineage("representation", "intermediary")) === '["intermediary","dual_agency"]')

  // ═══ E. STRIPPED-SOURCE CENSUS ═══════════════════════════════════════════════════════════════════════════
  section("E1 no model decides anything on the vocabulary path (AI explains; deterministic services decide)")
  const modelCall = (s: string) => /\b(generateText|generateObject|streamText|bookedGenerateObject|runBoundedModel|createOpenAI|anthropic\.messages)\s*\(/.test(s)
  const withModel = LANE_FILES.filter((f) => modelCall(code(f)))
  check(`no model call in the ${LANE_FILES.length} vocabulary-path files (found: ${withModel.join(", ") || "0"})`, withModel.length === 0)
  control("the model-call finder sees a call", modelCall, `const r = await generateObject({ model, schema })`)

  section("E2 the vocabulary is written ONLY through the proposal kernel or the attested merge — never a direct settings write")
  const directWrite = (s: string) => /from\(\s*["']brokerage_settings["']\s*\)\s*\.\s*(update|insert|upsert)/.test(s)
  const writers = LANE_FILES.filter((f) => directWrite(codeWithStrings(f)))
  const heal = code("lib/compliance/vocabulary-healing.ts")
  check(`no direct brokerage_settings write in the lane's files (found: ${writers.join(", ") || "0"})`, writers.length === 0)
  check("the attestation merge names its session actor (policy:) and runs inside withActionLedger", /mergeBrokerageSettings\(/.test(heal) && /policy:\s*\{\s*type:\s*"user"/.test(codeWithStrings("lib/compliance/vocabulary-healing.ts")) && /withActionLedger</.test(heal))
  control("the direct-write finder sees one", directWrite, `await svc.from("brokerage_settings").update({ settings })`)
  check("the key is a registered, versioned tenant policy key", TENANT_POLICY_SETTINGS_KEYS[ADAPTIVE_VOCABULARY_POLICY_KEY]?.store === "brokerage_settings.settings" && parsePolicyKey(ADAPTIVE_VOCABULARY_POLICY_KEY)?.kind === "settings")

  section("E3 the pickers read the ONE vocabulary — no hard-coded alternate labels for the extensible dimensions")
  const client = codeWithStrings("app/dashboard/settings/required-documents/required-docs-settings-client.tsx")
  const hardOption = (s: string) => /<option[^>]*value=["'](short_sale|new_construction|dual_agency|single_agency|designated_agency|reo_bank_owned)["']/.test(s)
  check("the rule form renders contract type and representation from the vocabulary options (platform list only as the unreadable fallback)", /subtypeOptions\.map\(/.test(client) && /representationOptions\.map\(/.test(client) && !hardOption(client))
  control("the hard-coded-option finder sees one", hardOption, `<option value="short_sale">Short sale</option>`)
  check("the rule write validates through the vocabulary and canonicalises an alias (vocabularyWriteValue)", /vocabularyWriteValue\(/.test(code("app/actions/compliance/manage-required-docs.ts")) && /isPrimarySourceUrl\(/.test(code("app/actions/compliance/manage-required-docs.ts")))
  check("every vocabulary door is session-gated (requireCallerTenant) and async", (() => { const a = code("app/actions/compliance/vocabulary.ts"); const exps = [...a.matchAll(/export\s+(async\s+)?function\s+(\w+)/g)]; return exps.length >= 5 && exps.every((m) => !!m[1]) && (a.match(/requireCallerTenant\(\)/g) ?? []).length === exps.length })())

  section("E4 ruling 17 — housing topics: 55+ is the ONLY (verified) exemption; probate / divorce / military are service topics")
  const topics = Object.entries(HOUSING_TOPIC_TREATMENT) as Array<[string, { treatment: string; fairHousingScanApplies: boolean; note: string }]>
  const badTopics = (t: Array<[string, { treatment: string; fairHousingScanApplies: boolean }]>) => t.filter(([k, x]) => !x.fairHousingScanApplies || (x.treatment === "exemption_if_verified") !== (k === "senior"))
  check("every topic is a canonical persona (CAMPAIGN_PERSONAS)", topics.every(([k]) => (CAMPAIGN_PERSONAS as readonly string[]).includes(k)))
  check("only `senior` is an exemption, and only if verified (it names the older-persons verifier); every topic stays under the fair-housing scan", badTopics(topics).length === 0 && /fair-housing-older-persons\.ts/.test(HOUSING_TOPIC_TREATMENT.senior.note) && existsSync("lib/compliance/fair-housing-older-persons.ts"))
  check("probate, divorce and military relocation are SERVICE TOPICS", (["probate", "divorce", "military"] as const).every((k) => HOUSING_TOPIC_TREATMENT[k].treatment === "service_topic"))
  check("POSITIVE CONTROL — a table that exempts probate is caught", badTopics([["probate", { treatment: "exemption_if_verified", fairHousingScanApplies: true }]]).length === 1)

  section("E5 state presets are common practice, not citations — they seed as brokerage policy; a state requirement is cited + approved")
  // Wave 145 (lane 145H): THE matcher now lives in the product (lib/compliance/required-doc-presets.ts
  // LEGAL_SOURCE_CLAIM / uncitedLegalClaims) — the settings page surfaces every such rule as a human compliance task and
  // the seed reports them. It also learned "Civil Code" / "ILCS" / "Public Act" (the 144A matcher was blind to CA / IL).
  const legalClaim = LEGAL_SOURCE_CLAIM
  const claims = getSupportedPresetStates().flatMap((s) => uncitedLegalClaims(getRequiredDocPresetsForState(s, "buyer").concat(getRequiredDocPresetsForState(s, "seller"))).map((p) => `${s}:${p.classification}`))
  console.log(`    published: ${new Set(claims).size} preset row(s) whose description asserts a legal source without a citation URL — seeded as brokerage policy (legal_basis NULL), each surfaced as a human compliance task: ${[...new Set(claims)].join(", ")}`)
  check("the uncited claims are SURFACED to a person: the settings page lists them and the seed reports them",
    /uncitedLegalClaims\(/.test(code("app/dashboard/settings/required-documents/page.tsx")) && /citation_tasks:\s+uncitedLegalClaims\(/.test(code("app/actions/compliance/seed-required-docs.ts")))
  check("a CITED state requirement is not a task; an uncited claim is (and a plain description is neither)",
    uncitedLegalClaims([{ description: "TX: TREC OP-H", legal_basis: "state_requirement", source_url: "https://www.trec.texas.gov/x" }]).length === 0
    && uncitedLegalClaims([{ description: "TX: TREC OP-H", legal_basis: null, source_url: null }]).length === 1
    && uncitedLegalClaims([{ description: "Buyer ID for the file", legal_basis: null, source_url: null }]).length === 0)
  const seed = code("app/actions/compliance/seed-required-docs.ts")
  check("the preset seed never writes legal_basis / a state requirement", !/legal_basis|state_requirement/.test(seed))
  check("the rule write records a state requirement only with a state, an official source and a compliance approver", (() => { const m = codeWithStrings("app/actions/compliance/manage-required-docs.ts"); return /legalBasis !== "state_requirement"/.test(m) && /isPrimarySourceUrl\(input\.sourceUrl/.test(m) && /VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES\.has\(actor\.userType\)/.test(m) && /if \(!input\.stateCode\)/.test(m) })())
  control("the legal-claim finder sees a statute marker", (s) => legalClaim.test(s), "WA: Real Estate Brokerage pamphlet — RCW 18.86")

  // ═══ F. THE MLS COMING-SOON POLICY (handed over by lane 144B) ═══════════════════════════════════════════
  section("F1 default CLOSED: no rule on file, an unreadable policy, or an unattested rule → unknown → NOT ready")
  check("the key is a registered, versioned tenant policy key", TENANT_POLICY_SETTINGS_KEYS[COMING_SOON_POLICY_KEY]?.store === "brokerage_settings.settings" && parsePolicyKey(COMING_SOON_POLICY_KEY)?.kind === "settings")
  const none = evaluateComingSoonReadiness(null, { stateCode: "FL" })
  const emptyRead = await loadComingSoonPolicy(memSupabase({ brokerage_settings: [{ id: "x", brokerage_id: B, settings: {} }] }) as any, B)
  const empty = emptyRead.ok ? evaluateComingSoonReadiness(emptyRead.policy, { stateCode: "FL" }) : null
  check("unreadable → not ready (unknown); nothing on file → not ready (unknown), the blocker says coming soon stays closed", !none.ready && none.status === "unknown" && !!empty && !empty.ready && empty.status === "unknown" && /stays closed/.test(empty.blockers[0] ?? ""))
  const permissive = (p: unknown) => ({ ready: !p || true })
  check("POSITIVE CONTROL — a permissive default (absent policy = allowed) is the defect this refuses", permissive(null).ready === true && none.ready === false)
  const refusedRead = await loadComingSoonPolicy(memSupabase({}, { refuse: { brokerage_settings: "permission denied" } }) as any, B)
  check("a refused read is ok:false (never an empty policy)", !refusedRead.ok)

  section("F2 nothing is invented — every value is the MLS's stated rule, cited")
  const FIXTURE_URL = "https://rules.example-coast-mls.test/rules-and-regulations#coming-soon" // a FIXTURE — not a real MLS's rule
  const goodCs = { mlsName: "Example Coast MLS", stateCodes: ["FL"], permitted: true, maxDays: 21, showingsPermitted: false, mlsSubmissionWithinBusinessDays: 1, sourceUrl: FIXTURE_URL, ruleRef: "Sec. 1.3 (fixture)" }
  const vr = (o: Record<string, unknown>) => validateComingSoonPolicyReport({ ...goodCs, ...o } as any, "2026-10-25T00:00:00.000Z")
  check("a fully stated, cited rule validates", vr({}).ok)
  check("unstated 'permitted' / 'showings' are refused (never assumed)", !vr({ permitted: null }).ok && !vr({ showingsPermitted: null }).ok)
  check("no source / an http source / no rule section / no MLS / no state are refused", !vr({ sourceUrl: null }).ok && !vr({ sourceUrl: "http://rules.example-coast-mls.test/x" }).ok && !vr({ ruleRef: null }).ok && !vr({ mlsName: "" }).ok && !vr({ stateCodes: [] }).ok)
  check("a fractional or negative day count is refused; blank = the rule states none", !vr({ maxDays: 2.5 }).ok && !vr({ maxDays: -1 }).ok && vr({ maxDays: null, mlsSubmissionWithinBusinessDays: "" }).ok)

  section("F3 end to end: proposal → a COMPLIANCE APPROVER approves → promoted + attested → the door reads it")
  const csMem = memSupabase({ improvement_proposals: [], tenant_policy_versions: [], agent_action_ledger: [], brokerage_settings: [{ id: "bs-cs", brokerage_id: B, settings: {}, updated_at: "2026-10-01T00:00:00.000Z" }] }, { stampCreatedAt: true, uuidIds: true })
  const csRep = await reportComingSoonPolicy(csMem as any, { brokerageId: B, reporterUserId: AGENT, report: goodCs })
  check("recorded as ONE policy proposal on coming_soon_policy, EVALUATED; nothing written", csRep.ok && csRep.status === "EVALUATED" && csMem.tables.improvement_proposals.length === 1 && (csMem.tables.improvement_proposals[0] as any).subject_key === COMING_SOON_POLICY_KEY && ((csMem.tables.brokerage_settings[0] as any).settings[COMING_SOON_POLICY_KEY] === undefined), JSON.stringify(csRep))
  const csId = csRep.ok ? csRep.proposalId : ""
  const csLead = await approveVocabularyProposal(csMem as any, { brokerageId: B, proposalId: csId, approver: { userId: LEAD, userType: "team_lead", isTenantAdmin: true } })
  check("a team lead cannot approve an MLS rule", !csLead.ok && /compliance approver/.test(csLead.error))
  const csCo = await approveVocabularyProposal(csMem as any, { brokerageId: B, proposalId: csId, approver: { userId: CO, userType: "compliance_officer", isTenantAdmin: true } })
  check("the compliance officer approves → PROMOTED, attested (ledger compliance.coming_soon_policy.attest), verified", csCo.ok && csCo.attested && csCo.verified && csMem.tables.agent_action_ledger.some((x: any) => x.action === "compliance.coming_soon_policy.attest") && csMem.tables.tenant_policy_versions.length === 2, JSON.stringify(csCo))
  const csPol = await loadComingSoonPolicy(csMem as any, B)
  const at = (o: Record<string, unknown>) => (csPol.ok ? evaluateComingSoonReadiness(csPol.policy, { stateCode: "FL", ...o }) : null)
  check("a FL listing 10 days in, no showings, submitted on time → ready, citing the rule", !!at({ daysInComingSoon: 10, showingsScheduled: 0, businessDaysSincePublicMarketing: 0 })?.ready && at({})?.source?.rule_ref === "Sec. 1.3 (fixture)")
  check("past max days / a showing / past the submission window → NOT ready, each blocker cites the MLS rule", (() => { const x = at({ daysInComingSoon: 30, showingsScheduled: 2, businessDaysSincePublicMarketing: 3 }); return !!x && !x.ready && x.blockers.length === 3 && x.blockers.every((b) => b.startsWith("Example Coast MLS Sec. 1.3")) })())
  check("a TX listing (no rule covers TX) stays closed", at({ stateCode: "TX" })?.status === "unknown" && at({ stateCode: "TX" })?.ready === false)
  const unattested = await loadComingSoonPolicy(memSupabase({ brokerage_settings: [{ id: "u", brokerage_id: B, settings: { [COMING_SOON_POLICY_KEY]: { mls: {
    example_coast_mls: { mls_slug: "example_coast_mls", mls_name: "Example Coast MLS", state_codes: ["FL"], permitted: true, max_days: 21, showings_permitted: true, mls_submission_within_business_days: 1, source: { url: FIXTURE_URL, rule_ref: "Sec. 1.3" } },
    second_mls: { mls_slug: "second_mls", mls_name: "Second MLS", state_codes: ["FL"], permitted: true, max_days: null, showings_permitted: true, mls_submission_within_business_days: null, source: { url: FIXTURE_URL, rule_ref: "Sec. 2" }, attestation: { user_id: CO, user_type: "compliance_officer", at: "2026-10-25" } },
  } } } }] }) as any, B)
  check("a rule written without a compliance attestation is NOT in force (unknown, closed)", unattested.ok && evaluateComingSoonReadiness(unattested.policy, { mlsSlug: "example_coast_mls" }).status === "unknown")

  // ═══ F4 (wave 144 integration — lane 144A Outside-lane 5): THE DOOR READS IT ═════════════════════════════════════
  section("F4 THE DOOR: COMING_SOON_ACTIVE declares coming_soon_policy; the readiness rail runs the attested rule, closed by default")
  const { getStageDefinition } = await import("../lib/listing-lifecycle/lifecycle-definitions")
  const { evaluateReadinessChecks } = await import("../lib/listing-lifecycle/readiness-checker")
  check("the stage table declares coming_soon_policy on COMING_SOON_ACTIVE (every door that validates the table runs it)", !!getStageDefinition("COMING_SOON_ACTIVE")?.readinessChecks.includes("coming_soon_policy" as never))
  const LST = "11111111-2222-4333-8444-555555555555"
  const door = (state: string, showings: Array<Record<string, unknown>> = []) => memSupabase({
    listings: [{ id: LST, brokerage_id: B, state, lifecycle_stage: "COMING_SOON_PREP", stage_entered_at: null }],
    showings: showings.map((s, i) => ({ id: `sh${i}`, listing_id: LST, ...s })),
  }) as any
  const runDoor = async (client: any, policyClient: any) => (await evaluateReadinessChecks(client, LST, ["coming_soon_policy"], { comingSoonPolicyClient: policyClient })).results[0]
  const flOk = await runDoor(door("FL"), csMem)
  check("an FL listing under the attested FL rule, no showings → the door PASSES (the positive control for every refusal below)", flOk?.passed === true, JSON.stringify(flOk))
  const txDoor = await runDoor(door("TX"), csMem)
  check("a TX listing (no rule covers TX) → REFUSED, and the reason says coming soon stays closed", !txDoor.passed && /stays closed/.test(txDoor.reason ?? ""), JSON.stringify(txDoor))
  const shownDoor = await runDoor(door("FL", [{ status: "scheduled", completed_at: null }]), csMem)
  check("the FL rule permits no showings while coming soon: a scheduled showing → REFUSED, citing the rule", !shownDoor.passed && /showings are not permitted/.test(shownDoor.reason ?? ""), JSON.stringify(shownDoor))
  const cancelledDoor = await runDoor(door("FL", [{ status: "cancelled", completed_at: null }]), csMem)
  check("…a CANCELLED showing is not a scheduled one (read through the ONE showing-status fold)", cancelledDoor.passed === true, JSON.stringify(cancelledDoor))
  const oddDoor = await runDoor(door("FL", [{ status: "some_new_status", completed_at: null }]), csMem)
  check("…an UNRECOGNISED showing status counts as a planned showing (closed), never as none", oddDoor.passed === false, JSON.stringify(oddDoor))
  const blindDoor = await runDoor(door("FL"), memSupabase({}, { refuse: { brokerage_settings: "permission denied" } }))
  check("an unreadable policy → REFUSED (fail closed), the read error named", !blindDoor.passed && /could not be read/.test(blindDoor.reason ?? ""), JSON.stringify(blindDoor))
  const unanchored = await runDoor(memSupabase({ listings: [{ id: LST, brokerage_id: null, state: "FL" }], showings: [] }) as any, csMem)
  check("a listing with no brokerage anchor → REFUSED", unanchored.passed === false)
  const bodyOf = (s: string, fn: string) => { const i = s.indexOf(`export async function ${fn}(`); if (i < 0) return ""; const j = s.indexOf("\nexport async function ", i + 10); return s.slice(i, j < 0 ? undefined : j) }
  const readsBeforeMoving = (s: string) => { const b = bodyOf(s, "activateComingSoon"); const r = b.indexOf("evaluateReadinessChecks("), t = b.indexOf("transitionLifecycle("); return r >= 0 && t >= 0 && r < t && /getStageDefinition\("COMING_SOON_ACTIVE"\)/.test(b) }
  check("activateComingSoon (the coming-soon command card + voice door) evaluates the stage's DECLARED readiness before it moves the stage", readsBeforeMoving(codeWithStrings("app/actions/seller-listing/execution-engine.ts")))
  control("the order finder refuses a door that transitions first", (s) => !readsBeforeMoving(s), 'export async function activateComingSoon() {\n  await transitionLifecycle({})\n  await evaluateReadinessChecks(s, id, getStageDefinition("COMING_SOON_ACTIVE")?.readinessChecks)\n}\nexport async function next() {}')

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ADAPTIVE_VOCABULARY_FAIL"); process.exit(1) }
  console.log(" ✅ ADAPTIVE_VOCABULARY_PASS — a missing or state-specific label travels report → evaluation → validated proposal → human (compliance) approval → versioned tenant policy → verified; every term rolls up, so nothing that reads the platform list breaks")
}

main().catch((e) => { console.error(e); console.log(" ❌ ADAPTIVE_VOCABULARY_FAIL — threw"); process.exit(1) })
