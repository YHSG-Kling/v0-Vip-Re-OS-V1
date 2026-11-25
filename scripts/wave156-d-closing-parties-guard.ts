#!/usr/bin/env tsx
/**
 * scripts/wave156-d-closing-parties-guard.ts — wave 156, lane 156D. CLOSING ATTORNEY / TITLE / ESCROW BY FACT, AND THE CLOSING'S
 * FINANCIAL AND COMPLIANCE TRUTH.
 *
 * Owner (2026-11-25): "in many states, it is a closing attorney not title." Who conducts the closing (a closing attorney, a title
 * company, an escrow company or another authorized entity) is decided by FACT — the state's SOURCED rule
 * (lib/state-forms/closing-participants.ts) and what the contract / the party says — never by a hardcoded 50-state answer, and no
 * attorney is ever read as representing every party. A lender, a title company and an attorney are VENDOR CATEGORIES (CLAUDE.md §4).
 *
 * §A  VOCABULARY — the six vocabularies of lib/transactions/closing-parties.ts equal the m1010 CHECKs (read from the migration,
 *     `--` comments removed), with a positive control (a planted extra value is caught by the same comparison).
 * §B  THE RULES, DRIVEN (pure): cash vs financed; Georgia / North Carolina (sourced attorney-closing states) vs a title-company
 *     settlement agent; New York (customary buyer and seller attorneys); an unsupported state asks rather than answers; multiple legal
 *     representatives with representation never inferred; a side-specific attorney refused for the other side; an unknown lender is
 *     never named; a changed closing credit → corrected Closing Disclosure, no automatic wait restart (the lender decides).
 * §C  THE DOORS, DRIVEN (app/actions/transactions.ts → lib/application/transactions.ts, the deal-desk writers) on the in-memory client
 *     with the SESSION seat: an off-platform closing attorney is recorded with NO vendor / user / seat created and a confirmation task
 *     for the deal's agent; an on-platform attorney vendor must be this tenant's, fit the role and be assigned to the deal; a vendor seat
 *     is refused by the desk and writes nothing; a settlement agent of the wrong kind is refused; a title-company settlement agent in
 *     Georgia opens a counsel-review task; a confirmation needs evidence and closes the task; another deal's document cannot be
 *     assigned; with m1010 not applied the card still reads (said) and a write refuses in words.
 * §D  THE SURVIVORS THE DIRECTIVE NAMES, DRIVEN: the effective CDA policy (a deal closed under no-CDA stays no-CDA after the opt-in, a
 *     new deal gets the CDA, a closed deal accepts no switch, no dummy CDA row is written); a valid no-CDA close; a missing executed
 *     packet holds the final compliance check; an altered final settlement figure is a blocker and holds CDA approval; the broker's
 *     CDA signature is taken only after the fresh final-compliance gate (source order, comment-stripped); one authorized document
 *     correction (an assigned attorney vendor) files a new version, an unassigned vendor is refused, and after the close the closed
 *     record is not moved (post-closing adjustment); a closed deal's commission terms are frozen and a posted commission is corrected
 *     only by a NEW row; an agent-reported Closing Disclosure receipt is never lender-confirmed.
 *
 * §E  ROUND 2 (integrator): (1) m1011 — counsel joins the deal ledger as 'attorney', one vocabulary; (2) the broker's CDA signature is DRIVEN
 *     through the real door with the final compliance check and the e-sign transport as counted seams; (3) a fully signed addendum after
 *     the deal exists governs and holds the close for re-review, an unsigned one never governs; (4) the insurance item reads the deal's
 *     insurance checkpoint; (5) C30 — the portal answer never invents a closing party, driven with a counted model stub.
 *
 * RED AT BASE: W156D_ROOT=/home/user/v0-Vip-Re-OS-V1 runs §A–§C against the pre-wave tree (no closing-parties module, no closing-team
 * doors, no m1010) — they fail; §D drives survivors that existed before and passes there too (they are regression proofs, said so).
 *
 * BLIND SPOTS (published). The in-memory client has no row security, CHECKs or foreign keys: the m1010 CHECKs are proven equal to the
 * code vocabularies (§A), not executed by Postgres. lib/teams/team-scope.ts is a counted fixture (its rule is test:team-scope's).
 * The state table's legal content is NOT re-verified here — §B proves the code reads it and routes a conflict to a human; the
 * sources were fetched 2026-11-25 (NC opinion, GA 277 Ga. 472 PDF) and gabar.org/handbook/?rule=part46 rendered no text ("not
 * verified"). §D's broker-sign ordering is a SOURCE rule (the door needs the session + e-sign seams). The card (closing-team-section.tsx)
 * is not rendered here. The TRID writer's summary sync may refuse on the fake; §D reads the receipt ROW it wrote, not the summary.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.W156D_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 360)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string, root = ROOT): string => { const p = join(root, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }

const PURE = "lib/transactions/closing-parties.ts"
const ACTIONS = "app/actions/transactions.ts"
const MIGRATION = "supabase/migrations/m1010-closing-parties-counsel-roles-and-settlement-agent.sql"

// ═══ fixture world ═════════════════════════════════════════════════════════════════════════════════════════════════════
const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000156`
const B1 = u("b", 1), B2 = u("b", 2)
const U_BROKER = u("a", 1), U_AGENT = u("a", 2), U_VENDOR = u("a", 3), U_TC = u("a", 4), U_X = u("a", 5)
const U_CONTACT = u("a", 6), U_LENDER = u("a", 7), U_OFFDEAL = u("a", 8), U_CO = u("a", 9), AG_B = u("e", 3)
const AG_A = u("e", 1), AG_X = u("e", 2)
const TX_GA = u("d", 1), TX_NY = u("d", 2), TX_CASH = u("d", 3), TX_CLOSED = u("d", 4), TX_X = u("d", 9), TX_NEW = u("d", 5)
const V_ATTY = u("f", 1), V_ATTY_FREE = u("f", 2), V_LENDER = u("f", 3), V_X = u("f", 4)
const E_GA = u("c", 1), DOC_X = u("c", 2), DOC_GA = u("c", 3)
const C1 = u("1", 1), CDA1 = u("2", 1), DOC_SIGNED = u("3", 1), DOC_UNSIGNED = u("3", 2)

function world(): MemClient {
  return memSupabase({
    brokerages: [{ id: B1, offers_cda: true, non_cda_payout_default: null, plan_tier: "brokerage" }, { id: B2 }],
    contacts: [{ id: C1, brokerage_id: B1, agent_id: AG_A, first_name: "Casey" }],
    users: [
      { id: U_BROKER, brokerage_id: B1, user_type: "broker" }, { id: U_AGENT, brokerage_id: B1, user_type: "agent" },
      { id: U_VENDOR, brokerage_id: B1, user_type: "vendor" }, { id: U_TC, brokerage_id: B1, user_type: "tc" }, { id: U_X, brokerage_id: B2, user_type: "broker" },
      { id: U_CONTACT, brokerage_id: B1, user_type: "contact" }, { id: U_LENDER, brokerage_id: B1, user_type: "vendor" }, { id: U_OFFDEAL, brokerage_id: B1, user_type: "agent" }, { id: U_CO, brokerage_id: B1, user_type: "compliance_officer" },
    ],
    agents: [{ id: AG_A, user_id: U_AGENT, brokerage_id: B1 }, { id: AG_X, user_id: U_X, brokerage_id: B2 }, { id: AG_B, user_id: U_OFFDEAL, brokerage_id: B1 }],
    transactions: [
      { id: TX_GA, brokerage_id: B1, agent_id: AG_A, contact_id: C1, deleted_at: null, status: "under_contract", stage: "CLOSING_PREP", property_state: "GA", financing_type: "conventional", deal_type: "buyer", created_at: "2026-09-01T00:00:00Z" },
      { id: TX_NY, brokerage_id: B1, agent_id: AG_A, status: "under_contract", property_state: "NY", financing_type: "conventional", deal_type: "seller", created_at: "2026-09-01T00:00:00Z" },
      { id: TX_CASH, brokerage_id: B1, agent_id: AG_A, status: "under_contract", property_state: "TX", financing_type: "cash", deal_type: "buyer", created_at: "2026-09-01T00:00:00Z" },
      { id: TX_CLOSED, brokerage_id: B1, agent_id: AG_A, status: "closed", stage: "CLOSED", property_state: "NC", financing_type: "conventional", deal_type: "buyer", created_at: "2026-06-01T00:00:00Z" },
      { id: TX_NEW, brokerage_id: B1, agent_id: AG_A, status: "under_contract", property_state: "NC", financing_type: "cash", deal_type: "buyer", created_at: "2026-11-20T00:00:00Z" },
      { id: TX_X, brokerage_id: B2, agent_id: AG_X, status: "under_contract", property_state: "GA", financing_type: "conventional", deal_type: "buyer" },
    ],
    vendors: [
      { id: V_ATTY, brokerage_id: B1, category: "attorney", name: "Peach Law LLC" }, { id: V_ATTY_FREE, brokerage_id: B1, category: "attorney", name: "Unassigned Law" },
      { id: V_LENDER, brokerage_id: B1, category: "lender", name: "First Mortgage" }, { id: V_X, brokerage_id: B2, category: "attorney", name: "Other Tenant Law" },
    ],
    vendor_assignments: [
      { id: u("9", 1), vendor_id: V_ATTY, transaction_id: TX_GA, brokerage_id: B1, assignment_type: "other", status: "confirmed" },
      { id: u("9", 2), vendor_id: V_LENDER, transaction_id: TX_GA, brokerage_id: B1, assignment_type: "lender", status: "confirmed" },
      { id: u("9", 3), vendor_id: V_ATTY, transaction_id: TX_CLOSED, brokerage_id: B1, assignment_type: "other", status: "confirmed" },
    ],
    user_role_assignments: [{ id: u("8", 1), user_id: U_VENDOR, vendor_id: V_ATTY }, { id: u("8", 2), user_id: U_LENDER, vendor_id: V_LENDER }],
    transaction_participants: [],
    transaction_title_escrow: [{ id: E_GA, transaction_id: TX_GA, brokerage_id: B1, title_company_name: "Peach Title" }],
    transaction_documents: [
      { id: DOC_GA, transaction_id: TX_GA, brokerage_id: B1, doc_type: "title_commitment", doc_label: "Title commitment", status: "uploaded", uploaded_by_type: "vendor", metadata: { vendor_id: V_ATTY } },
      { id: DOC_X, transaction_id: TX_X, brokerage_id: B2, doc_type: "title_commitment", doc_label: "Other", status: "uploaded" },
    ],
    transaction_tasks: [], transaction_timeline: [], agent_action_ledger: [], tenant_policy_versions: [],
    closing_disclosure_agreement: [{ id: CDA1, transaction_id: TX_GA, brokerage_id: B1, agent_id: AG_A, status: "approved", broker_approved_at: null, revision_number: 1, field_values: {}, generated_pdf_url: null }],
    documents: [
      { id: DOC_SIGNED, brokerage_id: B1, transaction_id: TX_GA, classification: "addendum", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] }, extracted_fields: {} },
      { id: DOC_UNSIGNED, brokerage_id: B1, transaction_id: TX_GA, classification: "addendum", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] }, extracted_fields: {} },
    ], notifications: [], commission_distributions: [], agent_commissions: [], commission_adjustments: [], trid_disclosure_receipts: [], contract_term_versions: [],
    offers: [], document_field_extractions: [], transaction_coordinators: [], transaction_milestones: [], contact_memory: [], tasks: [],
    closing_disclosure_agreement_revisions: [], transaction_vendor_services: [], brokerage_settings: [],
    trid_timeline: [], transaction_compliance_log: [], teams: [], lifecycle_events: [], policy_decisions: [], transaction_lenders: [],
  }, { uuidIds: true })
}

// ═══ seams (installed BEFORE any app module loads) ═════════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__W = {
  mem: world() as MemClient, seat: null as string | null, missingColumns: null as Record<string, string[]> | null,
  finalCheck: "fail" as "pass" | "fail", calls: { finalCheck: [] as Array<{ transactionId: string; signedAtCall: string | null }>, esign: 0, model: 0 },
  client: () => {
    const m = G.__W.mem
    return Object.assign(m, { auth: { getUser: async () => ({ data: { user: G.__W.seat ? { id: G.__W.seat, email: "seat@example.test", user_metadata: {} } : null }, error: null }) } })
  },
}
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const OVERRIDE: Record<string, string> = {
  // §E2 — the final compliance check the broker-sign door runs is a COUNTED seam (its own content is test:closing-compliance's); the seam
  // records whether the CDA was already broker-signed WHEN it ran, so the ORDER is driven, not read from source.
  "lib/transactions/final-compliance-check.ts": "export async function runFinalComplianceCheck(transactionId){ const W = globalThis.__W; const row = (W.mem.tables.closing_disclosure_agreement ?? []).find((r) => r.transaction_id === transactionId); W.calls.finalCheck.push({ transactionId, signedAtCall: row?.broker_approved_at ?? null }); return W.finalCheck === 'pass' ? { passed: true, blockers: [] } : { passed: false, blockers: ['fixture: 1 required document not yet provided'] } }",
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__W.client() }; export async function createServerClient(){ return globalThis.__W.client() }",
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__W.client() }",
}
const REPLACE: Record<string, string> = {
  "lib/teams/team-scope.ts": "export async function leadsAgentsTeam(){ return { ok: true, leads: false, ledTeamId: null } }",
  // §E2 — the e-sign transport is a counted stub: no provider is ever reached.
  "lib/transactions/cda-esign.ts": "export async function dispatchCdaSignerEsign(){ globalThis.__W.calls.esign++; return { mode: 'in_app', provider: null, reason: 'fixture', dispatched: false } }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }; export async function draftMode(){ return { isEnabled: false } }",
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) {
    const p = join(ROOT, c)
    if (existsSync(p) && !statSync(p).isDirectory()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const rep = Object.keys(REPLACE).find((k) => path === realUrl(k))
    if (rep) return { url: dataUrl(REPLACE[rep]), shortCircuit: true }
    const ov = Object.keys(OVERRIDE).find((k) => path === realUrl(k))
    if (ov) return { url: dataUrl(`export * from ${JSON.stringify(realUrl(ov))}; ${OVERRIDE[ov]}`), shortCircuit: true }
    return r
  },
})

const load = async (p: string): Promise<any> => { if (!existsSync(join(ROOT, p))) throw new Error(`${p} does not exist in ${ROOT}`); return import(pathToFileURL(join(ROOT, p)).href) }
function as(seat: string | null, opts: { missingColumns?: Record<string, string[]> } = {}): MemClient {
  const w = world()
  G.__W.mem = opts.missingColumns ? memSupabase(w.tables as any, { uuidIds: true, missingColumns: opts.missingColumns }) : w
  G.__W.seat = seat
  G.__W.finalCheck = "fail"; G.__W.calls = { finalCheck: [], esign: 0, model: 0 }
  return G.__W.mem
}
const quiet = async <X,>(fn: () => Promise<X>): Promise<X> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l }
}
async function drive<X>(fn: () => Promise<X>): Promise<{ r: any; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: (e as Error)?.message ?? String(e) } }
}
const T = (m: MemClient, t: string): Row[] => m.tables[t] ?? []
const writesTo = (m: MemClient, t: string) => m.writes.filter((w) => w.table === t).length

// ═══ §A ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
/** PURE — the ARRAY[...] values of one CHECK in the migration (SQL `--` comments removed first). */
function checkArray(sql: string, constraint: string, column: string): string[] | null {
  const noComments = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
  const at = noComments.indexOf(constraint)
  if (at < 0) return null
  const tail = noComments.slice(at)
  const m = new RegExp(`${column}\\s*=\\s*ANY\\s*\\(ARRAY\\[([^\\]]*)\\]`).exec(tail)
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null
}
const sameSet = (a: readonly string[] | null, b: readonly string[] | null) => !!a && !!b && a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

