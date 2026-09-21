#!/usr/bin/env tsx
/**
 * scripts/identity-class-tool-context-guard.ts   (npm run test:identity-class-tool-context)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 76A — owner verbatim: "you made some mistakes with assigning contactid
 * with leadid."
 *
 * THE IDENTITY CLASSES (CLAUDE.md §3), and the slots each may fill:
 *   contacts.id              → contactId / contact_id / entity_id when entity_type='contact'
 *                              (contacts ALSO has a secondary uuid `contact_id` column —
 *                              a `.from("contacts").eq("contact_id", …)` always returns nothing)
 *   leads.id                 → leadId / lead_id / entity_id when entity_type='lead'
 *   calendar_events.id       → calendarEventId; entity_type='calendar_event'
 *   agents.id                → agentId / agent_id (VoiceToolExecContext.agentId,
 *                              CustomerContextToolsContext.agentId, DispatchActorContext.agentId)
 *   users.id                 → userId / agentUserId / agent_user_id / actor_user_id
 *                              (DISJOINT from agents.id — cross ONLY via agents.user_id)
 *   brokerages.id            → brokerageId — never an actor user
 *
 * Proves, in STRIPPED source (scripts/strip-comments.ts — a tombstone is not a
 * call site, CLAUDE.md §2) across every AI-agent tool-context surface:
 *   Layer 1 — POSITIVE CONTROLS: each scanner catches the defect it was written
 *             for, in a fixture that has it (a "0 found" below is not blindness).
 *   Layer 2 — the six class rules find ZERO violations in the audited files.
 *   Layer 3 — the specific wave-75 defects lane 76A fixed are gone (source-anchored,
 *             so a revert goes red): voice agents.id wiring, callback lead id in the
 *             note, the appointment signal's entity class, the ISA-email compliance
 *             actor/contact, the relay route's lead-class opt-out.
 *   Layer 4 — prompt ↔ registry: every tool name the voice guidance, the follow-up
 *             menu and the per-persona guide promise is a REGISTERED tool name.
 *   Layer 5 — runtime (no DB, no network): buildCustomerFreeTools never mounts a
 *             contact-requiring tool on a lead-only thread, a contact typed
 *             'vendor' is a SPHERE persona (lane 77A: a vendor is a seat, never
 *             a persona — its tools live on lib/ai-isa/user-type-tools.ts and
 *             never enter the customer bundle), and the callback note
 *             round-trips a leads.id.
 *
 * Run:  npx tsx scripts/identity-class-tool-context-guard.ts
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const stripped = (path: string) => stripComments(readFileSync(path, "utf8"))

// ─────────────────────────────────────────────────────────────────────────────
// THE AUDITED SURFACES — every file that builds or consumes an AI-agent tool
// context carrying a contactId/leadId/agentId (the lane-76A audit list).
// ─────────────────────────────────────────────────────────────────────────────
const AUDITED_FILES = [
  "lib/ai-isa/customer-context-tools.ts",
  "lib/ai-isa/capability-catalogue.ts",
  // Lane 77A — the user-type (seat) tool surface: userId = users.id,
  // vendorId = vendors.id, agent_id args = agents.id, never crossed.
  "lib/ai-isa/user-type-tool-policy.ts",
  "lib/ai-isa/user-type-tools.ts",
  "lib/ai-isa/listing-appointment.ts",
  "lib/ai-isa/callback-task.ts",
  "lib/ai-isa/qualification-signals.ts",
  "lib/ai-isa/batchdata-isa-tools.ts",
  "lib/voice/twilio-voice.ts",
  "lib/voice/reception-brain.ts",
  "lib/voice/platform-reception.ts",
  "lib/referrals/referral-record.ts",
  "app/api/did/custom-llm/route.ts",
  "app/api/internal/ai-chat/route.ts",
  "app/api/widget/message/route.ts",
  "app/api/portal/ai-chat/route.ts",
  "app/api/voice/twilio/turn/route.ts",
  "app/api/voice/relay/plan/route.ts",
  "app/api/voice/twilio/inbound/route.ts",
  "app/api/cron/ai-callback-dispatch/route.ts",
  "app/actions/ai-isa/handle-inbound-email.ts",
]

// ─────────────────────────────────────────────────────────────────────────────
// THE RULES — each is a pure function over stripped source returning the
// offending snippets, so the SAME function runs on a fixture (positive
// control) and on the live tree.
// ─────────────────────────────────────────────────────────────────────────────
type Rule = { id: string; what: string; find: (src: string) => string[] }

/** value expression after `key:` up to the next `,`, `;`, `}` or newline —
 *  `;` so an interface member (`contactId: string | null; leadId: …`) never
 *  reads as one slot swallowing the next member's name. */
