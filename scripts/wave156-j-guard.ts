#!/usr/bin/env tsx
/**
 * scripts/wave156-j-guard.ts — test:wave156-j-fraud-network (wave 156, lane 156J)
 *
 * THE FRAUD & TRUST NETWORK SHARES TACTICS, NEVER ACCUSATIONS. Drives the real exported doors of
 * app/actions/fraud-network.ts (and, through them, lib/fraud-network/network.ts) and the wire-fraud runner against the
 * in-memory client (scripts/in-memory-supabase.ts), with the session, the service client and every model seam replaced
 * by COUNTED stubs. No provider, model or network is reached.
 *
 *  §A  VOCABULARY & SCHEMA — 14 typologies each with a checklist and a protective action; m1035's CHECK lists, the
 *      bulletin read policy's seat list and the code sets are the SAME sets (derived from comment-stripped source); the
 *      bulletin table carries no tenant column; every m1035 table has row security; one session policy, SELECT only.
 *  §B  PRIVATE CASE (C20) — an agent reports a spoofed escrow-domain incident on a deal they work: only the reporter,
 *      the tenant's case reviewer and platform safety staff read it; a co-worker, another tenant, a vendor seat and
 *      marketing staff read nothing; the evidence view fails closed with the honest state; a deal the seat may not work,
 *      a full account number and the eleventh report of a day are refused with nothing written; a receipt is left.
 *  §C  HUMAN-ONLY PUBLICATION — a moderator drafts (deterministic redaction) and publishes a tactic warning; another
 *      tenant reads it with no reporter identity, case, evidence or tenant id in the payload; an unverified report can
 *      never be published naming anyone (negative); a named official warning without an authoritative citation is
 *      refused; a tenant seat and marketing staff cannot publish; zero model calls on every path.
 *  §D  CORROBORATION — duplicate reports from one tenant do not raise corroboration; a forwarded fingerprint does not;
 *      a second tenant with its own evidence does.
 *  §E  CORRECTION & TAKEDOWN — a wrongly named subject's request is recorded, a correction keeps the previous version,
 *      a takedown removes access for every tenant and withdraws the derived topic-pool row.
 *  §F  NO AUTOMATIC BAN OR DENIAL — no write to transactions / vendors / vendor_assignments / contacts / users exists
 *      in the network code (stripped source, with a planted positive control), no model import, no person search; and
 *      the driven flow leaves those tables byte-identical.
 *  §G  ACTIONABLE SAFETY (C21) — a changed wire whose sender matches a published bulletin creates ONE high-priority
 *      independent-verification task through the real runner; a replay creates no second task; no published match → no
 *      task; the deal is unchanged.
 *  §H  MEASURED METRICS, RETENTION, REACH — reads and acted-on tasks are counted, "losses prevented" is null with its
 *      reason; expired cases are purged and counted; the network is reachable from the existing navigation.
 *
 * RED AT BASE: WAVE156_J_ROOT=<the tree before this lane> — the network modules do not exist there, so every driven
 * check is red; the source checks over the wire runner stay green where they hold there too.
 *
 * BLIND SPOTS (published). The in-memory client has no row security, CHECKs, foreign keys or cascades — the policy and
 * CHECK text of m1035 is asserted from source, not executed; cascade deletion on tenant departure is not driven. The
 * person-name screen is pattern-based (a name in free text is caught only by the moderator attestation, which is driven
 * as REQUIRED, not as effective). The page / client component is not rendered. A model reached through a computed import
 * path is not seen by the import scan (the counted stub covers lib/ai/models.ts and lib/ai/generate.ts).
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const ROOT = process.env.WAVE156_J_ROOT || process.cwd()
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string): string => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }
const NET = "lib/fraud-network/network.ts", ACTIONS = "app/actions/fraud-network.ts", RUNNER = "lib/wire-fraud/wire-fraud-runner.ts"
const MIG = "supabase/migrations/m1035-fraud-intelligence-network.sql"

// ═══ fixture world ═══════════════════════════════════════════════════════════════════════════════════════════════════
const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000156`
const B0 = u("b", 0), B1 = u("b", 1), B2 = u("b", 2)
const U_AGENT = u("a", 1), U_AGENT2 = u("a", 2), U_CO = u("a", 3), U_VENDOR = u("a", 4), U_X = u("a", 5), U_XAGENT = u("a", 6), U_STAFF = u("a", 7), U_MKT = u("a", 8), U_SOLO = u("a", 9)
const AG_A = u("e", 1), AG_B = u("e", 2), AG_X = u("e", 6), AG_SOLO = u("e", 9)
const TX1 = u("d", 1), TX_OTHER = u("d", 2), C1 = u("c", 1), B3 = u("b", 3)
const FP = (n: number) => n.toString(16).padStart(2, "0").repeat(32)

function world(): MemClient {
  return memSupabase({
    brokerages: [{ id: B0, name: "Platform" }, { id: B1, name: "First Realty" }, { id: B2, name: "Second Homes" }, { id: B3, name: "Solo Agent Co" }],
    users: [
      { id: U_AGENT, brokerage_id: B1, user_type: "agent", email: "agent@first.test" }, { id: U_AGENT2, brokerage_id: B1, user_type: "agent" },
      { id: U_CO, brokerage_id: B1, user_type: "compliance_officer" }, { id: U_VENDOR, brokerage_id: B1, user_type: "vendor" },
      { id: U_X, brokerage_id: B2, user_type: "broker" }, { id: U_XAGENT, brokerage_id: B2, user_type: "agent" },
      { id: U_STAFF, brokerage_id: B0, user_type: "admin", platform_role: "support" }, { id: U_MKT, brokerage_id: B0, user_type: "admin", platform_role: "marketing" },
      { id: U_SOLO, brokerage_id: B3, user_type: "agent" },
    ],
    agents: [{ id: AG_A, user_id: U_AGENT, brokerage_id: B1 }, { id: AG_B, user_id: U_AGENT2, brokerage_id: B1 }, { id: AG_X, user_id: U_XAGENT, brokerage_id: B2 }, { id: AG_SOLO, user_id: U_SOLO, brokerage_id: B3 }],
    transactions: [
      { id: TX1, brokerage_id: B1, agent_id: AG_A, buyer_agent_id: null, seller_agent_id: null, status: "under_contract", contact_id: C1 },
      { id: TX_OTHER, brokerage_id: B1, agent_id: AG_B, buyer_agent_id: null, seller_agent_id: null, status: "under_contract" },
    ],
    vendors: [{ id: u("f", 1), brokerage_id: B1, category: "title", status: "active" }],
    vendor_assignments: [{ id: u("f", 2), vendor_id: u("f", 1), transaction_id: TX1, brokerage_id: B1, status: "confirmed" }],
    contacts: [{ id: C1, brokerage_id: B1, first_name: "Casey", agent_id: AG_A }],
    listings: [], teams: [], user_role_assignments: [], platform_role_capability_overrides: [],
    fraud_incident_cases: [], fraud_case_evidence: [], fraud_bulletins: [], fraud_bulletin_sources: [], fraud_bulletin_revisions: [],
    fraud_correction_requests: [], fraud_warning_subscriptions: [], fraud_bulletin_reads: [], fraud_bulletin_derivatives: [],
    notifications: [], agent_action_ledger: [], tasks: [], lifecycle_events: [], manager_signals: [], content_topic_sources: [], content_topic_bank: [],
  }, { uuidIds: true, stampCreatedAt: true } as any)
}

// ═══ seams (installed BEFORE any app module loads) ═══════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__J = { mem: world(), seat: null as string | null, model: 0 }
const sess = () => Object.assign(G.__J.mem, { auth: { getUser: async () => ({ data: { user: G.__J.seat ? { id: G.__J.seat, user_metadata: {} } : null }, error: null }) } })
G.__J.sess = sess
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const OVERRIDE: Record<string, string> = {
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__J.sess() }; export async function createServerClient(){ return globalThis.__J.sess() }",
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__J.sess() }",
}
/** COUNTED model seams — a network path that reached a model would show here. */
const REPLACE: Record<string, string> = {
  "lib/ai/models.ts": "export async function generateTextRouted(){ globalThis.__J.model++; return { text: '' } }; export async function generateObjectRouted(){ globalThis.__J.model++; return { object: {} } }; export async function streamTextRouted(){ globalThis.__J.model++; throw new Error('no stream') }",
  "lib/ai/generate.ts": "export function bookedGenerateObject(){ return async () => { globalThis.__J.model++; return { object: {} } } }",
  "lib/teams/team-scope.ts": "export async function leadsAgentsTeam(){ return { ok: true, leads: false, ledTeamId: null } }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) { const p = join(ROOT, c); if (existsSync(p) && !statSync(p).isDirectory()) return p }
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
const load = async (p: string): Promise<any> => { try { return await import(pathToFileURL(join(ROOT, p)).href) } catch (e) { console.log(`  (cannot load ${p}: ${(e as Error).message.slice(0, 120)})`); return null } }
const T = (t: string): Row[] => (G.__J.mem as MemClient).tables[t] ?? []
const quiet = async <X,>(fn: () => Promise<X>): Promise<X | { ok: false; error: string; threw: true }> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } catch (x) { return { ok: false, error: (x as Error)?.message ?? String(x), threw: true } } finally { console.warn = w; console.error = e; console.log = l }
}
async function as<X>(seat: string | null, fn: () => Promise<X>): Promise<any> { G.__J.seat = seat; return quiet(fn) }