async function sectionA(cp: any) {
  section("§A · the closing vocabularies equal the m1010 CHECKs")
  const sql = raw(MIGRATION)
  check("the m1010 migration exists", !!sql)
  const pairs: Array<[string, string, string, string]> = [
    ["CLOSING_PARTY_ROLES", "transaction_participants_party_role_check", "party_role", ""],
    ["PARTY_REPRESENTS", "transaction_participants_represents_check", "represents", ""],
    ["CLOSING_FACT_SOURCES", "transaction_participants_fact_source_check", "fact_source", ""],
    ["SETTLEMENT_AGENT_KINDS", "transaction_title_escrow_settlement_agent_kind_check", "settlement_agent_kind", ""],
    ["SETTLEMENT_AGENT_BASES", "transaction_title_escrow_settlement_agent_basis_check", "settlement_agent_basis", ""],
    ["CLOSING_CHECK_STATUSES", "transaction_title_escrow_closing_check_statuses", "payoff_status", ""],
  ]
  for (const [name, con, col] of pairs) check(`${name} equals the ${con} CHECK`, sameSet(cp?.[name] ?? null, checkArray(sql, con, col)), { code: cp?.[name], sql: checkArray(sql, con, col) })
  // ROUND 3: m1012 splits m1010's three-column CHECK into one CHECK per column (the vocabulary cache reads single-column CHECKs only).
  const m1012 = raw("supabase/migrations/m1012-closing-check-statuses-one-check-per-column.sql")
  for (const col of ["payoff_status", "hoa_estoppel_status", "recording_status"]) {
    const con = `ADD CONSTRAINT transaction_title_escrow_${col}_check`
    check(`m1012: ${col} has its OWN CHECK with exactly CLOSING_CHECK_STATUSES`, sameSet(cp?.CLOSING_CHECK_STATUSES ?? null, checkArray(m1012, con, col)), checkArray(m1012, con, col))
  }
  check("m1012 drops the combined three-column CHECK (and nothing else)", /DROP CONSTRAINT IF EXISTS transaction_title_escrow_closing_check_statuses;/.test(m1012) && (m1012.match(/DROP CONSTRAINT/g) ?? []).length === 1)
  check("POSITIVE CONTROL: a planted extra value is caught by the same comparison", !sameSet([...(cp?.CLOSING_PARTY_ROLES ?? []), "everyone"], checkArray(sql, "transaction_participants_party_role_check", "party_role")))
  check("no representation value means 'all parties' (one attorney is never everyone's)", Array.isArray(cp?.PARTY_REPRESENTS) && !cp.PARTY_REPRESENTS.some((v: string) => /all|both|every/i.test(v)))
  const noTypeSql = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
  check("m1010 adds no user type, no table and no policy (a closing attorney is a vendor specialization)", !!sql && !/user_type|CREATE\s+TABLE|CREATE\s+POLICY|ALTER\s+POLICY|DROP\s+(TABLE|COLUMN|POLICY)/i.test(noTypeSql))
}

