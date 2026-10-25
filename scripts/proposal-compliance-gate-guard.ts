#!/usr/bin/env tsx
/**
 * scripts/proposal-compliance-gate-guard.ts   (npm run test:proposal-compliance-gate — key listed for the integrator,
 * lane 144I; run with --conditions=react-server)
 * ─────────────────────────────────────────────────────────────────────────────
 * HUMANS APPROVE LEGAL — THE KERNEL HALF (wave 144, lane 144I; lane 144A Outside-lane 4, coordinator-routed;
 * lane brief requirement 4: "code changes and high-risk money/compliance need human review — verify the gates").
 *
 * Lane 144A's adaptive vocabulary (lib/compliance/vocabulary-healing.ts approveVocabularyProposal) checks the
 * compliance approver itself. The GENERIC door — Manager Trust (app/actions/admin/improvement-proposals.ts
 * decideProposalAction → lib/kernel/improvement-proposals.ts decideProposal) — did not: any tenant admin (a team
 * lead, an operations admin) could approve a state-scoped vocabulary change or an MLS coming-soon rule there, and
 * the evaluation never re-validated the change against the LIVE vocabulary. This proves, through the REAL kernel
 * against the in-memory client:
 *   A. evaluateImprovement re-validates adaptive_vocabulary / coming_soon_policy proposals: a valid one stays
 *      inconclusive (a human decides); a tampered patch (an attestation smuggled in, an entry outside the
 *      dimension), a requires_compliance flag that disagrees with the change, a change that no longer validates,
 *      a coming-soon patch that is not exactly its entry — each FAILS (→ REJECTED);
 *   B. decideProposal on a requires_compliance proposal: a team lead is refused, a user with NO role supplied is
 *      refused (fail closed — the old generic-door actor shape), a manager / the system is refused; the compliance
 *      officer approves. POSITIVE CONTROL: a brokerage-wide change (no compliance needed) is still approved by a
 *      team lead — the gate does not over-refuse;
 *   C. the generic door passes the SESSION role (stripped source), and 144A's own door does too.
 * BLIND SPOTS: in-memory (no RLS, no triggers); the SESSION role is trusted as requireCallerTenant resolves it
 * (that resolver has its own proofs); proposals created through other doors are covered only by A's re-validation.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"
import { decideProposal, evaluateImprovement, type ProposalActor } from "../lib/kernel/improvement-proposals"
import { reportVocabularyGap, reportComingSoonPolicy, VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES } from "../lib/compliance/vocabulary-healing"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)
const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

const B = "11111111-1111-4111-8111-11111111c144"
const AGENT = "aaaaaaaa-0000-4000-8000-0000000001a1", LEAD = "aaaaaaaa-0000-4000-8000-0000000001a2", CO = "aaaaaaaa-0000-4000-8000-0000000001a3"
const TREC = "https://www.trec.texas.gov/forms/information-about-brokerage-services"
const FIXTURE_URL = "https://rules.example-coast-mls.test/rules-and-regulations#coming-soon" // a FIXTURE — not a real MLS's rule

const fresh = () => memSupabase({
  improvement_proposals: [], tenant_policy_versions: [], agent_action_ledger: [],
  brokerage_settings: [{ id: "bs-1", brokerage_id: B, settings: {}, updated_at: "2026-10-01T00:00:00.000Z" }],
}, { stampCreatedAt: true, uuidIds: true })
const rowOf = (mem: ReturnType<typeof fresh>, id: string) => mem.tables.improvement_proposals.find((r: any) => r.id === id) as any
const user = (userId: string, userType: string | null): ProposalActor => ({ type: "user", userId, isTenantAdmin: true, ...(userType ? { userType } : {}), reason: "proof" })

async function main() {
  console.log("══════════════════════════════════════════════════════════════════")
  console.log(" PROPOSAL COMPLIANCE GATE — humans approve legal, at the kernel (wave 144, lane 144I)")
  console.log("══════════════════════════════════════════════════════════════════")

  // ── a state-scoped (TX) representation term → requires_compliance ──
  const mem = fresh()
  const rep = await reportVocabularyGap(mem as any, { brokerageId: B, reporterUserId: LEAD, report: { dimension: "representation", label: "Intermediary", kind: "different_in_state", rollsUpTo: "dual_agency", stateCode: "TX", sourceUrl: TREC, sourceTitle: "TREC Information About Brokerage Services" } as any })
  const pid = rep.ok && rep.outcome === "proposed" ? rep.proposalId : ""
  check("SETUP: a Texas representation term is proposed and flagged requires_compliance", !!pid && rowOf(mem, pid)?.proposed_change?.requires_compliance === true, JSON.stringify(rep).slice(0, 300))

  section("A. evaluateImprovement re-validates the vocabulary proposal against the LIVE vocabulary")
  const base = rowOf(mem, pid)
  const ev = (pc: Record<string, unknown>) => evaluateImprovement(mem as any, { brokerage_id: B, subject_kind: "policy", subject_key: base.subject_key, proposed_change: pc } as any)
  const ok = await ev(base.proposed_change)
  check("a valid state-scoped change stays INCONCLUSIVE — a compliance approver decides", ok.verdict === "inconclusive" && /compliance approver/.test(ok.why), ok.why)
  const smuggled = await ev({ ...base.proposed_change, patch: { ...base.proposed_change.patch, attestations: { "representation:intermediary": { user_id: LEAD, user_type: "team_lead", at: "2026-10-25", source_url: TREC } } } })
  check("an ATTESTATION smuggled into the patch FAILS (attestations are never proposed)", smuggled.verdict === "fail" && /attestation/.test(smuggled.why), smuggled.why)
  const k = Object.keys(base.proposed_change.patch)[0]
  const foreign = await ev({ ...base.proposed_change, patch: { [k]: { ...base.proposed_change.patch[k], "financing_type:zzz": { key: "zzz" } } } })
  check("a patch touching an entry OUTSIDE the change's dimension FAILS", foreign.verdict === "fail" && /outside the representation vocabulary/.test(foreign.why), foreign.why)
  const dodged = await ev({ ...base.proposed_change, requires_compliance: false })
  check("requires_compliance stored false on a state-scoped change FAILS (it cannot dodge the compliance approver)", dodged.verdict === "fail" && /requires_compliance/.test(dodged.why), dodged.why)
  const stale = await ev({ ...base.proposed_change, vocabulary_change: { ...base.proposed_change.vocabulary_change, rollsUpTo: "not_a_platform_key" } })
  check("a change that no longer validates (rolls up to a non-platform key) FAILS with the validator's reason", stale.verdict === "fail" && /re-validated/.test(stale.why), stale.why)
  const nopatch = await ev({ ...base.proposed_change, patch: {} })
  check("a proposal with NO patch FAILS", nopatch.verdict === "fail")

  section("B. decideProposal: a requires_compliance change is approved ONLY by a human compliance approver")
  const byLead = await decideProposal(mem as any, { brokerageId: B, id: pid, decision: "approve", actor: user(LEAD, "team_lead") })
  check("a TEAM LEAD (tenant admin, not a compliance approver) is refused", !byLead.ok && /compliance approver/.test(byLead.error) && rowOf(mem, pid).status === "EVALUATED", JSON.stringify(byLead))
  const noRole = await decideProposal(mem as any, { brokerageId: B, id: pid, decision: "approve", actor: user(LEAD, null) })
  check("a user whose role was NOT supplied (the old generic-door actor) is refused — fail closed", !noRole.ok && /not supplied/.test(noRole.error), JSON.stringify(noRole))
  const byMgr = await decideProposal(mem as any, { brokerageId: B, id: pid, decision: "approve", actor: { type: "manager", managerKey: "data_steward" } })
  check("a MANAGER is refused (a compliance-scoped change is never manager-approved)", !byMgr.ok && /never by a manager/.test(byMgr.error), JSON.stringify(byMgr))
  const bySys = await decideProposal(mem as any, { brokerageId: B, id: pid, decision: "approve", actor: { type: "system" } })
  check("the SYSTEM is refused", !bySys.ok)
  const byCo = await decideProposal(mem as any, { brokerageId: B, id: pid, decision: "approve", actor: user(CO, "compliance_officer") })
  check("the COMPLIANCE OFFICER approves → APPROVED", byCo.ok && byCo.status === "APPROVED" && rowOf(mem, pid).status === "APPROVED", JSON.stringify(byCo))
  check("the approver roster is lane 144A's derived set (compliance_officer + broker seats; never team_lead / admin)",
    VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has("compliance_officer") && !VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has("team_lead") && !VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has("admin"))

  // POSITIVE CONTROL — the gate does not over-refuse a change that needs no compliance approver.
  const mem2 = fresh()
  const rep2 = await reportVocabularyGap(mem2 as any, { brokerageId: B, reporterUserId: AGENT, report: { dimension: "financing_type", label: "FHA 203(k)", kind: "missing", rollsUpTo: "fha" } as any })
  const pid2 = rep2.ok && rep2.outcome === "proposed" ? rep2.proposalId : ""
  check("CONTROL: a brokerage-wide financing label is NOT flagged requires_compliance", !!pid2 && rowOf(mem2, pid2)?.proposed_change?.requires_compliance !== true)
  const leadOk = await decideProposal(mem2 as any, { brokerageId: B, id: pid2, decision: "approve", actor: user(LEAD, "team_lead") })
  check("CONTROL: …and a team lead still approves it (the gate refuses only what it exists for)", leadOk.ok && leadOk.status === "APPROVED", JSON.stringify(leadOk))
  const reject = await decideProposal(fresh() as any, { brokerageId: B, id: "nope", decision: "reject", actor: user(LEAD, "team_lead") })
  check("CONTROL: an unknown proposal is refused (loadProposal), not approved", !reject.ok)

  section("A2. the coming-soon proposal is re-validated too")
  const mem3 = fresh()
  const cs = await reportComingSoonPolicy(mem3 as any, { brokerageId: B, reporterUserId: AGENT, report: { mlsName: "Example Coast MLS", stateCodes: ["FL"], permitted: true, maxDays: 21, showingsPermitted: false, mlsSubmissionWithinBusinessDays: 1, sourceUrl: FIXTURE_URL, ruleRef: "Sec. 1.3 (fixture)" } })
  const csId = cs.ok ? cs.proposalId : ""
  const csRow = rowOf(mem3, csId)
  const evc = (pc: Record<string, unknown>) => evaluateImprovement(mem3 as any, { brokerage_id: B, subject_kind: "policy", subject_key: "coming_soon_policy", proposed_change: pc } as any)
  const csOk = await evc(csRow.proposed_change)
  check("a valid, cited MLS rule stays INCONCLUSIVE (a compliance approver decides)", csOk.verdict === "inconclusive", csOk.why)
  const slug = csRow.proposed_change.coming_soon_entry.mls_slug
  const csTamper = await evc({ ...csRow.proposed_change, patch: { mls: { [slug]: { ...csRow.proposed_change.coming_soon_entry, permitted: false } } } })
  check("a patch that is not exactly the stored entry FAILS", csTamper.verdict === "fail" && /not exactly/.test(csTamper.why), csTamper.why)
  const csFlag = await evc({ ...csRow.proposed_change, requires_compliance: false })
  check("requires_compliance false on an MLS rule FAILS", csFlag.verdict === "fail")
  const csUncited = await evc({ ...csRow.proposed_change, coming_soon_entry: { ...csRow.proposed_change.coming_soon_entry, source: { ...csRow.proposed_change.coming_soon_entry.source, url: "http://blog.example.com/x" } } })
  check("an entry whose source is no longer acceptable FAILS with the validator's reason", csUncited.verdict === "fail" && /re-validated/.test(csUncited.why), csUncited.why)
  const csLead = await decideProposal(mem3 as any, { brokerageId: B, id: csId, decision: "approve", actor: user(LEAD, "team_lead") })
  check("a team lead cannot approve the MLS rule through the generic kernel door", !csLead.ok && /compliance approver/.test(csLead.error))

  section("C. every door hands the kernel the SESSION role (stripped source)")
  const door = code("app/actions/admin/improvement-proposals.ts")
  check("Manager Trust's requireLearningAdmin passes userType: caller.userType into the actor", /actor:\s*\{[^}]*userType:\s*caller\.userType/.test(door))
  const healing = code("lib/compliance/vocabulary-healing.ts")
  check("lane 144A's approve doors pass userType: approver.userType (both)", (healing.match(/userType:\s*approver\.userType/g) ?? []).length >= 2)
  const kernel = code("lib/kernel/improvement-proposals.ts")
  check("the kernel gate reads requires_compliance and the derived roster (never a retyped list)", /requires_compliance\s*===\s*true/.test(kernel) && /VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES/.test(kernel) && !/\["broker",\s*"broker_owner"/.test(kernel))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log(" ❌ PROPOSAL_COMPLIANCE_GATE_FAIL"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ PROPOSAL_COMPLIANCE_GATE_PASS — a compliance-scoped proposal is re-validated at evaluation and approved only by a human compliance approver, on every door")
}
main().catch((e) => { console.error(e); process.exit(1) })
