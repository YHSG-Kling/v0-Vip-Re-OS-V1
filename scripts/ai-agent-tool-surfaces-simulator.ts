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

// The phone/voice ISA (Twilio ConversationRelay reception brain) uses a
// STRUCTURED JSON-PLAN turn engine (planTurnWithPrompt / planPlatformReceptionTurn),
// not AI-SDK tool()-calling — a deliberate latency-sensitive design from
// earlier waves (callback-task loop, wave 55). Lane 73B adds a BOUNDED,
// ONE-CALL-PER-TURN manual tool round on TOP of that JSON-plan engine (see
// Layer 5 below) rather than restructuring it into a full multi-step AI-SDK
// tool-calling loop — that larger architecture change remains UNRESOLVED,
// recorded here rather than silently claimed as done.
const twilioVoiceSrc = stripped("lib/voice/twilio-voice.ts")
check("the phone/voice ISA's turn engine is STILL a JSON-PLAN generator (generateTextRouted → parseTurnPlan), never native AI-SDK tool-calling (`tools:` passed to generateTextRouted) — the bounded manual round (Layer 5) is the smallest hook, not a full turn-engine rewrite",
  twilioVoiceSrc.includes("generateTextRouted") && !/generateTextRouted\(\{[\s\S]{0,200}tools:/.test(twilioVoiceSrc))

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
// LAYER 5 (lane 73B, item 3) — the voice ISA's turn plan carries an OPTIONAL
// `toolRequest`, executed AT MOST ONCE per turn against the SAME persona
// registry every chat surface uses, then re-planned once with the result —
// bounded, never chained. Proved with an INJECTED generateTextRouted (module
// mock) and a STUBBED batchDataIsaTools registry so this file makes NO
// network call and spends NO real BatchData/AI budget.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · voice ISA toolRequest — one bounded call per turn, fail closed without a token]")

{
  const { parseTurnPlan, parseVoiceToolRequest, VOICE_TOOL_NAMES } = await import("../lib/voice/reception-brain")

  // Schema-level: parseTurnPlan reads tool_request off the model's JSON.
  const withRequest = parseTurnPlan(JSON.stringify({
    say: "Let me check that for you.",
    action: "continue",
    tool_request: { name: "lookup_property", address: "123 Main St", city: "Austin", state: "TX", zip: "78701" },
  }))
  check("parseTurnPlan: reads a well-formed tool_request off the model's JSON", withRequest.toolRequest?.name === "lookup_property" && withRequest.toolRequest?.address === "123 Main St")

  const badName = parseVoiceToolRequest({ name: "skip_trace_property", address: "123 Main St" })
  check("parseVoiceToolRequest: an OUT-OF-ENUM tool name (e.g. skip_trace_property) is REJECTED — degrades to null, never reaches the executor", badName === null)
  const noAddress = parseVoiceToolRequest({ name: "lookup_property", address: "" })
  check("parseVoiceToolRequest: a blank address is REJECTED — degrades to null", noAddress === null)
  check("VOICE_TOOL_NAMES is the closed, property-only enum (no skip-trace/dnc/tcpa on the voice line)",
    (VOICE_TOOL_NAMES as readonly string[]).length === 4 &&
    !(VOICE_TOOL_NAMES as readonly string[]).includes("skip_trace_property") &&
    !(VOICE_TOOL_NAMES as readonly string[]).includes("check_dnc_status"))

  const withoutRequest = parseTurnPlan(JSON.stringify({ say: "Sure thing.", action: "continue" }))
  check("parseTurnPlan: toolRequest is undefined/null when the model omits tool_request entirely", !withoutRequest.toolRequest)

  // Executor round: INJECT generateTextRouted + batchDataIsaTools (VoiceToolRoundDeps,
  // a @proofSeam on lib/voice/twilio-voice.ts) so the WHOLE round (plan → execute →
  // re-plan) runs with zero network I/O and zero real AI-gateway/BatchData spend.
  const { planTurnWithPrompt } = await import("../lib/voice/twilio-voice")

  let generateCallCount = 0
  let lastPromptSeenToolResult = false
  let executedArgs: any = null
  const finalPlan = await planTurnWithPrompt(
    "You are the receptionist.", null, "What can you tell me about 123 Main St?",
    { brokerageId: "brokerage-1", agentId: null, contactId: null, conversationKey: "call-1" },
    {
      generateTextRouted: async ({ prompt }: { prompt: string }) => {
        generateCallCount++
        if (generateCallCount === 1) {
          return { text: JSON.stringify({ say: "Checking now.", action: "continue", tool_request: { name: "lookup_property", address: "123 Main St", city: null, state: null, zip: null } }) }
        }
        lastPromptSeenToolResult = /TOOL RESULT for lookup_property/.test(prompt)
        // A SECOND toolRequest in the re-plan response — proves the executor
        // discards it rather than chaining another round.
        return { text: JSON.stringify({ say: "It's a 3-bed built in 1998.", action: "continue", tool_request: { name: "comparable_property_preview", address: "999 Should Not Run" } }) }
      },
      batchDataIsaTools: async () => ({
        lookup_property: {
          execute: async (args: any) => { executedArgs = args; return { success: true, data: { address: args.address } } },
        },
      }),
    },
  )
  check("executeVoiceToolRound: exactly TWO generateTextRouted calls (the plan, then ONE re-plan) — never a third", generateCallCount === 2)
  check("executeVoiceToolRound: the tool actually ran with the model's requested address", executedArgs?.address === "123 Main St")
  check("executeVoiceToolRound: the re-plan prompt carries the tool's result", lastPromptSeenToolResult)
  check("executeVoiceToolRound: the FINAL plan's toolRequest is discarded even though the re-plan asked for a second one — bounded to ONE call per turn", finalPlan.toolRequest == null)
  check("executeVoiceToolRound: the final say comes from the SECOND (post-tool) generation, not the first", finalPlan.say === "It's a 3-bed built in 1998.")

  // Persona not in the allowlist / no BatchData token → the injected registry is empty,
  // proving the round REFUSES cleanly (no crash, no fabricated tool result) rather than
  // silently skipping straight to a final plan.
  let refusedGenerateCallCount = 0
  let refusalResultText = ""
  const refusedPlan = await planTurnWithPrompt(
    "You are the receptionist.", null, "What can you tell me about 1 Refused Way?",
    { brokerageId: "brokerage-1", agentId: null, contactId: null, conversationKey: "call-refused" },
    {
      generateTextRouted: async ({ prompt }: { prompt: string }) => {
        refusedGenerateCallCount++
        if (refusedGenerateCallCount === 1) {
          return { text: JSON.stringify({ say: "One moment.", action: "continue", tool_request: { name: "lookup_property", address: "1 Refused Way" } }) }
        }
        const m = prompt.match(/TOOL RESULT for lookup_property: (.+)/)
        refusalResultText = m?.[1] ?? ""
        return { text: JSON.stringify({ say: "I don't have that on hand right now — the team will confirm.", action: "continue" }) }
      },
      batchDataIsaTools: async () => ({}), // FAIL CLOSED / not in this persona's allowlist
    },
  )
  check("executeVoiceToolRound: a tool NOT in the registry (unconfigured token or persona refusal) is reported to the model plainly, never a crash", /not available/i.test(refusalResultText))
  check("executeVoiceToolRound: the turn still completes with a real plan after a tool refusal", refusedPlan.say.length > 0)

  // FAIL CLOSED WITHOUT A TOKEN: planTurnWithPrompt called with NO toolCtx at
  // all never attempts to execute a toolRequest — the field is parsed and
  // simply returned, proving the hook is additive/optional, not a silent
  // behavior change for every existing caller (the outbound ISA lane today).
  const plan = await planTurnWithPrompt(
    "You are the receptionist.", null, "Tell me about 1 Never Run Ln", undefined,
    { generateTextRouted: async () => ({ text: JSON.stringify({ say: "Sure.", action: "continue", tool_request: { name: "lookup_property", address: "1 Never Run Ln" } }) }) },
  )
  check("FAIL CLOSED WITHOUT A TOKEN: no toolCtx passed → toolRequest is returned UNEXECUTED (the model's plan still carries it, but nothing ran)", plan.toolRequest?.name === "lookup_property")

  // platform-reception.ts carries the schema field for PARITY but NEVER executes
  // it — no brokerage/property context exists on the platform prospect line.
  // The "reason on record" half is a DOC COMMENT — read RAW source for it on
  // purpose (same discipline as the chat-stream check in Layer 1C above).
  const platformReceptionSrc = stripped("lib/voice/platform-reception.ts")
  const platformReceptionRawSrc = readFileSync("lib/voice/platform-reception.ts", "utf8")
  check("platform-reception.ts's PlatformTurnPlan carries the toolRequest FIELD (schema parity)",
    platformReceptionSrc.includes("toolRequest"))
  check("...and its own doc comment records WHY it is never executed there (UNRESOLVED, not silently wired)",
    platformReceptionRawSrc.includes("UNRESOLVED"))
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
