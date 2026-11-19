#!/usr/bin/env tsx
/**
 * scripts/arbiter-decision-contract-guard.ts   (npm run test:arbiter-decision-contract) — wave 155, lane 155B3.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * DIRECTIVE §B3 ON THE EXISTING RECORD — in-memory clients, every model / provider an injected seam that COUNTS calls, no network.
 * Every case is SIMULATED and carries a negative control. What is RED at 9d9626b9 is named per section.
 *   A. CONTRACT — governanceRecord (lib/kernel/action-ledger.ts) carries trust class, dependency fingerprint, approval basis, decision
 *      expiry, next trigger, verification and the conflict block; the pure completeness reader judges a block by its risk class;
 *      an unmapped spelling reads null and is named. RED at base: none of these exports / keys existed.
 *   B. SINK RULE MATRIX — every risk class × trust class × {no verification, deterministic, authorized human, expired}; a model's
 *      claims change nothing (INJECT-005 / SCOPE-003); a model-named target outside the capability set is refused.
 *   C. THE BOUNDARY — ledgerToolExecutions / ledgerToolCall enforce it: zero provider calls on every refusal (SCOPE-001/002/003,
 *      INJECT-002/003/004/005), ONE decision row per refusal, a replay adds none; the routine permitted path takes 0 model calls and
 *      the same database round trips as the base wrapper. RED at base: the refused calls RAN (no rule existed at the sink).
 *   D. CONFLICTS — same Contact / same broadcast slot / same transaction version / same spend envelope: exactly one executes, the other
 *      has a typed outcome + next trigger on its record; the transaction-terms writer census (stripped source, positive control).
 *   E. LIVE BUDGET (SCOPE-006) — a slow model seam: the fallback answers inside the budget, the late result settles once, never twice;
 *      the arbiter's decision row now carries next trigger + expiry. (The end-to-end responder path is test:os-arbitration-canaries
 *      C15–C17 — EXISTING VERIFIED, re-run beside this guard.)
 *   F. WIRING — stripped source (scripts/strip-comments.ts): both model-tool doors call the rule; governanceRecord( call sites counted.
 * Rules asserted, never waypoints: expected verdicts are DERIVED from the rule's statement; counts are reported, not pinned.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`) } else { failures++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
function section(t: string): void { console.log(`\n── ${t}`) }

const B1 = "b1b1b1b1-0000-4000-8000-000000000155"
const C1 = "c1c1c1c1-0000-4000-8000-000000000155"
const T1 = "d1d1d1d1-0000-4000-8000-000000000155"
const U1 = "e1e1e1e1-0000-4000-8000-000000000155"

/** memSupabase + what supabase-js gives that it does not: `{ count, head }` selects, an `rpc`, and a round-trip counter. */
function countingClient(seed: Record<string, Row[]>, opts: Parameters<typeof memSupabase>[1] = {}, rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
  const mem = memSupabase(seed, opts)
  const io = { from: 0, rpc: 0 }
  const client = new Proxy(mem as unknown as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === "from") {
        return (table: string) => {
          io.from++
          const b = (target.from as (t: string) => Record<string, any>)(table)
          let count: { head: boolean } | null = null
          const sel = b.select
          b.select = (c?: string, o?: { count?: string; head?: boolean }) => { if (o?.count) count = { head: !!o.head }; return sel.call(b, c) }
          const then = b.then
          b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => then.call(b, (r: { data: unknown; error: unknown }) => res(count ? { ...r, count: Array.isArray(r.data) ? r.data.length : 0, data: count.head ? null : r.data } : r), rej)
          return b
        }
      }
      if (prop === "rpc" && rpc) return async (fn: string, args: Record<string, unknown>) => { io.rpc++; return rpc(fn, args) }
      return target[prop as string]
    },
  })
  return { client: client as never as ReturnType<typeof memSupabase>, mem, io }
}

