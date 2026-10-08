/**
 * scripts/lead-channel-rule-guard.ts — `npm run test:lead-channel-rule`
 *
 * WAVE 91, LANE 91B. Owner rulings (2026-09-30, verbatim):
 *   "Leads usually are non consenting so no sms or calls allowed only email and direct mail."
 *   "If the lead needs a callback, that is a positive intent so that lead gets converted."
 *   "we should only pull more recent data"
 *
 * Proves, with no network and no DB:
 *   A  THE PREDICATE — lib/ai-isa/lead-channel-policy.ts::channelRefusalForRecipient refuses every
 *      SMS / voice spelling for a LEAD, admits email + direct mail, never judges a CONTACT, and
 *      agrees with the ISA's own chooser (pickLeadOutreachChannel) on every requested channel.
 *   B  THE SEND DOORS — every SMS/voice primitive is DERIVED from the tree (call sites in lib/ + app/
 *      over comment-stripped, string-blanked source) and each chokepoint asks the predicate:
 *      dispatchSms, the TCPA gate (every messaging sendSMS / placeCall and every AI dial), the pre-dial
 *      stack (lead_channel gate — EXECUTED), the voicedrop rail. Raw provider sends are confined to
 *      their gated modules. No lead-context send site drops its recipient key. Positive controls: the
 *      pre-91B initiate-engagement SMS site and a raw Twilio Messages call are flagged.
 *   C  CALLBACK = POSITIVE INTENT — createCallbackTask converts a lead FIRST (EXECUTED with a fake
 *      client + injected converter) and lands the task on the agent's contact; the inbound classifier
 *      converts on a callback ask; the executor cron never dials a lead.
 *   D  RECENCY — the raw writer's Gate 1b drops a DATED stale record before the row exists (before
 *      PeopleData); the Exa/permit windows are the sourcers' own constants (derived, not pinned).
 */
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { blankComments, blankStrings } from "./strip-comments"
import {
  channelRefusalForRecipient, leadStageChannelRefusal,
  pickLeadOutreachChannel, LEAD_ALLOWED_CHANNELS,
} from "../lib/ai-isa/lead-channel-policy"

// callback-task / classifier / voice gates reach "server-only" through dynamic imports only on the
// paths this proof does not execute; the shim keeps a transitive import from throwing.
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not resolvable — nothing to shim */ }

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
/** Positions preserved: comments AND string contents blanked (a tombstone or a fixture is not code). */
const code = (src: string) => blankStrings(blankComments(src))
const codeOf = (p: string) => code(read(p))