// ═══ §B ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const P = (id: string, x: Record<string, unknown>) => ({ id, name: String(x.name ?? id), ...x })
async function sectionB(cp: any) {
  section("§B · the rules, driven (lib/transactions/closing-parties.ts)")
  if (!cp?.assessClosingTeam) { check("assessClosingTeam is exported", false); return }
  const base = (o: Record<string, unknown>) => ({ stateCode: "GA", financingType: "conventional", dealType: "buyer", participants: [], settlement: null, ...o })

  // cash vs financed
  const fin = base({ participants: [P("l1", { party_role: "lender", name: "First Mortgage", vendor_id: V_LENDER })] })
  const cash = base({ financingType: "cash" })
  const cdFin = cp.closingDocumentOwner("final_closing_disclosure", fin)
  const cdCash = cp.closingDocumentOwner("final_closing_disclosure", cash)
  check("financed: the Closing Disclosure belongs to the recorded lender", cdFin.applies && cdFin.ownerRole === "lender" && cdFin.participantId === "l1", cdFin)
  check("cash: there is no lender Closing Disclosure — the settlement statement governs", cdCash.applies === false, cdCash)
  const insFin = cp.dealTeamChecklist(fin).find((c: any) => c.key === "insurance"), insCash = cp.dealTeamChecklist(cash).find((c: any) => c.key === "insurance")
  check("insurance applies to a financed deal and not (as a lender requirement) to a cash deal", insFin?.applies === "yes" && insCash?.applies === "no", { insFin, insCash })

  // Georgia / North Carolina — sourced attorney-closing states
  const gaTitle = cp.assessClosingTeam(base({ participants: [P("t1", { party_role: "title_company", name: "Peach Title" })], settlement: { kind: "title_company", participantId: "t1", basis: "contract_named" } }))
  const gaF = gaTitle.findings.find((f: any) => f.key === "state_requires_attorney_closing")
  check("C06 GA: a title-company settlement agent is routed to a human with the Georgia source (never silently accepted)", !!gaF && gaF.severity === "needs_human" && /gabar\.org/.test(gaF.source?.url ?? "") && gaTitle.requiresHuman, gaF)
  const gaAtty = cp.assessClosingTeam(base({ participants: [P("a1", { party_role: "settlement_attorney", name: "Peach Law", represents: "neutral_settlement_agent" })], settlement: { kind: "attorney", participantId: "a1", basis: "contract_named" } }))
  check("C06 GA: an attorney settlement agent raises no attorney-closing finding (and never requires a title-company seat)", !gaAtty.findings.some((f: any) => f.key === "state_requires_attorney_closing" || f.key.startsWith("state_gap")), gaAtty.findings)
  const ncTitle = cp.assessClosingTeam(base({ stateCode: "NC", participants: [P("t1", { party_role: "title_company" })], settlement: { kind: "title_company", participantId: "t1", basis: "party_confirmed" } }))
  check("C06 NC: the same rule reads North Carolina's source (ncbar.gov opinion 2002-1)", ncTitle.findings.some((f: any) => f.key === "state_requires_attorney_closing" && /ncbar\.gov/.test(f.source?.url ?? "")))
  // New York — customary buyer AND seller attorneys
  const nySideless = cp.assessClosingTeam(base({ stateCode: "NY", participants: [P("a1", { party_role: "settlement_attorney" })] }))
  check("C07 NY: one side-less attorney does not satisfy the customary buyer's AND seller's attorney (never assumed to represent both)",
    ["buyer_closing_attorney", "seller_closing_attorney"].every((r) => nySideless.findings.some((f: any) => f.key === `state_gap:${r}`)), nySideless.findings.map((f: any) => f.key))
  const nyBoth = cp.assessClosingTeam(base({ stateCode: "NY", participants: [P("b", { party_role: "buyer_attorney" }), P("s", { party_role: "seller_attorney" })] }))
  check("C07 NY: a buyer's attorney and a seller's attorney satisfy it (positive control)", !nyBoth.findings.some((f: any) => f.key.startsWith("state_gap")), nyBoth.findings.map((f: any) => f.key))
  const tx = cp.assessClosingTeam(base({ stateCode: "TX" }))
  check("an unsupported state ASKS (needs a human) and invents no requirement", tx.state.status === "unsupported" && tx.findings.some((f: any) => f.key === "state_unsupported") && !tx.findings.some((f: any) => f.key.startsWith("state_gap")))

  // multiple legal representatives
  const multi = cp.assessClosingTeam(base({ participants: [P("b", { party_role: "buyer_attorney" }), P("s", { party_role: "seller_attorney" }), P("l", { party_role: "lender", vendor_id: V_LENDER }), P("x", { party_role: "settlement_attorney" })] }))
  const rep = Object.fromEntries(multi.parties.map((p: any) => [p.id, p.represents]))
  check("multiple representatives: buyer's → buyer, seller's → seller, the settlement attorney → unknown (asked), never 'everyone'",
    rep.b === "buyer" && rep.s === "seller" && rep.x === "unknown" && multi.findings.some((f: any) => f.key === "representation_unknown:x"), rep)
  const wrongSide = cp.decideClosingPartyDraft({ partyRole: "buyer_attorney", represents: "seller", name: "Jane Counsel" })
  check("a buyer's attorney cannot be recorded as representing the seller", wrongSide.ok === false, wrongSide)
  const side = cp.decideClosingPartyDraft({ partyRole: "seller_attorney", represents: null, name: "Sam Counsel" })
  check("a side-specific role states its own side (positive control)", side.ok && side.represents === "seller", side)

  // an unknown lender fact is never fabricated
  const noLender = base({ participants: [] })
  const cd = cp.closingDocumentOwner("final_closing_disclosure", noLender)
  const a = cp.assessClosingTeam(noLender)
  check("C30: a financed deal with no recorded lender names NOBODY — the agent/coordinator obtains it from the verified party",
    cd.applies && cd.participantName === null && cd.route === "agent_or_coordinator_obtains" && a.findings.some((f: any) => f.key === "lender_not_recorded"), cd)
  check("the Closing Disclosure rule: AI may compare / propose / route, never issue or fabricate", cp.CLOSING_STATEMENT_AI_RULE?.mayIssue === false && cp.CLOSING_STATEMENT_AI_RULE?.mayFabricate === false && cp.CLOSING_STATEMENT_AI_RULE?.mayCompare === true)

  // changed closing credit
  const credit = cp.closingDisclosureConsequence({ changedTerms: ["closing_cost_contribution"], financing: "financed" })
  check("changed closing credit (financed): a corrected Closing Disclosure is required; the wait is NOT restarted automatically — the lender decides",
    credit.correctedCdRequired && credit.restartsWaitAutomatically === false && credit.waitRestartDecidedBy === "lender" && credit.reviewBy === "human", credit)
  const creditCash = cp.closingDisclosureConsequence({ changedTerms: ["closing_cost_contribution"], financing: "cash" })
  check("changed closing credit (cash): a revised settlement statement, no lender waiting period", creditCash.correctedStatementRequired && !creditCash.correctedCdRequired && creditCash.waitRestartDecidedBy === "not_applicable")
  const nonMoney = cp.closingDisclosureConsequence({ changedTerms: ["possession_terms"], financing: "financed" })
  check("a change with no settlement figure requires no corrected disclosure (positive control)", !nonMoney.correctedCdRequired)
  check("the wait-restarting changes are the receipt ledger's revision vocabulary (12 CFR 1026.19(f)(2)(ii))", sameSet(cp.WAIT_RESTARTING_CD_CHANGES, ["apr_changed", "loan_product_changed", "prepayment_penalty_added"]))
}