async function main() {
  // ═══ §A ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§A vocabulary and schema (derived, comment-stripped)")
  const net = await load(NET)
  const A = await load(ACTIONS)
  const sql = stripComments(raw(MIG))
  const checkList = (col: string, src: string): string[] => {
    const m = new RegExp(`${col}\\s+text[^\\n]*?check\\s*\\(\\s*${col}\\s+in\\s*\\(([\\s\\S]*?)\\)\\s*\\)`, "i").exec(src)
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort() : []
  }
  const kinds: string[] = net ? [...net.FRAUD_TYPOLOGY_KINDS].sort() : []
  check("14 typologies, each with an evidence checklist, a protective action and an education topic", !!net && net.FRAUD_TYPOLOGY.length === 14 && net.FRAUD_TYPOLOGY.every((t: any) => t.evidenceChecklist.length > 0 && t.protectiveAction.length > 20 && /\?$/.test(t.educationalTopic)))
  check("m1035 incident_kind CHECK == the code typology (one vocabulary)", kinds.length === 14 && JSON.stringify(checkList("incident_kind", sql)) === JSON.stringify(kinds), checkList("incident_kind", sql))
  check("m1035 bulletin typology CHECK == the code typology", JSON.stringify(checkList("typology", sql)) === JSON.stringify(kinds))
  check("m1035 claim_class CHECK == FRAUD_CLAIM_CLASSES", !!net && JSON.stringify(checkList("claim_class", sql)) === JSON.stringify([...net.FRAUD_CLAIM_CLASSES].sort()))
  check("positive control: the CHECK reader sees a planted extra kind", JSON.stringify(checkList("incident_kind", sql.replace("'credential_phishing',", "'credential_phishing', 'planted_kind',"))) !== JSON.stringify(kinds))
  const policy = /create policy fraud_bulletins_published_read[\s\S]*?;/i.exec(sql)?.[0] ?? ""
  const policySeats = [...(/in\s*\(([^)]*)\)\s*\)\s*;?\s*$/i.exec(policy.trim())?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
  check("the bulletin read policy's seat list == FRAUD_NETWORK_PARTICIPANT_USER_TYPES (derived from TENANT_ADMIN_USER_TYPES)", !!net && policySeats.length > 0 && JSON.stringify(policySeats) === JSON.stringify([...net.FRAUD_NETWORK_PARTICIPANT_USER_TYPES].sort()), policySeats)
  check("the bulletin read policy admits ONLY published rows", /status\s*=\s*'published'/.test(policy) && /for select/i.test(policy))
  const bulletinTable = /create table if not exists public\.fraud_bulletins\s*\(([\s\S]*?)\n\);/i.exec(sql)?.[1] ?? ""
  check("fraud_bulletins carries NO tenant column (a readable row cannot expose who reported it)", bulletinTable.length > 0 && !/\bbrokerage_id\b/.test(bulletinTable))
  check("positive control: the column scan sees a planted brokerage_id", /\bbrokerage_id\b/.test(bulletinTable + "\n  brokerage_id uuid"))
  const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1])
  check("every m1035 table enables row security (9 tables)", tables.length === 9 && tables.every((t) => new RegExp(`alter table public\\.${t} enable row level security`).test(sql)), tables)
  check("exactly ONE session policy in m1035 and it is SELECT (writes only through the service door)", (sql.match(/create policy/gi) ?? []).length === 1 && !/for (insert|update|delete|all)/i.test(sql))
  check("a named entity needs official class + citation + legal review (CHECK in m1035)", /named_entity is null\s*or \(claim_class = 'official_public_warning' and named_entity_citation_url is not null and legal_review_by is not null/.test(sql))

  // ═══ §B ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§B the private case — an agent reports a spoofed escrow-domain incident (C20)")
  G.__J.mem = world(); G.__J.model = 0
  const incident = { incidentKind: "wire_diversion_lookalike_domain", channel: "email", summary: "Buyer received wire instructions from escrow@flrst-title.test claiming new bank details; agent called the title office at 555-201-3344 and it was fake.", eventDate: "2026-11-20", transactionId: TX1, lossOccurred: "no", allegedIndicators: [{ kind: "domain", value: "flrst-title.test" }, { kind: "account_last4", value: "4321" }], externalReports: [{ agency: "ic3", reference: "I-2026-77" }], evidence: [{ kind: "email_headers", fingerprint: FP(1), label: "headers.eml" }], shareConsent: false }
  const sub = A ? await as(U_AGENT, () => A.submitFraudIncident(incident)) : null
  const caseId = sub?.caseId
  check("the agent on the deal files the report — saved privately, evidence fingerprint recorded, storage honestly 'not_enabled'", sub?.ok === true && !!caseId && sub.evidenceRecorded === 1 && sub.evidenceStorage === "not_enabled", sub)
  check("the case is pinned to the SESSION tenant and reporter", T("fraud_incident_cases").length === 1 && T("fraud_incident_cases")[0].brokerage_id === B1 && T("fraud_incident_cases")[0].reporter_user_id === U_AGENT)
  check("a receipt was left (fraud.case.submit on agent_action_ledger)", T("agent_action_ledger").some((r) => r.action === "fraud.case.submit" && r.brokerage_id === B1))
  check("platform safety staff were alerted (generic text, no evidence)", T("notifications").some((n) => n.type === "fraud_case_submitted" && n.user_id === U_STAFF && !/flrst|4321|555/.test(String(n.body) + String(n.title))))
  const readBy = async (seat: string) => (A ? await as(seat, () => A.getFraudCase(caseId)) : null)
  check("the reporter reads the case", (await readBy(U_AGENT))?.ok === true)
  check("the tenant's case reviewer (compliance officer) reads the case", (await readBy(U_CO))?.ok === true)
  check("platform safety staff (support) read the case", (await readBy(U_STAFF))?.ok === true)
  for (const [who, seat] of [["a co-worker who did not report it", U_AGENT2], ["another tenant's broker", U_X], ["another tenant's agent", U_XAGENT], ["a vendor seat of the same tenant", U_VENDOR], ["marketing staff (no support capability)", U_MKT], ["nobody signed in", null]] as const) {
    const r = A ? await as(seat as any, () => A.getFraudCase(caseId)) : null
    check(`${who} reads NOTHING private`, !!A && r?.ok === false && !JSON.stringify(r).includes("flrst"), r)
  }
  const xList = A ? await as(U_X, () => A.listMyFraudCases()) : null
  check("another tenant's case list is empty", xList?.ok === true && xList.cases.length === 0)
  const coList = A ? await as(U_CO, () => A.listMyFraudCases()) : null
  const ag2List = A ? await as(U_AGENT2, () => A.listMyFraudCases()) : null
  check("the reviewer lists the tenant's case; a co-worker lists only their own (none)", coList?.ok === true && coList.cases.length === 1 && ag2List?.ok === true && ag2List.cases.length === 0)
  const ev = A ? await as(U_AGENT, () => A.requestFraudEvidenceView(caseId)) : null
  const evX = A ? await as(U_X, () => A.requestFraudEvidenceView(caseId)) : null
  check("the evidence file view FAILS CLOSED with the honest state for an authorized seat", !!net && ev?.ok === false && ev.error === net.EVIDENCE_STORAGE_NOT_ENABLED)
  check("an unauthorized seat learns only 'not found' from the evidence door", evX?.ok === false && evX.error === "Case not found.")
  const before = T("fraud_incident_cases").length
  const offDeal = A ? await as(U_AGENT, () => A.submitFraudIncident({ ...incident, transactionId: TX_OTHER })) : null
  check("a deal the seat may not work is refused by the deal desk — nothing written", offDeal?.ok === false && T("fraud_incident_cases").length === before, offDeal)
  const fullAcct = A ? await as(U_AGENT, () => A.submitFraudIncident({ ...incident, transactionId: null, summary: "They asked us to wire to account 123456789012" })) : null
  check("a full account number in the text is refused — nothing written", fullAcct?.ok === false && /last four/.test(fullAcct.error) && T("fraud_incident_cases").length === before)
  const vend = A ? await as(U_VENDOR, () => A.submitFraudIncident({ ...incident, transactionId: null })) : null
  check("a vendor seat cannot file into the network", vend?.ok === false && T("fraud_incident_cases").length === before)
  const solo = A ? await as(U_SOLO, () => A.submitFraudIncident({ ...incident, transactionId: null, incidentKind: "fake_rental_deposit" })) : null
  check("a solo agent's seat reports and reads its own case (every tenant shape)", solo?.ok === true && (await as(U_SOLO, () => A.getFraudCase(solo.caseId)))?.ok === true)
  for (let i = 0; i < 10; i++) T("fraud_incident_cases").push({ id: u("9", 100 + i), brokerage_id: B1, reporter_user_id: U_AGENT2, status: "submitted", created_at: new Date().toISOString(), retention_until: new Date(Date.now() + 1e10).toISOString(), summary: "x", incident_kind: "credential_phishing" })
  const n0 = T("fraud_incident_cases").length
  const flood = A ? await as(U_AGENT2, () => A.submitFraudIncident({ ...incident, transactionId: null })) : null
  check("the eleventh report of a day is refused (rate limit) — nothing written", flood?.ok === false && T("fraud_incident_cases").length === n0, flood)
  T("fraud_incident_cases").splice(0, T("fraud_incident_cases").length, ...T("fraud_incident_cases").filter((c) => c.reporter_user_id !== U_AGENT2))

  // ═══ §C ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§C human-only publication; another tenant reads the generic warning")
  check("before publication another tenant sees no warning", (A ? await as(U_XAGENT, () => A.listFraudBulletins({})) : null)?.bulletins?.length === 0)
  const draft = A ? await as(U_STAFF, () => A.draftFraudBulletinFromCase(caseId)) : null
  const bId = draft?.bulletinId
  const dRow = T("fraud_bulletins").find((b) => b.id === bId)
  check("the moderator drafts a warning: redacted (no email, phone or domain contact), unverified, low confidence, draft", draft?.ok === true && !!dRow && dRow.status === "draft" && dRow.claim_class === "unverified_report" && !/@|555-201/.test(dRow.tactic_summary), dRow?.tactic_summary)
  check("the draft is linked to its case (corroboration ledger)", T("fraud_bulletin_sources").some((s) => s.bulletin_id === bId && s.case_id === caseId && s.brokerage_id === B1))
  const tenantPub = A ? await as(U_CO, () => A.publishFraudBulletin(bId, { attestNoPersonIdentified: true, legalReviewConfirmed: true, verificationNote: "x" })) : null
  const mktPub = A ? await as(U_MKT, () => A.publishFraudBulletin(bId, { attestNoPersonIdentified: true, legalReviewConfirmed: true, verificationNote: "x" })) : null
  check("a tenant seat cannot publish; marketing staff cannot publish — the draft stays a draft", tenantPub?.ok === false && mktPub?.ok === false && dRow?.status === "draft")
  // NEGATIVE: an unverified report naming a person can never be published.
  await as(U_STAFF, () => A.updateFraudBulletinDraft(bId, { title: "Look-alike escrow domain wire diversion", tactic_summary: "A message from a domain one letter off the real escrow company asks the buyer to wire to new bank details.", named_entity: "Jordan Example" }))
  const named = A ? await as(U_STAFF, () => A.publishFraudBulletin(bId, { attestNoPersonIdentified: true, legalReviewConfirmed: true, verificationNote: "call-back confirmed" })) : null
  check("NEGATIVE: an unverified report naming a person is refused even with every box ticked", named?.ok === false && /never name/.test(named.error) && dRow?.status === "draft", named)
  const noAttest = A ? await as(U_STAFF, () => A.publishFraudBulletin(bId, { attestNoPersonIdentified: false, legalReviewConfirmed: false, verificationNote: "" })) : null
  check("publication without the no-person attestation is refused", noAttest?.ok === false && /Confirm/.test(noAttest.error))
  await as(U_STAFF, () => A.updateFraudBulletinDraft(bId, { named_entity: "", tactic_summary: "Contact escrow@flrst-title.test for details" }))
  const leak = A ? await as(U_STAFF, () => A.publishFraudBulletin(bId, { attestNoPersonIdentified: true, legalReviewConfirmed: false, verificationNote: "v" })) : null
  check("a tactic text carrying an email address is refused at publication", leak?.ok === false && /email/.test(leak.error))
  await as(U_STAFF, () => A.updateFraudBulletinDraft(bId, { tactic_summary: "A message from a domain one letter off the real escrow company asks the buyer to wire to new bank details.", claim_class: "verified_operational_pattern", confidence: "high", jurisdiction: "FL", indicators: [{ kind: "lookalike_domain", value: "flrst-title.test" }] }))
  const pub = A ? await as(U_STAFF, () => A.publishFraudBulletin(bId, { attestNoPersonIdentified: true, legalReviewConfirmed: false, verificationNote: "Call-back to the title office on the number from the signed statement confirmed the message was not theirs." })) : null
  check("platform safety staff publish the verified tactic warning through the one gated door", pub?.ok === true && dRow?.status === "published" && dRow?.published_by === U_STAFF, pub)
  check("publication left a LEGAL receipt and a revision (v1 snapshot)", T("agent_action_ledger").some((r) => r.action === "fraud.bulletin.publish") && T("fraud_bulletin_revisions").some((r) => r.bulletin_id === bId && r.change_kind === "published" && r.version === 1))
  const xl = A ? await as(U_XAGENT, () => A.listFraudBulletins({})) : null
  const payload = JSON.stringify(xl)
  check("ANOTHER tenant reads the generic warning", xl?.ok === true && xl.bulletins.length === 1 && xl.bulletins[0].id === bId)
  check("…without the reporter's identity, tenant, case, evidence or contact details", ![B1, U_AGENT, caseId, FP(1), "flrst-title.test@", "555-201", "First Realty", "I-2026-77", "account_last4"].some((s) => payload.includes(s)) && xl?.bulletins?.[0]?.reportedBy === "pseudonymous", payload.slice(0, 200))
  const opened = A ? await as(U_XAGENT, () => A.openFraudBulletin(bId)) : null
  check("opening it gives the protective action and records ONE measured read for that seat", opened?.ok === true && /independently/.test(opened.protectiveAction) && T("fraud_bulletin_reads").filter((r) => r.user_id === U_XAGENT).length === 1)
  // Named official warning: refused without an authoritative citation; admitted with one + legal review.
  const off = A ? await as(U_STAFF, () => A.draftFraudBulletinFromCase(caseId)) : null
  await as(U_STAFF, () => A.updateFraudBulletinDraft(off.bulletinId, { title: "Official warning: cloned title company identity", tactic_summary: "A state regulator warned that a cloned title company identity is requesting wires.", claim_class: "official_public_warning", confidence: "high", named_entity: "Example Cloned Title LLC", named_entity_citation_url: "https://example.com/warning", source_url: "https://example.com/warning" }))
  const noCite = A ? await as(U_STAFF, () => A.publishFraudBulletin(off.bulletinId, { attestNoPersonIdentified: true, legalReviewConfirmed: true, verificationNote: "official" })) : null
  check("a named-source warning WITHOUT an authoritative citation is refused", noCite?.ok === false && /authoritative/.test(noCite.error), noCite)
  await as(U_STAFF, () => A.updateFraudBulletinDraft(off.bulletinId, { named_entity_citation_url: "https://dfs.example.gov/consumer-alert", source_url: "https://dfs.example.gov/consumer-alert" }))
  const noLegal = A ? await as(U_STAFF, () => A.publishFraudBulletin(off.bulletinId, { attestNoPersonIdentified: true, legalReviewConfirmed: false, verificationNote: "official" })) : null
  const okOff = A ? await as(U_STAFF, () => A.publishFraudBulletin(off.bulletinId, { attestNoPersonIdentified: true, legalReviewConfirmed: true, verificationNote: "official" })) : null
  const offRow = T("fraud_bulletins").find((b) => b.id === off?.bulletinId)
  check("…refused without legal review; published WITH a .gov citation and legal review, stamped with the reviewer", noLegal?.ok === false && okOff?.ok === true && offRow?.legal_review_by === U_STAFF && !!offRow?.legal_review_at)
  check("ZERO model calls on every report, moderation and publication path", G.__J.model === 0, G.__J.model)

  // ═══ §D ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§D corroboration is independent evidence, not a count")
  const file = async (seat: string, fp: number) => (await as(seat, () => A.submitFraudIncident({ ...incident, transactionId: null, evidence: [{ kind: "screenshot", fingerprint: FP(fp) }] })))?.caseId
  const dupSame = A ? await file(U_AGENT, 1) : null
  const dupOther = A ? await file(U_CO, 2) : null
  const l1 = A ? await as(U_STAFF, () => A.linkFraudCaseToBulletin(bId, dupSame)) : null
  const l2 = A ? await as(U_STAFF, () => A.linkFraudCaseToBulletin(bId, dupOther)) : null
  check("two more reports from the SAME tenant (one re-using the same file) leave corroboration at 1 tenant", l1?.ok === true && l2?.ok === true && l2.corroboration.independentTenants === 1 && l2.corroboration.rawSources === 3, l2?.corroboration)
  const fwd = A ? await file(U_X, 1) : null
  const l3 = A ? await as(U_STAFF, () => A.linkFraudCaseToBulletin(bId, fwd)) : null
  check("another tenant forwarding the SAME evidence file does not raise corroboration", l3?.ok === true && l3.corroboration.independentTenants === 1)
  const indep = A ? await file(U_XAGENT, 9) : null
  const l4 = A ? await as(U_STAFF, () => A.linkFraudCaseToBulletin(bId, indep)) : null
  check("a second tenant with its OWN evidence raises corroboration to 2", l4?.ok === true && l4.corroboration.independentTenants === 2)
  check("pure positive control: the counter does count distinct tenants with distinct evidence", !!net && net.independentCorroboration([{ brokerage_id: "a", evidence_fingerprint: "1" }, { brokerage_id: "b", evidence_fingerprint: "2" }, { brokerage_id: "b", evidence_fingerprint: null }]).independentTenants === 2)

  // ═══ §E ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§E a wrongly named subject's correction; takedown removes access and derived copies")
  const topic = A ? await as(U_X, () => A.addFraudBulletinToTopicPool(bId)) : null
  const topicRow = T("content_topic_bank").find((t) => t.id === topic?.topicIds?.[0])
  check("a tenant reviewer adds the warning to ITS topic pool as a generic protective question (no bulletin text, no tenant of origin)", topic?.ok === true && !!topicRow && topicRow.brokerage_id === B2 && !/flrst|letter off|First Realty/.test(JSON.stringify(topicRow)), topic)
  check("the derived copy is recorded for takedown", T("fraud_bulletin_derivatives").some((d) => d.bulletin_id === bId && d.topic_id === topicRow?.id))
  const agentTopic = A ? await as(U_XAGENT, () => A.addFraudBulletinToTopicPool(bId)) : null
  check("a non-reviewer agent cannot feed the topic pool", agentTopic?.ok === false)
  const smuggle = A ? await as(U_STAFF, () => A.correctFraudBulletin(off.bulletinId, { named_entity: "A Private Person", claim_class: "verified_operational_pattern" }, "edit")) : null
  check("a correction cannot smuggle a name onto a non-official warning", smuggle?.ok === false && /never name/.test(smuggle.error), smuggle)
  const rec = A ? await as(U_STAFF, () => A.recordFraudSubjectCorrection({ bulletinId: off.bulletinId, channel: "support_ticket", statement: "We are the real Example Title; the regulator's alert concerns an impersonator, not us. Please correct.", supportTicketId: null })) : null
  check("the named subject's request (arrived through Support) is recorded", rec?.ok === true && T("fraud_correction_requests").some((r) => r.id === rec.requestId && r.requester_kind === "named_subject" && r.status === "received"))
  const cor = A ? await as(U_STAFF, () => A.resolveFraudCorrectionRequest({ requestId: rec.requestId, outcome: "corrected", resolution: "The alert concerns an impersonator; wording corrected to say so.", changes: { tactic_summary: "A state regulator warned that an IMPERSONATOR of a real title company is requesting wires; the real company is not involved." } })) : null
  check("the correction is versioned: v2 live, v1 kept in the history with the request id", cor?.ok === true && cor.version === 2 && offRow?.version === 2 && T("fraud_bulletin_revisions").some((r) => r.bulletin_id === off.bulletinId && r.change_kind === "corrected" && r.version === 1 && r.correction_request_id === rec.requestId && /cloned title company identity is requesting/.test(r.snapshot.tactic_summary)))
  const tReq = A ? await as(U_XAGENT, () => A.requestFraudBulletinCorrection(bId, "This warning is outdated.")) : null
  check("a tenant can request a correction in-app", tReq?.ok === true && T("fraud_correction_requests").some((r) => r.requester_kind === "tenant" && r.brokerage_id === B2))
  const down = A ? await as(U_STAFF, () => A.resolveFraudCorrectionRequest({ requestId: tReq.requestId, outcome: "taken_down", resolution: "Pattern no longer active in this form." })) : null
  check("takedown: the warning is gone from every tenant's list and its direct read", down?.ok === true && (await as(U_XAGENT, () => A.listFraudBulletins({})))?.bulletins?.every((b: any) => b.id !== bId) && (await as(U_XAGENT, () => A.openFraudBulletin(bId)))?.ok === false)
  check("takedown withdrew the derived topic-pool copy (status rejected)", topicRow?.status === "rejected" && down?.derivedWithdrawn === 1)

  // ═══ §F ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§F no automatic ban, denial, score or person search exists")
  const FORBIDDEN_WRITE = /\.from\(\s*["'`](transactions|vendors|vendor_assignments|contacts|users|agents)["'`]\s*\)(?:(?!\.from\()[\s\S]){0,240}?\.(insert|update|delete|upsert)\s*\(/
  const findWrites = (src: string) => FORBIDDEN_WRITE.test(src)
  const offenders = [NET, ACTIONS, RUNNER].filter((f) => findWrites(stripComments(raw(f))))
  check("no write to transactions / vendors / vendor_assignments / contacts / users / agents in the network or the runner", !!net && offenders.length === 0, offenders)
  check("positive control: the finder catches a planted vendor ban", findWrites(`await svc.from("vendors").update({ status: "banned" }).eq("id", x)`) && findWrites(`svc.from('transactions').update({ status: 'denied' })`))
  const modelImport = /["'`]@\/lib\/ai\/|generateObject|generateText|streamText/
  check("the network modules import no model (classification and publication are human)", !!net && ![NET, ACTIONS].some((f) => modelImport.test(stripComments(raw(f)))))
  check("positive control: the model-import scan sees a planted import", modelImport.test(`const { generateObjectRouted } = await import("@/lib/ai/models")`))
  const personSearch = /\.(ilike|textSearch|or)\s*\(/
  check("no free-text / allegation search exists (no ilike / textSearch / or-filter in the network)", !!net && !personSearch.test(stripComments(raw(NET))))
  check("positive control: the search scan sees a planted name search", personSearch.test(`q.ilike("named_entity", "%x%")`))
  const snap = (t: string) => JSON.stringify(T(t))
  const initial = world().tables
  check("the driven flow left transactions, vendors, vendor_assignments and contacts byte-identical", ["transactions", "vendors", "vendor_assignments", "contacts"].every((t) => snap(t) === JSON.stringify(initial[t])))

  // ═══ §G ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§G a changed wire matching a bulletin → ONE independent-verification task (C21)")
  const runnerMod = await load(RUNNER)
  // Re-publish a fresh verified bulletin with the look-alike domain (the first one was taken down in §E).
  const d2 = A ? await as(U_STAFF, () => A.draftFraudBulletinFromCase(caseId)) : null
  await as(U_STAFF, () => A.updateFraudBulletinDraft(d2?.bulletinId, { title: "Look-alike escrow domain", tactic_summary: "Wire requests from a domain one letter off the real escrow company.", claim_class: "verified_operational_pattern", confidence: "high", indicators: [{ kind: "lookalike_domain", value: "flrst-title.test" }] }))
  const p2 = A ? await as(U_STAFF, () => A.publishFraudBulletin(d2?.bulletinId, { attestNoPersonIdentified: true, legalReviewConfirmed: false, verificationNote: "verified by call-back" })) : null
  const txBefore = JSON.stringify(T("transactions"))
  const wire = { senderEmail: "escrow@flrst-title.test", expectedDomains: ["first-title.test"], priorInstructions: { account: "1111" }, newInstructions: { account: "2222" }, messageText: "updated wire instructions" }
  const run = (ref: string) => quiet(() => runnerMod.runWireFraudSentinel({ brokerageId: B1, contactId: C1, agentUserId: U_AGENT, wire, transactionId: TX1, agentId: AG_A, subjectRef: ref }, G.__J.sess()))
  const r1: any = runnerMod && p2?.ok ? await run("wire_fraud:doc-1") : null
  const tasks = () => T("tasks").filter((t) => t.source === "fraud_bulletin_match")
  check("the sentinel still BLOCKS and alerts the agent (survivor behavior kept)", r1?.verdict?.riskLevel === "block" && T("notifications").some((n) => n.type === "wire_fraud_alert"))
  check("a bulletin match (exact look-alike domain) PROPOSES one high-priority verification task on the deal, assigned to its agent", r1?.bulletinMatch?.indicatorMatch === true && tasks().length === 1 && tasks()[0].priority === "high" && tasks()[0].transaction_id === TX1 && tasks()[0].assigned_to_agent_id === AG_A && tasks()[0].status === "pending", r1?.bulletinMatch)
  check("the task asks for a call-back on an independently obtained number and accuses no one", /independently/.test(String(tasks()[0]?.description)) && /not a finding about any person/.test(String(tasks()[0]?.description)))
  const r2: any = runnerMod && p2?.ok ? await run("wire_fraud:doc-1") : null
  check("a replay of the same wire creates no second task", r2?.bulletinMatch?.taskId === tasks()[0]?.id && tasks().length === 1)
  check("the deal is unchanged — no automatic denial", JSON.stringify(T("transactions")) === txBefore)
  check("the match path left a receipt (fraud.verification_task.propose)", T("agent_action_ledger").some((r) => r.action === "fraud.verification_task.propose"))
  await as(U_STAFF, () => A.takeDownFraudBulletin(d2?.bulletinId, "test: no published match"))
  await as(U_STAFF, () => A.takeDownFraudBulletin(off?.bulletinId, "test: no published match"))
  const r3: any = runnerMod && p2?.ok ? await run("wire_fraud:doc-2") : null
  check("with NO published matching bulletin the runner proposes no task (it still alerts)", r3?.verdict?.riskLevel === "block" && (r3?.bulletinMatch?.matched ?? ["x"]).length === 0 && tasks().length === 1)

  // ═══ §H ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§H measured metrics, retention, reach")
  const t0 = tasks()[0]
  if (t0) { t0.status = "completed"; t0.completed_at = new Date(Date.parse(t0.created_at ?? new Date().toISOString()) + 2 * 3_600_000).toISOString() }
  const m = A ? await as(U_STAFF, () => A.getFraudNetworkMetrics()) : null
  check("platform metrics are counted from rows: reads, proposed / acted tasks, mean hours to verify, corrections", m?.ok === true && m.metrics.bulletinsRead >= 1 && m.metrics.verificationTasksProposed === 1 && m.metrics.verifiedSafetyTasksActed === 1 && m.metrics.meanHoursToVerify === 2 && m.metrics.falsePositiveCorrections === 2, m?.metrics)
  check("'losses prevented' is null with its reason — never an imagined number", m?.metrics?.lossesPrevented === null && /verified outcome/.test(m?.metrics?.lossesPreventedNote))
  const mt = A ? await as(U_XAGENT, () => A.getFraudNetworkMetrics()) : null
  check("a tenant seat sees its OWN tenant's metrics only", mt?.ok === true && mt.metrics.scope === "tenant" && mt.metrics.verificationTasksProposed === 0)
  const expired = T("fraud_incident_cases")[0]
  if (expired) expired.retention_until = new Date(Date.now() - 1000).toISOString()
  const purge = net ? await quiet(() => net.purgeExpiredFraudCases(G.__J.sess())) : null
  check("retention: an expired private case is deleted and counted", (purge as any)?.purged === 1 && !T("fraud_incident_cases").some((c) => c.id === expired?.id))
  const route = stripComments(raw("app/api/cron/wire-fraud-sentinel/route.ts"))
  check("the purge rides the existing sentinel cron, and the cron hands the runner its deal, agent and subject ref", /purgeExpiredFraudCases\(/.test(route) && /subjectRef:\s*dedupeKey/.test(route))
  const nav = stripComments(raw("app/config/navigation-config.ts"))
  check("reach: the network is in the existing navigation and linked from Help & Support", /href:\s*'\/dashboard\/fraud-network'/.test(nav) && /\/dashboard\/fraud-network/.test(raw("app/dashboard/help/help-client.tsx")) && existsSync(join(ROOT, "app/dashboard/fraud-network/page.tsx")))
  const exported = [...stripComments(raw(ACTIONS)).matchAll(/^export\s+async\s+function\s+(\w+)/gm)].map((x) => x[1])
  const client = raw("app/dashboard/fraud-network/fraud-network-client.tsx") + raw("app/dashboard/fraud-network/page.tsx")
  check("every exported door has a caller on the screen (derived from the action file)", exported.length >= 20 && exported.every((e) => new RegExp(`\\b${e}\\b`).test(client)), exported.filter((e) => !new RegExp(`\\b${e}\\b`).test(client)))
  check("every exported door of the \"use server\" file is async and gates on the session first", exported.length > 0 && exported.every((e) => { const at = stripComments(raw(ACTIONS)).indexOf(`function ${e}(`); const body = stripComments(raw(ACTIONS)).slice(at, at + 600); return /(tenantSeat|staffSeat|caseReader)\(\)|staffSeat\((true|false)\)/.test(body) }))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log("FAILED:\n  - " + fails.join("\n  - ")); process.exit(1) }
}

// A crash is a failure WITH its count (a base run must still say how many checks were red before it stopped).
main().catch((e) => { check("the guard ran to the end", false, (e as Error)?.message ?? String(e)); console.log(`\n${passed} passed, ${failed} failed (stopped early)`); console.log("FAILED:\n  - " + fails.join("\n  - ")); process.exit(1) })