/** The body of a top-level function `name` (from its declaration to the next column-0 `}`). */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`).exec(src)
  if (!m) return ""
  // The body closes at a column-0 `}` ending its line — a multi-line parameter type closes at a
  // column-0 `}` too, but is followed by `)` / `:` on the same line, so it is skipped.
  const closer = /\n\}[ \t]*(\r?\n|$)/g
  closer.lastIndex = m.index
  const end = closer.exec(src)
  return src.slice(m.index, end ? end.index + 2 : undefined)
}

/** The balanced `( … )` argument text starting at `open` (the index of the `(`). */
function argText(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === "(") depth++
    else if (ch === ")") { depth--; if (depth === 0) return src.slice(open + 1, i) }
  }
  return src.slice(open + 1)
}

/** Only the TOP-LEVEL text of the first object literal in an argument list (nested objects blanked),
 *  so `metadata: { leadId }` is not mistaken for a recipient key. */
function topLevelKeys(args: string): string {
  const start = args.indexOf("{")
  if (start < 0) return ""
  let depth = 0
  let out = ""
  for (let i = start; i < args.length; i++) {
    const ch = args[i]
    if (ch === "{" || ch === "[" || ch === "(") { depth++; if (depth > 1) continue }
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) break; if (depth >= 1) continue }
    if (depth === 1) out += ch
  }
  return out
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p)
  }
  return out
}

// ═══ A · THE PREDICATE ════════════════════════════════════════════════════════
console.log("\n[A · the ONE lead-stage predicate]")
const TELEPHONE = ["sms", "text", "mms", "phone", "call", "voice", "voicemail", "voicedrop", "voice_drop", "ai_call", "ringless_voicemail", "whatsapp"]
const MAILISH = ["email", "direct_mail", "mail", "postcard", "letter", "newsletter", "video_email"]
const lead = { leadId: "lead-1", contactId: null }
const contact = { contactId: "contact-1", leadId: "lead-1" }
check(`every SMS/voice spelling is REFUSED for a lead (${TELEPHONE.length})`,
  TELEPHONE.every((c) => !!channelRefusalForRecipient(lead, c)), TELEPHONE.filter((c) => !channelRefusalForRecipient(lead, c)).join(","))
check(`email + direct mail (and their carried spellings) are ADMITTED for a lead (${MAILISH.length})`,
  MAILISH.every((c) => channelRefusalForRecipient(lead, c) === null), MAILISH.filter((c) => channelRefusalForRecipient(lead, c) !== null).join(","))
check("an unknown / empty channel is refused for a lead (fail closed)",
  !!leadStageChannelRefusal("carrier_pigeon") && !!leadStageChannelRefusal(null) && !!leadStageChannelRefusal("social"))
check("a CONTACT is never judged here (its own consent rules apply at the TCPA gate)",
  TELEPHONE.every((c) => channelRefusalForRecipient(contact, c) === null))
check("stage: contactId → contact · leadId alone → lead · neither → unknown (the TCPA gate resolves by phone)",
  channelRefusalForRecipient(contact, "sms") === null && !!channelRefusalForRecipient(lead, "sms") && channelRefusalForRecipient({}, "sms") === null)
check("the roster is ONE list: every LEAD_ALLOWED_CHANNELS member is admitted, and nothing outside the roster's carried spellings is",
  LEAD_ALLOWED_CHANNELS.every((c) => leadStageChannelRefusal(c) === null) && TELEPHONE.every((c) => leadStageChannelRefusal(c) !== null))
{
  // The chooser and the doors agree: whatever pickLeadOutreachChannel answers, the doors admit.
  const disagreements: string[] = []
  for (const req of [...TELEPHONE, ...MAILISH, null, "social"]) {
    for (const emailUsable of [true, false]) for (const mailingVerified of [true, false]) {
      const picked = pickLeadOutreachChannel({ requestedChannel: req, emailUsable, mailingVerified })
      if (picked !== "no_outreach" && channelRefusalForRecipient(lead, picked) !== null) disagreements.push(`${req}→${picked}`)
    }
  }
  check("the chooser (pickLeadOutreachChannel) never picks a channel the send doors refuse", disagreements.length === 0, disagreements.join(","))
}

// ═══ B · THE SEND DOORS ═══════════════════════════════════════════════════════
console.log("\n[B · every SMS / voice door asks the predicate]")
const DISPATCH = codeOf("lib/providers/dispatch.ts")
const TCPA = codeOf("lib/communication/tcpa-gate.ts")
const MESSAGING = codeOf("lib/providers/messaging/index.ts")
const GATES = codeOf("lib/voice/outbound-call-gates.ts")
const OUTBOUND = codeOf("lib/voice/twilio-outbound.ts")
const VOICEDROP = codeOf("lib/voicedrop/orchestrate-voicedrop-send.ts")

const dispatchSmsBody = fnBody(DISPATCH, "dispatchSms")
check("dispatchSms asks channelRefusalForRecipient BEFORE any read (first gate) and forwards leadId to the TCPA chokepoint",
  /channelRefusalForRecipient\(/.test(dispatchSmsBody)
    && dispatchSmsBody.indexOf("channelRefusalForRecipient(") < dispatchSmsBody.indexOf("autonomyGate(")
    && /messagingSendSMS\(\{[\s\S]*?leadId:/.test(dispatchSmsBody))
const tcpaBody = fnBody(TCPA, "enforceTCPACompliance")
// Table names are string literals — read this body with comments blanked and strings KEPT.
const leadStageBody = fnBody(blankComments(read("lib/communication/tcpa-gate.ts")), "leadStageRefusal")
check("enforceTCPACompliance runs the lead-stage arm BEFORE its contact consent block",
  /leadStageRefusal\(input\)/.test(tcpaBody) && tcpaBody.indexOf("leadStageRefusal(input)") < tcpaBody.indexOf("if (input.contactId)"))
check("the lead-stage arm asks the ONE predicate, resolves a number-only send by phone against unconverted leads, and FAILS CLOSED on an unreadable lookup",
  /channelRefusalForRecipient\(/.test(leadStageBody) && /\.from\("leads"\)[\s\S]*?\.is\("contact_id", null\)/.test(leadStageBody) && /if \(readErr\)\s*\{\s*return/.test(leadStageBody))
for (const fn of ["sendSMS", "placeCall"]) {
  const body = fnBody(MESSAGING, fn)
  check(`messaging ${fn} runs the TCPA chokepoint with the leadId key`, /enforceTCPACompliance\(\{[\s\S]*?leadId:/.test(body))
}
check("the pre-dial TCPA gate forwards leadId", /enforceTCPACompliance\(\{[\s\S]*?leadId: ctx\.leadId/.test(fnBody(GATES, "runTcpaGate")))
check("placeOutboundAiCall runs the gate stack BEFORE it dials", OUTBOUND.indexOf("runOutboundCallGates(") > 0 && OUTBOUND.indexOf("runOutboundCallGates(") < OUTBOUND.indexOf("placeCall(creds"))
check("the voicedrop rail asks the lead-stage arm BEFORE its consent read and before any connector call",
  /leadStageRefusal\(/.test(fnBody(VOICEDROP, "ensureCompliance")) && VOICEDROP.indexOf("ensureCompliance({") < VOICEDROP.indexOf("callConnector<"))

// EXECUTED — the pre-dial stack's lead_channel gate.
const { OUTBOUND_CALL_GATES } = await import("../lib/voice/outbound-call-gates")
const leadGate = OUTBOUND_CALL_GATES.find((g) => (g.key as string) === "lead_channel")
check("the pre-dial stack carries a lead_channel gate, consumer-protection, ahead of suppression/tcpa and every spend gate",
  !!leadGate && leadGate.consumerProtection === true
    && OUTBOUND_CALL_GATES.findIndex((g) => (g.key as string) === "lead_channel") < OUTBOUND_CALL_GATES.findIndex((g) => g.key === "tcpa")
    && OUTBOUND_CALL_GATES.findIndex((g) => (g.key as string) === "lead_channel") < OUTBOUND_CALL_GATES.findIndex((g) => !g.consumerProtection))
if (leadGate) {
  const refused = await leadGate.run({ brokerageId: "b", toNumber: "+15125550100", contactId: null, leadId: "lead-1" })
  const admitted = await leadGate.run({ brokerageId: "b", toNumber: "+15125550100", contactId: "contact-1", leadId: "lead-1" })
  check("EXECUTED: a lead-keyed dial is refused (blockReason lead_stage) before any read", refused?.blockReason === "lead_stage", JSON.stringify(refused))
  check("EXECUTED (positive control): a dial re-keyed to the contact passes this gate (the contact's consent is the TCPA gate's job)", admitted === null)
}

// ── the population — derived from the tree ───────────────────────────────────
const PRIMITIVES = ["dispatchSms", "sendSMS", "placeCall", "placeOutboundAiCall", "initiateVoiceCall", "orchestrateVoicedropSend", "orchestrateSmsPresetSend"]
const FILES = [...walk("lib"), ...walk("app")]
interface Site { file: string; fn: string; args: string }
const sites: Site[] = []
for (const f of FILES) {
  const src = codeOf(f)
  for (const fn of PRIMITIVES) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 20), m.index)
      if (/function\s+$/.test(before)) continue // the definition, not a call
      sites.push({ file: f, fn, args: argText(src, src.indexOf("(", m.index)) })
    }
  }
}
const perPrimitive = PRIMITIVES.map((p) => `${p}=${sites.filter((s) => s.fn === p).length}`).join(" ")
check(`the send-site population is derived from the tree (${sites.length} call sites across ${new Set(sites.map((s) => s.file)).size} files: ${perPrimitive})`,
  sites.length > 20 && PRIMITIVES.every((p) => sites.some((s) => s.fn === p)))

// Every primitive reaches the predicate: dispatchSms (itself) · sendSMS/placeCall (messaging → TCPA gate)
// · placeOutboundAiCall (gate stack) · initiateVoiceCall (→ placeOutboundAiCall, contact-keyed) ·
// orchestrateVoicedropSend (lead-stage arm) · orchestrateSmsPresetSend (→ dispatchSms).
check("initiateVoiceCall dials only through placeOutboundAiCall with a contactId",
  /placeOutboundAiCall\([^)]*\{[\s\S]*?contactId: metadata\.contactId/.test(fnBody(codeOf("lib/voice-engine/call-executor.ts"), "initiateVoiceCall")))
check("orchestrateSmsPresetSend sends only through dispatchSms", /dispatchSms\(/.test(codeOf("lib/sms/orchestrate-sms-preset-send.ts")) && !/messagingSendSMS|callConnector/.test(codeOf("lib/sms/orchestrate-sms-preset-send.ts")))

// A LEAD-CONTEXT site that DROPS the recipient key (neither contactId nor leadId at the top level of
// its argument object, while the call is plainly about a lead) is judged only by the phone lookup —
// the pre-91B initiate-engagement SMS shape. None may remain.
const dropsKey = (args: string) => {
  const top = topLevelKeys(args)
  return !/\b(contactId|leadId)\b/.test(top) && /\blead(Id|_id)?\b|\blead\./.test(args)
}
const dropped = sites.filter((s) => ["dispatchSms", "sendSMS", "placeOutboundAiCall", "orchestrateVoicedropSend", "orchestrateSmsPresetSend"].includes(s.fn) && dropsKey(s.args))
check("no lead-context SMS/voice send drops its recipient key", dropped.length === 0, dropped.map((s) => `${s.file}:${s.fn}`).join(", "))
const PRE_91B_SITE = code(`await dispatchSms({ brokerageId: lead.brokerage_id, to: phone, message: smsBody.slice(0, 320), metadata: { leadId, source: 'ai_isa', channel: 'sms' } })`)
check("POSITIVE CONTROL: the pre-91B initiate-engagement SMS site (no contactId, leadId only inside metadata) is flagged",
  dropsKey(argText(PRE_91B_SITE, PRE_91B_SITE.indexOf("("))))

// Raw provider sends bypass every primitive — confined to their gated modules.
const RAW_SEND = /Messages\.json|Calls\.json|placeCall\(creds|SMS_ADAPTERS\[|\.messages\.create\(|\.calls\.create\(|gateway\/vmb\.php/
const RAW_ALLOWED = new Set([
  "lib/providers/messaging/index.ts",          // behind enforceTCPACompliance
  "lib/providers/messaging/sms-adapters.ts",   // the adapters sendSMS dispatches to
  "lib/providers/twilio/client.ts",            // the SDK adapter itself
  "lib/voice/twilio-outbound.ts",              // behind runOutboundCallGates
  "lib/voice/warm-transfer.ts",                // the AGENT leg of a live transfer, never a lead
  "lib/voicedrop/orchestrate-voicedrop-send.ts", // behind ensureCompliance (lead-stage arm first)
])
// Comments blanked, STRINGS KEPT — the provider paths are string literals. A file matches when it
// both names a raw send path/token AND makes an outbound request.
const rawSend = (src: string) => RAW_SEND.test(src) && /callConnector|fetch\(|placeCall\(creds|SMS_ADAPTERS\[|\.create\(/.test(src)
const rawOutside = FILES.filter((f) => !RAW_ALLOWED.has(f) && rawSend(blankComments(read(f))))
check(`raw provider SMS/voice sends live only in their gated modules (${RAW_ALLOWED.size} allowed)`, rawOutside.length === 0, rawOutside.join(", "))
const RAW_FIXTURE = `await callConnector({ connector: "twilio", path: "/2010-04-01/Accounts/x/Messages.json", method: "POST" })`
check("POSITIVE CONTROL: a raw Twilio Messages call is recognised by the finder", rawSend(RAW_FIXTURE))

// Hand-rolled lead-stage tests migrated onto the predicate (the chooser's roster, not a local list).
for (const [file, token] of [
  ["app/actions/ai-isa/initiate-engagement.ts", "channelRefusalForRecipient("],
  ["lib/campaign-sequences/step-executor.ts", "channelRefusalForRecipient("],
  ["lib/workflow/adapters/sms.ts", "channelRefusalForRecipient("],
  ["lib/workflow/adapters/voice-drop.ts", "channelRefusalForRecipient("],
  ["lib/workflow/adapters/index.ts", "channelRefusalForRecipient("],
  ["app/api/voice/initiate-call/route.ts", "channelRefusalForRecipient("],
] as const) {
  check(`${file} asks the ONE predicate`, codeOf(file).includes(token))
}
check("no hand-typed lead allow-list survives in the migrated sites (FORCE_ALLOWED_CHANNELS / `!== \"email\" && … !== \"direct_mail\"`)",
  !/FORCE_ALLOWED_CHANNELS/.test(codeOf("app/actions/ai-isa/initiate-engagement.ts"))
    && !/step\.channel !== "email" && step\.channel !== "direct_mail"/.test(read("lib/campaign-sequences/step-executor.ts")))