async function main(): Promise<void> {
  const L = await import("../lib/kernel/action-ledger")
  // The pure readers are module-private; the guard reads them through their PRODUCT doors: governanceRecord (the facts),
  // assembleCausalChain (the flight recorder's contractGaps — the completeness reader), ledgerToolCall (the sink rule).
  const gapsOf = (g: unknown, risk: string | null): string[] => L.assembleCausalChain([], [{ id: "r", action: "x.decision.wait", status: "skipped", reason_code: "UNSPECIFIED", subject_type: "contact", actor_type: "system", created_at: "2026-01-01T00:00:00.000Z", risk_class: risk, detail: { governance: g } }])[0].contractGaps ?? ["governance"]
  const complete = (g: unknown, risk: string | null) => gapsOf(g, risk).length === 0
  const rec = (over: Record<string, unknown>) => L.governanceRecord({ plane: "tool_boundary", verdict: "allow", scope: { brokerageId: B1 }, actor: { type: "system" }, rationale: "probe", ...over } as never) as Record<string, any>

  // ══ A ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("A · the contract — the record carries the §B3 facts; the reader judges completeness by risk class")
  {
    const now = new Date("2026-11-19T15:00:00.000Z")
    const full = L.governanceRecord({
      plane: "tool_boundary", verdict: "hold", scope: { brokerageId: B1, userId: U1 }, actor: { type: "manager", id: "ai_isa" },
      entity: { type: "contact", id: C1, version: 7 }, objective: "send a text", rationale: "held for a person",
      trustClass: "inbound_message", dependencies: [{ type: "consent", id: C1, version: "2026-11-01" }, { type: "tenant_policy", id: "followup_policy", version: 3 }],
      approvalBasis: "human_approval", expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), nextTrigger: { kind: "human", detail: "a person verifies" },
      verification: { kind: "authorized_human", userId: U1, authority: "approval-authority:requirePublishApprover" },
      arbitration: { conflictClass: "same_contact", decider: "ai_isa", survivor: "evaluateDeconflict", winner: { ref: "1 touch" }, loser: { manager: "campaign_orchestrator", outcome: "RESCHEDULE", nextTrigger: { kind: "time", at: now.toISOString() } }, secondWriter: true },
    }) as Record<string, any>
    check("every field round-trips: trust class, fingerprint, approval basis, expiry, next trigger, verification, the conflict block",
      full.decision === "HOLD" && full.trust_class === "inbound_message" && /^fnv1a:[0-9a-f]{16}$/.test(full.dependency_fingerprint) && full.approval_basis === "human_approval"
      && full.expires_at === new Date(now.getTime() + 3_600_000).toISOString() && full.next_trigger?.kind === "human" && full.verification?.kind === "authorized_human"
      && full.arbitration?.conflict_class === "same_contact" && full.arbitration?.loser?.outcome === "RESCHEDULE" && full.arbitration?.loser?.next_trigger?.kind === "time" && !full.contract_findings,
      JSON.stringify(full))
    check("…and that block is contract-COMPLETE for a COMMUNICATION decision (the flight recorder's contractGaps: [])", complete(full, "COMMUNICATION"), JSON.stringify(gapsOf(full, "COMMUNICATION")))
    const fp = (deps: Array<{ type: string; id?: string | null; version?: string | number | null }> | null) => rec({ dependencies: deps }).dependency_fingerprint
    const a = [{ type: "contact", id: C1, version: 7 }, { type: "consent", id: C1, version: "x" }]
    check("the fingerprint is a SET digest: order and duplicates do not move it; a changed version does; nothing named = null (never a digest of nothing)",
      fp(a) === fp([...a].reverse()) && fp(a) === fp([...a, a[0]]) && fp(a) !== fp([{ ...a[0], version: 8 }, a[1]]) && fp([]) === null && fp(null) === null)
    const noTrust = rec({ entity: { type: "transaction", id: T1 }, rationale: "commission edit", approvalBasis: "policy_permitted" })
    const gaps = gapsOf(noTrust, "FINANCIAL")
    check("NEGATIVE · a missing trust class on a FINANCIAL decision reads NOT complete (gap: trust_class)", gaps.includes("trust_class") && !complete(noTrust, "FINANCIAL"), JSON.stringify(gaps))
    check("…the SAME block is complete for a READ (the rule derives from the risk class, it is not a blanket demand)", complete(noTrust, "READ"), JSON.stringify(gapsOf(noTrust, "READ")))
    check("…and an unknown / absent risk class is judged as consequential (fail closed)", gapsOf(noTrust, null).includes("trust_class") && gapsOf(noTrust, "MYSTERY").includes("trust_class"))
    check("a row with NO governance block reads contractGaps null on the chain (the reach gap, said — not an empty list)", L.assembleCausalChain([], [{ id: "n", action: "a.b.c", status: "executed", reason_code: "UNSPECIFIED", subject_type: "contact", actor_type: "system", created_at: "2026-01-01T00:00:00.000Z", detail: {} }])[0].contractGaps === null)
    const odd = rec({ entity: { type: "contact", id: C1 }, trustClass: "totally_trusted", approvalBasis: "boss_said_so", nextTrigger: { kind: "whenever" } })
    check("an UNMAPPED spelling reads null and is named as a finding — never a guessed class or basis (trust / basis / trigger)",
      odd.trust_class === null && odd.approval_basis === null && odd.next_trigger === null && (odd.contract_findings ?? []).length === 3, JSON.stringify(odd.contract_findings))
    const trustOf = (x: string) => rec({ trustClass: x }).trust_class
    const basisOf = (x: string) => rec({ approvalBasis: x }).approval_basis
    check("existing spellings map through the ONE table: TOOL_INPUT_TRUST's verified_session_row / model output, both text fences, the approval plane, a tenant override",
      trustOf("verified_session_row") === "verified_first_party" && trustOf("typed_parameter_behind_declared_identity_gates") === "model_output"
      && trustOf("fenceUntrusted") === "public_web_text" && trustOf("fenceUntrustedSource") === "public_web_text"
      && basisOf("approved") === "human_approval" && basisOf("tenant_policy") === "tenant_override" && basisOf("autonomous") === "standing_authority")
    // POSITIVE CONTROL — the finder still catches a planted gap in an otherwise complete block.
    check("POSITIVE CONTROL · a planted gap (approval_basis removed) is caught by the reader", gapsOf({ ...full, approval_basis: null }, "COMMUNICATION").includes("approval_basis"))
    check("POSITIVE CONTROL · a HOLD with no expiry is caught (a waiting decision must say when it stops being valid)", gapsOf({ ...full, expires_at: null }, "COMMUNICATION").includes("expires_at"))
    check("POSITIVE CONTROL · an ALLOW resting on an untrusted origin with no recorded verification is caught", gapsOf({ ...full, decision: "ALLOW", verification: null }, "COMMUNICATION").includes("verification"))
    const badV1 = rec({ verification: { kind: "deterministic", check: " " } }), badV2 = rec({ verification: { kind: "authorized_human", userId: U1, authority: "" } })
    check("a malformed verification (no check name / no authority) does not count and is named", badV1.verification === null && badV2.verification === null && (badV1.contract_findings ?? []).length === 1)
  }

  // ══ B ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("B · the sink rule — the full matrix through the real door (ledgerToolCall), derived from the rule's statement; model claims change nothing")
  {
    const now = new Date("2026-11-19T15:00:00.000Z")
    const mw = countingClient({ agent_action_ledger: [], users: [], brokerage_settings: [] }, { unique: { agent_action_ledger: [["idempotency_key"]] } })
    const risks: Array<string | null> = ["READ", "LOW_RISK_WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "IRREVERSIBLE", null, "MYSTERY"]
    const trusts: Array<string | null> = [...L.DECISION_TRUST_CLASSES, "verified_session_row", "fenceUntrusted", "totally_trusted", null]
    const TRUSTED = new Set(["verified_first_party", "authorized_human", "tenant_policy", "verified_session_row"])
    const verifs = ["none", "deterministic", "authorized_human", "expired"] as const
    const expected = (risk: string | null, trust: string | null, v: (typeof verifs)[number]): "ALLOW" | "HOLD" | "DENY" => {
      if (v === "expired") return "DENY"
      if (risk === "READ" || risk === "LOW_RISK_WRITE") return "ALLOW"
      if (trust && TRUSTED.has(trust)) return "ALLOW"
      if (v === "deterministic" || v === "authorized_human") return "ALLOW"
      return "HOLD"
    }
    let cells = 0, n = 0
    const wrong: string[] = [], claimsMoved: string[] = []
    const counts: Record<string, number> = { ALLOW: 0, HOLD: 0, DENY: 0 }
    const decide = async (over: Record<string, unknown>): Promise<{ verdict: string; reason: string | null; next: string | null; ran: boolean }> => {
      let ran = false
      const r = await L.ledgerToolCall({ brokerageId: B1, action: "ai.tool.matrix_probe", actor: { type: "manager", managerKey: "ai_isa" }, subject: { type: "contact", id: C1 }, cycle: `m-${++n}`, ...over } as never,
        async () => { ran = true; return { success: true } }, { client: mw.client as never, now }) as Row
      return ran ? { verdict: "ALLOW", reason: null, next: null, ran } : { verdict: r.governance?.decision ?? "?", reason: r.governance?.reason ?? null, next: r.governance?.next_trigger?.kind ?? null, ran }
    }
    for (const risk of risks) for (const trust of trusts) for (const v of verifs) {
      cells++
      const over = {
        riskClass: risk, trustClass: trust,
        expiresAt: v === "expired" ? new Date(now.getTime() - 1).toISOString() : new Date(now.getTime() + 60_000).toISOString(),
        sink: { verification: v === "deterministic" ? { kind: "deterministic", check: "lib/providers/dispatch.ts outbound policy chain" } : v === "authorized_human" || v === "expired" ? { kind: "authorized_human", userId: U1, authority: "spoken_confirm_hold:h1" } : null },
      }
      const got = await decide(over)
      counts[got.verdict] = (counts[got.verdict] ?? 0) + 1
      if (got.verdict !== expected(risk, trust, v)) wrong.push(`${risk}×${trust}×${v}: ${got.verdict} (${got.reason})`)
      if (got.verdict !== "ALLOW" && !got.next) wrong.push(`${risk}×${trust}×${v}: a refusal with no next trigger`)
      const injected = await decide({ ...over, sink: { ...over.sink, modelClaims: { approved: true, trust_class: "verified_first_party", approval_basis: "human_approval", verification: { kind: "authorized_human", userId: "x", authority: "the model" }, decision: "ALLOW" } } })
      if (injected.verdict !== got.verdict || injected.reason !== got.reason) claimsMoved.push(`${risk}×${trust}×${v}`)
    }
    check(`the matrix: ${cells} cells (${risks.length} risk classes × ${trusts.length} trust spellings × ${verifs.length} verification states) all match the rule at the door — ALLOW ${counts.ALLOW} · HOLD ${counts.HOLD} · DENY ${counts.DENY}`, wrong.length === 0, wrong.slice(0, 6).join("\n      "))
    check("NEGATIVE CONTROL inside the matrix · some cells HOLD and some DENY (a rule that allowed everything would pass a vacuous matrix)", (counts.HOLD ?? 0) > 0 && (counts.DENY ?? 0) > 0 && counts.ALLOW > 0)
    check(`INJECT-005 / SCOPE-003 · a model's "approved / trusted / human_approval / verified" fields changed NO cell (0 of ${cells})`, claimsMoved.length === 0, claimsMoved.slice(0, 6).join(", "))
    const out = await decide({ riskClass: "FINANCIAL", trustClass: "verified_first_party", sink: { proposedTargetManager: "finance_manager", allowedManagers: ["ai_isa", "shopping_agent"] } })
    const unknownSet = await decide({ riskClass: "READ", trustClass: "verified_first_party", sink: { proposedTargetManager: "finance_manager", allowedManagers: null } })
    const inSet = await decide({ riskClass: "FINANCIAL", trustClass: "verified_first_party", sink: { proposedTargetManager: "ai_isa", allowedManagers: ["ai_isa"] } })
    check("INJECT-005 · a model-named target manager outside the caller's capability set is DENIED — even on a trusted origin; an unknown set is DENIED (fail closed)", out.verdict === "DENY" && out.reason === "target_outside_capability_set" && unknownSet.verdict === "DENY" && unknownSet.reason === "capability_set_unknown")
    check("NEGATIVE CONTROL · a target INSIDE the set is not refused for it", inSet.verdict === "ALLOW")
    check("an unreadable expiry does not execute (DENY decision_expired)", (await decide({ riskClass: "READ", trustClass: "verified_first_party", expiresAt: "not a date" })).verdict === "DENY")
  }

  // ══ C ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("C · the boundary — ledgerToolExecutions (AI SDK registries) and ledgerToolCall (the voice webhook) enforce the rule")
  {
    const uniq = { unique: { agent_action_ledger: [["idempotency_key"]] } }
    const world = countingClient({ agent_action_ledger: [], users: [], brokerage_settings: [] }, uniq)
    const provider = { calls: 0 }
    const model = { calls: 0 }
    const tool = () => ({ execute: async () => { provider.calls++; return { success: true } } })
    const risk: Record<string, string> = { send_signup_link: "COMMUNICATION", blast_sms_to_contact: "COMMUNICATION", pull_paid_owner_list: "FINANCIAL" }
    const registry = L.ledgerToolExecutions({ send_signup_link: tool(), blast_sms_to_contact: tool(), pull_paid_owner_list: tool() }, {
      brokerageId: B1, subject: { type: "contact", id: C1 }, riskClassOf: (n) => risk[n] ?? "IRREVERSIBLE", actor: { type: "manager", managerKey: "ai_isa" }, surface: "customer_tools", policyKey: "authority_level:ai_isa",
    }, { client: world.client as never }) as Record<string, { execute: (a: unknown, o?: { toolCallId?: string }) => Promise<Row> }>
    const rows = () => world.mem.tables.agent_action_ledger as Row[]
    const decisionRows = () => rows().filter((r) => /\.decision\./.test(String(r.action)))

    const sms = await registry.blast_sms_to_contact.execute({ to: "+15550100", body: "hi", approved: true }, { toolCallId: "call-sms-1" })
    check("SCOPE-001 · a model-proposed SMS with no named deterministic gate is HELD at the sink: ZERO provider calls, typed feedback (not a throw)",
      provider.calls === 0 && sms.success === false && sms.governance?.decision === "HOLD" && sms.governance?.reason === "unverified_untrusted_origin" && sms.governance?.next_trigger?.kind === "human", JSON.stringify(sms))
    check("…ONE decision row (agent.decision.wait shape: ai.decision.wait) with the HOLD, the reason, the next trigger and the contract facts",
      decisionRows().length === 1 && decisionRows()[0].action === "ai.decision.wait" && decisionRows()[0].detail?.governance?.decision === "HOLD" && decisionRows()[0].detail?.governance?.trust_class === "model_output" && decisionRows()[0].detail?.proposed_action === "ai.tool.blast_sms_to_contact"
      && (decisionRows()[0].detail?.model_claims_ignored ?? []).includes("approved"), JSON.stringify(decisionRows()[0]?.detail))
    await registry.blast_sms_to_contact.execute({ to: "+15550100", body: "hi" }, { toolCallId: "call-sms-1" })
    check("IDEMPOTENCY · the same refused call replayed adds ZERO rows and still never runs", decisionRows().length === 1 && provider.calls === 0, `${decisionRows().length} rows`)
    const paid = await registry.pull_paid_owner_list.execute({ zip: "32571", count: 5000 }, { toolCallId: "call-paid-1" })
    check("SCOPE-002 · a model-proposed PAID pull (FINANCIAL, no named gate) — zero paid calls, held, recorded once", provider.calls === 0 && paid.governance?.decision === "HOLD" && decisionRows().length === 2)

    // The routine permitted path: measured against the BASE wrapper (what ledgerToolExecutions did at 9d9626b9 — withActionLedger directly).
    const warm = countingClient({ agent_action_ledger: [], users: [], brokerage_settings: [] }, uniq)
    await L.withActionLedger({ brokerageId: B1, action: "ai.tool.warm_cache", actor: { type: "manager", managerKey: "ai_isa" }, subject: { type: "contact", id: C1 }, riskClass: "COMMUNICATION", cycle: "warm", policyKey: "authority_level:ai_isa" }, async () => ({ success: true }), { settle: () => ({ status: "executed", outcome: "tool_completed" }), replay: () => ({ success: false }) }, { client: warm.client as never })
    const base = countingClient({ agent_action_ledger: [], users: [], brokerage_settings: [] }, uniq)
    await L.withActionLedger({ brokerageId: B1, action: "ai.tool.send_signup_link", channel: "ai_tool", actor: { type: "manager", managerKey: "ai_isa" }, subject: { type: "contact", id: C1 }, riskClass: "COMMUNICATION", systemSource: "customer_tools", cycle: "call-base", detail: { tool: "send_signup_link" }, policyKey: "authority_level:ai_isa" },
      async () => { provider.calls++; return { success: true } }, { settle: () => ({ status: "executed", outcome: "tool_completed" }), replay: () => ({ success: false }) }, { client: base.client as never })
    const after = countingClient({ agent_action_ledger: [], users: [], brokerage_settings: [] }, uniq)
    const reg2 = L.ledgerToolExecutions({ send_signup_link: tool() }, { brokerageId: B1, subject: { type: "contact", id: C1 }, riskClassOf: () => "COMMUNICATION", actor: { type: "manager", managerKey: "ai_isa" }, surface: "customer_tools", policyKey: "authority_level:ai_isa" }, { client: after.client as never }) as Record<string, { execute: (a: unknown, o?: { toolCallId?: string }) => Promise<Row> }>
    const before = provider.calls
    const ok = await reg2.send_signup_link.execute({ email: "p@example.test" }, { toolCallId: "call-ok-1" })
    const okRow = (after.mem.tables.agent_action_ledger as Row[])[0]
    check(`ROUTINE · a permitted gated tool runs once with 0 model calls and the SAME database round trips as the base wrapper (base ${base.io.from} · after ${after.io.from})`,
      ok.success === true && provider.calls === before + 1 && model.calls === 0 && after.io.from === base.io.from && after.io.rpc === base.io.rpc, JSON.stringify({ base: base.io, after: after.io }))
    check("…its ledger row carries the contract: ALLOW, model_output cleared by the named gate (TOOL_APPROVAL_GATE.send_signup_link), complete for COMMUNICATION",
      okRow?.status === "executed" && okRow?.detail?.governance?.decision === "ALLOW" && okRow?.detail?.governance?.verification?.check === "TOOL_APPROVAL_GATE.send_signup_link" && okRow?.detail?.governance?.approval_basis === "policy_permitted" && complete(okRow?.detail?.governance, "COMMUNICATION"),
      JSON.stringify(gapsOf(okRow?.detail?.governance, "COMMUNICATION")))

    // ledgerToolCall — the voice webhook's door.
    const runs = { n: 0 }
    const call = (over: Partial<Parameters<typeof L.ledgerToolCall>[0]>, cycle: string) => L.ledgerToolCall({
      brokerageId: B1, action: "ai.tool.edit_commission_split", channel: "ai_tool", actor: { type: "user", userId: U1 }, subject: { type: "transaction", id: T1 },
      riskClass: "FINANCIAL", systemSource: "voice_assistant", cycle, trustClass: "model_output", ...over,
    }, async () => { runs.n++; return { success: true } }, { client: world.client as never }) as Promise<Row>
    const before3 = decisionRows().length
    const commission = await call({ sink: { modelClaims: { approved_by_broker: true, approval_basis: "human_approval", trust_class: "verified_first_party" } } }, "voice_hold:none-1")
    const payout = await call({ action: "ai.tool.release_payout", riskClass: "IRREVERSIBLE", sink: { modelClaims: { approved: true } } }, "voice:payout-1")
    const cda = await call({ action: "ai.tool.release_cda", riskClass: "LEGAL" }, "voice:cda-1")
    check("SCOPE-003 · a commission edit / an irreversible payout / a CDA release proposed by the model, with the model CLAIMING broker approval — all HELD, the write never ran",
      runs.n === 0 && [commission, payout, cda].every((r) => r.success === false && r.governance?.decision === "HOLD") && decisionRows().length === before3 + 3, JSON.stringify([commission.governance, payout.governance, cda.governance]))
    const pub = await call({ action: "ai.tool.send_sms_to_all", riskClass: "COMMUNICATION", trustClass: "fenceUntrusted" }, "inject-2")
    const doc = await call({ action: "ai.tool.mark_clear_to_close", riskClass: "LEGAL", trustClass: "uploaded_document_text" }, "inject-3")
    const vendor = await call({ action: "ai.tool.record_lender_approval", riskClass: "FINANCIAL", trustClass: "unseated_vendor_claim" }, "inject-4")
    const target = await call({ action: "ai.tool.move_money", riskClass: "FINANCIAL", trustClass: "verified_first_party", sink: { proposedTargetManager: "finance_manager", allowedManagers: ["ai_isa"] } }, "inject-5")
    check("INJECT-002 / 003 / 004 · a public post's instruction, a document's 'clear to close', an unseated vendor's claim — each HELD, nothing ran",
      runs.n === 0 && [pub, doc, vendor].every((r) => r.governance?.decision === "HOLD"), JSON.stringify([pub.governance?.reason, doc.governance?.reason, vendor.governance?.reason]))
    check("INJECT-005 · a model-named target manager outside the caller's set — DENIED (ai.decision.do_nothing), nothing ran", runs.n === 0 && target.governance?.decision === "DENY" && target.governance?.reason === "target_outside_capability_set" && decisionRows().some((r) => r.action === "ai.decision.do_nothing"))
    const expired = await call({ expiresAt: "2020-01-01T00:00:00.000Z", sink: { verification: { kind: "authorized_human", userId: U1, authority: "spoken_confirm_hold:h-old" } } }, "voice_hold:h-old")
    check("an EXPIRED decision does not execute even with a human verification on it (DENY decision_expired, next trigger re_evaluate)", runs.n === 0 && expired.governance?.reason === "decision_expired" && expired.governance?.next_trigger?.kind === "re_evaluate")
    const facts = { trustClass: "model_output", approvalBasis: "human_approval", dependencies: [{ type: "transaction", id: T1, version: null }, { type: "agent_assistant_tool_calls", id: "h-1", version: "hold_released" }] }
    const verification = { kind: "authorized_human" as const, userId: U1, authority: "spoken_confirm_hold:h-1" }
    const released = await call({ ...facts, sink: { verification }, detail: { governance: L.governanceRecord({ plane: "tool_boundary", verdict: "allow", scope: { brokerageId: B1, userId: U1 }, actor: { type: "user", id: U1 }, entity: { type: "transaction", id: T1 }, rationale: "the speaker confirmed the persisted read-back", ...facts, verification }) } }, "voice_hold:h-1")
    const relRow = rows().find((r) => r.action === "ai.tool.edit_commission_split" && r.status === "executed")
    check("NEGATIVE CONTROL · the speaker's confirm of the persisted hold (an authorized human under a named authority) EXECUTES once, and its row is contract-complete for FINANCIAL",
      runs.n === 1 && released.success === true && !!relRow && complete(relRow.detail?.governance, "FINANCIAL"), JSON.stringify(gapsOf(relRow?.detail?.governance, "FINANCIAL")))
    check(`zero provider / tool-run calls on every refusal in this section (provider ${provider.calls - 1} extra, tool runs ${runs.n - 1} extra)`, provider.calls === before + 1 && runs.n === 1)
  }

  // ══ D ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("D · conflicts — one accountable decider; the loser's typed outcome and next trigger land on its record")
  {
    const dc = await import("../lib/kernel/deconflict")
    const { sourceChannel } = await import("../lib/kernel/deconflict/lead-channel")
    const now = new Date()
    const w = countingClient({ isa_outreach_log: [], marketing_campaign_touchpoints: [], lifetime_customer_touchpoints: [], buyer_fatigue_scores: [], deconflict_suppression_log: [], newsletter_campaigns: [] })
    const sends: string[] = []
    const propose = async (manager: string, source: string) => {
      const d = await dc.evaluateDeconflict({ brokerageId: B1, channel: "sms", contactId: C1, systemSource: source, requestingManager: manager, client: w.client as never, now })
      if (d.allowed) { sends.push(manager); (w.mem.tables.isa_outreach_log as Row[]).push({ id: `t-${sends.length}`, brokerage_id: B1, contact_id: C1, channel: sourceChannel("isa_outreach_log", "sms"), sent_at: now.toISOString() }) }
      return d
    }
    const first = await propose("campaign_orchestrator", "sequence")
    const second = await propose("ai_isa", "ai_isa")
    const log = w.mem.tables.deconflict_suppression_log as Row[]
    const arb = second.arbitration as Record<string, any> | null
    check("SAME CONTACT · two managers, one SMS slot: exactly ONE sends; the second is refused by the existing cap", sends.length === 1 && first.allowed && !second.allowed, JSON.stringify(sends))
    check("…the refusal names the accountable decider (ai_isa), the winning touches, and the loser (ai_isa's proposal) RESCHEDULED with a time trigger — on the survivor's own log row",
      arb?.conflict_class === "same_contact" && arb?.decider === "ai_isa" && arb?.loser?.manager === "ai_isa" && arb?.loser?.outcome === "RESCHEDULE" && arb?.loser?.next_trigger?.kind === "time" && log[1]?.metadata?.arbitration?.loser?.outcome === "RESCHEDULE",
      JSON.stringify(arb))
    check("NEGATIVE CONTROL · the allowed send carries no conflict record (nothing lost)", first.arbitration === null && !log[0]?.metadata?.arbitration)

    const cast = async (manager: string) => {
      const d = await dc.evaluateBroadcastDeconflict({ brokerageId: B1, channel: "newsletter", systemSource: "newsletter", requestingManager: manager, client: w.client as never, now })
      if (d.allowed) (w.mem.tables.newsletter_campaigns as Row[]).push({ id: `n-${manager}`, brokerage_id: B1, status: "sent", send_date: now.toISOString() })
      return d
    }
    const n1 = await cast("campaign_orchestrator")
    const n2 = await cast("sphere_of_influence")
    const sent = (w.mem.tables.newsletter_campaigns as Row[]).length
    check("SAME CAMPAIGN SLOT · two managers, one weekly newsletter slot: exactly ONE goes; the other is RESCHEDULED by the decider campaign_orchestrator with a next trigger",
      sent === 1 && n1.allowed && !n2.allowed && (n2.arbitration as Row)?.decider === "campaign_orchestrator" && (n2.arbitration as Row)?.loser?.manager === "sphere_of_influence" && (n2.arbitration as Row)?.loser?.next_trigger?.kind === "time", JSON.stringify(n2.arbitration))

    // COMPETING PROVIDER SPEND — the atomic envelope consume picks one; the loser's ledger row carries HOLD + the period reset.
    const budgets = await import("../lib/kernel/autonomy-budgets")
    let consumed = 0
    const spend = countingClient({ agent_action_ledger: [], users: [], brokerage_settings: [] }, { unique: { agent_action_ledger: [["idempotency_key"]] } }, async (fn, args) => {
      if (fn !== "consume_autonomy_budget") return { data: null, error: { code: "PGRST202", message: "absent" } }
      const amt = Number(args.p_amount), cap = Number(args.p_period_cap)
      if (consumed + amt > cap) return { data: { ok: false, reason: `period cap ${cap} reached` }, error: null }
      consumed += amt
      return { data: { ok: true, id: `cons-${consumed}`, period_consumed: consumed, scope_consumed: null }, error: null }
    })
    const policy = budgets.resolveAutonomyBudgets({ autonomy_budgets: { experiments: { max_usd_per_month: 100 } } })
    const ask = (manager: string, key: string) => budgets.consumeAutonomyEnvelope(spend.client as never, { brokerageId: B1, envelope: "experiment_budget", amount: 60, reasonCode: "UNSPECIFIED", reasonDetail: `${manager} wants 60`, subject: { type: "experiment", id: key }, idempotencyKey: `spend:${key}`, requestingManager: manager, now: new Date("2026-11-19T12:00:00Z") }, { policy })
    const s1 = await ask("campaign_orchestrator", "exp-a")
    const s2 = await ask("ads_manager", "exp-b")
    const spendRows = spend.mem.tables.agent_action_ledger as Row[]
    const loserRow = spendRows.find((r) => r.subject_id === "exp-b")
    const g = loserRow?.detail?.governance as Row | undefined
    check("COMPETING SPEND · two managers on one $100 envelope ask $60 each: exactly ONE is consumed", s1.allowed && !s2.allowed && consumed === 60, JSON.stringify({ s1: s1.allowed, s2: s2.allowed, consumed }))
    check("…the loser's ledger row (same settle — no extra write) carries HOLD, the decider (the envelope's owner campaign_orchestrator), the loser ads_manager and its next trigger: the period reset 2026-12-01",
      loserRow?.status === "skipped" && g?.decision === "HOLD" && g?.arbitration?.decider === "campaign_orchestrator" && g?.arbitration?.loser?.manager === "ads_manager" && g?.arbitration?.loser?.outcome === "HOLD"
      && g?.next_trigger?.at === "2026-12-01T00:00:00.000Z" && g?.expires_at === "2026-12-01T00:00:00.000Z" && !!loserRow?.detail?.envelope, JSON.stringify(g))
    const winRow = spendRows.find((r) => r.subject_id === "exp-a")
    check("NEGATIVE CONTROL · the winner's row is ALLOW with no conflict block, and the envelope detail survived the settle", winRow?.status === "executed" && winRow?.detail?.governance?.decision === "ALLOW" && winRow?.detail?.governance?.arbitration === null && winRow?.detail?.envelope?.key === "experiment_budget")

    // SAME TRANSACTION VERSION — two managers act on one delegation (subject: a transaction) on the version they both read.
    const del = await import("../lib/kernel/manager-delegation")
    const dw = countingClient({ manager_delegations: [{ id: "dg-1", mission_id: null, brokerage_id: B1, requesting_manager: "ai_isa", assigned_manager: "deal_coordinator", requested_capability: "transaction_milestones", objective: "re-time the inspection", input_entities: { transactionId: T1, subject_type: "transaction", subject_id: T1 }, required_output: {}, authority: 1, budget: {}, deadline: null, status: "REQUESTED", created_at: now.toISOString(), updated_at: now.toISOString() }], manager_delegation_events: [] })
    const deps = { ledger: async () => null, emit: async () => undefined, signal: async () => undefined, mission: {} } as never
    const [r1, r2] = await Promise.all([
      del.acceptDelegation({ brokerageId: B1, delegationId: "dg-1", actor: { type: "manager", id: "deal_coordinator" } }, dw.client as never, deps),
      del.cancelDelegation({ brokerageId: B1, delegationId: "dg-1", reason: "superseded", actor: { type: "manager", id: "ai_isa" } }, dw.client as never, deps),
    ])
    const refused = (dw.mem.tables.manager_delegation_events as Row[]).find((e) => e.event_kind === "refused")
    check("SAME TRANSACTION VERSION · two writers on the version both read: exactly ONE transition lands (compare-and-set)", [r1, r2].filter((r) => r.ok).length === 1, JSON.stringify([r1.ok ? "ok" : (r1 as Row).reason, r2.ok ? "ok" : (r2 as Row).reason]))
    check("…the loser is no longer silent: a refused event carries same_transaction_terms, the decider (deal_coordinator), HOLD and a re-evaluate trigger",
      refused?.evidence?.arbitration?.conflict_class === "same_transaction_terms" && refused?.evidence?.arbitration?.decider === "deal_coordinator" && refused?.evidence?.arbitration?.loser?.outcome === "HOLD" && refused?.evidence?.arbitration?.loser?.next_trigger?.kind === "re_evaluate",
      JSON.stringify(refused?.evidence))

    // CENSUS — who WRITES a transaction's terms (contract_term_versions inserts keyed to a transaction / offer chain). Stripped source.
    const termInsert = /\.from\(\s*["']contract_term_versions["']\s*\)\s*\.insert\(\s*\{([\s\S]{0,600}?)\}\s*\)/g
    const finder = (src: string): Array<{ subject: string }> => {
      const out: Array<{ subject: string }> = []
      for (const m of stripComments(src).matchAll(termInsert)) out.push({ subject: /listing_agreement_id:\s*(?!null)/.test(m[1]) ? "listing_agreement" : /transaction_id|root_offer_id|offer_id/.test(m[1]) ? "transaction_or_offer" : "unknown" })
      return out
    }
    const files: string[] = []
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) { if (n !== "node_modules" && !n.startsWith(".")) walk(p) } else if (/\.(ts|tsx)$/.test(n)) files.push(p) } }
    walk("lib"); walk("app")
    const writers = new Map<string, string[]>()
    for (const f of files) { const hits = finder(readFileSync(f, "utf8")); if (hits.length) writers.set(f, hits.map((h) => h.subject)) }
    const txWriters = [...writers.entries()].filter(([, s]) => s.includes("transaction_or_offer")).map(([f]) => f)
    check(`CENSUS · contract_term_versions INSERT writers: ${writers.size} file(s) (${[...writers.entries()].map(([f, s]) => `${f}: ${s.join("/")}`).join("; ")}) — a transaction's / offer chain's terms have ONE writer (${txWriters.join(", ")}); the other writes a LISTING AGREEMENT's terms (a different subject): no second writer competes for one transaction's terms — its self-race is the unique version index (23505 → "retry")`,
      txWriters.length === 1 && txWriters[0].endsWith("lib/offers/governing-terms.ts"), JSON.stringify([...writers.entries()]))
    check("POSITIVE CONTROL · the finder catches a planted second transaction-terms writer, and does NOT count a tombstone comment naming the call",
      finder(`const x = await svc.from("contract_term_versions").insert({ transaction_id: t, version_no: 9 })`).length === 1
      && finder(`// was: svc.from("contract_term_versions").insert({ transaction_id: t }) — moved to governing-terms.ts:302`).length === 0)
  }

  // ══ E ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("E · the live budget (SCOPE-006) — the fallback answers in time, the late result settles once, the row is contract-complete")
  {
    const arb = await import("../lib/ai-isa/followup-arbiter")
    const { platformFollowupPolicy } = await import("../lib/ai-isa/followup-policy")
    const facts = { subject: "contact", relationship: { type: "contact", persona: null, hasAssignedAgent: true }, intent: null, history: { hoursSinceAnyTouch: 96, hoursSinceAgentTouch: null, campaignTouches7d: 0, lastChannel: null, portalEducationViews: null }, journey: { transactionStage: null, nextMilestone: null, openLessons: null, nextLesson: null }, preferences: [], fatigueRisk: null, localHour: 11, moment: { key: "nurture", intent: "a routine nurture check-in", daysSinceOpen: 0 }, blindSpots: [] }
    const touch = { id: "send_now", kind: "communication", channels: ["email"], why: ["the planned routine touch"] }
    const menu = { menu: [touch, { id: "wait", kind: "wait", channels: [], why: ["hold"] }], locked: null }
    const model = { calls: 0 }
    const late: Array<{ decision: unknown }> = []
    const slow = () => { model.calls++; return new Promise<Row>((r) => setTimeout(() => r({ optionId: "send_now", channel: "email", format: null, waitHours: null, rationale: "routine, answered late", evidence: ["history", "moment"], confidence: 0.8 }), 150)) }
    const t0 = performance.now()
    const d = await arb.arbitrateFollowUp({ brokerageId: B1, facts: facts as never, menu: menu as never, planned: touch as never, policy: platformFollowupPolicy(), latencyBudgetMs: 25, onLateResult: (l) => { late.push(l) } }, { decide: slow as never })
    const ms = performance.now() - t0
    const now = new Date()
    const detail = arb.arbitrationLedgerDetail(d, null, { now }) as Row
    check(`a SLOW model (150 ms) against a 25 ms budget: the planned fallback answers in ${Math.round(ms)} ms (deterministic send_now), the obligation is persisted`,
      ms < 150 && d.source === "deterministic" && d.optionId === "send_now" && !!d.timedOut && detail.late_obligation?.status === "pending", JSON.stringify({ ms, source: d.source, timedOut: d.timedOut }))
    check("…the decision row now says what happens next and when it lapses: next trigger = the late-result settlement event, expiry = the obligation's TTL",
      detail.next_trigger?.kind === "event" && detail.next_trigger?.event === "inbound.late_result.settle" && detail.expires_at === new Date(now.getTime() + arb.LATE_OBLIGATION_TTL_MINUTES * 60_000).toISOString(), JSON.stringify({ n: detail.next_trigger, e: detail.expires_at }))
    await new Promise((r) => setTimeout(r, 220))
    console.log(`  · late hand-offs: ${late.length}, model calls: ${model.calls}, late decision: ${JSON.stringify(late[0]?.decision ?? null).slice(0, 160)}`)
    check("the late answer is handed over ONCE as evidence (never executed by the arbiter) — 1 model call, 1 late hand-off", model.calls === 1 && late.length === 1 && (late[0].decision as Row)?.optionId === "send_now" && (late[0].decision as Row)?.source === "ai")
    const own = { humanOwnedUntil: null, ownedReason: null, humanEngagedAt: null, lastOutboundAt: null, lastInboundAt: null }
    const decidedAt = now.toISOString()
    const answered = arb.lateResultDisposition({ decidedAt, fallbackAnswered: true, fallbackOptionId: "send_now", lateOptionId: "wait", ownership: own, now: new Date(now.getTime() + 1000) })
    const reopen = arb.lateResultDisposition({ decidedAt, fallbackAnswered: false, fallbackDispatchFailed: true, fallbackOptionId: "send_now", lateOptionId: "send_now", ownership: own, now: new Date(now.getTime() + 1000) })
    check("NO DOUBLE SEND · the fallback already answered → the late result is stale_answered (nothing sent twice); a failed fallback → a FRESH re-arbitration, never the late answer's own execution",
      answered.disposition === "stale_answered" && reopen.disposition === "re_arbitrate", JSON.stringify([answered, reopen]))
    const fastLate: unknown[] = []
    const fast = await arb.arbitrateFollowUp({ brokerageId: B1, facts: facts as never, menu: menu as never, planned: touch as never, policy: platformFollowupPolicy(), latencyBudgetMs: 2_500, onLateResult: (l) => { fastLate.push(l) } }, { decide: async () => ({ optionId: "send_now", channel: "email", format: null, waitHours: null, rationale: "a routine nurture touch", evidence: ["history", "moment"], confidence: 0.9 }) as never })
    const fastDetail = arb.arbitrationLedgerDetail(fast, null, { now }) as Row
    check("NEGATIVE CONTROL · a model inside its budget: no timeout, no late obligation, no late hand-off; its next trigger is a re-evaluation", !fast.timedOut && !fastDetail.late_obligation && fastLate.length === 0 && fastDetail.next_trigger?.kind === "re_evaluate")
    const rw = countingClient({ agent_action_ledger: [], users: [], brokerage_settings: [] })
    const rec = await arb.recordArbitration(rw.client, { brokerageId: B1, subject: { type: "contact", id: C1 }, decision: d, now, policyRef: "followup_policy@1", systemSource: "canary" })
    const row = (rw.mem.tables.agent_action_ledger as Row[])[0]
    check("the arbiter's decision row (recordArbitration) carries the governance block and is contract-complete (risk unstated → judged consequential)",
      rec.recorded && complete(row?.detail?.governance, null) && row?.detail?.governance?.next_trigger?.event === "inbound.late_result.settle", JSON.stringify(gapsOf(row?.detail?.governance, null)))
  }

  // ══ F ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("F · wiring — stripped source: both model-tool doors call the rule; the governanceRecord( reach")
  {
    const bodyOf = (src: string, head: string): string => { const s = stripComments(src); const i = s.indexOf(head); if (i < 0) return ""; const end = s.indexOf("\n}\n", i); return s.slice(i, end < 0 ? i + 4000 : end) }
    const ledgerSrc = readFileSync("lib/kernel/action-ledger.ts", "utf8")
    const wired = (src: string) => /sinkVerdictFor\(/.test(bodyOf(src, "export function ledgerToolCall")) && /sinkVerdictFor\(/.test(bodyOf(src, "export function ledgerToolExecutions"))
    check("both doors model tool calls pass through (ledgerToolCall · ledgerToolExecutions) call the sink rule before the claim", wired(ledgerSrc))
    check("POSITIVE CONTROL · the finder flags a door whose rule call survives only in a comment", !wired(ledgerSrc.replace(/const verdict = sinkVerdictFor\(ctx, opts\?\.now\)/, "// const verdict = sinkVerdictFor(ctx, opts?.now)\n  const verdict = { decision: \"ALLOW\" } as never")))
    const files: string[] = []
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) { if (n !== "node_modules" && !n.startsWith(".")) walk(p) } else if (/\.(ts|tsx)$/.test(n)) files.push(p) } }
    walk("lib"); walk("app")
    const sites = files.flatMap((f) => (stripComments(readFileSync(f, "utf8")).match(/\bgovernanceRecord\(/g) ?? []).map(() => f))
    const byFile = [...new Set(sites)].map((f) => `${f}×${sites.filter((x) => x === f).length}`)
    console.log(`  · governanceRecord( occurrences in app/ + lib/ (stripped, incl. the definition): ${sites.length} in ${new Set(sites).size} files — ${byFile.join(", ")}`)
    check("the record reaches the voice route, delegation, the spend envelope and the follow-up arbiter (each a real writer of decisions)", ["app/api/agent-assistant/tool-call/route.ts", "lib/kernel/manager-delegation.ts", "lib/kernel/autonomy-budgets.ts", "lib/ai-isa/followup-arbiter.ts"].every((f) => sites.includes(f)))
  }

  // ══ G ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("G · ledgerSessionAction — the one wrapper for a user-initiated write (integrator addendum, for the repair lanes)")
  {
    const w = countingClient({ agent_action_ledger: [], users: [], brokerage_settings: [] }, { unique: { agent_action_ledger: [["idempotency_key"]] } })
    const rows = () => w.mem.tables.agent_action_ledger as Row[]
    const runs = { n: 0 }
    const ctx = (cycle: string, action = "commission.split.update") => ({ brokerageId: B1, action, actor: { type: "user" as const, userId: U1 }, subject: { type: "transaction", id: T1 }, riskClass: "FINANCIAL", cycle })
    const before = w.io.from
    const ok = await L.ledgerSessionAction(ctx("s-1"), async () => { runs.n++; return { success: true, id: "x" } }, { client: w.client as never }) as Row
    const r1 = rows().find((r) => r.idempotency_key?.endsWith(":s-1"))
    check("EXECUTED · a session write runs once and settles executed; the trust class defaults to authorized_human for a user actor with a userId",
      ok.success === true && runs.n === 1 && r1?.status === "executed" && r1?.detail?.governance?.trust_class === "authorized_human", JSON.stringify(r1))
    check(`…claim + settle only: ${w.io.from - before} round trips beyond the actor / policy reads the base wrapper also makes`, w.io.from - before <= 4, String(w.io.from - before))
    const failed = await L.ledgerSessionAction(ctx("s-2"), async () => ({ success: false, error: "the split exceeds the deal" }), { client: w.client as never }) as Row
    check("FAILED RESULT · `success: false` settles failed (the tool wrapper's ONE rule, not a second)", failed.success === false && rows().find((r) => r.idempotency_key?.endsWith(":s-2"))?.status === "failed")
    let threw = false
    try { await L.ledgerSessionAction(ctx("s-3"), async () => { throw new Error("socket hang up") }, { client: w.client as never }) } catch { threw = true }
    check("THROWN · a thrown run is rethrown to the caller and settled (timeout-like → unknown, never retried blindly)", threw && rows().find((r) => r.idempotency_key?.endsWith(":s-3"))?.status === "unknown")
    const replay = await L.ledgerSessionAction(ctx("s-1"), async () => { runs.n++; return { success: true } }, { client: w.client as never }) as Row
    check("REPLAY · the same cycle again never calls run (typed result from the executed winner)", runs.n === 1 && replay.success === true)
    const bad = await L.ledgerSessionAction(ctx("s-4", "commission.update"), async () => { runs.n++; return { success: true } }, { client: w.client as never }) as Row
    check("NEGATIVE · a two-segment action name is REFUSED by the claim — typed refusal, run not called", runs.n === 1 && bad.success === false && typeof bad.error === "string")
    await L.ledgerSessionAction({ ...ctx("s-5"), actor: { type: "system" } }, async () => ({ success: true }), { client: w.client as never })
    check("NEGATIVE · a system actor gets NO default trust class (nothing set that the caller did not pass)", !rows().find((r) => r.idempotency_key?.endsWith(":s-5"))?.detail?.governance)
  }

  console.log(`\nGUARD_RESULT arbiter-decision-contract: ${passes} passed, ${failures} failed (SIMULATED — in-memory clients, counting seams)`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
