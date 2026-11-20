#!/usr/bin/env tsx
/**
 * scripts/team-checklist-guard.ts   (npm run test:team-checklist — wave 145, lane 145H)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * OWNER RULING 21 (2026-10-27): "Teams required document checklist should follow the team." Resolve checklists by
 * state / brokerage / team / transaction type / representation / stage / jurisdiction / policy version; on a team
 * move or join keep the team's authorized requirements, resolve conflicts toward the mandatory brokerage / state
 * rules, never delete historical policy evidence, never cross tenants.
 *
 *   A  CONFLICTS RESOLVE TOWARD THE MANDATORY RULE — a team / agent rule may add or tighten, never loosen a higher
 *      scope's blocking rule or a cited state requirement (lib/compliance/required-documents.ts, the floor). A
 *      brokerage's own more-specific choice at ITS scope still stands. Checklists with no lower-scope override read
 *      exactly as before (no floor, same fingerprint shape).
 *   B  THE DEAL'S TEAM — resolved through THE team resolver when not stated (a team LEAD's team is on
 *      teams.team_lead_id, not users.team_id).
 *   C  CLOSING — the closing audit reads the deal's agent off the transaction, so team / agent rules apply at closing.
 *   D  THE CARRY (lib/compliance/team-checklist-carry.ts) — the joined team's rules land in the adopting brokerage as
 *      team rules; the source is untouched (history); templates never point across tenants; a cited state requirement
 *      is carried as policy for re-attestation; a foreign vocabulary term is HELD; idempotent; versioned; refuses a
 *      team outside the target and refuses before m869.
 *   E  WHO MAY CARRY — only a completed adoption of the team's lead into the brokerage authorizes it; the door is
 *      session-gated, scope-checked and ledgered.
 *   F  m869 — line-1 status, provenance columns, the partial unique index, nothing dropped.
 *
 * BLIND SPOTS: in memory (scripts/in-memory-supabase.ts) — the m847 vocabulary trigger is SIMULATED by a wrapper that
 * refuses a non-platform contract type with 23514 (its SQL is held by test:adaptive-vocabulary); RLS is not modelled;
 * the adoption rail's own call of the carry is lane 145A's file (Outside-lane) and is PUBLISHED here, not asserted.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { blankStrings, stripComments } from "./strip-comments"
import { resolveRequiredDocuments, auditTransactionDocuments } from "../lib/compliance/required-documents"
import { carryTeamChecklistRules, listJoinedTeams } from "../lib/compliance/team-checklist-carry"
import { CONTRACT_SUBTYPES } from "../lib/compliance/checklist-dimensions"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
const code = (p: string) => blankStrings(stripComments(read(p)))
const codeWithStrings = (p: string) => stripComments(read(p))

const B1 = "b1000000-0000-4000-8000-000000000001"   // the adopting brokerage
const SRC = "5c000000-0000-4000-8000-000000000002"  // the team's previous workspace
const B2 = "b2000000-0000-4000-8000-000000000003"   // a stranger tenant
const T1 = "71000000-0000-4000-8000-000000000001", T2 = "72000000-0000-4000-8000-000000000002"
const LEAD = "1ead0000-0000-4000-8000-000000000001", AGENT_U = "a9e00000-0000-4000-8000-000000000001", LONER = "10e00000-0000-4000-8000-000000000001"
const AG_LEAD = "a9000000-0000-4000-8000-0000000000aa"
let n = 0
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
const rule = (o: Row): Row => ({ id: id(), brokerage_id: B1, scope_type: "brokerage", scope_id: B1, deal_type: "seller", is_required: true, block_on_missing: true, state_code: null, policy_version: 1, ...o })

/** The m847 admission trigger, simulated: a contract type that is not a platform value is refused 23514. */
function withVocabularyTrigger(db: MemClient): MemClient {
  const from = db.from.bind(db)
  return Object.assign(Object.create(db), {
    tables: db.tables, writes: db.writes,
    from(table: string) {
      const b: any = from(table)
      if (table !== "brokerage_required_documents") return b
      const insert = b.insert.bind(b)
      b.insert = (row: Row) => {
        const v = (row as Row).contract_subtype
        if (v && !(CONTRACT_SUBTYPES as readonly string[]).includes(v)) {
          return { select: async () => ({ data: null, error: { code: "23514", message: `contract_subtype "${v}" is neither a platform contract type nor a term in this brokerage's vocabulary` } }) }
        }
        return insert(row)
      }
      return b
    },
  }) as MemClient
}

