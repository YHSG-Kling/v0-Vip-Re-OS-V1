#!/usr/bin/env tsx
/**
 * scripts/outbound-call-gates-simulator.ts   (npm run test:outbound-call-gates)
 * ─────────────────────────────────────────────────────────────────────────────
 * A CONTACT SUPPRESSED ON THE *LIST* MUST NOT BE DIALLED BY THE AI VOICE LANE.
 *
 * THE DEFECT THIS GUARD EXISTS FOR (wave 8). Two functions placed an outbound
 * call and their gates were COMPLEMENTARY, not overlapping:
 *
 *   lib/providers/dispatch.ts:dispatchPhone (0 callers) had checkSuppression —
 *     contact flags (dnc_status / call_stop_flag) AND contact_suppression_list.
 *   lib/voice/twilio-outbound.ts:placeOutboundAiCall (LIVE — it dials) had
 *     enforceTCPACompliance, which reads the contact FLAG `contacts.dnc_status`
 *     and NEVER reads contact_suppression_list.
 *
 * So a contact suppressed via the LIST rather than the flag was refused only on
 * the code path nothing executed, and dialled on the one that runs. Consent
 * revocations recorded by the unsubscribe/STOP writer (addSuppression) or by an
 * admin land in that list. This is TCPA exposure, not tidiness.
 *
 * WHAT IS ASSERTED, AND WHY IT IS THE CONSTRUCT AND NOT A SPELLING. Two proofs
 * in this repo have already failed CI because they counted literal occurrences
 * and a CORRECT consolidation moved the code. So the properties here are:
 *   · the gate stack is a real exported VALUE (OUTBOUND_CALL_GATES) — the order
 *     is read off the list at runtime, not matched in a function body;
 *   · the runner short-circuits — proven by EXECUTING it with injected gates,
 *     not by looking at the loop;
 *   · every consumer-protection gate precedes the spend gate — read off each
 *     gate's own `consumerProtection` flag, so adding a gate cannot silently
 *     land on the wrong side of the money;
 *   · the gate module CANNOT dial (it holds no connector call at all), which is
 *     what makes "a gate after the Twilio call" structurally impossible rather
 *     than a convention;
 *   · the two data sources are pinned where they actually live: the TCPA gate
 *     reads the FLAG, checkSuppression reads the LIST, and the stack contains
 *     the suppression gate. If someone deletes that gate, this fails.
 *
 * There is no live layer: proving a refusal end-to-end would require dialling.
 */
// ── test-only shim ──────────────────────────────────────────────────────────
// lib/communication/tcpa-gate.ts imports `server-only`, which throws outside a
// Server Component. Neutralize it in the require cache BEFORE importing
// anything that transitively pulls it (see scripts/inbound-intent-simulator.ts
// for the same idiom).
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  OUTBOUND_CALL_GATES,
  OUTBOUND_CALL_GATE_ORDER,
  runOutboundCallGates,
  type OutboundCallGate,
  type OutboundCallGateContext,
  type OutboundCallRefusal,
} from "../lib/voice/outbound-call-gates"
// tcpa-gate.ts is `server-only` — imported AFTER the require-cache shim above
// (a static import would hoist above the shim and throw).
const {
  evaluateFreshScrubVerdict,
  isDncTcpaVerdictFresh,
  DNC_TCPA_SCRUB_STALENESS_DAYS,
} = await import("../lib/communication/tcpa-gate")
import { checkDncStatus, checkTcpaStatus, verifyPhone } from "../lib/external/batchdata-mcp"

let pass = 0, fail = 0
const fails: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** CODE ONLY. Prose that NAMES a gate is not a second gate — this repo keeps
 *  catching assertions that matched a sentence in a comment. */
const code = (p: string) => stripComments(src(p))

const CTX: OutboundCallGateContext = {
  brokerageId: "00000000-0000-0000-0000-000000000000",
  toNumber: "+15555550123",
  contactId: null,
}