// ═══ §C ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionC(act: any) {
  section("§C · the closing-team doors, driven (session seat → deal desk → service writer)")
  if (!act?.recordClosingPartyAction) { check("recordClosingPartyAction is exported by app/actions/transactions.ts", false); return }

  // off-platform closing attorney (vendor not on the platform)
  let m = as(U_BROKER)
  const vendorsBefore = T(m, "vendors").length, usersBefore = T(m, "users").length, uraBefore = T(m, "user_role_assignments").length
  const off = await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "settlement_attorney", name: "Off Platform Law PC", email: "closings@example.test" }))
  const row = T(m, "transaction_participants").find((p) => p.name === "Off Platform Law PC")
  check("C07 off-platform attorney: recorded on the deal with the SESSION tenant, no vendor, agent-entered, representation unknown",
    off.r?.success === true && !!row && row.brokerage_id === B1 && row.transaction_id === TX_GA && row.vendor_id === null && row.fact_source === "agent_entered" && row.represents === null, { r: off.r, row })
  check("off-platform: NO vendor, user or seat is created (never a phantom vendor account)", T(m, "vendors").length === vendorsBefore && T(m, "users").length === usersBefore && T(m, "user_role_assignments").length === uraBefore)
  const task = T(m, "transaction_tasks").find((t) => t.category === "closing_party_confirmation")
  check("off-platform: a confirmation task goes to the deal's AGENT (users.id) naming what to confirm, including whom they represent",
    !!task && task.assigned_user_id === U_AGENT && task.responsible_participant_id === row?.id && /represent/.test(task.description) && /not on the platform/.test(task.description), task)
  check("the record leaves a receipt (action ledger)", T(m, "agent_action_ledger").some((r) => r.action === "transaction.closing_party.record"))

  // confirmation needs evidence, then closes the task
  const shortEv = await drive(() => act.confirmClosingPartyFactAction(row?.id ?? u("0", 1), { evidence: "ok" }))
  check("a confirmation without evidence is refused", shortEv.r?.success === false)
  const conf = await drive(() => act.confirmClosingPartyFactAction(row?.id ?? u("0", 1), { evidence: "Email from the firm 11/20 — engagement letter on file", represents: "neutral_settlement_agent" }))
  const row2 = T(m, "transaction_participants").find((p) => p.id === row?.id)
  check("a confirmation with evidence records who/when/how, the stated representation, and closes the task",
    conf.r?.success === true && row2?.fact_source === "party_confirmed" && row2?.fact_confirmed_by === U_BROKER && row2?.represents === "neutral_settlement_agent" && T(m, "transaction_tasks").find((t) => t.id === task?.id)?.status === "completed", { r: conf.r, row2 })

  // on-platform attorney vendor
  m = as(U_BROKER)
  const onp = await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "buyer_attorney", name: "Peach Law LLC", vendor_id: V_ATTY }))
  const prow = T(m, "transaction_participants").find((p) => p.vendor_id === V_ATTY)
  check("an assigned attorney vendor of this tenant is recorded as on-platform, its side stated by its role, no confirmation task",
    onp.r?.success === true && prow?.fact_source === "vendor_seat" && prow?.represents === "buyer" && !T(m, "transaction_tasks").some((t) => t.responsible_participant_id === prow?.id), { r: onp.r, prow })
  for (const [label, vendor, role] of [["an attorney vendor NOT assigned to the deal", V_ATTY_FREE, "seller_attorney"], ["another tenant's attorney vendor", V_X, "seller_attorney"], ["a lender vendor recorded as a buyer's attorney", V_LENDER, "buyer_attorney"]] as const) {
    m = as(U_BROKER)
    const r = await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: role, name: "Counsel", vendor_id: vendor }))
    check(`refused: ${label} — nothing written`, r.r?.success === false && writesTo(m, "transaction_participants") === 0, r.r)
  }

  // unauthorized vendor seat
  m = as(U_VENDOR)
  const vend = await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "settlement_attorney", name: "Self Appointed" }))
  check("a vendor seat (even one assigned to the deal) is refused by the deal desk and writes nothing", vend.r?.success === false && m.writes.length === 0, vend.r)
  const vendRead = await drive(() => act.getClosingTeamAction(TX_GA))
  check("a vendor seat cannot read the closing team either", vendRead.r?.success === false)
  m = as(U_X)
  const cross = await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "settlement_attorney", name: "Cross Tenant" }))
  check("another tenant's broker is refused and writes nothing", cross.r?.success === false && m.writes.length === 0)
  m = as(U_AGENT)
  const own = await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "seller_attorney", name: "Seller Side Counsel" }))
  check("the deal's own agent is admitted (positive control for the desk)", own.r?.success === true, own.r)

  // settlement agent
  m = as(U_TC)
  await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "title_company", name: "Peach Title" }))
  const titleRow = T(m, "transaction_participants").find((p) => p.party_role === "title_company")
  const mismatch = await drive(() => act.setSettlementAgentAction(TX_GA, { participantId: titleRow?.id ?? u("0", 2), kind: "attorney", basis: "contract_named" }))
  check("a title company cannot be recorded as an ATTORNEY settlement agent", mismatch.r?.success === false && !T(m, "transaction_title_escrow").find((e) => e.id === E_GA)?.settlement_agent_kind)
  const setTitle = await drive(() => act.setSettlementAgentAction(TX_GA, { participantId: titleRow?.id ?? u("0", 2), kind: "title_company", basis: "contract_named" }))
  const counsel = T(m, "transaction_tasks").find((t) => t.category === "closing_counsel_review")
  check("C06 GA: recording a title-company settlement agent is SAVED as the contract says, and opens a counsel-review task with the source (the OS does not decide the law)",
    setTitle.r?.success === true && T(m, "transaction_title_escrow").find((e) => e.id === E_GA)?.settlement_agent_kind === "title_company" && !!counsel && /gabar\.org/.test(counsel.description) && counsel.priority === "high", { r: setTitle.r, counsel })

  // the card
  const card = await drive(() => act.getClosingTeamAction(TX_GA))
  check("the Closing Team card reads the deal (assessment, checklist, document owners, vocabularies)", card.r?.success === true && Array.isArray(card.r.checklist) && card.r.checklist.length === 9 && Array.isArray(card.r.documents) && card.r.vocab?.partyRoles?.length > 0, card.r?.error)

  // a signed changed closing credit AFTER the Closing Disclosure, read through the card's door
  m = as(U_BROKER)
  m.tables.trid_disclosure_receipts.push({ id: u("5", 1), brokerage_id: B1, transaction_id: TX_GA, disclosure_version: 1, received_at: "2026-11-10T15:00:00Z", verification_status: "lender_confirmed" })
  m.tables.contract_term_versions.push({ id: u("5", 2), brokerage_id: B1, transaction_id: TX_GA, source: "addendum", status: "executed", executed_at: "2026-11-15T15:00:00Z", terms: { closing_cost_contribution: 7500 } })
  m.tables.contract_term_versions.push({ id: u("5", 3), brokerage_id: B1, transaction_id: TX_GA, source: "addendum", status: "executed", executed_at: "2026-11-01T15:00:00Z", terms: { inspection_period_days: 10 } })
  const chg = await drive(() => act.getClosingTeamAction(TX_GA))
  const cdc = chg.r?.cdAfterChange
  check("changed closing credit signed AFTER the CD: the card names it, requires a corrected CD, and leaves any new wait to the lender (an earlier change is not counted)",
    chg.r?.success === true && Array.isArray(cdc?.changedTerms) && cdc.changedTerms.join() === "closing_cost_contribution" && cdc.consequence?.correctedCdRequired === true && cdc.consequence?.restartsWaitAutomatically === false, cdc)
  m = as(U_BROKER)
  const none = await drive(() => act.getClosingTeamAction(TX_GA))
  check("no Closing Disclosure on file → no after-CD change is claimed (positive control)", none.r?.success === true && none.r.cdAfterChange === null, none.r?.cdAfterChange)

  // responsibility on another deal's document
  m = as(U_BROKER)
  await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "settlement_attorney", name: "Peach Law" }))
  const pid = T(m, "transaction_participants")[0]?.id
  const xdoc = await drive(() => act.assignClosingResponsibilityAction(TX_GA, { target: "document", id: DOC_X, participantId: pid }))
  check("another deal's document cannot be assigned an owner here", xdoc.r?.success === false && T(m, "transaction_documents").find((d) => d.id === DOC_X)?.responsible_participant_id === undefined)
  const okdoc = await drive(() => act.assignClosingResponsibilityAction(TX_GA, { target: "document", id: DOC_GA, participantId: pid }))
  check("the deal's own document takes its responsible party (positive control)", okdoc.r?.success === true && T(m, "transaction_documents").find((d) => d.id === DOC_GA)?.responsible_participant_id === pid, okdoc.r)

  // m1010 not applied yet
  m = as(U_BROKER, { missingColumns: { transaction_participants: ["party_role", "represents", "vendor_id", "fact_source", "fact_confirmed_at", "fact_confirmed_by", "fact_evidence"], transaction_title_escrow: ["settlement_agent_kind", "settlement_agent_participant_id", "settlement_agent_basis", "title_file_number", "payoff_status", "hoa_estoppel_status", "recording_status"], transaction_documents: ["responsible_participant_id"] } })
  const pend = await drive(() => act.getClosingTeamAction(TX_GA))
  check("m1010 not applied: the card still reads and SAYS the fields are pending", pend.r?.success === true && pend.r.schemaPending === true, pend.r?.error)
  const pendW = await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "settlement_attorney", name: "Pending Law" }))
  check("m1010 not applied: a write refuses in words and leaves no row", pendW.r?.success === false && /m1010/.test(pendW.r?.error ?? "") && T(m, "transaction_participants").length === 0, pendW.r)
}

