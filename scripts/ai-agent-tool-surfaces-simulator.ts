#!/usr/bin/env tsx
/**
 * scripts/ai-agent-tool-surfaces-simulator.ts   (npm run test:ai-agent-tool-surfaces)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 72B — owner verbatim: "I didn't want you to create tools that didn't
 * make sense. these tools are not for users to use but the ai agent that has
 * to service the chat/phones etc. we want the ai agents to be able to
 * support the tenants or the real estate agents."
 *
 * Proves, in STRIPPED source (scripts/strip-comments.ts — CLAUDE.md §2), that:
 *   Layer 1 — every AI-agent chat/voice surface this repo has is enumerated
 *             and each carries the tool set its audience needs — isa persona
 *             for lead/contact-facing qualification surfaces, investor
 *             persona for the investor-facing lane, the full agent-copilot
 *             catalogue for tenant-staff/agent in-app chat — derived from
 *             SESSION/handler context, never a request body.
 *   Layer 2 — NO user-facing tool-invocation UI exists anywhere under
 *             app/dashboard (a "run skip trace" button etc.), with a
 *             POSITIVE CONTROL fixture proving the scanner can still find
 *             one if it existed (CLAUDE.md §2 — an absence assertion with
 *             no control reads clean when it is merely blind).
 *   Layer 3 — the two surfaces this lane wired (portal contact assistant,
 *             website widget) derive persona/tenant from context, never body.
 *
 * No DB, no network — everything here is static/pure. Run:
 *   npx tsx scripts/ai-agent-tool-surfaces-simulator.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function stripped(path: string): string {
  return stripComments(readFileSync(path, "utf8"))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — positive control: the stripper must still see code in the files
// this proof reads, on a token that lives ONLY inside a comment.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · strip-comments positive control]")
const isaToolsSrc = stripped("lib/ai-isa/batchdata-isa-tools.ts")
check("a comment-only phrase is ABSENT from stripped batchdata-isa-tools.ts (scanner sees comments)",
  !isaToolsSrc.includes("PERSONA allowlist (never skip-trace/owner-contact tools for an"))
check("a real code token from the same file IS present (the scanner did not eat the code too)",
  isaToolsSrc.includes("export async function batchDataIsaTools"))

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1B — SURFACE INVENTORY. Every AI-agent chat/voice/email surface that
// services a tenant, agent, contact, lead or investor, and the tool set it
// SHOULD carry per the owner's framework:
//   isa persona      → lead/contact qualification (email, live avatar, portal, widget)
//   investor persona  → the investor-facing lane (property-only, never skip-trace)
//   full copilot set  → tenant-staff/agent in-app chat (batchDataMcpTools + rentCastMcpTools)
//   none (by design)  → a surface that never itself talks to a person under a
//                        persona (a reply-DRAFT generator, a KB-only onboarding
//                        Q&A with no property-data need, a command classifier)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1B · surface inventory — tool set matches audience]")

interface SurfaceCheck { path: string; label: string; audience: string; expect: string[] }
const SURFACES: SurfaceCheck[] = [
  {
    path: "app/actions/ai-isa/handle-inbound-email.ts",
    label: "ISA inbound-email handler",
    audience: "lead (email reply)",
    expect: ["batchDataIsaTools", "resolveToolPersona", "buildCustomerFreeTools"],
  },
  {
    path: "app/api/did/custom-llm/route.ts",
    label: "D-ID live-avatar brain",
    audience: "visitor or contact (spoken), persona derived from contact context",
    expect: ["batchDataIsaTools", "resolveToolPersona", "buildCustomerFreeTools"],
  },
  {
    path: "app/api/internal/ai-chat/route.ts",
    label: "in-app agent copilot",
    audience: "tenant staff / licensed agent",
    expect: ["batchDataMcpTools", "rentCastMcpTools", "resolveEffectiveBatchDataToolTier", "filterToolsByTier"],
  },
  {
    path: "app/api/portal/ai-chat/route.ts",
    label: "portal contact assistant",
    audience: "known contact (buyer/seller/investor/renter/relocation/sphere)",
    expect: ["batchDataIsaTools", "resolveToolPersona", "buildCustomerFreeTools"],
  },
  {
    path: "app/api/widget/message/route.ts",
    label: "website visitor widget",
    audience: "anonymous pre-lead visitor",
    expect: ["batchDataIsaTools", "resolveToolPersona", "buildCustomerFreeTools"],
  },
]

for (const s of SURFACES) {
  const src = stripped(s.path)
  for (const token of s.expect) {
    check(`${s.label} (${s.audience}) carries: ${token}`, src.includes(token))
  }
}

// The persona catalogue is MUTUALLY EXCLUSIVE by construction inside
// batchDataIsaTools — the investor/seller personas' registries have NO
// skip-trace/owner-contact tool NAMES in them at all (not merely gated).
// Re-assert here, against the surface inventory's own claim, in stripped
// source.
check("skip_trace_property/reverse_skip_trace never appear in lib/ai-isa/batchdata-isa-tools.ts's registry at all (not gated — ABSENT for every persona)",
  !isaToolsSrc.includes("skip_trace_property") && !isaToolsSrc.includes("reverse_skip_trace"))
check("every registry entry is gated through isToolAllowedForPersona against the ONE persona-tool-policy.ts table, not a hand-rolled per-tool literal check",
  (isaToolsSrc.match(/isToolAllowedForPersona\(ctx\.persona,/g) ?? []).length >= 6)

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1C — surfaces audited and found to correctly carry NO batchdata/
// rentcast/peopledata tool set, with the reason on record (never a silent
// gap — CLAUDE.md §2 "publish blind spots beside the number").
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1C · surfaces correctly WITHOUT property-data tools, reason on record]")

const chatStreamSrc = stripped("app/api/chat/stream/route.ts")
// The "reason on record" half is a DOC COMMENT — read RAW source for it on
// purpose (stripping it is exactly what would make this check pass falsely
// once the explaining comment had been deleted, same discipline the
// lead-intake-pipeline-simulator uses for its own doc-comment assertion).
const chatStreamRawSrc = readFileSync("app/api/chat/stream/route.ts", "utf8")
check("agent_chat_stream drafts a REPLY SUGGESTION the agent sends in their OWN voice — it never itself talks to a client under a persona, so no property-lookup tool belongs on it (reason is in the file's own comment)",
  chatStreamRawSrc.includes("drafts a Them-First-scored REPLY SUGGESTION for the agent to") && !chatStreamSrc.includes("batchDataIsaTools") && !chatStreamSrc.includes("batchDataMcpTools"))

const onboardingSrc = stripped("app/api/onboarding/assistant/route.ts")
check("the onboarding assistant is a KB-grounded Q&A for a NEW AGENT learning the platform — no property-data need, so no batchdata/rentcast tool set (owner: tools must make sense for the job)",
  !onboardingSrc.includes("batchDataIsaTools") && !onboardingSrc.includes("batchDataMcpTools") && !onboardingSrc.includes("rentCastMcpTools"))

const voiceCommandSrc = stripped("app/api/internal/voice-command/route.ts")
check("internal voice-command is a STAFF COMMAND CLASSIFIER (extracts names/entities to dispatch existing actions), not an open-ended chat surface — no property-data tool set belongs on it",
  !voiceCommandSrc.includes("batchDataIsaTools") && !voiceCommandSrc.includes("batchDataMcpTools"))

// The phone/voice ISA (Twilio ConversationRelay reception brain) STILL
// returns the structured JSON-PLAN VoiceTurnPlan (say/action) every route
// consumes — that OUTPUT CONTRACT is unchanged. But lane 73E restructured HOW
// that plan gets produced when property tools are on offer: instead of wave
// 73B's hand-rolled "ask for a tool in your JSON, executor parses the field,
// runs at most one call, re-plans once" protocol, `planTurnWithPrompt` now
// makes ONE `generateTextRouted` call with REAL AI-SDK `tools:` +
// `maxSteps: VOICE_TOOL_ROUND_MAX_STEPS` (≤3) + a hard
// `abortSignal: AbortSignal.timeout(VOICE_TOOL_ROUND_DEADLINE_MS)` — genuine
// multi-step tool-calling, bounded and deadline-protected for
// ConversationRelay's real-time turn-taking budget. See Layer 5 below.
const twilioVoiceSrc = stripped("lib/voice/twilio-voice.ts")
check("the phone/voice ISA's turn engine now uses REAL native AI-SDK multi-step tool-calling (`tools:` + `maxSteps` passed to generateTextRouted) — restructured off wave 73B's manual toolRequest round (lane 73E)",
  twilioVoiceSrc.includes("tools: voiceTools") && twilioVoiceSrc.includes("maxSteps: VOICE_TOOL_ROUND_MAX_STEPS"))
check("the native tool round carries a hard per-turn deadline (AbortSignal.timeout) — an unbounded tool loop would blow ConversationRelay's real-time turn-taking budget",
  /abortSignal: AbortSignal\.timeout\(VOICE_TOOL_ROUND_DEADLINE_MS\)/.test(twilioVoiceSrc))
check("the step ceiling is bounded to ≤3 in source (the turn-engine design ceiling), not left to the SDK's own default",
  /VOICE_TOOL_ROUND_MAX_STEPS = 3/.test(twilioVoiceSrc))

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — NO USER-FACING TOOL-INVOCATION UI. A dashboard page/button that
// lets a HUMAN run skip_trace/lookup_property/etc directly would violate the
// owner's ruling that these tools are for the AI agent only. Positive control
// first (CLAUDE.md §2): the same scanner, run against a FIXTURE that DOES
// contain such a call site, must find it — proving a real "0" below is not
// just a blind scanner.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · no user-facing tool-invocation UI under app/dashboard, positive control first]")

const TOOL_CALL_PATTERNS = [
  /\bskipTraceProperty\s*\(/, /\bskip_trace_property\b/, /\blookupProperty\s*\(/,
  /\bsearchPropertiesPage\s*\(/, /\bverifyPhone\s*\(/, /\bcomparablePropertyPreview\s*\(/,
  /\binvestorBuyboxPreview\s*\(/, /\breverseSkipTrace\s*\(/,
]

const fixtureCode = `
// FIXTURE — simulates a dashboard button wired straight to a tool the owner said is AI-agent-only.
async function onRunSkipTraceClick() {
  const result = await skipTraceProperty({ address })
  setResult(result)
}
`
check("POSITIVE CONTROL: the scanner DOES find a tool-invocation call site in a fixture that has one (the scanner is not blind)",
  TOOL_CALL_PATTERNS.some((re) => re.test(fixtureCode)))

function listTsxFiles(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) listTsxFiles(p, out)
    else if (/\.(tsx?|jsx?)$/.test(e)) out.push(p)
  }
  return out
}

const dashboardFiles = listTsxFiles("app/dashboard")
check("app/dashboard directory scan actually found files (not a silent empty list)", dashboardFiles.length > 100, `found ${dashboardFiles.length}`)

const dashboardHits: string[] = []
for (const f of dashboardFiles) {
  const src = stripped(f)
  for (const re of TOOL_CALL_PATTERNS) {
    if (re.test(src)) dashboardHits.push(`${f} :: ${re}`)
  }
}
check("REAL SCAN: zero dashboard files call an AI-agent tool function directly (owner: 'these tools are not for users to use')",
  dashboardHits.length === 0, dashboardHits.join("; "))

// The BatchData-mentioning dashboard files that DO exist are status/settings
// panels (feed status, provider connection state), never a tool-run button —
// named explicitly so this assertion is provably about the RIGHT files.
const knownBatchdataMentioningDashboardFiles = [
  "app/dashboard/admin/markets/markets-client.tsx",
  "app/dashboard/superadmin/env-providers/providers-client.tsx",
  "app/dashboard/settings/integrations/lead-sources/lead-sources-client.tsx",
]
for (const f of knownBatchdataMentioningDashboardFiles) {
  const src = stripped(f)
  check(`${f} mentions BatchData/RentCast only as STATUS/SETTINGS copy, never a tool call`,
    !TOOL_CALL_PATTERNS.some((re) => re.test(src)))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — the two surfaces this lane wired derive tenant + persona from
// session/handler context, never a request body (CLAUDE.md §4).
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · portal + widget wiring — tenant/persona from context, never body]")

const portalSrc = stripped("app/api/portal/ai-chat/route.ts")
check("portal persona is derived via resolveToolPersona from the ACCESS-CHECKED contact row's own contact_type/contact_persona/home_owner_status",
  /const portalPersona = resolveToolPersona\(\{[\s\S]{0,120}contactType: contact\.contact_type,[\s\S]{0,60}contactPersona: contact\.contact_persona,[\s\S]{0,60}homeOwnerStatus: contact\.home_owner_status,/.test(portalSrc))
check("portal batchDataIsaTools call uses the contact's OWN brokerage_id/agent_id, never body fields",
  /brokerageId: contact\.brokerage_id,[\s\S]{0,80}agentId: contact\.agent_id \?\? null,[\s\S]{0,40}persona: portalPersona,/.test(portalSrc))
check("the persona derivation never reads the request body (no `body.persona` / `body.contactPersona` anywhere in this file)",
  !portalSrc.includes("body.persona") && !portalSrc.includes("body.contactPersona"))

const widgetSrc = stripped("app/api/widget/message/route.ts")
check("widget persona is derived via resolveToolPersona from the SESSION's own linked contact (never a body field) — a still-anonymous visitor resolves to the 'buyer' default",
  /const widgetPersona = resolveToolPersona\(\{/.test(widgetSrc))
check("widget batchDataIsaTools call uses the SESSION row's brokerage_id/agent_id (the only identity this route accepts), never a body field",
  /brokerageId: session\.brokerage_id,[\s\S]{0,60}agentId: session\.agent_id,[\s\S]{0,80}persona: widgetPersona,/.test(widgetSrc))
check("widget conversationKey is the session row's own id (stable per visitor), not a client-supplied value",
  /conversationKey: session\.id,/.test(widgetSrc))

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 5 (lane 73E) — the voice ISA's turn engine on GENUINE native AI-SDK
// multi-step tool-calling: `tools:` + `maxSteps` (≤3) + a hard per-turn
// `abortSignal` deadline, replacing wave 73B's hand-rolled
// plan→execute→re-plan protocol (TOMBSTONE in lib/voice/reception-brain.ts).
// Proved with an INJECTED generateTextRouted (module mock) and a STUBBED
// batchDataIsaTools registry so this file makes NO network call and spends NO
// real BatchData/AI budget — the mock plays the AI SDK's own role of calling
// the ONE tool it was offered before returning final text, which is exactly
// what this repo's other native tool-calling call sites (handle-inbound-
// email.ts, the in-app/portal/widget AI-chat routes) already trust the real
// SDK to do; this proof is about OUR wiring (which tools, what step bound,
// whether a deadline is set, and the timeout→plan-only fallback), not a
// re-test of the SDK's own multi-step loop.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · voice ISA — native multi-step tool-calling, bounded + deadline-protected + fail-safe]")

{
  const { parseTurnPlan, VOICE_TOOL_ALLOWLIST } = await import("../lib/voice/reception-brain")
  const { planTurnWithPrompt, VOICE_TOOL_ROUND_MAX_STEPS, VOICE_TOOL_ROUND_DEADLINE_MS } = await import("../lib/voice/twilio-voice")

  check("VOICE_TOOL_ALLOWLIST is the closed, property-only subset (no skip-trace/dnc/tcpa on the voice line)",
    (VOICE_TOOL_ALLOWLIST as readonly string[]).length === 4 &&
    !(VOICE_TOOL_ALLOWLIST as readonly string[]).includes("skip_trace_property") &&
    !(VOICE_TOOL_ALLOWLIST as readonly string[]).includes("check_dnc_status"))
  check("VOICE_TOOL_ROUND_MAX_STEPS obeys the turn-engine's ≤3 design ceiling",
    VOICE_TOOL_ROUND_MAX_STEPS >= 1 && VOICE_TOOL_ROUND_MAX_STEPS <= 3)
  check("VOICE_TOOL_ROUND_DEADLINE_MS is a positive, finite ms budget (env-tunable, default 4000)",
    VOICE_TOOL_ROUND_DEADLINE_MS > 0 && Number.isFinite(VOICE_TOOL_ROUND_DEADLINE_MS))

  // TOMBSTONE positive control: a raw `tool_request` field in the model's
  // JSON is simply IGNORED now — VoiceTurnPlan carries no such field, proving
  // the manual mechanism is actually gone, not merely unused.
  const withStaleField = parseTurnPlan(JSON.stringify({
    say: "Let me check that for you.", action: "continue",
    tool_request: { name: "lookup_property", address: "123 Main St" },
  })) as unknown as Record<string, unknown>
  check("parseTurnPlan: a stale tool_request field in the model's JSON is a no-op (native tool-calling replaced it, lane 73E tombstone)",
    !("toolRequest" in withStaleField))

  // ── native round: tools reach the SDK call, persona-filtered, bounded, deadline set ──
  let seenToolNames: string[] = []
  let seenMaxSteps: number | undefined
  let seenAbortSignal: unknown
  let executedArgs: any = null
  const finalPlan = await planTurnWithPrompt(
    "You are the receptionist.", null, "What can you tell me about 123 Main St?",
    { brokerageId: "brokerage-1", agentId: null, contactId: null, conversationKey: "call-1" },
    {
      generateTextRouted: async ({ tools, maxSteps, abortSignal }: any) => {
        seenToolNames = Object.keys(tools ?? {})
        seenMaxSteps = maxSteps
        seenAbortSignal = abortSignal
        // Play the AI SDK's own role for this proof: call the tool it was
        // offered, then return the final JSON with the result folded in —
        // exactly once, never a second manual re-prompt on our side.
        if (tools?.lookup_property) await tools.lookup_property.execute({ address: "123 Main St", city: null, state: null, zip: null }, { toolCallId: "t1", messages: [] })
        return { text: JSON.stringify({ say: "It's a 3-bed built in 1998.", action: "continue" }) }
      },
      batchDataIsaTools: async () => ({
        lookup_property: { execute: async (args: any) => { executedArgs = args; return { success: true, data: { address: args.address } } } },
        // NOT in VOICE_TOOL_ALLOWLIST — proves the voice line's property-only
        // subset filter applies even when a persona's fuller registry grants it.
        verify_phone: { execute: async () => ({ success: true }) },
      }),
    },
  )
  check("native round: only the VOICE_TOOL_ALLOWLIST subset reaches `tools:` — verify_phone is filtered out even though the stubbed registry granted it",
    seenToolNames.length === 1 && seenToolNames[0] === "lookup_property")
  check("native round: maxSteps is the bounded ceiling, not an unbounded loop", seenMaxSteps === VOICE_TOOL_ROUND_MAX_STEPS)
  check("native round: a real per-turn deadline (AbortSignal) is passed through to generateTextRouted", seenAbortSignal instanceof AbortSignal)
  check("native round: the offered tool's execute() actually ran with the model's args", executedArgs?.address === "123 Main St")
  check("native round: the final say comes from the ONE generateTextRouted call — the SDK folds the tool result in itself, never a second manual re-prompt",
    finalPlan.say === "It's a 3-bed built in 1998.")

  // ── cost-avoidance: nothing in this persona's/token's allowlist → skip the tool-enabled call entirely ──
  let plainCallSawTools: unknown = "unset"
  const refusedPlan = await planTurnWithPrompt(
    "You are the receptionist.", null, "What can you tell me about 1 Refused Way?",
    { brokerageId: "brokerage-1", agentId: null, contactId: null, conversationKey: "call-refused" },
    {
      generateTextRouted: async ({ tools }: any) => { plainCallSawTools = tools; return { text: JSON.stringify({ say: "I don't have that on hand right now — the team will confirm.", action: "continue" }) } },
      batchDataIsaTools: async () => ({}), // no token / persona grants none of the 4
    },
  )
  check("native round: an EMPTY registry (no token / persona grants none of the 4) skips the tool-enabled call entirely — no `tools:` key, never an empty-map call",
    plainCallSawTools === undefined)
  check("...and the turn still completes with a real spoken plan", refusedPlan.say.length > 0)

  // ── FAIL SAFE: a thrown/timed-out native round falls back to the plan-only path ──
  const calls: any[] = []
  const timeoutPlan = await planTurnWithPrompt(
    "You are the receptionist.", null, "Tell me about 500 Timeout Ave",
    { brokerageId: "brokerage-1", agentId: null, contactId: null, conversationKey: "call-timeout" },
    {
      generateTextRouted: async (args: any) => {
        calls.push(args)
        if (calls.length === 1) {
          const err: any = new Error("The operation was aborted.")
          err.name = "TimeoutError"
          throw err
        }
        return { text: JSON.stringify({ say: "Let me have the team call you back with that.", action: "continue" }) }
      },
      batchDataIsaTools: async () => ({ lookup_property: { execute: async () => ({ success: true }) } }),
    },
  )
  check("FAIL SAFE: exactly two generateTextRouted attempts — the (failed) tool round, then ONE plan-only fallback", calls.length === 2)
  check("FAIL SAFE: the first (failed) attempt carried tools", !!calls[0]?.tools && Object.keys(calls[0].tools).length > 0)
  check("FAIL SAFE: the fallback attempt carries NO tools — the plain plan-only path, not a retried tool round", calls[1]?.tools === undefined)
  check("FAIL SAFE: the turn still completes with a real spoken plan after the timeout — never silence on a live call", timeoutPlan.say.length > 0)

  // ── no toolCtx at all (the outbound ISA lane today) → plain call, unchanged ──
  let noCtxSawTools: unknown = "unset"
  const noCtxPlan = await planTurnWithPrompt(
    "You are the receptionist.", null, "Tell me about 1 Never Run Ln", undefined,
    { generateTextRouted: async ({ tools }: any) => { noCtxSawTools = tools; return { text: JSON.stringify({ say: "Sure.", action: "continue" }) } } },
  )
  check("no toolCtx passed → a plain call with no tools, exactly as before lane 73B ever existed (additive, not a silent behavior change)",
    noCtxSawTools === undefined)
  check("...and the turn still completes normally", noCtxPlan.say === "Sure.")

  // ── platform-reception.ts (item 5): ONE safe, tenant-free tool, native calling ──
  const platformReceptionSrc = stripped("lib/voice/platform-reception.ts")
  check("platform-reception.ts wires platform_faq_lookup as a REAL AI-SDK tool (native calling) — no more toolRequest schema-parity field",
    platformReceptionSrc.includes("platform_faq_lookup") && !platformReceptionSrc.includes("toolRequest"))
  check("the platform FAQ tool calls searchKB with brokerageId: null — tenant-free by construction (the RPC's own WHERE clause degrades to platform-wide rows only)",
    /searchKB\(query, null, 3\)/.test(platformReceptionSrc))
  check("platform-reception reuses the SAME bounded ceiling/deadline as the tenant voice line — no second, invented budget",
    platformReceptionSrc.includes("VOICE_TOOL_ROUND_MAX_STEPS") && platformReceptionSrc.includes("VOICE_TOOL_ROUND_DEADLINE_MS"))
  check("platform-reception still carries NO brokerage/property tool (search_properties/comparable_property/etc never appear there) — property lookups stay tenant-scoped",
    !platformReceptionSrc.includes("batchDataIsaTools") && !platformReceptionSrc.includes("lookup_property"))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 4 (lane 72B, task 3) — BatchData V3 skip-trace unit cost: ONE named
// constant, every reader derived from it, discrepancy resolved to the
// wave-67 RESEARCHED figure (the code's prior inline 0.15 cited no invoice).
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · BatchData skip-trace unit cost — one named constant]")

const batchdataClientSrc = stripped("lib/external/batchdata-client.ts")
const batchdataClientMod = await import("../lib/external/batchdata-client")
check("BATCHDATA_SKIP_TRACE_COST_USD is exported and equals the wave-67 researched figure ($0.06), not the prior unsourced $0.15",
  (batchdataClientMod as any).BATCHDATA_SKIP_TRACE_COST_USD === 0.06)
check("no bare 0.15 literal remains at the skip-trace cost accumulation site",
  !/cost \+= chunk\.length \* 0\.15/.test(batchdataClientSrc))
check("the skip-trace cost accumulation site now derives from the named constant",
  /cost \+= chunk\.length \* BATCHDATA_SKIP_TRACE_COST_USD/.test(batchdataClientSrc))
check("skipTraceBatchDataV3Batch is the ONLY reader of the skip-trace unit cost in this file (one vocabulary, §6)",
  (batchdataClientSrc.match(/BATCHDATA_SKIP_TRACE_COST_USD/g) ?? []).length === 2) // the const decl + its one use site

const envExampleSrc = readFileSync(".env.example", "utf8")
check(".env.example's documented skip-trace price (~$0.06/matched record) agrees with the code constant — no second, disagreeing figure",
  envExampleSrc.includes("~$0.06/matched record"))

const providersDocSrc = readFileSync("docs/real-estate-data-providers-2026-09.md", "utf8")
check("docs/real-estate-data-providers-2026-09.md records the reconciliation (not still flagging an unreconciled discrepancy)",
  providersDocSrc.includes("RECONCILED lane 72B") && providersDocSrc.includes("BATCHDATA_SKIP_TRACE_COST_USD"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ AI_AGENT_TOOL_SURFACES — see failures above")
  process.exit(1)
} else {
  console.log(" ✅ AI_AGENT_TOOL_SURFACES — every chat/phone surface's tool set matches its audience; no user-facing tool UI")
}