async function main() {
  // ═══ A. CONFLICTS RESOLVE TOWARD THE MANDATORY RULE ══════════════════════════════════════════════════════
  section("A a lower scope may add or tighten, never loosen a higher scope's blocking rule or a cited state requirement")
  const resolve = (rows: Row[], ctx: Record<string, unknown> = {}) =>
    resolveRequiredDocuments(memSupabase({ brokerage_required_documents: rows }), { brokerageId: B1, dealType: "seller", ...ctx } as any)
  {
    const brk = rule({ classification: "disclosure", block_on_missing: true })
    const team = rule({ classification: "disclosure", block_on_missing: false, scope_type: "team", scope_id: T1, description: "team wording" })
    const r = await resolve([brk, team], { teamId: T1 })
    const d = r.ok ? r.docs[0] : null
    check("the TEAM rule supplies the text, but the brokerage's BLOCKING rule keeps the document blocking", !!d && d.scope === "team" && d.description === "team wording" && d.block_on_missing === true && d.floor_rule_ids?.[0] === brk.id, JSON.stringify(d))
    check("…and the checklist fingerprint names the floor rule (which list applied)", r.ok && !!r.checklist_fingerprint && r.checklist_fingerprint.includes(`+${brk.id}`))
    const naive = team.block_on_missing   // the pre-145 rule: the most specific scope decides alone
    check("POSITIVE CONTROL — the old 'most specific wins alone' rule would have LOOSENED it to a warning", naive === false && d?.block_on_missing === true)
    const tighten = await resolve([rule({ classification: "disclosure", block_on_missing: false }), rule({ classification: "disclosure", block_on_missing: true, scope_type: "team", scope_id: T1 })], { teamId: T1 })
    check("a team may TIGHTEN (brokerage warns, team blocks → blocking, no floor needed)", tighten.ok && tighten.docs[0].block_on_missing === true && !tighten.docs[0].floor_rule_ids)
    const agentOverTeam = await resolve([rule({ classification: "title_report", block_on_missing: true, scope_type: "team", scope_id: T1 }), rule({ classification: "title_report", block_on_missing: false, scope_type: "agent", scope_id: AGENT_U })], { teamId: T1, agentUserId: AGENT_U })
    check("the TEAM's blocking rule binds its agent too (an agent rule cannot loosen it)", agentOverTeam.ok && agentOverTeam.docs[0].scope === "agent" && agentOverTeam.docs[0].block_on_missing === true)
    const generic = rule({ classification: "disclosure", block_on_missing: true }), fl = rule({ classification: "disclosure", block_on_missing: false, state_code: "FL" })
    const own = await resolve([generic, fl], { stateCode: "FL" })
    check("CONTROL — the brokerage's OWN more specific choice at its scope still stands (FL warns; no floor across one scope)", own.ok && own.docs[0].block_on_missing === false && !own.docs[0].floor_rule_ids)
    const stateReq = rule({ classification: "addendum", state_code: "FL", block_on_missing: true, legal_basis: "state_requirement", source_url: "https://www.flrules.gov/x", approved_by: LEAD, approved_at: "2026-10-01T00:00:00Z" })
    const narrowWarn = rule({ classification: "addendum", state_code: "FL", required_stage: "offer", block_on_missing: false })
    const st = await resolve([stateReq, narrowWarn], { stateCode: "FL", stage: "offer" })
    check("a cited STATE requirement floors even a more specific rule at the same scope, and is cited on the document",
      st.ok && st.docs[0].block_on_missing === true && st.docs[0].legal_basis === "state_requirement" && st.docs[0].source_url === "https://www.flrules.gov/x" && !!st.docs[0].floor_rule_ids?.includes(stateReq.id), JSON.stringify(st.ok && st.docs[0]))
    const plain = await resolve([rule({ classification: "disclosure" }), rule({ classification: "agency_disclosure", block_on_missing: false })])
    check("a brokerage-only checklist reads exactly as before: no floor ids, no '+' in the fingerprint", plain.ok && plain.docs.every((x) => !x.floor_rule_ids) && !plain.checklist_fingerprint!.includes("+"))
    const unresolvedFloor = await resolve([rule({ classification: "proof_of_funds", financing_kind: "cash", block_on_missing: true }), rule({ classification: "proof_of_funds", block_on_missing: false, scope_type: "team", scope_id: T1 })], { teamId: T1 })
    check("a floor that could not be confirmed to cover the deal (financing unknown) does not block — it is no floor", unresolvedFloor.ok && unresolvedFloor.docs[0].block_on_missing === false)
  }

  // ═══ B. THE DEAL'S TEAM ═══════════════════════════════════════════════════════════════════════════════
  section("B the deal's team resolves through THE team resolver (a lead's team lives on teams.team_lead_id)")
  {
    const teamRule = rule({ classification: "hoa_documents", scope_type: "team", scope_id: T1 })
    const world = () => memSupabase({
      brokerage_required_documents: [rule({ classification: "disclosure" }), teamRule],
      teams: [{ id: T1, brokerage_id: B1, team_lead_id: LEAD, deleted_at: null, created_at: "2026-01-01" }],
      users: [{ id: LEAD, brokerage_id: B1, team_id: null }, { id: LONER, brokerage_id: B1, team_id: null }],
      agents: [], team_members: [],
    })
    const lead = await resolveRequiredDocuments(world(), { brokerageId: B1, dealType: "seller", agentUserId: LEAD, teamId: null })
    check("a team LEAD with no users.team_id gets the team's checklist (the lead link resolves the team)", lead.ok && lead.docs.some((d) => d.classification === "hoa_documents" && d.scope === "team"))
    const loner = await resolveRequiredDocuments(world(), { brokerageId: B1, dealType: "seller", agentUserId: LONER, teamId: null })
    check("POSITIVE CONTROL — an agent on no team does not get it", loner.ok && !loner.docs.some((d) => d.classification === "hoa_documents"))
    const foreign = await resolveRequiredDocuments(memSupabase({ brokerage_required_documents: [rule({ classification: "hoa_documents", brokerage_id: B2, scope_type: "team", scope_id: T1 })] }), { brokerageId: B1, dealType: "seller", teamId: T1 })
    check("NEVER ACROSS TENANTS — another brokerage's rule naming the same team id never applies here", foreign.ok && foreign.docs.length === 0)
  }

  // ═══ C. CLOSING ═══════════════════════════════════════════════════════════════════════════════════════
  section("C the closing audit reads the deal's agent off the transaction, so the team's closing rules apply")
  {
    const TX = id()
    const world = (opts: Parameters<typeof memSupabase>[1] = {}) => memSupabase({
      brokerage_required_documents: [rule({ classification: "title_report", scope_type: "team", scope_id: T1, required_stage: "closing" })],
      transactions: [{ id: TX, brokerage_id: B1, agent_id: null, seller_agent_id: AG_LEAD, buyer_agent_id: null }],
      agents: [{ id: AG_LEAD, brokerage_id: B1, user_id: LEAD, team_id: null }],
      teams: [{ id: T1, brokerage_id: B1, team_lead_id: LEAD, deleted_at: null, created_at: "2026-01-01" }],
      users: [{ id: LEAD, brokerage_id: B1, team_id: null }], team_members: [], documents: [],
    }, opts)
    const a = await auditTransactionDocuments(world(), { transactionId: TX, brokerageId: B1, dealType: "seller", stage: "closing" })
    check("a closing audit asked with NO agent and NO team applies the deal agent's team rule", !a.unavailable_reason && a.required_breakdown.some((d) => d.classification === "title_report" && d.scope === "team") && a.missing_blocking.includes("title_report" as never), a.unavailable_reason ?? "")
    const b = await auditTransactionDocuments(world(), { transactionId: TX, brokerageId: B1, dealType: "seller", stage: "closing", agentUserId: null })
    check("POSITIVE CONTROL — a caller that states 'no agent' gets the brokerage checklist only (the derivation is what applied it)", !b.unavailable_reason && b.required_total === 0)
    const refused = await auditTransactionDocuments(world({ refuse: { transactions: "permission denied" } }), { transactionId: TX, brokerageId: B1, dealType: "seller", stage: "closing" })
    check("a REFUSED transaction read → the audit could not run (never 'nothing required')", !!refused.unavailable_reason)
  }

  // ═══ D. THE CARRY ═════════════════════════════════════════════════════════════════════════════════════
  section("D the carry — team rules follow the team; history kept; no cross-tenant pointer; idempotent; versioned")
  const R1 = rule({ brokerage_id: SRC, scope_type: "team", scope_id: T1, classification: "disclosure", template_form_id: "f0000000-0000-4000-8000-0000000000a1" })
  const R2 = rule({ brokerage_id: SRC, scope_type: "brokerage", scope_id: SRC, classification: "agency_disclosure", deal_type: "buyer", template_form_id: "f0000000-0000-4000-8000-0000000000b2" })
  const R3 = rule({ brokerage_id: SRC, scope_type: "team", scope_id: T1, classification: "addendum", state_code: "FL", legal_basis: "state_requirement", source_url: "https://www.flrules.gov/x", approved_by: LEAD, approved_at: "2026-09-01T00:00:00Z" })
  const R4 = rule({ brokerage_id: SRC, scope_type: "team", scope_id: T1, classification: "signed_contract", contract_subtype: "fl_as_is_form" })
  const R5 = rule({ brokerage_id: SRC, scope_type: "team", scope_id: T1, classification: "hoa_documents", block_on_missing: false })
  const R6 = rule({ brokerage_id: SRC, scope_type: "team", scope_id: T2, classification: "title_report" })
  const EXISTING = rule({ brokerage_id: B1, scope_type: "team", scope_id: T1, classification: "hoa_documents", block_on_missing: true, carried_from_rule_id: null })
  const carryWorld = (opts: Parameters<typeof memSupabase>[1] = {}) => withVocabularyTrigger(memSupabase({
    brokerage_required_documents: [R1, R2, R3, R4, R5, R6, EXISTING].map((r) => ({ ...r })),
    teams: [{ id: T1, brokerage_id: B1, team_lead_id: LEAD, deleted_at: null }, { id: T2, brokerage_id: SRC, team_lead_id: null, deleted_at: null }],
    brokerage_form_library: [{ id: "f0000000-0000-4000-8000-0000000000a1", brokerage_id: B1, team_id: T1 }, { id: "f0000000-0000-4000-8000-0000000000b2", brokerage_id: SRC, team_id: null }],
    tenant_policy_versions: [],
  }, { uuidIds: true, unique: { brokerage_required_documents: [["brokerage_id", "scope_type", "scope_id", "carried_from_rule_id"]] }, ...opts }))
  {
    const db = carryWorld()
    const sourceBefore = JSON.stringify(db.tables.brokerage_required_documents.filter((r) => r.brokerage_id === SRC))
    const res = await carryTeamChecklistRules(db, { sourceBrokerageId: SRC, targetBrokerageId: B1, teamIds: [T1], includeWorkspaceRules: true, actorUserId: LEAD, reason: "guard" })
    const carried = db.tables.brokerage_required_documents.filter((r) => r.brokerage_id === B1 && r.carried_from_rule_id)
    check("three rules follow the team (its own disclosure + addendum, and its workspace's agency disclosure)", res.ok && res.carried === 3 && carried.length === 3, JSON.stringify(res))
    check("…each lands as the TEAM's rule in the adopting brokerage, naming its origin", carried.every((r) => r.scope_type === "team" && r.scope_id === T1 && r.brokerage_id === B1 && [R1.id, R2.id, R3.id].includes(r.carried_from_rule_id)))
    check("HISTORY KEPT — the previous workspace's rules are byte-for-byte untouched", JSON.stringify(db.tables.brokerage_required_documents.filter((r) => r.brokerage_id === SRC)) === sourceBefore)
    check("POSITIVE CONTROL — the history check sees a moved row", JSON.stringify([{ ...R1, brokerage_id: B1 }]) !== JSON.stringify([R1]))
    const c1 = carried.find((r) => r.carried_from_rule_id === R1.id)!, c2 = carried.find((r) => r.carried_from_rule_id === R2.id)!, c3 = carried.find((r) => r.carried_from_rule_id === R3.id)!
    check("a template that MOVED with the team (its own packet) is kept", c1.template_form_id === R1.template_form_id)
    check("NO CROSS-TENANT POINTER — the workspace's brokerage packet stayed behind, so the copy carries no template and says so", !c2.template_form_id && res.ok && res.templatesDropped.some((t) => t.ruleId === R2.id))
    check("a cited STATE requirement is carried as the team's policy (source kept), listed for re-attestation — never as another tenant's attestation",
      c3.legal_basis === undefined && !c3.approved_by && c3.source_url === R3.source_url && res.ok && res.reattestation.some((x) => x.ruleId === R3.id))
    check("a rule naming a term the adopting vocabulary lacks is HELD for a person (23514), not rewritten", res.ok && res.held.some((h) => h.ruleId === R4.id && /vocabulary/.test(h.reason)) && !db.tables.brokerage_required_documents.some((r) => r.carried_from_rule_id === R4.id))
    check("an equivalent team rule already here is not duplicated", res.ok && res.equivalentExists === 1 && db.tables.brokerage_required_documents.filter((r) => r.brokerage_id === B1 && r.classification === "hoa_documents").length === 1)
    check("another team's rules (not moved) are not carried", !db.tables.brokerage_required_documents.some((r) => r.carried_from_rule_id === R6.id))
    const versions = db.tables.tenant_policy_versions ?? []
    check("each carried rule starts its history in the adopting tenant (a policy version naming its origin)",
      carried.every((r) => versions.some((v) => v.brokerage_id === B1 && v.policy_key === `required_document:${r.id}` && String(v.reason).includes(String(r.carried_from_rule_id)))), `${versions.length} versions`)
    const again = await carryTeamChecklistRules(db, { sourceBrokerageId: SRC, targetBrokerageId: B1, teamIds: [T1], includeWorkspaceRules: true, actorUserId: LEAD, reason: "guard rerun" })
    check("IDEMPOTENT — a re-run carries nothing new (3 already carried) and writes no row", again.ok && again.carried === 0 && again.alreadyCarried === 3 && db.tables.brokerage_required_documents.filter((r) => r.brokerage_id === B1 && r.carried_from_rule_id).length === 3)
    const after = await resolveRequiredDocuments(db, { brokerageId: B1, dealType: "seller", teamId: T1 })
    check("the carried team rule now applies to the team's deals in the adopting brokerage", after.ok && after.docs.some((d) => d.classification === "disclosure" && d.scope === "team"))
  }
  {
    const db = carryWorld()
    const res = await carryTeamChecklistRules(db, { sourceBrokerageId: SRC, targetBrokerageId: B1, teamIds: [T1], includeWorkspaceRules: false, actorUserId: LEAD, reason: "guard" })
    check("a workspace that was NOT the team's own: its brokerage-level rules stay (only the team's own rules follow)", res.ok && !db.tables.brokerage_required_documents.some((r) => r.carried_from_rule_id === R2.id) && res.carried === 2)
    const stray = await carryTeamChecklistRules(carryWorld(), { sourceBrokerageId: SRC, targetBrokerageId: B1, teamIds: [T2], includeWorkspaceRules: true, actorUserId: LEAD, reason: "guard" })
    check("NEVER ACROSS TENANTS — a team that is not in the adopting brokerage is refused, nothing written", !stray.ok && /not in the adopting brokerage/.test(stray.error))
    const pre = carryWorld({ missingColumns: { brokerage_required_documents: ["carried_from_rule_id"] }, uuidIds: true })
    const preRes = await carryTeamChecklistRules(pre, { sourceBrokerageId: SRC, targetBrokerageId: B1, teamIds: [T1], includeWorkspaceRules: true, actorUserId: LEAD, reason: "guard" })
    check("before m869 the carry REFUSES and names the migration (a copy that cannot be idempotent is not made)", !preRes.ok && /m869/.test(preRes.error) && !pre.tables.brokerage_required_documents.some((r) => r.brokerage_id === B1 && r.classification !== "hoa_documents"))
    const refused = await carryTeamChecklistRules(carryWorld({ refuse: { teams: "permission denied" } }), { sourceBrokerageId: SRC, targetBrokerageId: B1, teamIds: [T1], includeWorkspaceRules: true, actorUserId: LEAD, reason: "guard" })
    check("a refused read refuses the carry (nothing half-done is reported as done)", !refused.ok)
  }

  // ═══ E. WHO MAY CARRY ═════════════════════════════════════════════════════════════════════════════════
  section("E only a completed adoption of the team's lead authorizes the carry; the door is session-gated and ledgered")
  {
    const LEAD2 = "1ead0000-0000-4000-8000-000000000002", T3 = "73000000-0000-4000-8000-000000000003"
    const db = memSupabase({
      teams: [{ id: T1, name: "North", brokerage_id: B1, team_lead_id: LEAD, deleted_at: null }, { id: T3, name: "South", brokerage_id: B1, team_lead_id: LEAD2, deleted_at: null }],
      brokerage_transfer_requests: [
        { id: "req-1", source_brokerage_id: SRC, target_brokerage_id: B1, subject_user_id: LEAD, target_role: "team_lead", status: "completed", completed_at: "2026-10-20T00:00:00Z" },
        { id: "req-2", source_brokerage_id: SRC, target_brokerage_id: B1, subject_user_id: LEAD2, target_role: "team_lead", status: "migrating", completed_at: null },
        { id: "req-3", source_brokerage_id: SRC, target_brokerage_id: B2, subject_user_id: LEAD2, target_role: "team_lead", status: "completed", completed_at: "2026-10-21T00:00:00Z" },
      ],
    })
    const j = await listJoinedTeams(db, B1)
    check("the team whose lead's adoption COMPLETED into this brokerage is listed (its own workspace)", j.ok && j.teams.length === 1 && j.teams[0].teamId === T1 && j.teams[0].sourceBrokerageId === SRC && j.teams[0].workspaceWasTheTeams)
    check("POSITIVE CONTROL — an adoption still migrating, or completed into ANOTHER brokerage, authorizes nothing", j.ok && !j.teams.some((t) => t.teamId === T3))
    const door = code("app/actions/compliance/manage-required-docs.ts")
    const body = door.split("export async function carryJoinedTeamChecklist")[1]?.split("export async function")[0] ?? ""
    check("the door: session actor, scope check on THAT team, the completed-adoption lookup for the SESSION brokerage, ledgered",
      /resolveActor\(\)/.test(body) && /canManage\(actor, "team", input\.teamId\)/.test(codeWithStrings("app/actions/compliance/manage-required-docs.ts")) && /listJoinedTeams\(svc, actor\.brokerageId, input\.teamId\)/.test(body)
      && /withActionLedger/.test(body) && /targetBrokerageId: actor\.brokerageId/.test(body) && !/input\.(brokerageId|sourceBrokerageId)/.test(body))
    check("the settings page offers it, and the cascade text says a team rule never loosens the brokerage's", /<TeamChecklistCarryPanel/.test(code("app/dashboard/settings/required-documents/page.tsx")) && /never\s+loosens a brokerage rule/.test(read("app/dashboard/settings/required-documents/page.tsx")))
    const rail = code("lib/kernel/brokerage-transfer.ts")
    console.log(`    published (lane 145A's file, Outside-lane): the adoption rail ${/carryTeamChecklistRules\(/.test(rail) ? "CALLS carryTeamChecklistRules in its membership step" : "does NOT yet call carryTeamChecklistRules — the exact call is in lane 145H's notes (Outside-lane); until it lands, the settings door carries a joined team's checklist on request"}`)
  }

  // ═══ F. m869 ══════════════════════════════════════════════════════════════════════════════════════════
  section("F m869 — line-1 status, the provenance columns, the partial unique index, nothing dropped")
  {
    const mig = readdirSync("supabase/migrations").find((f) => /team-checklist-follows-the-team/.test(f)) ?? ""
    const sql = read(join("supabase/migrations", mig))
    const sqlCode = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    check(`the migration exists (${mig || "missing"})`, !!mig)
    check("line 1 states its status (the lane stamp until applied; APPLIED LIVE once the integrator applied it)", /^-- (WRITTEN, NOT APPLIED \(wave 145, lane 145H\)|── APPLIED LIVE )/.test(sql.split("\n")[0]))
    check("carried_from_rule_id references the rule table ON DELETE SET NULL; carried_at timestamptz", /carried_from_rule_id uuid REFERENCES public\.brokerage_required_documents\(id\) ON DELETE SET NULL/.test(sqlCode) && /carried_at timestamptz/.test(sqlCode))
    check("one copy per (target, scope, team, origin) — the partial unique index the carry's idempotency rides", /CREATE UNIQUE INDEX IF NOT EXISTS brd_carried_once[\s\S]*\(brokerage_id, scope_type, scope_id, carried_from_rule_id\)[\s\S]*WHERE carried_from_rule_id IS NOT NULL/.test(sqlCode))
    check("nothing is dropped", !/DROP (COLUMN|INDEX|CONSTRAINT|TABLE)/i.test(sqlCode))
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ TEAM_CHECKLIST_FAIL"); process.exit(1) }
  console.log(" ✅ TEAM_CHECKLIST_PASS — a team's checklist follows the team, tightens but never loosens the brokerage's or the state's, and the history stays where it was")
}

main().catch((e) => { console.error(e); process.exit(1) })