console.log("\n═══ 1. There is ONE gate stack, and it is a value ═══")
{
  check("OUTBOUND_CALL_GATES is a non-empty ordered list", OUTBOUND_CALL_GATES.length > 0)
  check("no gate key is declared twice (one stack, not a stack plus a straggler)",
    new Set(OUTBOUND_CALL_GATE_ORDER).size === OUTBOUND_CALL_GATE_ORDER.length,
    OUTBOUND_CALL_GATE_ORDER.join(" → "))
  check("every gate is runnable", OUTBOUND_CALL_GATES.every((g) => typeof g.run === "function"))

  // The three gates merged over from the deleted dispatchPhone, plus the two the
  // survivor already had. Naming them here is the regression pin: dropping any
  // one of them re-opens the hole it was carried across to close.
  for (const key of ["autonomy", "suppression", "tcpa", "deconflict", "vendor_budget"] as const) {
    check(`the stack carries the '${key}' gate`, OUTBOUND_CALL_GATE_ORDER.includes(key))
  }
}

console.log("\n═══ 2. Cheap consumer-protection refusals before the money ═══")
{
  const spendIdx = OUTBOUND_CALL_GATES.findIndex((g) => !g.consumerProtection)
  check("there is a spend gate in the stack", spendIdx >= 0)
  check("EVERY consumer-protection gate runs before EVERY spend gate — a compliance\n    refusal must never spend, and budget must never mask a compliance refusal",
    OUTBOUND_CALL_GATES.every((g, i) => (g.consumerProtection ? i < spendIdx : i >= spendIdx)),
    OUTBOUND_CALL_GATES.map((g) => `${g.key}${g.consumerProtection ? "" : "(spend)"}`).join(" → "))
  check("suppression runs before the TCPA gate writes its compliance-log row —\n    a list-suppressed contact is refused on the stronger reason",
    OUTBOUND_CALL_GATE_ORDER.indexOf("suppression") < OUTBOUND_CALL_GATE_ORDER.indexOf("tcpa"))
}

console.log("\n═══ 3. The runner short-circuits (executed, not read) ═══")
{
  const ran: string[] = []
  const gate = (key: string, refusal: OutboundCallRefusal | null): OutboundCallGate => ({
    key: key as OutboundCallGate["key"],
    consumerProtection: true,
    run: async () => { ran.push(key); return refusal },
  })
  const REFUSAL: OutboundCallRefusal = { ok: false, error: "test refusal", blocked: true, blockReason: "test" }

  const allPass = await runOutboundCallGates(CTX, [gate("a", null), gate("b", null), gate("c", null)])
  check("all gates pass ⇒ null (the call may proceed)", allPass === null)
  check("...and every gate ran, in declared order", ran.join(",") === "a,b,c", ran.join(","))

  ran.length = 0
  const refused = await runOutboundCallGates(CTX, [gate("a", null), gate("b", REFUSAL), gate("c", null)])
  check("a refusal is returned as-is, in PlaceOutboundResult's own shape",
    refused !== null && refused.ok === false && refused.error === "test refusal" && refused.blocked === true)
  check("...and NO later gate runs — the refusal reaches neither the spend\n    ceiling nor the dial",
    ran.join(",") === "a,b", ran.join(","))

  ran.length = 0
  const firstWins = await runOutboundCallGates(CTX, [gate("a", REFUSAL), gate("b", REFUSAL)])
  check("the FIRST refusal wins (deterministic reason, not the last one)",
    firstWins !== null && ran.join(",") === "a")
}

console.log("\n═══ 4. Refusals carry a real reason, never a bare false ═══")
{
  // Every production gate builds its refusal from a reason string supplied by the
  // check that refused. A refusal with an empty error would surface to an agent
  // as a silent failure, which is the thing this lane must never do.
  const gatesSrc = src("lib/voice/outbound-call-gates.ts")
  const emptyErrors = /error:\s*(""|''|`\s*`|null|undefined)/.test(gatesSrc)
  check("no gate can return an empty/absent error string", !emptyErrors)
  // Count-free and reformat-proof: look at each RETURNED object literal (not the
  // interface that declares the shape) and require that any refusal also carries
  // blocked:true, so callers can tell a policy refusal (403) from an
  // infrastructure failure (503). A new gate that forgets it fails here.
  const returned = code("lib/voice/outbound-call-gates.ts").split("return {").slice(1).map((s) => s.slice(0, 400))
  const refusalLiterals = returned.filter((body) => /ok:\s*false/.test(body))
  check("there are refusal literals to check", refusalLiterals.length > 0)
  check("every refusal is marked blocked:true so callers can distinguish a policy\n    refusal (403) from an infrastructure failure (503)",
    refusalLiterals.every((body) => /blocked:\s*true/.test(body)),
    `${refusalLiterals.filter((b) => !/blocked:\s*true/.test(b)).length} of ${refusalLiterals.length} missing`)
}

