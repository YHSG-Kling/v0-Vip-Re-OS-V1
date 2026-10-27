/**
 * scripts/canaries/wave145-lead-contact.ts — LEAD / CONTACT canary (wave 145, lane 145J; owner rulings 15, 16, 17; contracts C2, C3):
 *   RULING 15 / C2 — "Leads are only evaluated without a contact_id; if a contact_id is present, then communication ends in the lead
 *     table and continues in the contact table as a contact": lib/contact-promotion/lead-domain-boundary.ts isInLeadDomain /
 *     canonicalPartyFor; scheduled lead sends suppressed, provenance kept, no AI-ISA activity across two competing records.
 *   RULING 16 — "Speed to lead should be consumed by the followup-arbiter and should be the arbiter decision": no independent
 *     dispatcher; a fresh eligible lead / contact event goes to the arbiter immediately, which weighs it with speed-to-lead as a
 *     high-priority requirement.
 *   RULING 17 — "The welcome email with the login info … has to wait for the avatar welcome … and auto send after": ONE idempotent
 *     conversion → invite → avatar video → validated → ONE welcome (secure activation link, never a password) + the approved video →
 *     auto-delivered when ready; a failure is a visible, recoverable state with a human-approved exception — never falsely sent,
 *     never silently pending forever. The welcome format reads accessibility preferences through C3.
 *
 * Through the survivors at b364eb4b: lib/ai-isa/speed-to-lead.ts runSpeedToLead (driven in memory with recorder seams),
 * lib/contact-promotion/lead-deactivator.ts deactivateLead (the conversion paths' suppression door — lib/kernel/crm.ts and
 * lib/contact-promotion/promote-lead-to-contact.ts call it), lib/contact-promotion/conversion-welcome.ts (pure classifiers + the
 * exception door). Nothing is sent: the engagement / welcome seams record, no provider and no model is reached.
 *
 * MEASURED AT b364eb4b: the LEAD sweep of speed-to-lead picks its own channel (firstTouchDecision, email before mail) and dispatches
 * it without asking the arbiter; a converted lead's 'proposed' / 'approved' lead-addressed drafts stay sendable; decideWelcomeTiming
 * sends the welcome NOW and lets the video follow (the wave-144 ruling 13 shape ruling 17 replaces); an overdue render releases the
 * welcome without the video, unattended.
 */
