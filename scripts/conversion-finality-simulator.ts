#!/usr/bin/env tsx
/**
 * scripts/conversion-finality-simulator.ts   (npm run test:conversion-finality)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OWNER RULING THIS PROVES, verbatim:
 *
 *   "if a lead converted to a contact, then only the contact gets updated
 *    because once a lead converts, all communication/updates or schedules are
 *    to cease and only contacts get the actions."
 *
 * Before this pass NO conversion guard existed anywhere in the tree — an
 * exhaustive search for isConverted / assertNotConverted / hasConverted /
 * leadIsConverted returned ZERO function definitions. What existed instead were
 * six ad-hoc inline `.is("contact_id", null)` filters and one inline boolean,
 * scattered across four files, while eleven communication / update / schedule
 * paths had no conversion check of any kind. This proof exists so that cannot
 * quietly come back.
 *
 * WHAT IT ASSERTS
 *   1. THE GUARD  — lib/contact-promotion/conversion-finality.ts exports both
 *      shapes and behaves correctly AT RUNTIME against stub clients: converted
 *      refuses, open allows, and a refused / throwing / missing read FAILS
 *      CLOSED with a populated, reportable reason.
 *   2. THE SITES  — every named communication / update / schedule path consults
 *      the guard: it imports the module AND uses one of its exported symbols in
 *      REAL CODE (comments and string contents masked, so a mention in prose
 *      never counts as wiring).
 *   3. THE LOOP   — the stale-lead processor's re-arming write-back is gone: it
 *      no longer UPDATEs `leads` at all, and its ghost-recovery notification is
 *      keyed to the CONTACT.
 *   4. THE CONVERTERS — all three converters route deactivation through the ONE
 *      implementation, so `is_active` / `ai_isa_owner` / sequence_enrollments
 *      can no longer disagree between lanes.
 *   5. THE VOICE STACK — `conversion_finality` is a consumer-protection gate and
 *      runs before the spend gate.
 *
 * MEASUREMENT DISCIPLINE (CLAUDE.md §2)
 *   · Comments are removed with scripts/strip-comments.ts and NOTHING ELSE.
 *     `stripComments` where line numbers / string literals matter (the import
 *     specifier IS a string, and so are the values the loop detector hunts);
 *     `blankStrings` where a name inside a narrative string would otherwise read
 *     as a call.
 *   · Every absence assertion carries a POSITIVE CONTROL: the finder is re-run
 *     against a deliberately broken fixture and must go RED, then against the
 *     real file and must go GREEN. A finder that cannot see the defect it was
 *     written for reports zero and reads as a clean bill of health.
 *   · The denominator and the exclusions are printed at the end.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import {
  CONVERSION_MARKER_COLUMN,
  conversionVerdictForRow,
  assertLeadNotConverted,
  excludeConvertedLeads,
  partitionConvertedLeads,
  describeConversionRefusal,
} from "../lib/contact-promotion/conversion-finality"
import { evaluateSLABreach } from "../lib/lead-governance/sla-escalation"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `  — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const GUARD_MODULE = "contact-promotion/conversion-finality"
const GUARD_SYMBOLS = [
  "CONVERSION_MARKER_COLUMN",
  "conversionVerdictForRow",
  "assertLeadNotConverted",
  "excludeConvertedLeads",
  "partitionConvertedLeads",
  "describeConversionRefusal",
]

// ─── THE FINDER (one function, so the positive control exercises the REAL one) ─
/**
 * Is this source consulting the conversion guard?
 *  · `code`   = stripComments — comments gone, STRINGS INTACT, because the
 *               module specifier of `await import("…/conversion-finality")` is a
 *               string and masking it would hide every dynamic-import call site.
 *  · `masked` = blankStrings  — comments gone AND string contents blanked, so a
 *               guard name written inside prose or a log line is a MENTION, not
 *               a use. Both must hold.
 */