// ═══ §D ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionD() {
  section("§D · the closing survivors the directive names, driven")
  const pol = await load("lib/transactions/cda-closing-policy.ts")
  // changed CDA policy: no-CDA → CDA on 2026-11-01
  const m = as(U_BROKER)
  m.tables.tenant_policy_versions.push({ id: u("7", 1), brokerage_id: B1, policy_key: "cda_policy", version: 1, value: { offers_cda: true, non_cda_payout_default: null, effective_at: "2026-11-01T00:00:00Z", scope: "brokerage" }, previous: { offers_cda: false, non_cda_payout_default: "direct_deposit", effective_at: null, scope: "brokerage" }, created_at: "2026-11-01T00:00:00Z" })
  const eff: any = await quiet(() => pol.loadEffectiveCdaModes(m, { brokerageId: B1, transactionIds: [TX_CLOSED, TX_NEW] }))
  check("C09 CDA opt-in is PROSPECTIVE: the deal closed under no-CDA stays no-CDA; a deal opened after the opt-in gets the CDA",
    eff.ok && eff.deals[TX_CLOSED]?.mode === "no_cda" && eff.deals[TX_NEW]?.mode === "cda" && eff.current.mode === "cda", eff.ok ? { closed: eff.deals[TX_CLOSED]?.mode, fresh: eff.deals[TX_NEW]?.mode } : eff)
  const sw = pol.decideDealCdaSwitch({ effective: { mode: "no_cda" }, target: "cda", dealStatus: "closed", cdaRow: null, reason: "opted in to CDA this month" })
  check("C09 a closed deal accepts no CDA switch (never retroactively blocked or given a CDA)", sw.ok === false && sw.error === "deal_completed", sw)
  check("C09 the policy reader wrote nothing — no dummy CDA row (only the fixture's own CDA exists)", m.writes.length === 0 && T(m, "closing_disclosure_agreement").filter((r) => r.transaction_id !== TX_GA).length === 0)
  check("a CDA never blocks a close in either mode", pol.resolveCdaMode({ offersCda: true }).blocksClosing === false && pol.resolveCdaMode({ offersCda: false }).blocksClosing === false)
  // valid no-CDA close
  const proof = pol.noCdaClosingProof({
    cdaMode: pol.resolveCdaMode({ offersCda: false }), transaction: { status: "closed", compliance_passed_at: "2026-11-10T00:00:00Z" },
    finalSettlement: { documentId: "doc-final", uploadedAt: "2026-11-10T00:00:00Z", uploadedBy: U_TC, uploadedByType: "staff" },
    commissions: [{ id: "c1", status: "paid", deposit_received_at: "2026-11-11T00:00:00Z", deposit_received_by: U_BROKER, paid_at: "2026-11-12T00:00:00Z" }],
    openBlockingCompliance: 0, lifetimeHoldOpen: false,
  })
  check("C09 a valid no-CDA close: final settlement, receipt and compliance are the proof — nothing missing, no CDA required", proof.mode === "no_cda" && proof.missing.length === 0 && proof.blocksClosing === false, proof.missing)
  const proofMissing = pol.noCdaClosingProof({ cdaMode: pol.resolveCdaMode({ offersCda: false }), transaction: { status: "closed" }, finalSettlement: null, commissions: [], openBlockingCompliance: 1, lifetimeHoldOpen: false })
  check("a no-CDA close with no final settlement / open compliance is NOT a complete proof (positive control)", proofMissing.missing.length > 0)

  // missing executed required packet
  const fc = await load("lib/transactions/final-compliance-check.ts")
  const held = fc.evaluateFinalCompliance({ pendingSignatures: 1, missingDocs: 1, rejectedDocs: 0, blockingComplianceFailures: 0 })
  check("missing executed required packet holds the final compliance check", held.passed === false && held.blockers.length === 2, held)
  check("a complete file passes (positive control)", fc.evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0 }).passed === true)
  // the broker's CDA signature comes AFTER the final compliance gate
  const cda = stripComments(raw("app/actions/cda-portal.ts"))
  const at = cda.search(/export\s+async\s+function\s+brokerSignCdaAction\s*\(/)
  const body = at < 0 ? "" : cda.slice(at, cda.indexOf("\nexport ", at + 10))
  const gateAt = body.search(/freshClosingFileGate\s*\(/), stampAt = body.search(/broker_approved_at:\s*now/)
  check("the broker's CDA signature is recorded only AFTER the fresh final-compliance gate (and its refusal returns)", gateAt > 0 && stampAt > gateAt && /if\s*\(\s*!signFileGate\.ok\s*\)\s*return/.test(body), { gateAt, stampAt })
  check("POSITIVE CONTROL: the order rule sees a body with the gate after the stamp as wrong", (() => { const b = "broker_approved_at: now\nfreshClosingFileGate("; return !(b.search(/freshClosingFileGate\s*\(/) < b.search(/broker_approved_at:\s*now/)) })())

  // altered final settlement
  const cmp = pol.comparePreliminaryStatementFigures({ sales_price: 400000, seller_credits: 15000 }, { sales_price: 400000, seller_credits: 5000 })
  check("an altered settlement figure (seller credit 15,000 vs the executed 5,000) is a BLOCKER", cmp.discrepancies.some((d: any) => d.field === "seller_credits" && d.severity === "blocker"), cmp)
  const gate = pol.cdaFigureGate({ status: "correction_requested" } as any)
  check("an open correction request on the statement holds CDA approval", gate.ok === false, gate)
  check("figures the statement does not state are 'unverifiable', never $0 (nothing fabricated)", cmp.unverifiable.includes("gross_commission"))

  // one authorized document correction / unauthorized vendor / frozen at close
  const dv = await load("lib/documents/vendor-document-correction.ts")
  const deps = { fileDocument: async () => ({ success: true, documentId: u("6", 1) }), recheck: async () => ({ ran: true, openBlocking: 0, reason: null }), notify: async () => 0 }
  const file = { storageUrl: "private/corrected.pdf", storagePath: "corrected.pdf", fileName: "corrected.pdf", sha256: "a".repeat(64) }
  let mm = as(U_VENDOR)
  const okc = await drive(() => dv.fileIssuerCorrection(mm, { brokerageId: B1, transactionId: TX_GA, original: { rail: "transaction_documents", id: DOC_GA }, actor: { via: "issuer", userId: U_VENDOR, identity: { kind: "vendor", vendorId: V_ATTY } }, file }, deps))
  check("C05/7 ONE authorized correction: the assigned closing-attorney vendor files a new version of ITS document; the original is superseded, not replaced",
    okc.r?.ok === true && okc.r.mode === "pre_close_version" && okc.r.superseded >= 1 && T(mm, "transaction_documents").some((d) => d.id === DOC_GA), okc.r)
  mm = as(U_VENDOR)
  const deny = await drive(() => dv.fileIssuerCorrection(mm, { brokerageId: B1, transactionId: TX_GA, original: { rail: "transaction_documents", id: DOC_GA }, actor: { via: "issuer", userId: U_VENDOR, identity: { kind: "vendor", vendorId: V_ATTY_FREE } }, file }, deps))
  check("unauthorized vendor (not assigned to the deal) is DENIED and nothing is filed", deny.r?.ok === false && writesTo(mm, "transaction_documents") === 0, deny.r)
  mm = as(U_VENDOR)
  mm.tables.transaction_documents.push({ id: u("c", 5), transaction_id: TX_CLOSED, brokerage_id: B1, doc_type: "title_commitment", doc_label: "Title", status: "approved", uploaded_by_type: "vendor", metadata: { vendor_id: V_ATTY } })
  const post = await drive(() => dv.fileIssuerCorrection(mm, { brokerageId: B1, transactionId: TX_CLOSED, original: { rail: "transaction_documents", id: u("c", 5) }, actor: { via: "issuer", userId: U_VENDOR, identity: { kind: "vendor", vendorId: V_ATTY } }, file }, deps))
  const orig = T(mm, "transaction_documents").find((d) => d.id === u("c", 5))
  check("transaction frozen at close: a correction after the close is a post-closing adjustment — the closed record's document is not superseded",
    post.r?.ok === true && post.r.mode === "post_close_adjustment" && post.r.superseded === 0 && !orig?.metadata?.superseded_by && T(mm, "transaction_tasks").some((t) => t.category === "closing_adjustment"), post.r)

  // commission frozen at close; post-close correction is a new row
  const ctc = await load("lib/commission/commission-term-change.ts")
  const actor = { userId: U_BROKER, agentId: null, brokerageId: B1, userType: "broker" }
  mm = as(U_BROKER)
  const frozen = await drive(() => ctc.requestCommissionTermChange(mm, actor, { transactionId: TX_CLOSED, valueType: "percent", value: 2.5, reason: "seller asked for a lower rate", effectiveDate: "2026-11-20", idempotencyKey: "w156d-frozen-1" }))
  check("changed commission on a CLOSED deal is refused (signed effective terms freeze at close)", frozen.r?.ok === false && /^frozen/.test(frozen.r?.error ?? ""), frozen.r)
  mm = as(U_BROKER)
  const open = await drive(() => ctc.requestCommissionTermChange(mm, actor, { transactionId: TX_GA, valueType: "percent", value: 2.5, reason: "seller asked for a lower rate", effectiveDate: "2026-11-20", idempotencyKey: "w156d-open-1" }))
  check("changed commission BEFORE close is not frozen (positive control — it proceeds to the governed approval path)", !/^frozen/.test(open.r?.error ?? ""), open.r)
  const corr = await load("lib/commission/distribution-correction.ts")
  const plan = corr.planDistributionCorrection({ original: { id: "d1", status: "paid", entry_type: "entry", calculated_amount: 6000 }, priorCorrections: [], kind: "adjustment", correctedAmount: 5500, reason: "post-closing credit agreed" })
  check("a post-closing commission adjustment is a NEW row against the posted original (never a rewrite)", plan.ok && plan.amount === -500 && plan.netAfter === 5500, plan)
  check("an unposted entry is not 'corrected' — it is still editable in its lifecycle (positive control)", corr.planDistributionCorrection({ original: { id: "d1", status: "pending", calculated_amount: 6000 }, priorCorrections: [], kind: "reversal", reason: "five chars" }).ok === false)

  // TRID: agent-reported receipt is never lender-confirmed
  const trid = await load("lib/compliance/trid-disclosure-clock-evidence.ts")
  mm = as(U_AGENT)
  const receipt = { brokerageId: B1, transactionId: TX_GA, version: 1, issuerName: "First Mortgage", senderRole: "creditor", deliveryMethod: "email", receivedAt: "2026-11-18T15:00:00Z", receiptTimezone: "America/New_York", receiptEvidence: "lender_statement", lenderContactName: "Loan officer (by phone)", today: "2026-11-20" }
  await drive(() => trid.recordTridReceiptEvidence(mm, { ...receipt, actor: { userId: U_AGENT, kind: "agent" } }))
  const rrow = T(mm, "trid_disclosure_receipts")[0]
  check("C08 an agent-reported Closing Disclosure receipt is recorded PENDING the lender's confirmation — never lender-confirmed", !!rrow && rrow.verification_status === "pending_lender_confirmation" && rrow.source === "agent_reported", rrow)
  mm = as(U_AGENT)
  const agentWait = await drive(() => trid.recordTridReceiptEvidence(mm, { ...receipt, newWaitDetermination: "no_new_wait", actor: { userId: U_AGENT, kind: "agent" } }))
  check("C08 an agent cannot record the lender's waiting-period determination", agentWait.r?.ok === false && T(mm, "trid_disclosure_receipts").length === 0, agentWait.r)
  mm = as(U_VENDOR)
  await drive(() => trid.recordTridReceiptEvidence(mm, { ...receipt, actor: { userId: U_VENDOR, kind: "lender", lenderVendorId: V_LENDER } }))
  const lrow = T(mm, "trid_disclosure_receipts")[0]
  check("C08 the ASSIGNED lender's receipt is lender-confirmed (positive control)", lrow?.verification_status === "lender_confirmed" && lrow?.source === "lender_portal", lrow)
}

// ═══ §E (round 2) ═════════════════════════════════════════════════════════════════════════════════════════════════════
const constList = (stripped: string, name: string): string[] | null => {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(stripped)
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null
}
async function sectionE(act: any, cp: any) {
  section("§E1 · one vocabulary: counsel joins the deal ledger as 'attorney' (m1011)")
  const sql = raw("supabase/migrations/m1011-vendor-assignment-type-admits-attorney.sql")
  const m1011 = checkArray(sql, "ADD CONSTRAINT vendor_assignments_assignment_type_check", "assignment_type")
  const cache = await load("scripts/check-vocabularies.ts").then((x) => x.CHECK_VOCABULARIES?.vendor_assignments?.assignment_type ?? null).catch(() => null)
  const added = m1011 && cache ? m1011.filter((v) => !cache.includes(v)) : null
  check("m1011 NARROWS NOTHING and adds at most 'attorney' to the live CHECK (the generated cache); the file admits 'attorney' — true before it is applied (one value added) and after (none added, the cache already holds it)", !!m1011 && !!cache && cache.every((v: string) => m1011.includes(v)) && m1011.includes("attorney") && (added ?? ["?"]).every((v) => v === "attorney"), { m1011, cache })
  check("'attorney' is the vendors.category spelling (one vocabulary)", (await load("lib/kernel/vendor-categories.ts")).VENDOR_CATEGORIES?.includes("attorney") === true && cp?.COUNSEL_ASSIGNMENT_TYPE === "attorney")
  const kernelList = constList(stripComments(raw("app/actions/vendors-kernel.ts")), "VENDOR_ASSIGNMENT_TYPES"), uiList = constList(stripComments(raw("app/dashboard/vendors/vendor-directory-client.tsx")), "VENDOR_ASSIGNMENT_TYPES")
  check("the assignment door and the picker both offer exactly the m1011 vocabulary", sameSet(kernelList, m1011) && sameSet(uiList, m1011), { kernelList, uiList })
  check("POSITIVE CONTROL: a list without 'attorney' is caught", !sameSet((kernelList ?? []).filter((v) => v !== "attorney"), m1011))
  let m = as(U_BROKER)
  const r = await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "settlement_attorney", name: "Peach Law LLC", vendor_id: V_ATTY }))
  check("an attorney vendor assigned as 'other' is re-typed 'attorney' on THIS deal's ledger row when recorded as counsel (counted)", r.r?.success === true && T(m, "vendor_assignments").find((x) => x.id === u("9", 1))?.assignment_type === "attorney" && T(m, "vendor_assignments").find((x) => x.id === u("9", 3))?.assignment_type === "other", r.r)
  m = as(U_BROKER)
  await drive(() => act.recordClosingPartyAction({ transaction_id: TX_GA, party_role: "lender", name: "First Mortgage", vendor_id: V_LENDER }))
  check("a lender recorded as a party keeps its 'lender' assignment (positive control)", T(m, "vendor_assignments").find((x) => x.id === u("9", 2))?.assignment_type === "lender")

  section("§E2 · the broker's CDA signature, DRIVEN: the fresh final compliance check runs BEFORE it is recorded")
  const cda = await quiet(() => load("app/actions/cda-portal.ts"))
  m = as(U_BROKER); G.__W.finalCheck = "fail"
  const failSign = await drive(() => cda.brokerSignCdaAction({ cdaId: CDA1 }))
  const rowF = T(m, "closing_disclosure_agreement").find((x) => x.id === CDA1)
  check("a FAILING final compliance check: the signature is refused, NOT recorded, and the e-sign transport is never reached",
    failSign.r?.success === false && /closing_file_not_ready/.test(failSign.r?.error ?? "") && !rowF?.broker_approved_at && G.__W.calls.esign === 0 && G.__W.calls.finalCheck.length === 1, { r: failSign.r, calls: G.__W.calls })
  m = as(U_BROKER); G.__W.finalCheck = "pass"
  const okSign = await drive(() => cda.brokerSignCdaAction({ cdaId: CDA1 }))
  const rowP = T(m, "closing_disclosure_agreement").find((x) => x.id === CDA1)
  const fc = G.__W.calls.finalCheck
  check("a PASSING check: exactly one signature is recorded, and the check ran while the CDA was still unsigned (check → then signature)",
    okSign.r?.success === true && !!rowP?.broker_approved_at && rowP?.broker_id === U_BROKER && fc.length === 1 && fc[0].signedAtCall === null && G.__W.calls.esign === 1, { r: okSign.r, fc })
  const again = await drive(() => cda.brokerSignCdaAction({ cdaId: CDA1 }))
  check("a repeated sign is idempotent — still one signature, no second check or transport", again.r?.success === true && G.__W.calls.esign === 1 && G.__W.calls.finalCheck.length === 1 && T(m, "closing_disclosure_agreement").find((x) => x.id === CDA1)?.broker_approved_at === rowP?.broker_approved_at)
  m = as(U_AGENT); G.__W.finalCheck = "pass"
  const agentSign = await drive(() => cda.brokerSignCdaAction({ cdaId: CDA1 }))
  check("an agent cannot sign as the broker (positive control for the role gate)", agentSign.r?.success === false && !T(m, "closing_disclosure_agreement").find((x) => x.id === CDA1)?.broker_approved_at)

  section("§E3 · a later signed document after the deal exists: a signed addendum governs and holds the close for re-review; an unsigned one never governs")
  const gt = await load("lib/offers/governing-terms.ts"), core = await load("lib/transactions/closing-compliance-core.ts"), ccomp = await quiet(() => load("lib/transactions/closing-compliance.ts"))
  m = as(U_BROKER)
  const recheck: any[] = []
  const deps = { runClosingCompliance: async (_svc: unknown, input: any) => { recheck.push(input); return { ran: true, openBlocking: 1, reason: null } } }
  const fake = await drive(() => gt.recordContractTermsVersion(m, { brokerageId: B1, transactionId: TX_GA, source: "addendum", status: "executed", terms: { offer_price: 410000 }, documentId: DOC_UNSIGNED, executedAt: "2026-11-20T15:00:00Z", recordedBy: U_BROKER }, { consequenceDeps: deps }))
  check("an addendum missing the seller's signature cannot be recorded as executed — nothing recorded, no consequence run", fake.r?.ok === false && /seller/.test(fake.r?.reason ?? "") && T(m, "contract_term_versions").length === 0 && recheck.length === 0, fake.r)
  const prop = await drive(() => gt.recordContractTermsVersion(m, { brokerageId: B1, transactionId: TX_GA, source: "addendum", status: "proposed", terms: { offer_price: 390000 }, documentId: DOC_UNSIGNED, recordedBy: U_BROKER }, { consequenceDeps: deps }))
  const gov1 = await drive(() => gt.governingContractTerms(m, B1, { transactionId: TX_GA }))
  check("C05 an UNSIGNED (proposed) addendum is recorded as pending and never changes what governs the close; no re-review is run",
    prop.r?.ok === true && gov1.r?.ok === true && gov1.r.governing.values.offer_price === undefined && gov1.r.governing.pending.length === 1 && recheck.length === 0, { prop: prop.r, values: gov1.r?.governing?.values })
  const signed = await drive(() => gt.recordContractTermsVersion(m, { brokerageId: B1, transactionId: TX_GA, source: "addendum", status: "executed", terms: { offer_price: 410000 }, documentId: DOC_SIGNED, executedAt: "2026-11-20T15:00:00Z", recordedBy: U_BROKER, evidence: { term_evidence_stated: { offer_price: { page: 1, field: "Purchase price", quote: "$410,000" } } } }, { consequenceDeps: deps }))
  const gov2 = await drive(() => gt.governingContractTerms(m, B1, { transactionId: TX_GA }))
  check("a FULLY SIGNED addendum changing the price after the deal exists governs, and re-runs closing compliance (trigger contract_addendum)",
    signed.r?.ok === true && gov2.r?.governing?.values?.offer_price === 410000 && recheck.length === 1 && recheck[0].trigger === "contract_addendum" && signed.r?.consequences?.complianceReReview?.ran === true, { signed: signed.r?.reason ?? signed.r?.consequences?.complianceReReview, values: gov2.r?.governing?.values })
  // the hold: an approval pinned to the file before the addendum no longer stands; only a closing reviewer re-approves
  const ATT = "closing_attestation"
  const rows = [{ check_type: ATT, check_label: "Closing question", status: "pass", is_blocking: true, failure_reason: null }]
  const base = { complianceRows: rows, settlement: { state: "ready", finalOnFile: true, fingerprint: "s1" }, trid: { tracked: false, deliveredDate: null }, cda: null, attestationStatus: "pass", attestationCheckType: ATT, flaggedDocuments: [] }
  const before = core.buildClosingReadiness({ ...base, dealFileDocumentIds: ["contract-1"] })
  const approved = { decision: "green" as const, fingerprint: before.fingerprint, notes: null, decidedBy: U_BROKER, decidedAt: "2026-11-19T12:00:00Z" }
  const after = core.buildClosingReadiness({ ...base, dealFileDocumentIds: ["contract-1", DOC_SIGNED] })
  const standBefore = core.closingReviewStanding({ required: true, latest: approved, currentFingerprint: before.fingerprint })
  const standAfter = core.closingReviewStanding({ required: true, latest: approved, currentFingerprint: after.fingerprint })
  check("the earlier final closing approval stood before the addendum, and is REOPENED by it — the close is held until re-review",
    standBefore.state === "approved" && standBefore.blocker === null && standAfter.state === "reopened" && !!standAfter.blocker, { standBefore, standAfter })
  check("only a person with closing authority may re-review (an agent / a vendor may not; compliance / the broker may)",
    ccomp.mayReviewClosing({ userType: "agent" }) === false && ccomp.mayReviewClosing({ userType: "vendor" }) === false && ccomp.mayReviewClosing({ userType: "compliance_officer" }) === true && ccomp.mayReviewClosing({ userType: "broker" }) === true)
  const re = core.decideClosingReview({ readiness: after, decision: "approve", notes: null, reviewer: { isReviewer: true } })
  const standRe = core.closingReviewStanding({ required: true, latest: { ...approved, fingerprint: after.fingerprint, decidedAt: "2026-11-21T12:00:00Z" }, currentFingerprint: after.fingerprint })
  check("a closing reviewer's re-approval on the CURRENT file releases the hold (positive control)", re.ok === true && standRe.state === "approved" && standRe.blocker === null)
  const refusedRe = core.decideClosingReview({ readiness: after, decision: "approve", notes: null, reviewer: { isReviewer: false } })
  check("a non-reviewer's approval is refused", refusedRe.ok === false)

  section("§E4 · the insurance item reads the deal's own insurance record — never a permanent 'unknown'")
  m = as(U_BROKER)
  const card = await drive(() => act.getClosingTeamAction(TX_GA))
  const ins = card.r?.checklist?.find((c: any) => c.key === "insurance")
  check("financed deal, no lender requirement / policy recorded: 'Not recorded yet' with the next action, applies, not done", !!ins && ins.applies === "yes" && ins.done === false && /^Not recorded yet/.test(ins.detail) && /Next:/.test(ins.detail), ins)
  m = as(U_BROKER)
  const cash = await drive(() => act.getClosingTeamAction(TX_CASH))
  const insCash = cash.r?.checklist?.find((c: any) => c.key === "insurance")
  check("cash deal: the checkpoint says not applicable and the item is done (positive control)", insCash?.applies === "no" && insCash?.done === true, insCash)
  if (cp?.insuranceItem) {
    const unread = cp.insuranceItem({ unreadable: "The deal's insurance record could not be read" }, "financed")
    check("an unreadable insurance record is said and never shown as done", unread.done === false && /could not be read/.test(unread.detail))
  } else check("insuranceItem is exported", false)

  section("§E5 · C30 — the portal never invents the closing attorney / lender / settlement agent")
  const qad = await load("lib/portal/question-answer-decision.ts")
  const fabricated = "Your closing attorney is John Fabricated of Fabricated & Co, 555-0100, closing 12/01."
  let modelCalls = 0
  const ask = async (question: string) => quiet(() => qad.decidePortalAnswer(G.__W.mem, { brokerageId: B1, contactId: C1, question, agentName: "Avery", generalAnswer: async () => { modelCalls++; return fabricated } }, { knowledge: async () => [] }))
  m = as(null)
  // nothing recorded: the deal's lender vendor assignment is removed for this part (an on-platform lender is the positive control below)
  m.tables.vendor_assignments = m.tables.vendor_assignments.filter((x) => x.vendor_id !== V_LENDER)
  for (const q of ["Who is my closing attorney?", "Who is our lender?", "Who is the settlement agent?"]) {
    modelCalls = 0
    const d: any = await ask(q).catch((e: Error) => ({ text: `threw ${e.message}`, plan: {}, modelCalls: -1 }))
    check(`"${q}" with nothing recorded: 'not recorded — your agent has been asked', a task planned, 0 model calls, no invented name`,
      modelCalls === 0 && d.modelCalls === 0 && /not recorded/i.test(d.text) && /asked Avery/.test(d.text) && !/Fabricated|555-0100/.test(d.text) && d.plan?.createTask === true, { text: d.text, plan: d.plan, modelCalls })
  }
  // THE DEFECT THIS CLOSES: a model draft that names a party carries no figure or date, so the claim screen keeps it. Asked of the
  // general branch (where "who is our lender?" went before), the invented name reached the client.
  modelCalls = 0
  const nameOnly: any = await quiet(() => qad.decidePortalAnswer(G.__W.mem, { brokerageId: B1, contactId: C1, question: "Who is our lender?", agentName: "Avery", generalAnswer: async () => { modelCalls++; return "Your lender is Fabricated Mortgage Company." } }, { knowledge: async () => [] }))
  check("a name-only model draft never reaches the client (the claim screen cannot catch a NAME, so the model is not asked at all)", modelCalls === 0 && !/Fabricated Mortgage/.test(nameOnly.text), { text: nameOnly.text, modelCalls })
  modelCalls = 0
  const dLender: any = await ask("Who is our lender?")
  check("an off-platform lender is a request to the assigned human to ask the party and record it", dLender.plan?.offPlatformRequest === "lender", dLender.plan)
  const ding: any = await quiet(() => qad.fileQuestionDing(G.__W.mem, { brokerageId: B1, contactId: C1, sessionId: null, agentId: AG_A, question: "Who is my closing attorney?", decision: dLender, surface: "portal_tutor" }))
  check("the ding files ONE task for the agent (the 'your agent has been asked' is true)", ding.filed === true && !!ding.taskId && T(G.__W.mem, "tasks").length === 1, ding)
  // agent-entered (unconfirmed) is listed, not stated; confirmed is stated from the record; an on-platform lender vendor is stated
  m = as(null)
  m.tables.transaction_participants.push({ id: u("4", 1), transaction_id: TX_GA, brokerage_id: B1, name: "Typed In Law", party_role: "settlement_attorney", fact_source: "agent_entered" })
  const dTyped: any = await ask("Who is my closing attorney?")
  check("an attorney only TYPED in by the agent is 'listed, not confirmed' — its name is not stated as fact", /not confirmed/.test(dTyped.text) && !/Typed In Law/.test(dTyped.text) && dTyped.answered === "unresolved", dTyped.text)
  m.tables.transaction_participants.push({ id: u("4", 2), transaction_id: TX_GA, brokerage_id: B1, name: "Peach Law LLC", party_role: "buyer_attorney", represents: "buyer", fact_source: "party_confirmed", fact_confirmed_at: "2026-11-20T10:00:00Z" })
  m.tables.vendor_assignments.push({ id: u("9", 9), vendor_id: V_LENDER, transaction_id: TX_GA, brokerage_id: B1, assignment_type: "lender", status: "confirmed" })
  modelCalls = 0
  const dOk: any = await ask("Who is my closing attorney?")
  const dLenderOk: any = await ask("Who is our lender?")
  check("a CONFIRMED attorney is stated from the record with whom they represent; a lender vendor on the deal is stated (positive control); still 0 model calls",
    dOk.answered === "sourced" && /Peach Law LLC, representing the buyer/.test(dOk.text) && dLenderOk.answered === "sourced" && /First Mortgage/.test(dLenderOk.text) && modelCalls === 0, { a: dOk.text, l: dLenderOk.text })
  check("the classifier routes these questions to the record, not to the legal-judgment or general branch", ["Who is my closing attorney?", "who's our loan officer", "Who is the title company?"].every((q) => ["closing_attorney", "lender_identity", "settlement_agent"].includes(qad.classifyPortalQuestion(q).fact ?? "")))
  check("a general question about attorneys is still education (positive control — the rule is narrow)", qad.classifyPortalQuestion("What does a closing attorney do?").fact === null)
}