const slotValues = (src: string, keys: string[]) => {
  const out: Array<{ key: string; value: string }> = []
  const re = new RegExp(`\\b(${keys.join("|")})\\s*:\\s*([^,;\\n}]+)`, "g")
  for (const m of src.matchAll(re)) out.push({ key: m[1], value: m[2].trim() })
  return out
}
const LEAD_ID_TOKEN = /\bleadId\b|\blead_id\b|\bleads?\.id\b|\bleadRow\.id\b|\blead\.id\b/
const CONTACT_ID_TOKEN = /\bcontactId\b|\bcontact_id\b|\bcontacts?\.id\b|\bcontact\.id\b/
const USER_ID_TOKEN = /\bagentUserId\b|\bagent_user_id\b|\buser\.id\b|\buserId\b|\bactorUserId\b|\bactor_user_id\b/
const NON_CONTACT_ENTITY_TOKEN = /\bleadId\b|\blead_id\b|\blead\.id\b|\bcalendarEventId\b|\bcalendar_event_id\b|\bagentId\b|\bagentUserId\b|\buserId\b|\bbrokerageId\b/

const RULES: Rule[] = [
  {
    id: "R1", what: "a leads.id in a contactId/contact_id slot",
    find: (src) => slotValues(src, ["contactId", "contact_id", "referrerContactId", "referredContactId", "resulting_contact_id"])
      .filter((s) => LEAD_ID_TOKEN.test(s.value) && !CONTACT_ID_TOKEN.test(s.value))
      .map((s) => `${s.key}: ${s.value}`),
  },
  {
    id: "R2", what: "a contacts.id in a leadId/lead_id slot",
    find: (src) => slotValues(src, ["leadId", "lead_id", "referredLeadId"])
      .filter((s) => CONTACT_ID_TOKEN.test(s.value) && !LEAD_ID_TOKEN.test(s.value))
      .map((s) => `${s.key}: ${s.value}`),
  },
  {
    id: "R3", what: "entity_type 'contact' written with a non-contact id (lead / calendar event / agent / user / brokerage)",
    find: (src) => {
      const out: string[] = []
      // entityType first …
      // The two keys always sit in ONE object literal, so the gap between them
      // may not cross a closing `}` / `)` — otherwise an id would be paired
      // with the NEXT object's entity_type.
      for (const m of src.matchAll(/\bentity(?:Type|_type)\s*:\s*["']contact["'][^})]{0,220}?\bentity(?:Id|_id)\s*:\s*([^,;\n}]+)/g)) {
        const v = m[1].trim()
        if (NON_CONTACT_ENTITY_TOKEN.test(v) && !CONTACT_ID_TOKEN.test(v)) out.push(`entity_type contact ← ${v}`)
      }
      // … or entityId first — same single-object rule.
      for (const m of src.matchAll(/\bentity(?:Id|_id)\s*:\s*([^,;\n}]+)[^})]{0,220}?\bentity(?:Type|_type)\s*:\s*["']contact["']/g)) {
        const v = m[1].trim()
        if (NON_CONTACT_ENTITY_TOKEN.test(v) && !CONTACT_ID_TOKEN.test(v)) out.push(`entity_type contact ← ${v}`)
      }
      return out
    },
  },
  {
    id: "R4", what: "a users.id in an agentId/agent_id slot (agents.id and users.id are disjoint)",
    find: (src) => slotValues(src, ["agentId", "agent_id", "assignedToAgentId", "assigned_to_agent_id"])
      .filter((s) => USER_ID_TOKEN.test(s.value) && !/\bagents?\b|\bagentRow|\bagentRecord|resolveUserIdToAgentRecord|resolveAgentId\(/.test(s.value))
      .map((s) => `${s.key}: ${s.value}`),
  },
  {
    id: "R5", what: "the contacts table queried by its SECONDARY uuid column (.from(\"contacts\") … .eq(\"contact_id\") — always empty)",
    find: (src) => {
      const out: string[] = []
      for (const m of src.matchAll(/\.from\(["']contacts["']\)([\s\S]{0,400}?)\.eq\(["']contact_id["']/g)) {
        if (!/\.from\(/.test(m[1])) out.push(`.from("contacts")…eq("contact_id") @${m.index}`)
      }
      return out
    },
  },
  {
    id: "R6", what: "a brokerages.id / agents.id in an actorContext.userId slot (users.id)",
    find: (src) => {
      const out: string[] = []
      for (const m of src.matchAll(/actorContext\s*:\s*\{[\s\S]{0,200}?\buserId\s*:\s*([^,\n}]+)/g)) {
        const v = m[1].trim()
        if (/\bbrokerage_id\b|\bbrokerageId\b|\bagent_id\b|\bagentId\b/.test(v) && !USER_ID_TOKEN.test(v)) out.push(`actorContext.userId: ${v}`)
      }
      return out
    },
  },
  // ── THE SECOND RULE FAMILY — DATA FLOW, NOT NAMES (lane 77C, blind spot (7)) ──
  // R1-R6 judge a slot by the NAME of the value in it (`lead.id`, `leadId`).
  // A binding named `row`, `data`, `hit` or `r` that was READ FROM THE LEADS
  // TABLE and then written into a contactId slot passes every one of them,
  // and that is exactly the shape a refactor produces (`const { data: row }
  // = await svc.from("leads")…; … contactId: row.id`). R7/R8 follow the value
  // from the table it was read from to the slot it lands in, WITHIN THE SAME
  // FUNCTION BODY, whatever the binding is called. Scope is the enclosing
  // function: from the read to the next top-level function boundary (a
  // column-0 `function` / `export function` / `export const x = (` line) or
  // EOF — so a same-named binding in the NEXT function is never blamed for
  // this one's read (the negative control below proves the boundary holds).
  // BLIND SPOTS, published: a read whose query is built in one statement and
  // awaited in another (`const q = svc.from("leads")…; const { data } = await
  // q`), a re-binding (`const lead = row`), and a value that leaves the
  // function through a return are NOT followed — none is guessed at.
  ...tableFlowRules(),
]

/** The declaration shapes a supabase read lands in, capturing the binding:
 *  `const { data: X } = await …from("T")`, `const { data: X, error } = …`,
 *  `const X = await …from("T")…`. Non-greedy to the `.from("T")` on the same
 *  statement (no `;`), so a later statement's `.from` is never attributed. */
function tableReads(src: string, table: string): Array<{ binding: string; at: number }> {
  const out: Array<{ binding: string; at: number }> = []
  const re = new RegExp(
    String.raw`\b(?:const|let)\s+(?:\{\s*data\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]|([A-Za-z_$][\w$]*)\s*=)[^;]*?\.from\(\s*["']${table}["']\s*\)`,
    "g",
  )
  for (const m of src.matchAll(re)) {
    const binding = m[1] ?? m[2]
    if (binding) out.push({ binding, at: m.index ?? 0 })
  }
  return out
}

/** End of the function body a read at `at` belongs to — the next column-0
 *  function boundary after it, else EOF. */
function scopeEnd(src: string, at: number): number {
  const boundary = /\n(?:export\s+)?(?:async\s+)?function\b|\n(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(/g
  boundary.lastIndex = at
  const m = boundary.exec(src)
  return m ? m.index : src.length
}

function tableFlowRules(): Rule[] {
  const flow = (table: string, slotKeys: string[]) => (src: string): string[] => {
    const out: string[] = []
    for (const { binding, at } of tableReads(src, table)) {
      const body = src.slice(at, scopeEnd(src, at))
      const b = binding.replace(/[$]/g, "\\$")
      // `contactId: row.id` · `contact_id: row?.id` · `contactId: rows[0].id`
      const slot = new RegExp(String.raw`\b(${slotKeys.join("|")})\s*:\s*${b}(?:\[\d+\])?\??\.id\b`, "g")
      for (const s of body.matchAll(slot)) out.push(`${s[1]}: ${binding}.id (read from .from("${table}"))`)
    }
    return out
  }
  return [
    {
      id: "R7", what: "a value read from .from(\"leads\") written into a contactId/contact_id slot (data flow, name-agnostic)",
      find: flow("leads", ["contactId", "contact_id", "referrerContactId", "referredContactId", "resulting_contact_id"]),
    },
    {
      id: "R8", what: "a value read from .from(\"contacts\") written into a leadId/lead_id slot (data flow, name-agnostic)",
      find: flow("contacts", ["leadId", "lead_id", "referredLeadId"]),
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 0 · strip-comments positive control]")
const voiceSrc = stripped("lib/voice/twilio-voice.ts")
check("a comment-only phrase is ABSENT from stripped twilio-voice.ts (the scanner sees comments)",
  !voiceSrc.includes("THE TWILIO-NATIVE VOICE LANE"))
check("a real code token from the same file IS present (the scanner did not eat the code too)",
  voiceSrc.includes("export async function planReceptionTurn"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · POSITIVE CONTROLS — every rule catches its own defect in a fixture]")
const FIXTURES: Record<string, string> = {
  R1: `await createCallbackTask(svc, { brokerageId, contactId: lead.id, phone })\nconst x = { contact_id: leadId }`,
  R2: `await foo({ leadId: contact.id })\nconst y = { lead_id: contactId }`,
  R3: `await publishManagerSignal({ entityType: "contact", entityId: calendarEventId })\nawait svc.from("notifications").insert({ entity_id: leadId, entity_type: "contact" })`,
  R4: `const ctx = { brokerageId, agentId: ctx.agentUserId, contactId }\nawait writeFollowUpActivity({ agent_id: user.id })`,
  R5: `const { data } = await svc.from("contacts").select("id").eq("contact_id", ctx.contactId).maybeSingle()`,
  R6: `await evaluateOutbound({ actorContext: { userId: lead.brokerage_id, role: 'isa', brokerageId: lead.brokerage_id } })`,
  // Name-agnostic binding (`row`) — R1 cannot see this; R7 must.
  R7: `async function a(svc, leadId) {\n  const { data: row } = await svc.from("leads").select("id, brokerage_id").eq("id", leadId).maybeSingle()\n  await createCallbackTask(svc, { brokerageId: row.brokerage_id, contactId: row.id })\n}`,
  R8: `export async function b(svc, id) {\n  const hit = await svc.from("contacts").select("id").eq("id", id).maybeSingle()\n  await publishQualificationSignal({ leadId: hit?.id, contactId: null })\n}`,
}
const CLEAN_FIXTURES: Record<string, string> = {
  R1: `await createCallbackTask(svc, { contactId: lead.contact_id, leadId: lead.id })`,
  R2: `await foo({ leadId: lead.id, contactId: contact.id })`,
  R3: `await publishManagerSignal({ entityType: "calendar_event", entityId: calendarEventId, contactId })\nawait svc.from("notifications").insert({ entity_type: "contact", entity_id: params.contactId })`,
  R4: `const ctx = { agentId: (call as any).agent_id ?? null }\nconst a = { agentId: agentRow.id }`,
  R5: `await svc.from("contacts").select("id").eq("id", ctx.contactId)\nawait svc.from("activities").select("id").eq("contact_id", ctx.contactId)`,
  R6: `await evaluateOutbound({ actorContext: { userId: actorUserId, role: 'isa', brokerageId: lead.brokerage_id } })`,
  // The class-correct slot (leadId ← leads read), AND the scope boundary: the
  // NEXT function's `row` is a contacts read whose id may go in contactId.
  R7: `async function a(svc, leadId) {\n  const { data: row } = await svc.from("leads").select("id").eq("id", leadId).maybeSingle()\n  await createCallbackTask(svc, { leadId: row.id, contactId: null })\n}\n\nexport async function c(svc, id) {\n  const { data: row } = await svc.from("contacts").select("id").eq("id", id).maybeSingle()\n  await createCallbackTask(svc, { contactId: row.id })\n}`,
  R8: `export async function b(svc, id) {\n  const hit = await svc.from("contacts").select("id").eq("id", id).maybeSingle()\n  await publishQualificationSignal({ contactId: hit?.id, leadId: null })\n}`,
}
for (const r of RULES) {
  const hits = r.find(FIXTURES[r.id])
  check(`${r.id} POSITIVE CONTROL: catches "${r.what}" in a fixture that has it (${hits.length} hit${hits.length === 1 ? "" : "s"})`, hits.length >= 1, hits.join("; "))
  const clean = r.find(CLEAN_FIXTURES[r.id])
  check(`${r.id} NEGATIVE CONTROL: the class-correct spelling is NOT flagged`, clean.length === 0, clean.join("; "))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · zero violations across the audited AI-agent tool-context surfaces]")
let scannedBytes = 0
for (const f of AUDITED_FILES) {
  const src = stripped(f)
  scannedBytes += src.length
  for (const r of RULES) {
    const hits = r.find(src)
    check(`${f} · ${r.id} (${r.what}): 0`, hits.length === 0, hits.join(" | "))
  }
}
check(`denominator: ${AUDITED_FILES.length} files, ${scannedBytes} stripped bytes actually scanned (not a silent empty list)`, scannedBytes > 100_000)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · the wave-75 identity defects lane 76A fixed are GONE (source-anchored)]")
check("twilio-voice.ts: planReceptionTurn passes the route's agents.id into VoiceToolExecContext (was hardcoded null)",
  /agentId:\s*input\.voiceToolCtx\.agentId\s*\?\?\s*null/.test(voiceSrc) && !/brokerageId:\s*input\.ctx\.brokerageId,\s*agentId:\s*null,/.test(voiceSrc))
check("twilio-voice.ts: the free bundle receives the resolved persona (vendor gating reaches voice)",
  /buildCustomerFreeTools\(\{[\s\S]{0,200}?persona,/.test(voiceSrc))
check("twilio-voice.ts: a lead-only call resolves persona from the LEADS table, never by querying contacts with a leads.id",
  /\.from\("leads"\)[\s\S]{0,120}?\.eq\("id",\s*toolCtx\.leadId\)/.test(voiceSrc))
for (const route of ["app/api/voice/twilio/turn/route.ts", "app/api/voice/relay/plan/route.ts"]) {
  const src = stripped(route)
  check(`${route}: voiceToolCtx carries agentId = voice_calls.agent_id (agents.id), never ctx.agentUserId`,
    /voiceToolCtx:[\s\S]{0,260}?agentId:\s*\(call as any\)\.agent_id\s*\?\?\s*null/.test(src) && !/voiceToolCtx:[\s\S]{0,260}?agentId:\s*ctx\.agentUserId/.test(src))
}
const relaySrc = stripped("app/api/voice/relay/plan/route.ts")
check("relay/plan: the outbound opt-out honours a LEAD-only leg under entityType 'lead' (was contact-only — a lead's 'stop calling' was ignored on this transport)",
  /entityType:\s*\(call as any\)\.contact_id\s*\?\s*"contact"\s*:\s*"lead"/.test(relaySrc))

const callbackSrc = stripped("lib/ai-isa/callback-task.ts")
check("callback-task.ts: the note carries leadId (encode + decode) — tasks has no lead column and tasks.contact_id is a contacts.id slot",
  /leadId:\s*note\.leadId\s*\?\?\s*null/.test(callbackSrc) && /leadId:\s*typeof p\.leadId === "string"/.test(callbackSrc))
check("callback-task.ts: createCallbackTask writes the lead id into the NOTE, never into contact_id",
  /leadId:\s*params\.contactId\s*\?\s*null\s*:\s*params\.leadId\s*\?\?\s*null/.test(callbackSrc) && /contact_id:\s*params\.contactId,/.test(callbackSrc))
const executorSrc = stripped("app/api/cron/ai-callback-dispatch/route.ts")
check("ai-callback-dispatch: the executor prefers note.leadId (tenant-checked) over a phone re-guess",
  /else if \(note\.leadId\)/.test(executorSrc) && /\.eq\("id",\s*note\.leadId\)\.eq\("brokerage_id",\s*brokerageId\)/.test(executorSrc))

const apptSrc = stripped("lib/ai-isa/listing-appointment.ts")
check("listing-appointment.ts: the pending-confirmation signal keys its calendar_events.id under entityType 'calendar_event' (was 'contact')",
  /signalType:\s*"listing_appointment_pending_confirmation",[\s\S]{0,200}?entityType:\s*"calendar_event",\s*entityId:\s*calendarEventId,\s*contactId:\s*params\.contactId/.test(apptSrc))
check("listing-appointment.ts: bookListingAppointment REQUIRES a contacts.id (a lead converts at the caller first)",
  /export interface BookListingAppointmentParams \{[\s\S]{0,80}?contactId:\s*string\b/.test(apptSrc))

const emailSrc = stripped("app/actions/ai-isa/handle-inbound-email.ts")
check("handle-inbound-email: no lead-shaped object is passed as the compliance CONTACT (no `id: lead.id` fallback)",
  !/id:\s*lead\.id,/.test(emailSrc) && /contact:\s*contact\s*\?\?\s*undefined/.test(emailSrc))
check("handle-inbound-email: the lead-only thread is gated on the LEAD's own dnc_status/email_opt_out (fail closed)",
  /lead\.dnc_status === true \|\| lead\.email_opt_out === true/.test(emailSrc))
check("handle-inbound-email: actorContext.userId is a resolved users.id (agents.user_id crossing, then tenant admin), never lead.brokerage_id",
  /userId:\s*actorUserId,/.test(emailSrc) && !/userId:\s*lead\.brokerage_id/.test(emailSrc) && /\.from\('agents'\)\.select\('user_id'\)/.test(emailSrc) && /\[\.\.\.TENANT_ADMIN_USER_TYPES\]/.test(emailSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · prompt ↔ registry — every promised tool name is a registered one]")
{
  const { FREE_INTERNAL_TOOL_NAMES, PERSONA_TOOL_POLICY, resolveToolPersona } = await import("../lib/ai-isa/persona-tool-policy")
  const { QUALIFICATION_FOLLOW_UP_MENU, PERSONA_QUESTION_GUIDE } = await import("../lib/ai-isa/qualification-playbook")
  const { CAPABILITY_IDS } = await import("../lib/ai-isa/capability-catalogue")
  const { TOOL_TURN_GUIDANCE } = await import("../lib/voice/reception-brain")
  const registered = new Set<string>([...FREE_INTERNAL_TOOL_NAMES, ...(CAPABILITY_IDS as readonly string[])])

  const menuUnknown = QUALIFICATION_FOLLOW_UP_MENU.map((o) => o.tool).filter((t) => !registered.has(t))
  check("follow-up menu names only registered tools", menuUnknown.length === 0, menuUnknown.join(", "))
  for (const [persona, guide] of Object.entries(PERSONA_QUESTION_GUIDE)) {
    const unknown = guide.offers.filter((t) => !(CAPABILITY_IDS as readonly string[]).includes(t))
    check(`PERSONA_QUESTION_GUIDE.${persona}.offers ⊆ CAPABILITY_IDS`, unknown.length === 0, unknown.join(", "))
    check(`PERSONA_QUESTION_GUIDE.${persona} asks at least 3 realistic questions`, guide.asks.length >= 3)
  }
  check("every ToolPersona in PERSONA_TOOL_POLICY has a question guide, and the guide names NO user type (lane 77A: vendor is a seat, not a persona)",
    Object.keys(PERSONA_TOOL_POLICY).every((p) => p in PERSONA_QUESTION_GUIDE) && !("vendor" in PERSONA_QUESTION_GUIDE) && !("vendor" in PERSONA_TOOL_POLICY))
  check("resolveToolPersona: contact_type 'vendor' → sphere (a CRM record about a vendor is a business relationship — never the buyer default, never a persona of its own)",
    resolveToolPersona({ contactType: "vendor" }) === "sphere")

  // The voice tool guidance's parenthesised tool list — every snake_case token must be registered.
  const promised = (TOOL_TURN_GUIDANCE.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).filter((t) => t.includes("_"))
  const promisedUnknown = [...new Set(promised)].filter((t) => !registered.has(t))
  check("voice TOOL_TURN_GUIDANCE promises only registered tool names (the retired book_agent_appointment is gone)",
    promisedUnknown.length === 0 && !TOOL_TURN_GUIDANCE.includes("book_agent_appointment"), promisedUnknown.join(", "))
  // POSITIVE CONTROL: the same scan catches a retired name in a fixture.
  const fixtureGuidance = "call ONE follow-up tool (schedule_callback, book_agent_appointment) once"
  const fixtureUnknown = (fixtureGuidance.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).filter((t) => !registered.has(t))
  check("POSITIVE CONTROL: the promised-name scan DOES flag a retired tool name in a fixture", fixtureUnknown.includes("book_agent_appointment"))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · runtime — identity gates on the free bundle, vendor-typed contact, callback note round-trip]")
{
  const { buildCustomerFreeTools } = await import("../lib/ai-isa/customer-context-tools")
  const { encodeCallbackNote, decodeCallbackNote, bumpCallbackAttempt } = await import("../lib/ai-isa/callback-task")

  const leadOnly = Object.keys(await buildCustomerFreeTools({ brokerageId: "b-1", contactId: null, leadId: "lead-1", agentId: null }))
  check("lead-only thread: NO contact-requiring tool is mounted (request_showing absent), and no SEAT tool ever rides the customer bundle (get_my_vendor_status absent)",
    !leadOnly.includes("request_showing") && !leadOnly.includes("get_my_vendor_status"), leadOnly.join(","))
  check("lead-only thread: the lead-safe follow-ups + the new persona tools ARE mounted (record_qualification, schedule_callback, request_vendor_referral, capture_referral, get_listing_details)",
    ["record_qualification", "schedule_callback", "request_vendor_referral", "capture_referral", "get_listing_details"].every((n) => leadOnly.includes(n)), leadOnly.join(","))

  const contactKeys = Object.keys(await buildCustomerFreeTools({ brokerageId: "b-1", contactId: "c-1", leadId: null, agentId: "a-1" }))
  check("contact thread (persona unresolved): the full bundle incl. request_showing and the seller tools (buyer is the UNKNOWN default; 'both' is live)",
    ["request_showing", "schedule_home_value_review", "book_listing_appointment", "send_matching_listings", "get_listing_details", "request_vendor_referral", "capture_referral"].every((n) => contactKeys.includes(n)) && !contactKeys.includes("get_my_vendor_status"), contactKeys.join(","))

  // Lane 77A — a CONTACT typed 'vendor' is a sphere persona: it gets the
  // sphere-shaped customer bundle (referral capture, vendor bench, equity
  // review) and never a seat tool. The vendor SEAT's own tools are proved in
  // scripts/user-type-tool-surfaces-guard.ts.
  const { resolveToolPersona: resolvePersonaAgain } = await import("../lib/ai-isa/persona-tool-policy")
  const vendorTypedKeys = Object.keys(await buildCustomerFreeTools({ brokerageId: "b-1", contactId: "c-2", leadId: null, agentId: "a-1", persona: resolvePersonaAgain({ contactType: "vendor" }) }))
  check("a contact typed 'vendor' resolves to the SPHERE persona and gets the sphere customer bundle (capture_referral, request_vendor_referral, schedule_home_value_review) — and NO seat tool (get_my_vendor_status absent)",
    vendorTypedKeys.includes("capture_referral") && vendorTypedKeys.includes("request_vendor_referral") && vendorTypedKeys.includes("schedule_home_value_review") && !vendorTypedKeys.includes("get_my_vendor_status"), vendorTypedKeys.join(","))

  const note = encodeCallbackNote({ phone: "+15125550100", reason: "pricing", rawPhrase: "tomorrow 3pm", voiceCallId: null, leadId: "lead-42" })
  const decoded = decodeCallbackNote(note)
  check("callback note round-trips leadId (encode → decode)", decoded?.leadId === "lead-42")
  check("callback note keeps leadId across a retry bump (bumpCallbackAttempt re-encodes the SAME shape)",
    decodeCallbackNote(encodeCallbackNote(bumpCallbackAttempt(decoded!)))?.leadId === "lead-42")
  check("a pre-76A note (no leadId key) still decodes, with leadId null (never a crash on an older task)",
    decodeCallbackNote(`[CALLBACK] Call back x.\n${JSON.stringify({ phone: "+15125550100", reason: null, rawPhrase: "x", voiceCallId: null, attempts: 0 })}`)?.leadId === null)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ IDENTITY_CLASS_TOOL_CONTEXT — see failures above")
  process.exit(1)
} else {
  console.log(" ✅ IDENTITY_CLASS_TOOL_CONTEXT — no leads.id in a contacts.id slot (by name R1/R2 AND by data flow R7/R8), no users.id in an agents.id slot, no lead-shaped compliance contact, every promised tool name registered")
}