function guardVerdict(source: string): { guarded: boolean; imports: boolean; uses: string[] } {
  const code = stripComments(source)
  const masked = blankStrings(source)
  const imports = code.includes(GUARD_MODULE)
  const uses = GUARD_SYMBOLS.filter((s) => new RegExp(`\\b${s}\\b`).test(masked))
  return { guarded: imports && uses.length > 0, imports, uses }
}

// ── THE MANIFEST — the denominator. Every path the audit named. ───────────────
type Shape = "query" | "row/id"
const SITES: Array<{ path: string; shape: Shape; what: string }> = [
  // BATCH sweeps — the `.is("contact_id", null)` predicate
  { path: "lib/ai-isa/ghost-reengagement.ts",              shape: "query",  what: "ghost detection + re-engagement sends" },
  { path: "lib/ai-isa/long-term-nurture.ts",               shape: "query",  what: "monthly nurture enrolment + reactivation" },
  { path: "lib/ai-isa/speed-to-lead.ts",                   shape: "query",  what: "first-touch sweep" },
  { path: "lib/lead-assignment/stale-lead-detector.ts",    shape: "query",  what: "stale-lead detection" },
  // SINGLE-lead paths — row / id refusal
  { path: "app/actions/ai-isa/initiate-engagement.ts",     shape: "row/id", what: "AI-ISA first-touch dispatch (email/sms/phone/mail/social)" },
  { path: "lib/kernel/ai-isa.ts",                          shape: "row/id", what: "AI-ISA ownership assignment" },
  { path: "lib/ai-isa/appointment-scheduler.ts",           shape: "row/id", what: "ISA appointment booking (a SCHEDULE)" },
  { path: "lib/ai-isa/post-call-outcome.ts",               shape: "row/id", what: "post-call routing (lead branch)" },
  { path: "lib/kernel/manager-signals.ts",                 shape: "row/id", what: "sphere nurture email + persona reel 1:1 email" },
  { path: "lib/campaign-sequences/step-executor.ts",       shape: "row/id", what: "sequence step send (lead branch)" },
  { path: "lib/voice/outbound-call-gates.ts",              shape: "row/id", what: "outbound dial gate stack" },
  { path: "lib/lead-governance/stale-lead-processor.ts",   shape: "row/id", what: "SLA breach sweep + ghost recovery" },
  { path: "lib/lead-governance/sla-monitor.ts",            shape: "row/id", what: "SLA evaluation + escalation activity" },
  { path: "lib/lead-governance/sla-escalation.ts",         shape: "row/id", what: "SLA stage-breach evaluation" },
]

/** Sites that reached the guard's semantics BEFORE it existed, with the inline
 *  idiom. Not counted in the denominator above — they are the published blind
 *  spot: correct today, but not yet owned by the one guard. */
const PRE_EXISTING_INLINE = [
  "lib/kernel/communications.ts",
  "app/api/voice/twilio/inbound/route.ts",
  "lib/lead-pipeline/parked-retention.ts",
  "lib/ai-isa/lead-nurture.ts",
]