// ═══ C · CALLBACK = POSITIVE INTENT ═══════════════════════════════════════════
console.log("\n[C · a lead's callback ask converts it first; the callback lands on the agent's contact]")
const cb = await import("../lib/ai-isa/callback-task")

function fakeSvc() {
  const inserts: Array<{ table: string; row: any }> = []
  const svc = {
    inserts,
    from(table: string) {
      const q: any = {
        insert(row: any) { inserts.push({ table, row }); return q },
        select() { return q }, eq() { return q }, is() { return q }, in() { return q }, limit() { return q },
        maybeSingle: async () => ({ data: { id: `${table}-new` }, error: null }),
        single: async () => ({ data: { id: `${table}-new` }, error: null }),
      }
      return q
    },
  }
  return svc
}
{
  const svc = fakeSvc()
  const calls: any[] = []
  const r = await cb.createCallbackTask(svc, {
    brokerageId: "b1", contactId: null, leadId: "lead-9", phone: "+15125550100",
    whenPhrase: "tomorrow at 3pm", reason: "wants to talk", voiceCallId: "vc-1", assigneeType: "ai_isa",
  }, { convertLead: async (p) => { calls.push(p); return { ok: true, contactId: "contact-9", agentId: "agent-9", side: "buyer" } } })
  const row = svc.inserts.find((i) => i.table === "tasks")?.row
  check("EXECUTED: a LEAD's callback ask runs the converter FIRST (brokerage + lead)", calls.length === 1 && calls[0].leadId === "lead-9" && calls[0].brokerageId === "b1")
  check("EXECUTED: the task lands on the CONVERTED contact, assigned to its agent (assignee 'agent') — never an ai_isa dial to the lead",
    r.ok && row?.contact_id === "contact-9" && row?.assigned_to_agent_id === "agent-9" && row?.assignee_type === "agent" && r.convertedFromLeadId === "lead-9", JSON.stringify(row))
  check("EXECUTED: the note carries no leadId once converted (the executor can never re-key it to the lead)",
    cb.decodeCallbackNote(row?.description)?.leadId === null)
}
{
  const svc = fakeSvc()
  let converted = 0
  const r = await cb.createCallbackTask(svc, {
    brokerageId: "b1", contactId: "contact-2", leadId: null, phone: "+15125550100",
    whenPhrase: "tomorrow at 3pm", reason: null, voiceCallId: null,
  }, { convertLead: async () => { converted++; return { ok: true, contactId: "x" } } })
  const row = svc.inserts.find((i) => i.table === "tasks")?.row
  check("EXECUTED (positive control): a CONTACT's ask is unchanged — no conversion, assignee stays ai_isa",
    r.ok && converted === 0 && row?.contact_id === "contact-2" && row?.assignee_type === "ai_isa")
}
{
  const svc = fakeSvc()
  const handOffs: any[] = []
  const r = await cb.createCallbackTask(svc, {
    brokerageId: "b1", contactId: null, leadId: "lead-3", phone: "+15125550100",
    whenPhrase: "asap", reason: null, voiceCallId: null,
  }, {
    convertLead: async () => ({ ok: false, error: "lead under representation" }),
    handOff: (async (_s: any, p: any) => { handOffs.push(p); return { humanTask: "lead_followup", notified: 1 } }) as any,
  })
  check("EXECUTED: a REFUSED conversion writes NO task (a lead is never called), hands the ask to a person, and says why",
    !r.ok && svc.inserts.filter((i) => i.table === "tasks").length === 0 && handOffs.length === 1 && /never|converts/.test(r.error ?? ""), r.error)
}
check("callbackPositiveIntent: a written ask converts on the lead's known side",
  cb.callbackPositiveIntent("Could you call me tomorrow afternoon?", null, "seller")?.side === "seller"
    && cb.callbackPositiveIntent("please give me a call", null, null)?.reason === "positive_reply")