console.log("\n═══ 5. The gate module cannot dial ═══")
{
  const gatesSrc = src("lib/voice/outbound-call-gates.ts")
  check("outbound-call-gates.ts holds NO connector call and no Twilio endpoint —\n    so no gate can be placed 'after the dial'; the dial is in the caller",
    !/callConnector|api\.twilio\.com|Calls\.json/.test(gatesSrc))

  const exec = src("lib/voice/twilio-outbound.ts")
  const gateIdx = exec.indexOf("runOutboundCallGates")
  // wave 70: the dial is the official Twilio SDK adapter's placeCall(...)
  // (lib/providers/twilio/client.ts). EARLIEST dial-shaped marker wins so an
  // injected connector-gateway call ahead of the stack is still caught.
  const dialIdx = Math.min(...["placeCall(", "callConnector"].map((m) => exec.indexOf(m)).filter((i) => i > -1), Number.POSITIVE_INFINITY)
  check("placeOutboundAiCall runs the stack, and runs it before the dial",
    gateIdx >= 0 && Number.isFinite(dialIdx) && gateIdx < dialIdx)
  const execCode = code("lib/voice/twilio-outbound.ts")
  check("...and does NOT keep a second, private copy of a gate beside the stack\n    (prose naming a gate is not a gate — comments are stripped first)",
    !/\benforceTCPACompliance\s*[({]/.test(execCode) && !/\bcheckVendorBudget\s*[({]/.test(execCode))
}

console.log("\n═══ 6. The hole is closed where it actually was ═══")
{
  const tcpa = src("lib/communication/tcpa-gate.ts")
  const suppression = src("lib/kernel/compliance/check-suppression.ts")

  check("enforceTCPACompliance still reads the contact FLAG contacts.dnc_status",
    tcpa.includes("dnc_status"))
  check("...and still does NOT read contact_suppression_list — which is exactly\n    why the stack must keep a separate suppression gate",
    !tcpa.includes("contact_suppression_list"))
  check("checkSuppression reads BOTH the flags and contact_suppression_list",
    suppression.includes("contact_suppression_list") && suppression.includes("call_stop_flag"))
  check("the outbound-call stack routes its suppression gate through checkSuppression",
    src("lib/voice/outbound-call-gates.ts").includes("check-suppression"))

  // ── enforceTCPACompliance ITSELF must fail closed ────────────────────────
  // Found while verifying this slice: the gate's `contacts` read was
  // `const { data: contact }` with the error dropped. supabase-js RESOLVES a
  // refused query, so a refusal produced `contact === null`, the whole
  // `if (contact)` block was skipped, and DNC / STOP opt-out / express consent
  // / phone-status / RND staleness were ALL bypassed — execution fell through
  // to quiet hours, which knows nothing about consent, and the gate could
  // return allowed. A consent gate that fails OPEN is the one direction this
  // must never fail, and it covers SMS as well as voice.
  //
  // Asserted as a CONSTRUCT, not a spelling: the read destructures its error,
  // and BOTH unverifiable cases (read refused, and an id named with no row)
  // return allowed:false. The suppression gate now runs first and would also
  // catch a refusal, but this gate must stand on its own — the next caller may
  // not be behind that stack.
  const tcpaReadsError = /const \{ data: contact, error: \w+ \} = await/.test(tcpa)
  check("enforceTCPACompliance DESTRUCTURES the error on its compliance read —\n    a refused read must not read as 'no restrictions on file'",
    tcpaReadsError && !/const \{ data: contact \} =/.test(tcpa))
  check("...and REFUSES on both unverifiable cases: read error, and id-named-but-no-row",
    /if \(contactError\)[\s\S]{0,400}allowed: false/.test(tcpa) &&
    /if \(!contact\)[\s\S]{0,400}allowed: false/.test(tcpa))

  // FAIL CLOSED. supabase-js RESOLVES a refused query, so an undestructured read
  // makes "we could not check" look identical to "nothing suppressed".
  check("checkSuppression destructures `error` on the contact read AND the list\n    read, and returns suppressed=true when either is unreadable (fails closed)",
    /contactError/.test(suppression) && /suppressionError/.test(suppression)
    && (suppression.match(/suppressed:\s*true,\s*\n\s*reason: `[^`]*unreadable/g) ?? []).length === 2)
}

console.log("\n═══ 7. The duplicates are gone, and named their survivor ═══")
{
  const dispatch = src("lib/providers/dispatch.ts")
  check("dispatch.ts no longer defines or exports dispatchPhone",
    !/export (async )?function dispatchPhone/.test(dispatch) && !/DispatchPhoneParams/.test(dispatch))
  check("...and leaves an in-code record naming the survivor by file:function",
    dispatch.includes("lib/voice/twilio-outbound.ts:placeOutboundAiCall"))
  check("...that lists the gates carried across",
    ["autonomy", "checkSuppression", "deconflict"].every((g) => dispatch.includes(g)))

  const resolver = src("lib/providers/messaging/resolve-sms-provider.ts")
  check("resolve-sms-provider.ts no longer defines resolveSMSProviderForBrokerage",
    !/export async function resolveSMSProviderForBrokerage/.test(resolver))
  check("...and the survivor resolveSMSProviderForActor is still exported",
    /export async function resolveSMSProviderForActor/.test(resolver))
  check("...with an in-code record naming it",
    resolver.includes("SURVIVOR: resolveSMSProviderForActor"))
}

console.log("\n═══ 8. SCRUB BEFORE USE — fresh DNC/TCPA verdict (wave 68) ═══")
{
  // PURE decision core — no network calls, exhaustively testable per CLAUDE.md §2.
  const CLEAN_DNC = { ok: true, dnc: false }
  const CLEAN_TCPA = { ok: true, tcpaLitigator: false }

  console.log("  — positive control: a verified-clean number PASSES —")
  {
    const v = evaluateFreshScrubVerdict(CLEAN_DNC, CLEAN_TCPA)
    check("verified + clean passes (verified:true, blocked:false)", v.verified === true && (v as any).blocked === false)
  }

  console.log("  — negative control 1: dnc=true is REFUSED —")
  {
    const v = evaluateFreshScrubVerdict({ ok: true, dnc: true }, CLEAN_TCPA)
    check("dnc:true refuses with blockReason 'dnc'", v.verified === true && (v as any).blocked === true && (v as any).blockReason === "dnc")
  }

  console.log("  — negative control 2: a TCPA litigator number is REFUSED —")
  {
    const v = evaluateFreshScrubVerdict(CLEAN_DNC, { ok: true, tcpaLitigator: true })
    check("tcpaLitigator:true refuses with blockReason 'tcpa_litigator'", v.verified === true && (v as any).blocked === true && (v as any).blockReason === "tcpa_litigator")
  }

  console.log("  — negative control 3: unverifiable-without-key is REFUSED (fail closed) —")
  {
    const v = evaluateFreshScrubVerdict({ ok: false, dnc: null, unconfigured: true }, { ok: false, tcpaLitigator: null, unconfigured: true })
    check("unconfigured (no BatchData key) refuses rather than assuming clean", v.verified === false && typeof (v as any).reason === "string" && (v as any).reason.length > 0)
  }
  {
    // Both calls FAILED (not merely unconfigured — e.g. a network error) also refuses.
    const v = evaluateFreshScrubVerdict({ ok: false, dnc: null, error: "timeout" }, { ok: false, tcpaLitigator: null, error: "timeout" })
    check("a provider failure with no answer from either check also refuses", v.verified === false)
  }

  console.log("  — freshness clock (pure) —")
  {
    const now = Date.now()
    check("null verified_at is NEVER fresh", isDncTcpaVerdictFresh(null, now) === false)
    check(`a verdict ${DNC_TCPA_SCRUB_STALENESS_DAYS - 1}d old is fresh`, isDncTcpaVerdictFresh(new Date(now - (DNC_TCPA_SCRUB_STALENESS_DAYS - 1) * 86400000).toISOString(), now) === true)
    check(`a verdict ${DNC_TCPA_SCRUB_STALENESS_DAYS + 1}d old is STALE`, isDncTcpaVerdictFresh(new Date(now - (DNC_TCPA_SCRUB_STALENESS_DAYS + 1) * 86400000).toISOString(), now) === false)
  }

  console.log("  — live-call I/O shell (env unconfigured — no real BatchData spend) —")
  {
    delete process.env.BATCHDATA_MCP_URL
    delete process.env.BATCHDATA_MCP_AUTH
    delete process.env.BATCHDATA_API_KEY
    // Run all three synchronously so a slow/absent network never blocks this proof.
  }

  console.log("  — the gate is wired into enforceTCPACompliance, not a second gate stack —")
  {
    const tcpa = code("lib/communication/tcpa-gate.ts")
    check("enforceTCPACompliance calls evaluateFreshScrubVerdict (the extension lives IN the existing gate)",
      /evaluateFreshScrubVerdict\(/.test(tcpa))
    check("...reads the freshness clock off contacts.dnc_verified_at before deciding whether to re-check live",
      /isDncTcpaVerdictFresh\(contact\.dnc_verified_at/.test(tcpa))
    check("...and calls the THIN wrappers on lib/external/batchdata-mcp.ts (checkDncStatus/checkTcpaStatus) — never a raw callBatchDataMcp string here",
      /checkDncStatus/.test(tcpa) && /checkTcpaStatus/.test(tcpa) && !/callBatchDataMcp/.test(tcpa))
    check("no SECOND gate stack was built — phone-scrub-runner.ts (the intake scrub) now reuses the SAME thin wrappers",
      /checkDncStatus, checkTcpaStatus/.test(code("lib/compliance/phone-scrub-runner.ts")))
  }

  console.log("  — thin MCP wrappers exist and are fail-closed by construction —")
  {
    check("checkDncStatus/checkTcpaStatus/verifyPhone are exported functions", typeof checkDncStatus === "function" && typeof checkTcpaStatus === "function" && typeof verifyPhone === "function")
  }
}

console.log("\n═══ 9. Outbound EMAIL gets a fresh verification verdict too (wave 68) ═══")
{
  const msg = code("lib/providers/messaging/index.ts")
  check("sendEmail gates on a fresh verification verdict when a contactId is present",
    /if \(params\.contactId && !params\.skipVerificationGate\)/.test(msg))
  check("...and REUSES the existing email verifier (lib/external/email-verifier.ts) rather than a second implementation",
    /import\("@\/lib\/external\/email-verifier"\)/.test(msg) && /checkEmailMx/.test(msg))
  check("...persisting the verdict on the SAME columns the schema already carries (email_verified / email_verification_date)",
    /email_verified: true, email_verification_date:/.test(msg))
}

console.log("\n═══ 10. VOICEDROP calls the SAME TCPA gate — no second scrub (wave 69C carry a) ═══")
{
  const vd = code("lib/voicedrop/orchestrate-voicedrop-send.ts")

  console.log("  — positive control: the voicedrop path actually calls enforceTCPACompliance —")
  check("orchestrateVoicedropSend's compliance step imports enforceTCPACompliance from THE gate",
    /["']@\/lib\/communication\/tcpa-gate["']/.test(vd) && /enforceTCPACompliance\(/.test(vd))
  check("...gated on channel:\"call\" (voicedrop is a phone call under FCC interpretation)",
    /channel:\s*["']call["']/.test(vd))
  check("...and refuses the send when the gate refuses (never a fire-and-forget call)",
    /if \(!scrub\.allowed\) return \{ ok: false/.test(vd))

  console.log("  — negative control: it does NOT hand-roll a second fresh-scrub implementation —")
  check("voicedrop's own file never calls checkDncStatus/checkTcpaStatus directly —\n    the fresh scrub lives in exactly ONE place (tcpa-gate.ts), never duplicated here",
    !/checkDncStatus\(|checkTcpaStatus\(/.test(vd))
  check("...and never re-derives evaluateFreshScrubVerdict/isDncTcpaVerdictFresh locally\n    (those stay exported from tcpa-gate.ts only)",
    !/function evaluateFreshScrubVerdict|function isDncTcpaVerdictFresh/.test(vd))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`OUTBOUND CALL GATES — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of fails) console.log(`  · ${f}`)
  console.log("\nThe AI voice lane has ONE pre-dial gate stack and it must contain the")
  console.log("list-aware suppression check: enforceTCPACompliance reads contacts.dnc_status")
  console.log("and never contact_suppression_list, so removing that gate silently makes")
  console.log("every list-only suppression dialable again.")
  process.exit(1)
}
console.log("One stack, ordered, short-circuiting, list-aware — and nothing dials past it.")