console.log("\n══ 1. THE GUARD — runtime behaviour, including every fail-closed path ══")
{
  check("the marker is `contact_id` — the one column every converter writes",
    CONVERSION_MARKER_COLUMN === "contact_id")

  // PURE row verdicts
  const open = conversionVerdictForRow({ id: "L1", contact_id: null })
  check("an OPEN lead is allowed", open.allowed && open.converted === false && open.code === "open")

  const conv = conversionVerdictForRow({ id: "L2", contact_id: "C2" }, "L2")
  check("a CONVERTED lead is refused", !conv.allowed && conv.converted === true && conv.code === "lead_converted")
  check("the refusal names the CONTACT that owns the action now", conv.contactId === "C2")
  check("the refusal is REPORTABLE (non-empty reason)", conv.reason.length > 0)
  check("describeConversionRefusal produces a loggable line",
    describeConversionRefusal(conv, "ISA email").includes("C2"))

  const missing = conversionVerdictForRow(null, "L3")
  check("a MISSING row FAILS CLOSED (not 'unconverted')",
    !missing.allowed && missing.converted === null && missing.code === "lead_missing")

  // ID verdicts against stub clients
  const stub = (result: any) => ({
    from: () => ({ select: () => ({ eq: function () { return this }, maybeSingle: async () => result }) }),
  })
  const okRow = await assertLeadNotConverted(stub({ data: { id: "L4", contact_id: null }, error: null }), "L4")
  check("assertLeadNotConverted allows an open lead", okRow.allowed)

  const convRow = await assertLeadNotConverted(stub({ data: { id: "L5", contact_id: "C5" }, error: null }), "L5")
  check("assertLeadNotConverted refuses a converted lead and names the contact",
    !convRow.allowed && convRow.contactId === "C5")

  const refused = await assertLeadNotConverted(stub({ data: null, error: { message: "permission denied" } }), "L6")
  check("a REFUSED read FAILS CLOSED (supabase-js resolves refusals — the error is read)",
    !refused.allowed && refused.converted === null && refused.code === "conversion_unreadable",
    JSON.stringify(refused))
  check("the fail-closed refusal carries the underlying error text",
    refused.reason.includes("permission denied"))

  const thrower = { from: () => { throw new Error("network down") } }
  const threw = await assertLeadNotConverted(thrower, "L7")
  check("a THROWING read FAILS CLOSED", !threw.allowed && threw.code === "conversion_unreadable")

  const absent = await assertLeadNotConverted(stub({ data: null, error: null }), "L8")
  check("a lead that does not exist FAILS CLOSED", !absent.allowed && absent.code === "lead_missing")

  const noLead = await assertLeadNotConverted(stub({ data: null, error: null }), null)
  check("a contact-only path (no leadId) is not refused — nothing to guard", noLead.allowed)

  // QUERY predicate
  const calls: Array<[string, unknown]> = []
  const q = { is: (c: string, v: unknown) => { calls.push([c, v]); return q } }
  excludeConvertedLeads(q)
  check("excludeConvertedLeads applies `.is(\"contact_id\", null)`",
    calls.length === 1 && calls[0][0] === "contact_id" && calls[0][1] === null)

  // …and against a REAL PostgREST builder, AFTER `.limit()` / `.or()`. Every
  // sweep this guard wraps ends in one of those, and `.limit()` is typed as
  // returning a TransformBuilder — if the filter did not survive it, four sweeps
  // would throw at runtime while every stub-based test stayed green.
  {
    const { createClient } = await import("@supabase/supabase-js")
    const c = createClient("http://127.0.0.1:1/", "anon-key-not-used")
    const built: any = excludeConvertedLeads(
      c.from("leads").select("id").eq("brokerage_id", "b").or("a.is.null,b.eq.1").limit(50),
    )
    const url = String(built.url)
    check("the predicate survives a real builder chain ending in .or()/.limit()",
      url.includes("contact_id=is.null"), url)
  }

  // BATCH partition
  const batchStub = (result: any) => ({ from: () => ({ select: () => ({ in: async () => result }) }) })
  const part = await partitionConvertedLeads(
    batchStub({ data: [{ id: "a", contact_id: null }, { id: "b", contact_id: "cb" }], error: null }),
    ["a", "b", "c"],
  )
  check("partition: open leads stay open", part.open.join(",") === "a")
  check("partition: converted leads map to their contact", part.converted.get("b") === "cb")
  check("partition: a lead the read did not return is UNREADABLE, not open",
    part.unreadable.join(",") === "c" && !part.open.includes("c"))

  const partErr = await partitionConvertedLeads(batchStub({ data: null, error: { message: "rls" } }), ["a", "b"])
  check("partition FAILS CLOSED on a refused read (nothing open, everything unreadable)",
    partErr.open.length === 0 && partErr.unreadable.length === 2 && !!partErr.error)

  // Pure SLA evaluator — the lane that had NO conversion predicate at all
  const slaConverted = evaluateSLABreach({ contact_id: "C9", lead_stage: "new", created_at: new Date(0).toISOString() })
  check("SLA stage-breach: a converted lead no longer breaches or escalates",
    slaConverted.breached === false && slaConverted.escalationTarget === "")
  const slaOpen = evaluateSLABreach({ contact_id: null, lead_stage: "new", created_at: new Date(0).toISOString() })
  check("SLA stage-breach still fires for an OPEN stale lead (the guard did not blind it)",
    slaOpen.breached === true)
}