check("callbackPositiveIntent keeps the classifier's own reading when it had one",
  cb.callbackPositiveIntent("call me back about the CMA", { side: "seller", reason: "cma_request" }, null)?.reason === "cma_request")
check("POSITIVE CONTROLS: a negated ask, a third party and plain text are NOT callback asks",
  cb.callbackPositiveIntent("please don't call me, email only", null, "buyer") === null
    && cb.callbackPositiveIntent("I'll call the bank back later", null, "buyer") === null
    && cb.callbackPositiveIntent("thanks for the listings", null, "buyer") === null)
check("the voice backstop detector's own contract still holds (call me back · return my call)",
  cb.detectCallbackRequest(["I need you to call me back tomorrow"]).requested && cb.detectCallbackRequest(["please return my call"]).requested)

const CLASSIFIER = codeOf("lib/ai-isa/inbound-intent-classifier.ts")
const routerBody = fnBody(CLASSIFIER, "classifyAndRouteInbound")
check("the inbound router converts on a callback ask (callbackPositiveIntent) and lands it on the agent's contact (landCallbackOnAgentContact) in BOTH converter branches",
  /callbackPositiveIntent</.test(routerBody) && (routerBody.match(/landCallbackOnAgentContact\(/g) ?? []).length === 2)
check("the keyword floor carries the callback arm too (model down never strands a callback ask)",
  /callbackPositiveIntent</.test(fnBody(CLASSIFIER, "keywordIntentFallback")))
check("createCallbackTask converts before it writes (convert → insert order)",
  (() => { const b = fnBody(codeOf("lib/ai-isa/callback-task.ts"), "createCallbackTask"); return b.indexOf("convert({") > 0 && b.indexOf("convert({") < b.indexOf(".insert(") })())
const CRON = codeOf("app/api/cron/ai-callback-dispatch/route.ts")
const neverDialsLead = (src: string) => {
  const conv = src.indexOf("convertLeadOnCallbackIntent(")
  const dial = src.indexOf("placeOutboundAiCall(")
  const guard = src.slice(conv, dial)
  return conv > 0 && conv < dial && /if \(!contactId && leadId\)/.test(src.slice(Math.max(0, conv - 1200), conv)) && /continue/.test(guard)
}
check("the executor cron never dials a lead: a lead-keyed task converts, is re-keyed to the contact + agent, and `continue`s before the dial",
  neverDialsLead(CRON))
const PRE_91B_CRON = code(`const { placeOutboundAiCall } = await import("x"); const placed = await placeOutboundAiCall(svc, { toNumber: note.phone, contactId, brokerageId, leadId })`)
check("POSITIVE CONTROL: the pre-91B executor (dial with leadId, no conversion) is flagged", !neverDialsLead(PRE_91B_CRON))
check("the ISA schedule_callback tool converts a lead first (proved in depth by test:qualification-playbook Layer 12)",
  /convertLeadOnCallbackIntent\(/.test(codeOf("lib/ai-isa/customer-context-tools.ts")))

// ═══ D · RECENCY ══════════════════════════════════════════════════════════════
console.log("\n[D · every pull is recency-windowed; stale records never reach enrichment]")
const { isWithinRecencyWindow } = await import("../lib/lead-pipeline/raw-record-types")
const { SOURCE_RECENCY, recencyWindowForSource, ALL_SOURCE_KEYS, DEFAULT_ACQUISITION_RECENCY_DAYS } = await import("../lib/lead-pipeline/source-intent-map")
const NOW = Date.now()
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()
const rec = (rawPayload: Record<string, unknown>) => ({ rawPayload })
check("a DATED stale post (ISO, 200d) is dropped by a 60-day window", !isWithinRecencyWindow(rec({ postedAt: daysAgo(200) }), 60, NOW))
check("a reddit epoch-seconds created_utc 90d old is dropped; 10d old is kept",
  !isWithinRecencyWindow(rec({ created_utc: Math.floor((NOW - 90 * 86_400_000) / 1000) }), 60, NOW)
    && isWithinRecencyWindow(rec({ created_utc: Math.floor((NOW - 10 * 86_400_000) / 1000) }), 60, NOW))
check("a nested post/extraction date is read (one level deep): stale nested → dropped, fresh nested → kept",
  !isWithinRecencyWindow(rec({ post: { publishedAt: daysAgo(200) } }), 60, NOW) && isWithinRecencyWindow(rec({ extraction: { posted_at: daysAgo(5) } }), 60, NOW))
check("UNDATED, relative ('3 days ago') and future-dated records are KEPT (nothing proves them stale — the published blind spot)",
  isWithinRecencyWindow(rec({}), 60, NOW) && isWithinRecencyWindow(rec({ posted_at: "3 days ago" }), 60, NOW)
    && isWithinRecencyWindow(rec({ date: new Date(NOW + 30 * 86_400_000).toISOString() }), 60, NOW))
check("POSITIVE CONTROL: the SAME stale record passes when no window applies — the window is what drops it",
  isWithinRecencyWindow(rec({ postedAt: daysAgo(200) }), null, NOW))
const SCRAPING = blankComments(read("lib/kernel/scraping.ts")) // the table name is a string literal
const ingestBody = fnBody(SCRAPING, "ingestRawSourceBatch")
check("ingestRawSourceBatch drops stale records BEFORE the raw insert (so PeopleData never sees them) and counts them",
  ingestBody.indexOf("isWithinRecencyWindow(") > 0 && ingestBody.indexOf("isWithinRecencyWindow(") < ingestBody.indexOf(".from('raw_scraped_leads')") && /skipped_stale\+\+/.test(ingestBody))
check(`every SourceKey has a recency entry (${ALL_SOURCE_KEYS.length})`, ALL_SOURCE_KEYS.every((k) => k in SOURCE_RECENCY))
check("an unregistered source spelling falls to the default window (fail toward recent)", recencyWindowForSource("some_new_scraper") === DEFAULT_ACQUISITION_RECENCY_DAYS && DEFAULT_ACQUISITION_RECENCY_DAYS > 0)
const { EXA_LOOKBACK_DAYS } = await import("../lib/lead-pipeline/exa-sourcer")
const { PERMIT_SOURCER_LOOKBACK_DAYS } = await import("../lib/lead-pipeline/permit-sourcer")
check("the Exa client window IS the sourcer's own request-side lookback (derived, not pinned)", SOURCE_RECENCY.exa_buyer_intent.windowDays === EXA_LOOKBACK_DAYS)
check("the permit client window IS the permit sourcer's own request-side lookback", SOURCE_RECENCY.permit_prelisting_intent.windowDays === PERMIT_SOURCER_LOOKBACK_DAYS)
check("the Exa sourcers still send startPublishedDate on every search",
  /startPublishedDate: since/.test(codeOf("lib/lead-pipeline/exa-sourcer.ts")) && /startPublishedDate: since/.test(codeOf("lib/lead-pipeline/permit-sourcer.ts")))

console.log(`\n  denominators: ${TELEPHONE.length + MAILISH.length} channel spellings · ${sites.length} SMS/voice call sites in ${FILES.length} files · ${ALL_SOURCE_KEYS.length} SourceKeys`)
console.log("  blind spots: send sites are found by the primitive's NAME over comment-stripped, string-blanked source (an aliased import would read as unseen — the chokepoints still gate it at runtime); a number-only send is a lead only when the tenant's leads carry that phone (a lead with no phone on file cannot be matched, and it cannot be dialled either); the recency gate can only drop what a payload DATES — undated rows are kept; Apify actors get no request-side date key (unverified per-actor input schemas — a rejected input would silently empty the lane), so their window is client-side only")
console.log(`\n${"─".repeat(50)}\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ LEAD_CHANNEL_RULE_FAIL"); process.exit(1) }
console.log(" ✅ LEAD_CHANNEL_RULE_PASS")