// ═══ §F (round 2) — every CDA door asks the deal desk ═══════════════════════════════════════════════════════════════════
async function sectionF() {
  section("§F · app/actions/cda-portal.ts — all exported doors, driven: refused seats reach nothing; desk seats pass the gate")
  const src = stripComments(raw("app/actions/cda-portal.ts"))
  const doors = [...src.matchAll(/^export\s+async\s+function\s+(\w+)\s*\(/gm)].map((m) => m[1])
  check(`the doors are DERIVED from the comment-stripped source (${doors.length} exported actions)`, doors.length >= 20, doors)
  const cda = await quiet(() => load("app/actions/cda-portal.ts"))
  const input: any = { cdaId: CDA1, transactionId: TX_GA, reason: "Fixture reason that is long enough to pass", documentId: DOC_GA, fileName: "fixture.pdf", fileUrl: "private/fixture.pdf",
    note: "fixture note", recipient: "closer@example.test", method: "email", payoutMethod: "check", artifact: "final_cd", storageUrl: "private/fixture.pdf", signedBy: "Broker" }
  const call = (d: string) => (d === "getCdaForTransactionAction" ? cda[d](TX_GA) : cda[d](input))
  const REFUSED: Array<[string, string]> = [[U_CONTACT, "a contact seat"], [U_LENDER, "the lender vendor seat assigned to the deal"], [U_VENDOR, "the attorney vendor seat assigned to the deal"], [U_OFFDEAL, "an agent off the deal"], [U_X, "another tenant's broker"]]
  const realFetch = globalThis.fetch
  ;(globalThis as any).fetch = async () => { throw new Error("network blocked in the guard") }
  try {
    for (const d of doors) {
      if (typeof cda[d] !== "function") { check(`${d} is exported`, false); continue }
      const leaked: string[] = []
      for (const [seat, label] of REFUSED) {
        const m = as(seat)
        const x = await drive(() => call(d))
        const refused = x.r?.success === false || x.r === null || (!!x.threw && m.writes.length === 0)
        if (!refused || m.writes.length > 0 || G.__W.calls.esign > 0 || G.__W.calls.finalCheck.length > 0) leaked.push(`${label}: ${m.writes.length} write(s), answered ${JSON.stringify(x.r ?? x.threw)?.slice(0, 120)}`)
      }
      check(`NEG ${d}: a contact, the lender and the attorney vendor seats, an agent off the deal and another tenant's broker are refused and write nothing`, leaked.length === 0, leaked)
      const passed: string[] = []
      for (const [seat, label] of [[U_AGENT, "the deal's agent"], [U_CO, "compliance"]] as Array<[string, string]>) {
        as(seat); G.__W.finalCheck = "fail"
        const x = await drive(() => call(d))
        if (String(x.r?.error ?? "").startsWith("not_on_deal_desk")) passed.push(`${label} was refused by the gate`)
      }
      check(`${d}: the deal's agent and compliance pass the desk gate (positive control)`, passed.length === 0, passed)
    }
  } finally { (globalThis as any).fetch = realFetch }
}

// ═══ §G (round 2) — the deal page shows the server's refusal ══════════════════════════════════════════════════════════════
function sectionG() {
  section("§G · the deal page shows a refusal as a refusal (source rule — the page is not rendered here)")
  const c = stripComments(raw("app/dashboard/transactions/[id]/transaction-detail-client.tsx"))
  const after = (token: string, span = 600) => { const i = c.indexOf(token); return i < 0 ? "" : c.slice(i, i + span) }
  const surfaced = (win: string) => { const e = win.indexOf("toast.error("); return e >= 0 && /\.error\b/.test(win.slice(e + 12, e + 260)) }
  const refusedBeforeRefresh = (win: string) => { const e = win.search(/toast\.error\(/), r = win.search(/router\.refresh\(\)/); return e >= 0 && (r < 0 || e < r) && /return\s*\}/.test(win.slice(e, r < 0 ? undefined : r)) }
  check("adding a deadline shows the server's refusal text (no generic 'Failed to add deadline')", surfaced(after("await addDeadline(", 1400)) && !/Failed to add deadline/.test(c))
  check("adding a participant shows the server's refusal text (no generic 'Failed to add participant')", surfaced(after("await addParticipant(", 1400)) && !/Failed to add participant/.test(c))
  check("completing a deadline: a refusal is a visible error and returns BEFORE the refresh (never looks like success)", surfaced(after("await completeDeadline(", 400)) && refusedBeforeRefresh(after("await completeDeadline(", 400)))
  check("responding to a repair request: a refusal is a visible error and returns BEFORE the refresh", surfaced(after("await respondToRepairRequest(", 400)) && refusedBeforeRefresh(after("await respondToRepairRequest(", 400)))
  check("POSITIVE CONTROL: the rule sees a silent refresh as wrong", !refusedBeforeRefresh("await completeDeadline(d.id)\n router.refresh()"))
}

// ═══ run ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`wave156-d-closing-parties-guard — ROOT=${ROOT}`)
  let cp: any = null, act: any = null
  try { cp = await load(PURE) } catch (e) { check(`${PURE} loads`, false, (e as Error).message.slice(0, 200)) }
  try { act = await quiet(() => load(ACTIONS)) } catch (e) { check(`${ACTIONS} loads in the harness`, false, (e as Error).message.slice(0, 300)) }
  await sectionA(cp)
  await sectionB(cp)
  await sectionC(act)
  await sectionD()
  await sectionE(act, cp)
  await sectionF()
  sectionG()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log(`FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