console.log("\n══ 2. THE SITES — every named path consults the guard ══")
{
  for (const site of SITES) {
    const v = guardVerdict(src(site.path))
    check(`[${site.shape}] ${site.path} — ${site.what}`, v.guarded,
      v.imports ? `imports the guard but uses no symbol` : `no import of ${GUARD_MODULE}`)
  }
}

console.log("\n══ 3. POSITIVE CONTROL — the site finder can still see an UNGUARDED path ══")
{
  // Take a REAL guarded file and remove exactly what makes it guarded. If the
  // finder still says "guarded", the finder is blind and every ✓ above is worthless.
  const real = src("lib/ai-isa/appointment-scheduler.ts")
  const before = guardVerdict(real)
  check("control A (baseline): the real file reads as GUARDED", before.guarded,
    `uses=${before.uses.join(",")}`)

  let broken = real.replace(new RegExp(GUARD_MODULE, "g"), "some-other-module")
  for (const s of GUARD_SYMBOLS) broken = broken.replace(new RegExp(`\\b${s}\\b`, "g"), "somethingElse")
  const after = guardVerdict(broken)
  check("control A (break): the SAME finder reports the de-guarded copy as UNGUARDED", !after.guarded,
    `imports=${after.imports} uses=${after.uses.join(",")}`)

  const restored = guardVerdict(real)
  check("control A (restore): the finder is GREEN again on the untouched file", restored.guarded)

  // The finder must not be fooled by a MENTION. A file that only names the guard
  // in a comment and a string is not guarded.
  const decoy = [
    `// this file should call assertLeadNotConverted from the conversion-finality guard`,
    `const note = "excludeConvertedLeads / conversionVerdictForRow"`,
    `export function nothing() { return 1 }`,
  ].join("\n")
  const decoyV = guardVerdict(decoy)
  check("control B: a comment + string MENTION of the guard does NOT read as wiring",
    !decoyV.guarded, `imports=${decoyV.imports} uses=${decoyV.uses.join(",")}`)
}