import { LIVE } from "./_harness"
import { strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"
import { CONTRACTS, bindContract, canary145, quiet, type Contract } from "./wave145-harness"

// ── WAVE145 BIND (lane 145E notes, "## Canary requirements", published 16:32Z) ──────────────────────────────────────────────────
// C2 isInLeadDomain · canonicalPartyFor; ruling 15 lib/contact-promotion/lead-deactivator.ts deactivateLead(supabase, leadId);
// ruling 16 lib/ai-isa/followup-arbiter.ts arbitrateSpeedToLead + runSpeedToLead's `arbitrateLead` seam, engage-contact's arbiter
// PRIORITY; ruling 17 conversion-welcome.ts decideWelcomeTiming · classifyPendingWelcome · holdWelcomeForException ·
// releaseApprovedWelcomeExceptions · WELCOME_EXCEPTION_ITEM_TYPE; C3 readWelcomeAccessibility (through H's readAccessibilityPreferences).
const SUPPRESSION: Contract = { id: "145E ruling-15 suppression", lane: "145E", file: "lib/contact-promotion/lead-deactivator.ts", exports: ["deactivateLead"] }
const ARBITER_LEAD: Contract = { id: "145E speed-to-lead arbiter (leads)", lane: "145E", file: "lib/ai-isa/followup-arbiter.ts", exports: ["arbitrateSpeedToLead"] }
const WELCOME_EXCEPTION: Contract = { id: "145E welcome exception", lane: "145E", file: "lib/contact-promotion/conversion-welcome.ts", exports: ["holdWelcomeForException", "releaseApprovedWelcomeExceptions", "WELCOME_EXCEPTION_ITEM_TYPE"] }
const WELCOME_C3: Contract = { id: "145E welcome accessibility (C3)", lane: "145E", file: "lib/contact-promotion/conversion-welcome.ts", exports: ["readWelcomeAccessibility"] }

const LEAD_CHANNELS_ALLOWED = new Set(["email", "direct_mail"]) // an unconsented lead: verified email / verified mail — never SMS or a call

export async function run() {
  const c = canary145("Lead/contact: leads evaluated only without contact_id (C2) · speed-to-lead is the arbiter's decision · ONE welcome waits for the validated avatar video, auto-sends, fails visibly to a human · activation link never a password · accessibility via C3")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const B = "B", B2 = "B2"

  // ── 1 · C2: the boundary contract ──
  const C2 = await bindContract(CONTRACTS.C2_BOUNDARY)
  await c.check("145E", "C2 · A LEAD IS IN THE LEAD DOMAIN ONLY WITHOUT A contact_id (ruling 15): isInLeadDomain(lead) is true for a lead with no contact_id, FALSE once contact_id is set and FALSE for no lead at all (fail closed); canonicalPartyFor(lead) names the LEAD while open and the CONTACT (that contact_id) once converted — the journey continues on the contact, the lead is provenance", async () => {
    if (!C2.mod) return { ok: false, evidence: C2.evidence }
    const open = { id: "lead-open", brokerage_id: B, contact_id: null }, conv = { id: "lead-conv", brokerage_id: B, contact_id: "contact-9" }
    const inOpen = await C2.mod.isInLeadDomain(open), inConv = await C2.mod.isInLeadDomain(conv), inNull = await C2.mod.isInLeadDomain(null)
    const pOpen = (await C2.mod.canonicalPartyFor(open)) as Record<string, unknown>, pConv = (await C2.mod.canonicalPartyFor(conv)) as Record<string, unknown>
    return { ok: inOpen === true && inConv === false && inNull === false && pOpen.type === "lead" && pOpen.id === "lead-open" && pConv.type === "contact" && pConv.id === "contact-9", evidence: `open → ${inOpen} ${JSON.stringify(pOpen)}; converted → ${inConv} ${JSON.stringify(pConv)}; null → ${inNull}` }
  })

  // ── 2 + 4a · one speed-to-lead sweep, in memory, recorder seams at every door (no engagement, no model) ──
  const NOW = new Date("2026-10-27T15:00:00.000Z")
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()
  const leadRow = (id: string, over: Record<string, unknown> = {}) => ({ id, brokerage_id: B, created_at: ago(60), distributed_at: null, first_touched_at: null, contact_id: null, is_active: true,
    email: `${id}@example.test`, email_verified: true, email_opt_out: false, mailing_address: "1 Main St", mailing_address_verified: true, direct_mail_opt_out: false,
    preferred_channel: null, lead_score: 82, lead_temperature: "hot", timeline: "1-3_months", source: "website", ai_isa_owner: true, lifecycle_state: "new", ...over })
  const db = memSupabase({ leads: [leadRow("L-both"), leadRow("L-none", { email_verified: false, mailing_address_verified: false }), leadRow("L-conv", { contact_id: "C-1" })], contacts: [], automation_errors: [], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true })
  const leadCalls: Array<{ id: string; force: unknown }> = [], arbAsked: string[][] = []
  const stl = await quiet(async () => import("../../lib/ai-isa/speed-to-lead"))
  const swept = await quiet(() => stl.runSpeedToLead(B, { now: NOW }, {
    supabase: db as never,
    // The arbiter's seam (lane 145E): records what it was offered and answers with ITS pick — direct mail where mail is permitted.
    arbitrateLead: (async (input: { permitted: readonly string[] }) => { arbAsked.push([...input.permitted]); const ch = input.permitted.includes("direct_mail") ? "direct_mail" : (input.permitted[0] ?? null); return { channel: ch, decision: null, skippedReason: ch ? null : "nothing permitted" } }) as never,
    initiateEngagement: (async (id: string, o?: { forceChannel?: string }) => { leadCalls.push({ id, force: o?.forceChannel }); return { success: true, channel: o?.forceChannel } }) as never,
    contactEngagement: (async () => ({ success: true, channel: "email" })) as never,
  } as never)) as Record<string, any>
  const leadAt = (id: string) => (db.tables.leads ?? []).find((x) => x.id === id) ?? {}
  c.rule("145E", "A CONVERTED LEAD IS NEVER A FIRST-TOUCH CANDIDATE (ruling 15; green, preserve): the speed-to-lead sweep never engages the lead whose contact_id is set — no AI-ISA activity on the lead row once a canonical contact exists", leadCalls.length > 0 && !leadCalls.some((x) => x.id === "L-conv"), `lead engagements: ${leadCalls.map((x) => x.id).join(",") || "none"}; touched ${swept.leadsTouched}`)
  const both = leadCalls.find((x) => x.id === "L-both")
  const offeredOutsideRule = arbAsked.flat().filter((ch) => !LEAD_CHANNELS_ALLOWED.has(ch))
  const errs = (db.tables.automation_errors ?? []).map((e) => String(e.error_message ?? e.message ?? "")).filter(Boolean)
  c.rule("145E", "SPEED-TO-LEAD IS THE ARBITER'S DECISION — LEADS (ruling 16: 'consumed by the followup-arbiter … the arbiter decision'; no independent dispatcher): the sweep ASKS the arbiter for a fresh lead's first touch, offering only what the lead rule permits (verified email / verified mail — never SMS or a call), and dispatches the ARBITER's pick (direct mail here) through the lead door; first_touch_channel records that channel; a lead with nothing permitted is never handed to a door", arbAsked.length > 0 && offeredOutsideRule.length === 0 && both?.force === "direct_mail" && leadAt("L-both").first_touch_channel === "direct_mail" && !leadCalls.some((x) => x.id === "L-none"), `arbiter asked ${arbAsked.length}× (offered ${JSON.stringify(arbAsked)}); L-both dispatched on ${both ? String(both.force ?? "its own channel") : "nothing"}, stamped ${leadAt("L-both").first_touch_channel ?? "∅"}; L-none dispatched ${leadCalls.some((x) => x.id === "L-none")}${errs.length ? `; sweep errors: ${errs.join(" | ").slice(0, 160)}` : ""}`)

  // ── 3 · ruling 15: scheduled lead-table sends stop once contact_id exists (provenance kept, idempotent) ──
  const sup = await bindContract(SUPPRESSION)
  await c.check("145E", "ONCE contact_id EXISTS EVERY LEAD-TABLE QUEUE / SEND STOPS (ruling 15: 'communication ends in the lead table and continues in the contact table'): the conversion door (deactivateLead, which lib/kernel/crm.ts and promote-lead-to-contact call) leaves no lead-addressed draft sendable and no lead sequence running — NOT deleted: every row stays as provenance; already-sent, contact-addressed and other leads' rows are untouched; the lead stops being AI-ISA-owned; a duplicate conversion event changes nothing more", async () => {
    if (!sup.mod) return { ok: false, evidence: sup.evidence }
    const L = "L-9", msg = (id: string, over: Record<string, unknown>) => ({ id, brokerage_id: B, recipient_lead_id: L, recipient_contact_id: null, status: "proposed", rationale: "lead plan touch", send_error: null, ...over })
    const s = memSupabase({
      leads: [{ id: L, brokerage_id: B, contact_id: "C-9", is_active: true, ai_isa_owner: true }, { id: "L-other", brokerage_id: B, contact_id: null, is_active: true, ai_isa_owner: true }],
      agent_client_messages: [msg("m-prop", {}), msg("m-appr", { status: "approved" }), msg("m-sent", { status: "sent" }), msg("m-contact", { recipient_contact_id: "C-9" }), msg("m-other", { recipient_lead_id: "L-other" })],
      sequence_enrollments: [{ id: "e-act", lead_id: L, status: "active" }, { id: "e-pau", lead_id: L, status: "paused" }, { id: "e-done", lead_id: L, status: "completed" }, { id: "e-other", lead_id: "L-other", status: "active" }],
      notifications: [],
    }, { uuidIds: true })
    const rowsOf = (t: string) => (s.tables[t] ?? []).map((r) => ({ ...r }))
    const before = { m: rowsOf("agent_client_messages"), e: rowsOf("sequence_enrollments") }
    const r1 = await quiet(async () => sup.mod!.deactivateLead(s, L)) as Record<string, unknown>
    const after1 = { m: rowsOf("agent_client_messages"), e: rowsOf("sequence_enrollments") }
    const m = (id: string) => after1.m.find((x) => x.id === id) ?? {}, mb = (id: string) => before.m.find((x) => x.id === id) ?? {}
    const e = (id: string) => after1.e.find((x) => x.id === id) ?? {}
    const SENDABLE = new Set(["proposed", "approved", "scheduled", "queued", "pending"])
    const suppressed = ["m-prop", "m-appr"].every((id) => !SENDABLE.has(String(m(id).status)) && m(id).recipient_lead_id === L && m(id).rationale === mb(id).rationale)
    const untouched = ["m-sent", "m-contact", "m-other"].every((id) => JSON.stringify(m(id)) === JSON.stringify(mb(id))) && JSON.stringify(e("e-other")) === JSON.stringify(before.e.find((x) => x.id === "e-other")) && e("e-done").status === "completed"
    const stopped = ["e-act", "e-pau"].every((id) => !["active", "paused"].includes(String(e(id).status)))
    const kept = after1.m.length === before.m.length && after1.e.length === before.e.length
    const lead = (s.tables.leads ?? []).find((x) => x.id === L) ?? {}
    await quiet(async () => sup.mod!.deactivateLead(s, L))
    const again = JSON.stringify({ m: rowsOf("agent_client_messages"), e: rowsOf("sequence_enrollments").map(({ completed_at: _c, ...rest }) => rest) }) === JSON.stringify({ m: after1.m, e: after1.e.map(({ completed_at: _c, ...rest }) => rest) })
    // Reach: the conversion paths call this door (stripped; positive control on the finder).
    const callsDoor = (f: string) => /\bdeactivateLead\s*\(/.test(strippedRepo(f) ?? "")
    const reach = callsDoor("lib/kernel/crm.ts") && callsDoor("lib/contact-promotion/promote-lead-to-contact.ts") && !/\bdeactivateLead\s*\(/.test(stripComments("// deactivateLead(x) is retired"))
    return { ok: r1.success !== false && suppressed && untouched && stopped && kept && lead.ai_isa_owner === false && lead.is_active === false && again && reach, evidence: `lead drafts → ${m("m-prop").status}/${m("m-appr").status} (provenance kept ${suppressed}); sent/contact/other untouched ${untouched}; lead sequences → ${e("e-act").status}/${e("e-pau").status}; rows kept ${kept}; lead ai_isa_owner ${lead.ai_isa_owner}, is_active ${lead.is_active}; duplicate event changes nothing ${again}; conversion paths call the door ${reach}` }
  })

  // ── 4b · ruling 16: the arbiter weighs speed-to-lead as a HIGH PRIORITY — the first touch goes at once, on a permitted channel ──
  const arbLead = await bindContract(ARBITER_LEAD)
  await c.check("145E", "THE ARBITER WEIGHS SPEED-TO-LEAD AS A HIGH-PRIORITY REQUIREMENT (ruling 16: 'a fresh eligible lead/contact event goes to the arbiter immediately … speed-to-lead as a high-priority requirement'): a model answer that PARKS a fresh lead (wait 48h) still yields a first touch now, on a permitted channel; a model pick OUTSIDE the lead rule (SMS to an unconsented lead) is refused for a permitted one; and the CONTACT door hands the speed-to-lead priority to the arbiter (stripped engage-contact.ts; finder control)", async () => {
    if (!arbLead.mod) return { ok: false, evidence: arbLead.evidence }
    const { platformFollowupPolicy } = await quiet(async () => import("../../lib/ai-isa/followup-policy"))
    const facts = { leadTemperature: "hot", leadScore: 80, timeline: "1-3_months", source: "website", minutesSinceArrival: 2, hoursSinceLastOutreach: null, preferences: [] }
    const ask = (decide: () => Promise<Record<string, unknown>>) => quiet(async () => arbLead.mod!.arbitrateSpeedToLead({ brokerageId: B, policy: platformFollowupPolicy(), permitted: ["email", "direct_mail"], facts }, { decide }) as Promise<Record<string, any>>)
    const parked = await ask(async () => ({ optionId: "wait", channel: null, waitHours: 48, rationale: "Hold it for two days.", evidence: ["intent"], confidence: 0.9 }))
    const sms = await ask(async () => ({ optionId: "first_touch", channel: "sms", format: null, waitHours: null, rationale: "Text them now.", evidence: ["intent"], confidence: 0.95 }))
    const eng = strippedRepo("app/actions/ai-isa/engage-contact.ts") ?? ""
    const PRIORITY = /priority\s*:\s*[^,\n}]*['"]speed_to_lead['"]/
    const contactDoor = /\barbitrateAndRecordExperience\s*\(/.test(eng) && PRIORITY.test(eng)
    const finderControl = PRIORITY.test("priority: reason === 'speed_to_lead' ? 'speed_to_lead' : null") && !PRIORITY.test("fixedSend: reason === 'speed_to_lead' ? 'speed_to_lead' : null")
    return { ok: LEAD_CHANNELS_ALLOWED.has(String(parked.channel)) && LEAD_CHANNELS_ALLOWED.has(String(sms.channel)) && contactDoor && finderControl, evidence: `a 'wait 48h' answer → first touch on ${parked.channel ?? "NOTHING"} now; an SMS pick → ${sms.channel ?? "nothing"}; contact door passes the speed-to-lead priority ${contactDoor} (finder control ${finderControl})` }
  })

  // ── 5–7 · ruling 17 on the pure welcome survivors ──
  const cw = await quiet(async () => import("../../lib/contact-promotion/conversion-welcome")) as unknown as Record<string, any>
  const timing = (v: Record<string, unknown>) => cw.decideWelcomeTiming(v) as { action: string; reason: string }
  const inFlight = timing({ commissioned: true, reason: "commissioned" })
  const noVideo = timing({ commissioned: false, reason: "agent_not_video_ready" })
  const standing = timing({ commissioned: false, reason: "agent_not_video_ready", standingVideoReady: true })
  const statedNo = timing({ commissioned: true, reason: "commissioned", statedNoVideo: true })
  const isSend = (a: { action?: unknown }) => /^send/.test(String(a.action))
  c.rule("145E", "THE WELCOME WAITS FOR THE AVATAR VIDEO (ruling 17: 'has to wait for the avatar welcome email from the agent to finish and auto send after'): with the agent's personal video commissioned and rendering, the welcome is HELD — never sent now with the video to follow; with no personal video possible it is raised to a HUMAN (never sent without it unattended, never left waiting); controls: an agent's standing video ready to be selected, or a person who STATED no video (C3), sends at once", !isSend(inFlight) && !isSend(noVideo) && /human|exception|approv/i.test(`${noVideo.action} ${noVideo.reason}`) && isSend(standing) && isSend(statedNo), `commissioned → ${inFlight.action}; no video possible → ${noVideo.action}; standing video → ${standing.action}; stated no video → ${statedNo.action}`)
  const ready = cw.classifyPendingWelcome({ status: "rendering", ageMs: 10 * 60_000, composite: "landed", hasRenderedUrl: true, videoOptOut: false, hasEmail: true, welcomeState: "none" }) as Record<string, any>
  c.rule("145E", "ONE WELCOME CARRYING THE VALIDATED VIDEO, AUTO-SENT WHEN READY (ruling 17: 'ONE welcome email with a secure activation link + the approved video → auto-delivered when ready'): once the rendered, assembled video exists and the welcome has not gone, the sweeper's verdict releases ONE welcome WITH the video — not a welcome plus a second video note", String(ready.action) === "send_with_video", `ready + welcome unsent → ${ready.action} (${String(ready.reason).slice(0, 90)})`)
  const overdue = cw.classifyPendingWelcome({ status: "rendering", ageMs: 10 * 60 * 60_000, composite: "pending", hasRenderedUrl: false, videoOptOut: false, hasEmail: true, welcomeState: "none" }) as Record<string, any>
  c.rule("145E", "A FAILED / OVERDUE VIDEO IS A VISIBLE, RECOVERABLE STATE WITH A HUMAN-APPROVED EXCEPTION (ruling 17: 'never falsely sent, never silently pending forever'): a render that has not landed long past its window does NOT auto-release the welcome without the video, does NOT keep waiting and is NOT recorded as sent — the verdict raises the exception to a human (who may approve sending without it)", !isSend(overdue) && String(overdue.action) !== "wait" && overdue.ledgerStatus !== "sent" && /human|exception|escalat|approv/i.test(`${overdue.action} ${overdue.reason}`), `overdue → ${overdue.action}, ledger ${overdue.ledgerStatus ?? "∅"} (${String(overdue.reason).slice(0, 110)})`)

  // ── 7b · the human-approved exception is a real, idempotent, tenant-pinned door ──
  const exc = await bindContract(WELCOME_EXCEPTION)
  await c.check("145E", "THE HUMAN-APPROVED EXCEPTION IS ONE REAL, IDEMPOTENT, TENANT-PINNED DOOR (ruling 17: 'a human-approved exception … one idempotent workflow'): holding a welcome files ONE pending approval item for the contact (a second hold files nothing more); the release sends a held welcome ONLY for an item a person APPROVED recently, whose contact has no welcome yet and belongs to the item's brokerage — a pending, rejected, stale or already-welcomed item, or a contact of another brokerage, never sends", async () => {
    if (!exc.mod) return { ok: false, evidence: exc.evidence }
    const TYPE = String(exc.mod.WELCOME_EXCEPTION_ITEM_TYPE)
    const hold = memSupabase({ approval_items: [], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true })
    const h1 = await quiet(async () => exc.mod!.holdWelcomeForException(hold, { brokerageId: B, contactId: "C-7", agentId: "A-1", reason: "the agent has no avatar" })) as Record<string, any>
    const h2 = await quiet(async () => exc.mod!.holdWelcomeForException(hold, { brokerageId: B, contactId: "C-7", agentId: "A-1", reason: "the agent has no avatar" })) as Record<string, any>
    const items = (hold.tables.approval_items ?? []).filter((r) => r.item_type === TYPE && r.item_id === "C-7" && r.brokerage_id === B)
    const { WELCOME_RATIONALE_TAG } = await quiet(async () => import("../../lib/kernel/client-welcome"))
    const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
    const item = (id: string, contactId: string, status: string, reviewedDaysAgo: number | null) => ({ id, brokerage_id: B, item_type: TYPE, item_id: contactId, status, reviewed_at: reviewedDaysAgo === null ? null : day(reviewedDaysAgo) })
    const contact = (id: string, brokerage = B) => ({ id, contact_id: id, brokerage_id: brokerage, contact_type: "buyer", first_name: "Pat", last_name: id })
    const rel = memSupabase({
      approval_items: [item("a1", "C-1", "approved", 1), item("a2", "C-2", "pending", null), item("a3", "C-3", "rejected", 1), item("a4", "C-4", "approved", 30), item("a5", "C-5", "approved", 1), item("a6", "C-6", "approved", 1)],
      contacts: [contact("C-1"), contact("C-2"), contact("C-3"), contact("C-4"), contact("C-5"), contact("C-6", B2)],
      agent_client_messages: [{ id: "w5", brokerage_id: B, recipient_contact_id: "C-5", rationale: `${WELCOME_RATIONALE_TAG} welcome`, status: "sent" }],
    }, { uuidIds: true })
    const ensured: string[] = []
    const r = await quiet(async () => exc.mod!.releaseApprovedWelcomeExceptions(rel, { now: NOW }, { ensureWelcome: async (ct: { id: string }) => { ensured.push(ct.id); return { state: "sent" } } })) as Record<string, any>
    return { ok: h1.filed === true && h2.filed === true && h2.existing === true && items.length === 1 && items[0].status === "pending" && !r.error && ensured.join(",") === "C-1", evidence: `hold → filed ${h1.filed}, again → existing ${h2.existing}; pending items for the contact ${items.length}; release sent for ${ensured.join(",") || "nobody"} (approved+recent C-1 only; pending C-2, rejected C-3, stale C-4, welcomed C-5, other-tenant C-6 held)${r.error ? `; error ${r.error}` : ""}` }
  })

  // ── 8 · a secure activation link, never a password (green — preserve) ──
  const welcomeFiles = ["lib/contact-promotion/conversion-welcome.ts", "lib/contact-promotion/welcome-avatar-video.ts", "lib/contact-promotion/portal-access.ts", "lib/kernel/client-welcome.ts", "lib/portal/invite.ts", "lib/portal/portal-invite.ts"]
  const PASSWORD_MINT = /\b(generate\w*Password|random\w*Password|temp(orary)?_?[Pp]assword|initialPassword|password\s*:\s*(?!null\b|undefined\b)[\w"'`])/
  const mints = welcomeFiles.filter((f) => PASSWORD_MINT.test(strippedRepo(f) ?? ""))
  const present = welcomeFiles.filter((f) => strippedRepo(f) !== null)
  const pwControl = PASSWORD_MINT.test(`const body = { email, password: generateTempPassword() }`) && !PASSWORD_MINT.test(`const link = createActivationLink(token)`)
  c.rule("145E", "THE WELCOME CARRIES A SECURE ACTIVATION LINK, NEVER A PASSWORD (ruling 17; green, preserve): no welcome / portal-invite composer mints or embeds a password — access is the invite row's activation (magic) link (positive control: a minted temp password IS caught; an activation link is not)", pwControl && present.length > 0 && mints.length === 0, `${present.length} composer file(s) read; password minted in ${mints.join(", ") || "none"}`)

  // ── 9 · C3: the welcome format reads the person's STATED accessibility preferences through lane 145H's one reader ──
  const C3 = await bindContract(CONTRACTS.C3_ACCESSIBILITY)
  const wc3 = await bindContract(WELCOME_C3)
  await c.check(C3.landed && !C3.missing.length ? "145E" : "145H", "C3 · THE WELCOME'S FORMAT FOLLOWS THE PERSON'S STATED ACCESSIBILITY PREFERENCES (contract C3: 'lane E's welcome composition … read it through that function only'): the welcome composition calls readAccessibilityPreferences (lib/contacts/accessibility-preferences.ts); a stated text-only format means no video wait, captions or a screen reader mean a transcript, large text means larger text; an unreadable preference read is a stated blind spot, never a guess", async () => {
    const readers = welcomeFiles.filter((f) => /\breadAccessibilityPreferences\b/.test(strippedRepo(f) ?? ""))
    if (!C3.mod || !wc3.mod) return { ok: false, evidence: `${C3.evidence}; ${wc3.evidence}; welcome readers: ${readers.join(", ") || "none"}` }
    const row = (id: string, prefs: Record<string, unknown>) => ({ id, contact_id: id, brokerage_id: B, accessibility_preferences: prefs, preferred_language: null, enrichment_profile: {} })
    const rows = [row("K-text", { communication_format: "text" }), row("K-cap", { captions: true }), row("K-sr", { portal_modality: "screen_reader" }), row("K-big", { text_size: "large" })]
    const s = memSupabase({ contacts: rows }, { uuidIds: true })
    const read = async (svc: unknown, id: string) => (await quiet(async () => wc3.mod!.readWelcomeAccessibility(svc, { brokerageId: B, contactId: id }))) as { accessibility: Record<string, any> | null; blindSpot: string | null }
    const t = await read(s, "K-text"), cap = await read(s, "K-cap"), sr = await read(s, "K-sr"), big = await read(s, "K-big")
    const denied = await read(memSupabase({ contacts: rows }, { refuse: { contacts: "permission denied for table contacts" } }), "K-cap")
    return { ok: readers.length > 0 && t.accessibility?.statedNoVideo === true && cap.accessibility?.transcript === true && sr.accessibility?.transcript === true && big.accessibility?.largeText === true && cap.accessibility?.statedNoVideo !== true && denied.accessibility === null && !!denied.blindSpot, evidence: `readers ${readers.join(", ")}; text → no video ${t.accessibility?.statedNoVideo}; captions → transcript ${cap.accessibility?.transcript}; screen reader → transcript ${sr.accessibility?.transcript}; large → ${big.accessibility?.largeText}; refused read → ${denied.accessibility === null ? `null + blind spot (${String(denied.blindSpot).slice(0, 60)})` : "READ"}` }
  })

  c.blind("The speed-to-lead sweep ran on the in-memory client with recorder seams at every door and the arbiter's seam answering (no engagement executed, no model, no provider); the arbiter itself is driven only on its lead half (arbitrateSpeedToLead with a scripted model answer) — the contact half's arbitrateAndRecordExperience is read as source (the priority handed over), not run. The ruling-15 door ran in memory (no RLS); its reach is read as stripped source in two conversion paths. The end-to-end conversion (convertLeadToContact for an agent with no avatar → no welcome + one pending exception item) is lane 145E's own proof (test:conversion-finality / the conversion-welcome simulator), not run here.")
  return c.report([], 0)
}
