#!/usr/bin/env tsx
/**
 * scripts/manager-deliberation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MANAGER DELIBERATION harness (round 35 — "the managers should also argue a
 * solution and work through the reason why that solution is the best for the
 * situation").
 *
 * Layer 1 (pure): the registry's deliberate flags land ONLY on genuine-tradeoff
 *   domains (SIX after round 36's full build-out); refusals for non-collaboration
 *   pairs still hold; the grounding guard (filterEvidenceToCitations) drops invented
 *   evidence; deliberate() produces grounded positions, ONE bounded rebuttal round
 *   when positions directly conflict (rebuttal evidence grounded through the same
 *   guard; engines without rebut hold none; the bound is structural), a resolution
 *   that states the WHY, honest dissent only on merit, and an honest 'unavailable'
 *   record on an unreachable/junk engine (never canned arguments); THE PRINCIPAL'S
 *   CALL (applyPrincipalOverride) only lands on resolved records, only picks argued
 *   positions, always requires a reason; teamwork rollup math (counts, odd/even
 *   median, dissents, rebuttals, overrides) and omit-when-empty on both the QBR
 *   section and the teamwork lines; REGISTRY-DRIVEN emitter coverage — every
 *   deliberative domain has a live raiser in REFERRAL_EMITTERS (sweeps carry a
 *   runnable entry point, hooks are proven by source markers) and a fact loader for
 *   every participant; the referral handler source actually escalates (wiring
 *   check, doc-kernel idiom).
 * Layer 2 (live, creds-gated): a real referral is raised on the bus
 *   (listing_demand_bridge), runDeliberation grounds briefs from the tenant's own
 *   tables, persists the record onto the referral row (payload.deliberation), the
 *   principal's call persists onto the SAME row (recordPrincipalOverride), the
 *   metrics loader rolls both up, and a retried deliberation NEVER re-argues (the
 *   persisted record is reused even with a throwing engine). Self-cleans.
 *
 * Run: npx tsx scripts/manager-deliberation-simulator.ts
 * Suggested npm script: "test:manager-deliberation": "tsx scripts/manager-deliberation-simulator.ts"
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  MANAGERS, MANAGER_COLLABORATIONS, canRefer, collaborationsFor, type ManagerKey,
} from "../lib/kernel/manager-registry"
import { composeTeamArgumentMap } from "../lib/managers/team-argument-map"
import { validateReferral, REFERRAL_EMITTERS, emittersForDomain } from "../lib/managers/cross-referral"
import {
  isDeliberativeDomain, deliberativeDomains, filterEvidenceToCitations,
  validResolutionWinner, summarizeDeliberation, parseDeliberation, deliberate,
  positionsDirectlyConflict, applyPrincipalOverride, effectiveWinner,
  MANAGER_FACT_LOADERS, DELIBERATION_UNAVAILABLE,
  type ManagerBrief, type DeliberationEngine, type DeliberationRecord,
} from "../lib/managers/deliberation"
import {
  rollupTeamwork, median, composeTeamworkLines, type ReferralLedgerRow,
} from "../lib/managers/teamwork-metrics"
import { composeQuarterlyReview } from "../lib/intelligence/quarterly-review"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Manager Deliberation (argued teamwork) verified")
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// A deterministic engine: argues from the brief (with deliberately invented evidence
// mixed in, to prove the grounding guard), REBUTS with one cited pushback (invented
// evidence mixed in again, to prove the rebuttal rides the same guard), resolves to
// the first position, dissents for the second — every behavior asserted below is the
// CODE's, not the model's. rebutCalls counts invocations to prove the one-round bound.
function fixtureEngine(overrides: Partial<DeliberationEngine> = {}): DeliberationEngine & { rebutCalls: { count: number } } {
  const rebutCalls = { count: 0 }
  return {
    rebutCalls,
    argue: async ({ manager, brief, ask }) => ({
      proposal: `${MANAGERS[manager].label}'s solution to: ${ask.slice(0, 60)}`,
      reasoning: brief.facts[0] ? `Grounded in: ${brief.facts[0]}` : "No domain rows in the window — arguing from the situation alone.",
      risks: ["could be wrong"],
      evidence: [...(brief.citations[0] ? [brief.citations[0]] : []), "totally.invented=42 (made.up.id=999)"],
    }),
    rebut: async ({ manager, others, brief }) => {
      rebutCalls.count += 1
      return {
        rebuttal: `${MANAGERS[manager].label} disputes ${others.length} other position(s) on the facts`,
        evidence: [...(brief.citations[0] ? [brief.citations[0]] : []), "fabricated.rebuttal=1 (nope.id=0)"],
      }
    },
    resolve: async ({ positions }) => ({
      winner: positions[0].manager,
      why: `it addresses the situation's facts directly while the other ${positions.length - 1} position(s) optimize a narrower slice`,
      dissent: positions[1] ? { manager: positions[1].manager, note: "the losing position correctly flags real demand-side risk" } : null,
    }),
    ...overrides,
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Manager Deliberation simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1a · the deliberate flags — argument only where the overlap is a real tradeoff]")
  const flagged = deliberativeDomains().map((d) => d.key).sort()
  check("exactly the NINE tradeoff domains are deliberative (rounds 36+38 + round 41's no-noise audit adds: referral-fee terms vs closing margin, dropped sequence touch vs ISA cadence)",
    JSON.stringify(flagged) === JSON.stringify([
      "assignment_policy_outcomes", "closing_money_and_risk", "lead_quality_spend",
      "listing_demand_bridge", "organic_paid_content", "recruiting_offer_economics",
      "referral_fee_economics", "sequence_touch_cadence", "transaction_vendor_selection",
    ]), flagged.join(","))
  check("isDeliberativeDomain: listing_demand_bridge (a pricing dispute by construction) → true",
    isDeliberativeDomain("listing_demand_bridge"))
  check("isDeliberativeDomain: approval_queue_slo (an SLA nag — one obvious action, nothing to argue) → false",
    !isDeliberativeDomain("approval_queue_slo"))
  check("isDeliberativeDomain: unknown/null domains → false",
    !isDeliberativeDomain("no_such_domain") && !isDeliberativeDomain(null))
  check("deliberate flags did NOT change pre-existing membership (no stewardship drift) and the new edges declare exactly their two disputing seats",
    MANAGER_COLLABORATIONS.listing_demand_bridge.managers.length === 2
    && MANAGER_COLLABORATIONS.closing_money_and_risk.managers.length === 3
    && MANAGER_COLLABORATIONS.organic_paid_content.managers.length === 2
    && JSON.stringify(MANAGER_COLLABORATIONS.lead_quality_spend.managers.slice().sort()) === JSON.stringify(["ads_manager", "ai_isa"])
    && JSON.stringify(MANAGER_COLLABORATIONS.recruiting_offer_economics.managers.slice().sort()) === JSON.stringify(["finance_manager", "recruiting_manager"])
    && JSON.stringify(MANAGER_COLLABORATIONS.transaction_vendor_selection.managers.slice().sort()) === JSON.stringify(["data_steward", "deal_coordinator"])
    && JSON.stringify(MANAGER_COLLABORATIONS.assignment_policy_outcomes.managers.slice().sort()) === JSON.stringify(["ai_isa", "data_steward"])
    && JSON.stringify(MANAGER_COLLABORATIONS.referral_fee_economics.managers.slice().sort()) === JSON.stringify(["finance_manager", "sphere_of_influence"])
    && JSON.stringify(MANAGER_COLLABORATIONS.sequence_touch_cadence.managers.slice().sort()) === JSON.stringify(["ai_isa", "campaign_orchestrator"])
    && JSON.stringify(MANAGER_COLLABORATIONS.public_records_seller_signals.managers.slice().sort()) === JSON.stringify(["ai_isa", "data_steward"])
    // 16 → 18. The count is here so an edge cannot be MINTED SILENTLY — a new
    // collaboration widens canRefer, so the total is a tripwire, not decoration.
    // But the claim this check makes is about DRIFT, and the two additions do
    // not drift anything: every per-edge membership asserted above is unchanged,
    // and the nine-deliberative-domain check directly above still passes, which
    // is the substantive half. Both new edges are NON-deliberative — a handoff
    // with no tradeoff to argue — so neither can reach the deliberation path:
    //
    //   tenant_principal_books            finance_manager + data_steward + recruiting_manager
    //     Whether a team-scale tenant's lead reads its books. Money is
    //     finance_manager's; the tier/identity facts the condition is built from
    //     (brokerages, subscriptions, users) are data_steward's; `teams` — the
    //     leadership anchor — is recruiting_manager's. The owner ruled the
    //     boundary ("yes to the team lead and agents"), so there is nothing to
    //     deliberate; the edge exists so the seam has a named owner.
    //
    //   seller_signal_education_routing   data_steward + ai_isa + shopping_agent + listing_concierge
    //     A protected-class-derived seller signal reaching the education channel
    //     selector. Again a handoff: the signal's steward hands a fact to the
    //     selector. No REFERRAL_EMITTERS raiser exists for it, so flagging it
    //     deliberative would be aspirational — an edge that declares an argument
    //     nothing can raise.
    //
    // Adding an edge is the CORRECT response to a cross-manager seam (the
    // repo's ownership model is cross-cooperative by design). Bumping this
    // number without naming the edges would turn the tripwire off.
    //
    // 18 → 19. NAMED, per the rule directly above — bumping the number without
    // naming the edge is how the tripwire gets turned off:
    //
    //   ad_audience_basis                 ads_manager + compliance_officer
    //     What an ad audience is segmented ON. facebook_custom_audiences.source_rule
    //     is written and read by ads_manager's commands; the rules deciding whether
    //     that jsonb may be acted on are compliance_officer's (the protected-class
    //     refusal and the owner's positive persona rule). The vocabularies OVERLAP by
    //     construction — four canonical Persona members (senior, probate, divorce,
    //     military) are also PROTECTED_CLASS_TOKENS — so the seam needs a named owner.
    //     NON-deliberative: the owner ruled both halves, so there is nothing to argue,
    //     and no REFERRAL_EMITTERS raiser exists for it.
    // 19 → 20. NAMED, per the rule above — bumping the number without naming
    // the edge is how the tripwire gets turned off:
    //
    //   benefit_offerings                 recruiting_manager + finance_manager + compliance_officer
    //     OWNER RULING (2026-08-27): brokerages mark residual income / medical /
    //     retirement in settings. The marks are written by the finance-gated
    //     settings home, READ by recruiting surfaces (pitch kit, careers page,
    //     retention lever), and WORDED under compliance's offered-never-promised
    //     rule — a mark flipped on the finance side silently changes what
    //     recruiting advertises, which is exactly the seam that must be declared.
    //     NON-deliberative: the broker declares, finance gates, compliance words —
    //     a settled handoff chain with no live raiser that could stage an argument.
    && Object.keys(MANAGER_COLLABORATIONS).length === 20
    && !isDeliberativeDomain("tenant_principal_books")
    && !isDeliberativeDomain("seller_signal_education_routing")
    && !isDeliberativeDomain("ad_audience_basis")
    && !isDeliberativeDomain("benefit_offerings")
    && JSON.stringify(MANAGER_COLLABORATIONS.benefit_offerings.managers.slice().sort()) === JSON.stringify(["compliance_officer", "finance_manager", "recruiting_manager"])
    && JSON.stringify(MANAGER_COLLABORATIONS.ad_audience_basis.managers.slice().sort()) === JSON.stringify(["ads_manager", "compliance_officer"]))
  check("every deliberative domain's evidence names its LIVE RAISER (no aspirational edges)",
    deliberativeDomains().every((d) => /raiser|sweep|hook|assignVendorToTransaction|publish/i.test(d.evidence)))

  console.log("\n[Layer 1b · refusals for non-collaboration pairs still hold]")
  check("recruiting_manager → ads_manager shares NO collaboration domain → canRefer false",
    !canRefer("recruiting_manager", "ads_manager"))
  const badEdge = validateReferral({ fromManager: "marketing_agent", toManager: "deal_coordinator", collabDomain: "organic_paid_content" })
  check("a deliberative domain still refuses an undeclared edge (marketing → deal_coordinator on organic_paid_content)",
    !badEdge.ok && (badEdge as { reason: string }).reason.includes("MANAGER_COLLABORATIONS"))
  const goodEdge = validateReferral({ fromManager: "listing_concierge", toManager: "shopping_agent", collabDomain: "listing_demand_bridge" })
  check("the declared edge on the deliberative domain still validates", goodEdge.ok)

  console.log("\n[Layer 1c · the grounding guard — evidence can never be invented]")
  const cits = ["listings.list_price=799000 (listings.id=a1)", "listings.showing_count=3 (listings.id=a1)"]
  check("invented evidence is dropped; verbatim citations survive",
    JSON.stringify(filterEvidenceToCitations(["totally.invented=42", cits[0]], cits)) === JSON.stringify([cits[0]]))
  check("all-invented evidence falls back to the loader's REAL citations (never stands on fiction)",
    JSON.stringify(filterEvidenceToCitations(["fake.a=1", "fake.b=2"], cits)) === JSON.stringify(cits))
  check("no citations at all → honest empty evidence",
    filterEvidenceToCitations(["fake.a=1"], []).length === 0)

  console.log("\n[Layer 1d · deliberate() — argued positions, the stated why, dissent on merit]")
  const domain = MANAGER_COLLABORATIONS.listing_demand_bridge
  const briefs: ManagerBrief[] = [
    { manager: "listing_concierge", facts: ["12 Oak St — list price $799,000, 41 days on market, 3 showings"], citations: cits },
    { manager: "shopping_agent", facts: ["9 buyer saves on this listing (2 high-interest)", "1 live offer, best $749,000"], citations: ["saved_properties.count=9 (saved_properties.listing_id=a1)", "offers.offer_price=749000 (offers.id=o1)"] },
  ]
  const rec = await deliberate({
    domain, ask: "41 days on market with demand evidence piling up — argue the price move.",
    raisedBy: "listing_concierge", briefs, brokerageId: "b-test", engine: fixtureEngine(), now: new Date("2026-07-20T12:00:00Z"),
  })
  check("every participating manager argued a position", rec.status === "resolved" && rec.positions.length === 2
    && rec.positions.map((p) => p.manager).sort().join(",") === "listing_concierge,shopping_agent")
  check("positions are GROUNDED — the invented citation was filtered from every position",
    rec.positions.every((p) => p.evidence.every((e) => !e.includes("invented"))))
  check("each position's evidence is field-level citations from its OWN manager's loader",
    rec.positions[0].evidence[0] === cits[0] && rec.positions[1].evidence[0].startsWith("saved_properties."))
  check("the resolution names a winner who actually argued", rec.winner !== null && validResolutionWinner(rec.winner!, rec.positions))
  check("the resolution states WHY the winner beats the others",
    (rec.resolution ?? "").includes("addresses the situation's facts"))
  check("dissent recorded honestly for the losing position with merit",
    rec.dissent?.manager === "shopping_agent" && rec.dissent.note.includes("demand-side risk"))
  const summary = summarizeDeliberation(rec)
  check("the consumed-action summary carries positions count + winner + the why + the dissent",
    summary.includes("2 positions argued") && summary.includes("won:") && summary.includes("DISSENT on the record"))

  // Dissent hygiene: a dissent naming the WINNER (or a non-participant) is discarded.
  const recNoDissent = await deliberate({
    domain, ask: "same", raisedBy: "listing_concierge", briefs, brokerageId: "b-test",
    engine: fixtureEngine({
      resolve: async ({ positions }) => ({ winner: positions[0].manager, why: "clear win", dissent: { manager: positions[0].manager, note: "self-dissent?" } }),
    }),
  })
  check("a dissent naming the WINNER is discarded — dissent only ever attaches to a losing position",
    recNoDissent.status === "resolved" && recNoDissent.dissent === null)

  console.log("\n[Layer 1d2 · THE ONE BOUNDED REBUTTAL ROUND (round 36) — cited pushback, same grounding guard, structural bound]")
  check("positionsDirectlyConflict: distinct proposals conflict; unanimous/single positions do not",
    positionsDirectlyConflict([
      { manager: "listing_concierge", proposal: "Hold the price", reasoning: "", risks: [], evidence: [] },
      { manager: "shopping_agent", proposal: "Cut to $749k", reasoning: "", risks: [], evidence: [] },
    ])
    && !positionsDirectlyConflict([
      { manager: "listing_concierge", proposal: "Cut to $749k", reasoning: "", risks: [], evidence: [] },
      { manager: "shopping_agent", proposal: "  cut to  $749K ", reasoning: "", risks: [], evidence: [] },
    ])
    && !positionsDirectlyConflict([{ manager: "listing_concierge", proposal: "x", reasoning: "", risks: [], evidence: [] }]))
  check("conflicting positions → the rebuttal round ran and each position carries a cited rebuttal",
    rec.rebuttalHeld === true && rec.positions.every((p) => (p.rebuttal?.note ?? "").includes("disputes")))
  check("rebuttal evidence rides the SAME grounding guard — the fabricated citation was filtered from every rebuttal",
    rec.positions.every((p) => (p.rebuttal?.evidence ?? []).every((e) => !e.includes("fabricated")))
    && rec.positions[0].rebuttal!.evidence[0] === cits[0])
  check("the summary names the rebuttal round + count", summarizeDeliberation(rec).includes("one rebuttal round held (2 cited rebuttals)"))
  {
    // BOUNDED TO EXACTLY ONE ROUND — structural: rebut is invoked once per manager, never again.
    const counted = fixtureEngine()
    await deliberate({ domain, ask: "argue it", raisedBy: "listing_concierge", briefs, brokerageId: "b-test", engine: counted })
    check("rebut is called EXACTLY once per participating manager (one round, never more)",
      counted.rebutCalls.count === briefs.length, `calls=${counted.rebutCalls.count}`)
  }
  {
    // No conflict → no rebuttal round (nothing to argue against).
    const agree = fixtureEngine({ argue: async () => ({ proposal: "Cut to $749k", reasoning: "same", risks: [], evidence: [cits[0]] }) })
    const recAgree = await deliberate({ domain, ask: "argue it", raisedBy: "listing_concierge", briefs, brokerageId: "b-test", engine: agree })
    check("unanimous proposals → NO rebuttal round held (no manufactured disagreement)",
      recAgree.status === "resolved" && recAgree.rebuttalHeld === false && agree.rebutCalls.count === 0
      && recAgree.positions.every((p) => !p.rebuttal))
  }
  {
    // Engine without a rebut capability → honestly no round; the deliberation still resolves.
    const base = fixtureEngine()
    const noRebut: DeliberationEngine = { argue: base.argue, resolve: base.resolve }
    const recNoRebut = await deliberate({ domain, ask: "argue it", raisedBy: "listing_concierge", briefs, brokerageId: "b-test", engine: noRebut })
    check("an engine without rebut holds NO rebuttal round — recorded honestly, resolution unaffected",
      recNoRebut.status === "resolved" && recNoRebut.rebuttalHeld === false && recNoRebut.winner !== null)
  }
  {
    // A manager may honestly decline to rebut (null) — no manufactured pushback attached.
    const declines = fixtureEngine({ rebut: async () => ({ rebuttal: null, evidence: [] }) })
    const recDecline = await deliberate({ domain, ask: "argue it", raisedBy: "listing_concierge", briefs, brokerageId: "b-test", engine: declines })
    check("a null rebuttal is an honest pass — the round ran but no rebuttal text was fabricated",
      recDecline.status === "resolved" && recDecline.rebuttalHeld === true && recDecline.positions.every((p) => !p.rebuttal))
  }

  console.log("\n[Layer 1d3 · THE PRINCIPAL'S CALL (round 36) — human override on the same record, reason required]")
  const call = applyPrincipalOverride(rec, { winner: "shopping_agent", reason: "Seller told me on the phone they'll take the cut — demand evidence wins.", by: "user-1", now: new Date("2026-07-20T13:00:00Z") })
  check("a valid call lands: the override records winner + reason + who + when on the record",
    call.ok && call.record.override?.winner === "shopping_agent"
    && call.record.override.by === "user-1" && call.record.override.at === "2026-07-20T13:00:00.000Z")
  check("the argued record stays INTACT underneath the override (positions + argued winner unchanged)",
    call.ok && call.record.winner === rec.winner && call.record.positions.length === rec.positions.length)
  check("effectiveWinner: the principal's call governs when recorded, the argued winner otherwise",
    call.ok && effectiveWinner(call.record) === "shopping_agent" && effectiveWinner(rec) === rec.winner)
  check("the summary speaks the PRINCIPAL'S CALL with the stated reason",
    call.ok && summarizeDeliberation(call.record).includes("PRINCIPAL'S CALL")
    && summarizeDeliberation(call.record).includes("Shopping Agent"))
  check("an override WITHOUT a stated reason is refused (an unexplained override is not governance)",
    !applyPrincipalOverride(rec, { winner: "shopping_agent", reason: "   " }).ok)
  check("an override naming a manager who never argued is refused",
    !applyPrincipalOverride(rec, { winner: "finance_manager", reason: "x" }).ok
    && !applyPrincipalOverride(rec, { winner: "not_a_manager", reason: "x" }).ok)
  check("an unavailable deliberation cannot take a principal's call (no argued positions to pick from)",
    !applyPrincipalOverride({ ...rec, status: "unavailable", winner: null, positions: [] }, { winner: "shopping_agent", reason: "x" }).ok)
  check("re-overriding replaces the previous call — the latest human decision governs",
    call.ok && (() => {
      const second = applyPrincipalOverride(call.record, { winner: "listing_concierge", reason: "New comps came in — hold the price." })
      return second.ok && second.record.override?.winner === "listing_concierge" && effectiveWinner(second.record) === "listing_concierge"
    })())
  check("parseDeliberation roundtrips the override (the payload IS the ledger)",
    call.ok && parseDeliberation({ deliberation: call.record as unknown as Record<string, unknown> })?.override?.winner === "shopping_agent")

  console.log("\n[Layer 1e · honest refusal — an unreachable model NEVER yields canned arguments]")
  const recDown = await deliberate({
    domain, ask: "same", raisedBy: "listing_concierge", briefs, brokerageId: "b-test",
    engine: fixtureEngine({ argue: async () => { throw new Error("gateway unreachable (ECONNREFUSED)") } }),
  })
  check("unreachable model → status 'unavailable', ZERO positions (no canned arguments)",
    recDown.status === "unavailable" && recDown.positions.length === 0 && recDown.winner === null && recDown.resolution === null)
  check("the unavailable record carries the honest reason", (recDown.unavailableReason ?? "").includes("unreachable"))
  check("its summary says 'deliberation unavailable' and disclaims substitution",
    summarizeDeliberation(recDown).startsWith(DELIBERATION_UNAVAILABLE) && summarizeDeliberation(recDown).includes("no canned arguments"))
  const recJunk = await deliberate({
    domain, ask: "same", raisedBy: "listing_concierge", briefs, brokerageId: "b-test",
    engine: fixtureEngine({ resolve: async () => ({ winner: "not_a_manager", why: "x", dissent: null }) }),
  })
  check("a junk winner from the model → honest 'unavailable', never a fabricated resolution",
    recJunk.status === "unavailable" && (recJunk.unavailableReason ?? "").includes("not_a_manager"))
  check("parseDeliberation roundtrips a record off a payload (and rejects non-records)",
    parseDeliberation({ deliberation: rec as unknown as Record<string, unknown> })?.winner === rec.winner
    && parseDeliberation({ deliberation: { status: "weird" } }) === null && parseDeliberation(null) === null)

  console.log("\n[Layer 1f · a REAL fact loader exists for every deliberative participant]")
  for (const d of deliberativeDomains()) {
    check(`every co-manager of '${d.key}' has a domain fact loader (${d.managers.join(", ")})`,
      d.managers.every((m: ManagerKey) => typeof MANAGER_FACT_LOADERS[m] === "function"))
  }

  console.log("\n[Layer 1f2 · NO DELIBERATIVE DOMAIN WITHOUT A LIVE RAISER — registry-driven, not a hardcoded list]")
  for (const d of deliberativeDomains()) {
    const emitters = emittersForDomain(d.key)
    check(`'${d.key}' has at least one registered live emitter`, emitters.length > 0)
  }
  for (const e of Object.values(REFERRAL_EMITTERS)) {
    const domain = MANAGER_COLLABORATIONS[e.collabDomain]
    check(`emitter '${e.key}': its collaboration domain exists and declares the raising manager (${e.from})`,
      !!domain && domain.managers.includes(e.from))
    check(`emitter '${e.key}': ${e.kind === "sweep" ? "sweep carries a runnable cron entry point" : "hook's raise is present at its declared decision point"} (${e.sourceFile})`,
      e.kind === "sweep"
        ? typeof e.run === "function" && src(e.sourceFile).includes(e.marker)
        : typeof e.run === "undefined" && src(e.sourceFile).includes(e.marker) && src(e.sourceFile).includes("raiseReferralDeduped"))
  }
  check("the manager-signals cron runs the sweep emitters REGISTRY-DRIVEN (runReferralSweeps — a new sweep auto-joins)",
    src("app/api/cron/manager-signals/route.ts").includes("runReferralSweeps")
    && src("lib/managers/cross-referral.ts").includes("for (const emitter of Object.values(REFERRAL_EMITTERS))"))
  check("every hook emitter dedupes over the bus ledger itself (raiseReferralDeduped — no parallel state)",
    src("lib/managers/cross-referral.ts").includes('.contains("payload", input.dedupe)'))

  console.log("\n[Layer 1f3 · THE NO-NOISE AUDIT (round 41) — every non-deliberating manager carries a DOCUMENTED no-edge verdict, registry-derived]")
  const registrySrc = src("lib/kernel/manager-registry.ts")
  const deliberatingManagers = new Set<ManagerKey>(deliberativeDomains().flatMap((d) => d.managers))
  for (const mk of Object.keys(MANAGERS) as ManagerKey[]) {
    if (deliberatingManagers.has(mk)) {
      check(`'${mk}' holds a deliberative seat — no stale no-edge verdict lingers in the registry`,
        !registrySrc.includes(`· ${mk} — no conflicting evidence`))
    } else {
      check(`'${mk}' holds NO deliberative seat — the registry documents the honest no-edge verdict ('no conflicting evidence exists')`,
        registrySrc.includes(`· ${mk} — no conflicting evidence`))
    }
  }
  check("nobody is off the team — every one of the 14 managers sits on at least one declared collaboration edge (deliberative or handoff)",
    (Object.keys(MANAGERS) as ManagerKey[]).every((mk) => collaborationsFor(mk).length > 0))
  check("rejected CANDIDATES are documented too, not silently dropped (the gift-budget candidate names its honest why)",
    registrySrc.includes("REJECTED") && registrySrc.includes("gift/QBR budget"))

  console.log("\n[Layer 1i · THE TEAM ARGUMENT MAP — who argues with whom, derived from the registry alone]")
  const teamMap = composeTeamArgumentMap()
  check("one seat per registered manager (derived from MANAGERS — never a hand-kept list)",
    teamMap.length === Object.keys(MANAGERS).length
    && teamMap.every((s) => s.manager in MANAGERS && s.label === MANAGERS[s.manager].label))
  check("arguesWith is SYMMETRIC — if A argues with B, B argues with A (edges, not arrows)",
    teamMap.every((s) => s.arguesWith.every((peer) =>
      (teamMap.find((p) => p.manager === peer)?.arguesWith ?? []).includes(s.manager))))
  check("neverDeliberates is HONEST — exactly the managers outside every deliberative domain",
    teamMap.every((s) => s.neverDeliberates === !deliberatingManagers.has(s.manager)))
  check("every deliberative seat has a grounded loader AND every one of its deliberative domains a live emitter",
    teamMap.filter((s) => s.deliberates).every((s) =>
      s.hasGroundedLoader && s.domains.filter((d) => d.deliberative).every((d) => d.emitters.length > 0)))
  check("seat domains mirror the registry (peers = the domain's other managers, deliberative flags intact)",
    teamMap.every((s) => s.domains.every((d) => {
      const reg = MANAGER_COLLABORATIONS[d.key]
      return !!reg && reg.managers.includes(s.manager)
        && JSON.stringify(d.peers.slice().sort()) === JSON.stringify(reg.managers.filter((m) => m !== s.manager).sort())
        && d.deliberative === (reg.deliberate === true)
    })))
  check("the trust surface mounts the map — the page computes composeTeamArgumentMap server-side and the client renders the card (with the honest never-deliberated line)",
    src("app/dashboard/admin/manager-trust/page.tsx").includes("composeTeamArgumentMap")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("Team argument map")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("has never deliberated"))

  console.log("\n[Layer 1g · teamwork metrics — the pure rollup math + omit-when-empty]")
  check("median: odd count picks the middle", median([10, 2, 4]) === 4)
  check("median: even count averages the middle pair", median([1, 2, 10, 20]) === 6)
  check("median: empty → null (never a fabricated stat)", median([]) === null)
  const t0 = new Date("2026-07-01T00:00:00Z").getTime()
  const iso = (h: number) => new Date(t0 + h * 3_600_000).toISOString()
  const overridden = call.ok ? call.record : rec
  const fixtureRows: ReferralLedgerRow[] = [
    { status: "consumed", created_at: iso(0), consumed_at: iso(2), payload: { deliberation: rec as unknown as Record<string, unknown> } },
    { status: "consumed", created_at: iso(0), consumed_at: iso(4), payload: { deliberation: recDown as unknown as Record<string, unknown> } },
    { status: "consumed", created_at: iso(0), consumed_at: iso(10), payload: {} },
    { status: "open", created_at: iso(0), consumed_at: null, payload: null },
    { status: "expired", created_at: iso(0), consumed_at: null, payload: {} },
    { status: "consumed", created_at: iso(0), consumed_at: iso(6), payload: { deliberation: overridden as unknown as Record<string, unknown> } },
  ]
  const m = rollupTeamwork(fixtureRows, 90)
  check("handed-off / resolved counts", m.handedOff === 6 && m.resolved === 4)
  check("median time-to-pickup over resolved rows (2h, 4h, 6h, 10h → 5h)", m.medianPickupHours === 5)
  check("deliberations held counts only RESOLVED arguments; unavailable counted separately",
    m.deliberationsHeld === 2 && m.deliberationsUnavailable === 1)
  check("dissents recorded", m.dissentsRecorded === 2)
  check("rebuttals argued counted across resolved deliberations (2 per argued record → 4)", m.rebuttalsArgued === 4)
  check("principal overrides counted (the one overridden record)", m.principalOverrides === 1)
  const lines = composeTeamworkLines(m)
  check("teamwork lines state the numbers + the argued-why framing + rebuttals + the principal's call",
    lines.length >= 3 && lines[0].includes("6 cross-manager referrals") && lines[0].includes("median pickup 5 hours")
    && lines[1].includes("2 deliberations held") && lines[1].includes("4 cited rebuttals") && lines[1].includes("2 honest dissents")
    && lines.some((l) => l.includes("1 principal's call") && l.includes("stated reason")))
  const empty = rollupTeamwork([], 90)
  check("OMIT-WHEN-EMPTY: a silent period composes ZERO teamwork lines", composeTeamworkLines(empty).length === 0)
  const baseFacts = {
    windowLabel: "Apr 21 – Jul 20", planTier: "team", closedDeals: 1, closedVolume: 500_000, activeDeals: 2,
    newContacts: 5, approvals: 3, autonomousActs: 0, grantsHeld: 0, conflictsCaught: 0, giftsOrdered: 0,
    briefingsOpened: 4, unusedRails: [], trustIncidents: 0, expansion: null,
  }
  const qbrWith = composeQuarterlyReview({ ...baseFacts, teamworkLines: lines })
  const qbrWithout = composeQuarterlyReview(baseFacts)
  check("QBR mounts the teamwork section from the rollup lines", (qbrWith.teamwork ?? []).length === lines.length)
  check("QBR omits the teamwork section when the quarter had none", (qbrWithout.teamwork ?? []).length === 0)

  console.log("\n[Layer 1h · wiring — the referral handler escalates deliberative domains (source check, doc-kernel idiom)]")
  const handlerSrc = src("lib/kernel/manager-signals.ts")
  check("handleCrossManagerReferral escalates on domain.deliberate === true via runDeliberation",
    handlerSrc.includes("domain.deliberate === true") && handlerSrc.includes("runDeliberation")
    && handlerSrc.includes("summarizeDeliberation"))
  check("the escalation reuses the referral's own payload (idempotent — a retry never re-argues)",
    handlerSrc.includes("existingPayload: signal.payload"))
  check("the governance surface renders the argument (positions, winner, why, dissent, rebuttals) + the teamwork card",
    src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("DeliberationBlock")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("winning position")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("Rebuts the others")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("Dissents recorded")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("Rebuttals argued"))
  check("THE PRINCIPAL'S CALL is wired end-to-end: admin action (auth-gated) → recordPrincipalOverride → sentinelWrite; the surface offers the override with a required reason",
    src("app/actions/admin/manager-evals.ts").includes("overrideDeliberationWinner")
    && src("app/actions/admin/manager-evals.ts").includes("recordPrincipalOverride")
    && src("lib/managers/deliberation.ts").includes("manager_deliberation_override")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("overrideDeliberationWinner")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("Principal&apos;s call")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("Principal's calls"))
  check("the QBR loader feeds composeTeamworkLines (mounted, not orphaned)",
    src("lib/intelligence/quarterly-review-loader.ts").includes("composeTeamworkLines")
    && src("app/dashboard/admin/command-center/quarterly-review-card.tsx").includes(`section("Teamwork"`))
  check("the deliberation ledger write rides sentinelWrite (no silent loss)",
    src("lib/managers/deliberation.ts").includes("sentinelWrite"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live deliberation]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live — grounded briefs, ledger persistence, idempotent reuse]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { raiseCrossManagerReferral } = await import("../lib/managers/cross-referral")
  const { runDeliberation, loadManagerBrief } = await import("../lib/managers/deliberation")
  const { loadTeamworkMetrics } = await import("../lib/managers/teamwork-metrics")
  const svc = createServiceClient()
  const TAG = `__delib_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const brokerageId = (brk as { id: string }).id

    // Grounded briefs: every deliberative participant's loader runs against REAL tables.
    for (const d of deliberativeDomains()) {
      const briefsLive = await Promise.all(d.managers.map((mk: ManagerKey) =>
        loadManagerBrief(mk, { brokerageId, ask: "sim", entityType: null, entityId: null }, svc)))
      check(`'${d.key}': every participant loads a brief from its own stewarded tables (no throw, arrays returned)`,
        briefsLive.every((b) => Array.isArray(b.facts) && Array.isArray(b.citations)))
      check(`'${d.key}': citations are field-level (table.column=...) when facts exist`,
        briefsLive.every((b) => b.facts.length === 0 || b.citations.every((c) => /^[a-z_]+\.[a-z_]+.*=/.test(c))))
    }

    // Raise a REAL referral on the deliberative pricing-dispute domain.
    const raised = await raiseCrossManagerReferral({
      brokerageId, fromManager: "listing_concierge", toManager: "shopping_agent",
      collabDomain: "listing_demand_bridge",
      ask: `${TAG} 41 days on market and buyer demand disagrees with the price — argue the move.`,
    }, svc)
    check("live: the referral publishes on the governed bus", raised.ok && !!raised.signalId, raised.reason)
    if (raised.signalId) cleanup.push({ table: "manager_signals", id: raised.signalId })

    const { data: sigRow } = await svc.from("manager_signals").select("payload").eq("id", raised.signalId!).single()
    const live = await runDeliberation({
      brokerageId, collabDomain: "listing_demand_bridge",
      ask: `${TAG} argue the price move`, fromManager: "listing_concierge",
      signalId: raised.signalId!, existingPayload: (sigRow as { payload: Record<string, unknown> }).payload,
    }, svc, fixtureEngine())
    check("live: the deliberation resolves with a winner + the stated why",
      live?.status === "resolved" && !!live.winner && (live.resolution ?? "").length > 0)

    const { data: after } = await svc.from("manager_signals").select("payload").eq("id", raised.signalId!).single()
    const persisted = parseDeliberation((after as { payload: Record<string, unknown> }).payload)
    check("live: the record persisted onto the EXISTING referral ledger row (payload.deliberation)",
      persisted?.status === "resolved" && persisted.winner === live?.winner)
    check("live: the merge kept the referral's original payload keys (collab_domain survives)",
      ((after as { payload: Record<string, unknown> }).payload)["collab_domain"] === "listing_demand_bridge")

    // Idempotent reuse: a retry with a THROWING engine returns the persisted record untouched.
    const reused = await runDeliberation({
      brokerageId, collabDomain: "listing_demand_bridge",
      ask: `${TAG} argue the price move`, fromManager: "listing_concierge",
      signalId: raised.signalId!, existingPayload: (after as { payload: Record<string, unknown> }).payload,
    }, svc, fixtureEngine({ argue: async () => { throw new Error("must not be called on a retry") } }))
    check("live: a retried deliberation REUSES the persisted record — never re-argues (no double gateway spend)",
      reused?.status === "resolved" && reused.winner === live?.winner && reused.deliberatedAt === live?.deliberatedAt)
    check("live: the fixture positions conflicted → the ONE rebuttal round ran and persisted",
      reused?.rebuttalHeld === true && (reused?.positions ?? []).some((p) => p.rebuttal?.note))

    // THE PRINCIPAL'S CALL — persisted onto the SAME referral row through the real path.
    const { recordPrincipalOverride, effectiveWinner: liveEffectiveWinner } = await import("../lib/managers/deliberation")
    const liveLoser = (live?.positions ?? []).find((p) => p.manager !== live?.winner)?.manager
    if (liveLoser) {
      const ov = await recordPrincipalOverride({
        brokerageId, signalId: raised.signalId!,
        winner: liveLoser, reason: `${TAG} the human weighs in — demand evidence wins`, by: null,
      }, svc)
      check("live: the principal's call records onto the same payload (sentinelWrite path)", ov.ok, (ov as { error?: string }).error)
      const { data: afterOv } = await svc.from("manager_signals").select("payload").eq("id", raised.signalId!).single()
      const persistedOv = parseDeliberation((afterOv as { payload: Record<string, unknown> }).payload)
      check("live: the override governs (effectiveWinner) while the argued record stays intact underneath",
        persistedOv?.override?.winner === liveLoser
        && persistedOv !== null && liveEffectiveWinner(persistedOv) === liveLoser
        && persistedOv.winner === live?.winner)
      check("live: an override without a reason is refused by the same path",
        !(await recordPrincipalOverride({ brokerageId, signalId: raised.signalId!, winner: liveLoser, reason: "  " }, svc)).ok)
    }

    // Metrics loader folds the live row (deliberationsHeld counts it while it exists).
    const liveMetrics = await loadTeamworkMetrics(brokerageId, { days: 1 }, svc)
    check("live: the teamwork loader rolls the referral + deliberation + rebuttals + the principal's call off the one ledger",
      liveMetrics.handedOff >= 1 && liveMetrics.deliberationsHeld >= 1
      && liveMetrics.rebuttalsArgued >= 1 && (!liveLoser || liveMetrics.principalOverrides >= 1))

    // Non-deliberative + unknown domains refuse escalation at runDeliberation itself.
    const notDelib = await runDeliberation({
      brokerageId, collabDomain: "approval_queue_slo", ask: "x", fromManager: "cron_manager",
    }, svc, fixtureEngine())
    check("live: a non-deliberative domain never deliberates (runDeliberation → null)", notDelib === null)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).like("message", `%${TAG}%`)
    check("cleanup verified — 0 seeded signals remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