console.log("\n══ 4. THE RE-ARMING LOOP — the worst defect, and its positive control ══")
{
  // stripComments (NOT blankStrings): the defect's fingerprints are STRING
  // VALUES — 'isa_qualifying', 'active', entity_type 'lead' — so masking strings
  // would blind this detector completely.
  const rearmDefects = (source: string): string[] => {
    const code = stripComments(source)
    const found: string[] = []
    if (/from\(["']leads["']\)[\s\S]{0,80}?\.update\(/.test(code)) found.push("writes back to the LEAD")
    if (/lifecycle_state:\s*["']isa_qualifying["']/.test(code)) found.push("re-arms lifecycle_state='isa_qualifying' (the ghost sweep's own predicate)")
    if (/reengagement_status:\s*["']active["']/.test(code)) found.push("re-arms reengagement_status='active'")
    // Order-agnostic: the two keys appear in either order in the insert literal.
    if (/entity_type:\s*["']lead["'][\s\S]{0,300}?isa_takeover/.test(code)
      || /isa_takeover[\s\S]{0,300}?entity_type:\s*["']lead["']/.test(code)) {
      found.push("files the takeover activity against the LEAD")
    }
    return found
  }

  // POSITIVE CONTROL: the ORIGINAL defective block, kept verbatim as a fixture.
  const originalDefect = `
          if (recoveryResult.success) {
            await supabase
              .from("leads")
              .update({
                lifecycle_state:    "isa_qualifying",
                reengagement_status: "active",
                updated_at:          new Date().toISOString(),
              })
              .eq("id", lead.id)
            if (leadRow.agent_id) {
              await supabase.from("activities").insert({
                activity_type: "isa_takeover_notification",
                entity_type:   "lead",
              })
            }
          }`
  const controlHits = rearmDefects(originalDefect)
  check("control (break): the detector still catches the ORIGINAL re-arming block",
    controlHits.length === 4, `found ${controlHits.length}/4: ${controlHits.join("; ")}`)

  const proc = src("lib/lead-governance/stale-lead-processor.ts")
  const live = rearmDefects(proc)
  check("live: the stale-lead processor no longer re-arms the lead", live.length === 0,
    live.join("; "))

  const procCode = stripComments(proc)
  check("the ghost-recovery dispatch to the CONTACT survived",
    /triggerGhostRecovery\(\{[\s\S]{0,80}?contactId/.test(procCode))
  check("the takeover notification is now filed against the CONTACT",
    /entity_type:\s*["']contact["']/.test(procCode))
}

console.log("\n══ 5. THE CONVERTERS — one deactivation implementation, three callers ══")
{
  const converters = [
    ["lib/kernel/crm.ts", "convertLeadToContact (manual lead-desk lane)"],
    ["lib/contact-promotion/promote-lead-to-contact.ts", "promoteLeadToContactService"],
    ["lib/kernel/lead-acquisition-handlers.ts", "handleLeadAssigned (automatic lane)"],
  ] as const
  for (const [path, label] of converters) {
    const masked = blankStrings(src(path))
    check(`${label} deactivates through the ONE implementation`, /\bdeactivateLead\b/.test(masked))
  }

  const deact = stripComments(src("lib/contact-promotion/lead-deactivator.ts"))
  check("the one deactivator stamps is_active=false", /is_active:\s*false/.test(deact))
  check("the one deactivator releases ai_isa_owner", /ai_isa_owner:\s*false/.test(deact))
  check("the one deactivator closes sequence_enrollments",
    /sequence_enrollments/.test(deact) && /status:\s*["']completed["']/.test(deact))

  // The FALSE claim this file used to make about the ISA gates.
  const deactRaw = src("lib/contact-promotion/lead-deactivator.ts")
  check("the false 'the ISA gates check is_active + ai_isa_owner' claim is corrected",
    !/gates \(which check is_active \+ ai_isa_owner\) both reject/.test(deactRaw))
  const isaDoor = stripComments(src("lib/kernel/ai-isa.ts"))
  check("assignAiIsaToLeadAfterGate now actually reads the conversion marker",
    /select\(["'][^"']*contact_id[^"']*["']\)/.test(isaDoor))
}

console.log("\n══ 6. THE VOICE STACK — conversion finality is a consumer-protection gate ══")
{
  const { OUTBOUND_CALL_GATES, OUTBOUND_CALL_GATE_ORDER } = await import("../lib/voice/outbound-call-gates")
  check("the stack carries the 'conversion_finality' gate",
    OUTBOUND_CALL_GATE_ORDER.includes("conversion_finality" as any),
    OUTBOUND_CALL_GATE_ORDER.join(" → "))
  const g = OUTBOUND_CALL_GATES.find((x) => x.key === ("conversion_finality" as any))
  check("it is classed as CONSUMER PROTECTION, not spend", g?.consumerProtection === true)
  const spendIdx = OUTBOUND_CALL_GATES.findIndex((x) => !x.consumerProtection)
  check("it runs BEFORE the spend gate",
    OUTBOUND_CALL_GATE_ORDER.indexOf("conversion_finality" as any) < spendIdx)
}

// ─── 7. WAVE 145 (lane 145E) — CONTRACT C2: THE LEAD / CONTACT BOUNDARY ──────
// Owner ruling 15 (2026-10-27): "Leads are only evaluated without a contact_id; if a contact_id is present, then communication
// ends in the lead table and continues in the contact table as a contact." The contract's two names are built ON this guard
// (lib/contact-promotion/lead-domain-boundary.ts → conversionVerdictForRow) — asserted here at runtime, with the duplicate /
// retry shapes the canaries need, plus the one scheduled-send door conversion left open (lead-addressed drafts).
console.log("\n══ 7. WAVE 145 CONTRACT C2 — isInLeadDomain / canonicalPartyFor + the lead drafts conversion supersedes ══")
{
  const { isInLeadDomain, canonicalPartyFor } = await import("../lib/contact-promotion/lead-domain-boundary")
  check("C2: an OPEN lead (no contact_id) is in the lead domain and is its own party",
    isInLeadDomain({ id: "L1", contact_id: null }) && canonicalPartyFor({ id: "L1", contact_id: null }).type === "lead")
  const conv = canonicalPartyFor({ id: "L2", contact_id: "C2" })
  check("C2: a lead WITH a contact_id is OUT of the lead domain and resolves to its CONTACT (the lead id kept as provenance)",
    !isInLeadDomain({ id: "L2", contact_id: "C2" }) && conv.type === "contact" && conv.id === "C2" && conv.leadId === "L2")
  const unread = canonicalPartyFor(null)
  check("C2: an UNREAD row FAILS CLOSED — not in the lead domain and resolved to neither party (never 'the lead' on a guess)",
    !isInLeadDomain(null) && !isInLeadDomain(undefined) && unread.type === "unresolved" && unread.id === null && unread.reason.length > 0)
  check("C2 (positive control): the boundary is the guard's own verdict — the two answers can never disagree",
    [{ id: "a", contact_id: null }, { id: "b", contact_id: "c" }, null].every((r) => isInLeadDomain(r as never) === conversionVerdictForRow(r as never).allowed))
  // RETRY / DUPLICATE EVENT: the same converted lead evaluated twice resolves to the same contact both times.
  check("C2 retry: a replayed event on the same converted lead resolves to the SAME contact every time (no second competing record)",
    JSON.stringify(canonicalPartyFor({ id: "L2", contact_id: "C2" })) === JSON.stringify(canonicalPartyFor({ id: "L2", contact_id: "C2" })))

  // WIRING (stripped source): the lead first-touch sweep re-checks per row; the life-change responder answers on the contact.
  const stl = stripComments(src("lib/ai-isa/speed-to-lead.ts"))
  const arbSrc = stripComments(src("lib/ai-isa/followup-arbiter.ts"))
  check("C2 WIRED: the speed-to-lead LEAD sweep excludes converted leads at the query AND re-checks each row before it touches (a conversion between select and send)",
    /excludeConvertedLeads\(/.test(stl) && /if \(!isInLeadDomain\(lead/.test(stl) && stl.indexOf("isInLeadDomain(lead") < stl.indexOf("doLeadEngagement(lead.id"))
  check("C2 WIRED: the life-change responder answers a converted lead's signal on its contact through canonicalPartyFor",
    /canonicalPartyFor\(data/.test(arbSrc) && /party\.type === "contact"\) subject = \{ type: "contact", id: party\.id \}/.test(arbSrc))
  check("(control) the per-row finder rejects a sweep that touches without the re-check",
    !/if \(!isInLeadDomain\(lead/.test("for (const lead of leads) { await doLeadEngagement(lead.id) }"))

  // THE SCHEDULED LEAD SEND CONVERSION LEFT OPEN: drafts addressed to the LEAD (agent_client_messages.recipient_lead_id).
  const { memSupabase } = await import("./in-memory-supabase")
  const { deactivateLead } = await import("../lib/contact-promotion/lead-deactivator")
  const mem = memSupabase({
    leads: [{ id: "LD", is_active: true, ai_isa_owner: true }],
    sequence_enrollments: [],
    agent_client_messages: [
      { id: "m-prop", recipient_lead_id: "LD", recipient_contact_id: null, status: "proposed", rationale: "lead plan step 2" },
      { id: "m-appr", recipient_lead_id: "LD", recipient_contact_id: null, status: "approved", rationale: "lead plan step 3" },
      { id: "m-sent", recipient_lead_id: "LD", recipient_contact_id: null, status: "sent", rationale: "step 1 (already went)" },
      { id: "m-both", recipient_lead_id: "LD", recipient_contact_id: "CX", status: "proposed", rationale: "conversion race" },
      { id: "m-other", recipient_lead_id: "LZ", recipient_contact_id: null, status: "proposed", rationale: "another lead" },
    ],
    notifications: [{ id: "n1", entity_type: "agent_client_message", entity_id: "m-prop", type: "approval_needed" }, { id: "n2", entity_type: "agent_client_message", entity_id: "m-other", type: "approval_needed" }],
  })
  const quiet = console.log; console.log = () => {}
  const d1 = await deactivateLead(mem, "LD")
  const d2 = await deactivateLead(mem, "LD")
  console.log = quiet
  const msg = (id: string) => mem.tables.agent_client_messages.find((m) => m.id === id) ?? {}
  check("C2 suppression: on conversion the lead's PENDING drafts (proposed + approved) are closed 'rejected' WITH the reason — never deleted (provenance kept)",
    d1.success && msg("m-prop").status === "rejected" && msg("m-appr").status === "rejected" && /superseded on conversion/.test(String(msg("m-prop").send_error)) && mem.tables.agent_client_messages.length === 5)
  check("C2 suppression (controls): a SENT draft, a draft already naming the contact (the conversion race the governor stages) and another lead's draft are untouched",
    msg("m-sent").status === "sent" && msg("m-both").status === "proposed" && msg("m-other").status === "proposed")
  check("C2 suppression: the moot 'approve me' bell for a closed draft is cleared; another lead's bell stays",
    !(mem.tables.notifications ?? []).some((n) => n.entity_id === "m-prop") && (mem.tables.notifications ?? []).some((n) => n.entity_id === "m-other"))
  check("C2 retry: a second conversion pass (duplicate event) changes nothing more and still succeeds", d2.success && msg("m-prop").status === "rejected" && msg("m-other").status === "proposed")
}

// ─── MEASUREMENT: denominator and blind spots ────────────────────────────────
console.log("\n══ DENOMINATOR AND EXCLUSIONS ══")
console.log(`  files audited for guard wiring : ${SITES.length}`)
console.log(`    · batch/query shape          : ${SITES.filter((s) => s.shape === "query").length}`)
console.log(`    · single-lead row/id shape   : ${SITES.filter((s) => s.shape === "row/id").length}`)
console.log(`  converters audited             : 3 (all three must call deactivateLead)`)
console.log(`  EXCLUDED — pre-existing inline \`.is("${CONVERSION_MARKER_COLUMN}", null)\` / inline boolean,`)
console.log(`             correct today but NOT yet owned by the guard (${PRE_EXISTING_INLINE.length} files):`)
for (const p of PRE_EXISTING_INLINE) console.log(`             · ${p}`)
console.log(`  BLIND SPOTS this proof does NOT cover:`)
console.log(`             · it is a STATIC wiring check for the site list above — it proves the guard is`)
console.log(`               CONSULTED, not that every branch inside each file honours the verdict.`)
console.log(`             · lead-keyed paths outside the audited list (other lanes' files) are unmeasured.`)
console.log(`             · leads.lifecycle_state remains UNRECONCILED: crm.ts writes 'assigned' while`)
console.log(`               LEAD_CONVERTED_STATE is 'representation' and nothing writes it. The guard keys`)
console.log(`               on contact_id precisely because lifecycle_state cannot answer the question.`)

console.log(`\n${fail === 0 ? "✅" : "❌"} conversion-finality: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
