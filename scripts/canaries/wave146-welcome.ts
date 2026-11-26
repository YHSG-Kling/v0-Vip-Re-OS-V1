/**
 * scripts/canaries/wave146-welcome.ts — WELCOME canary (wave 146, lane 146J; owner ruling 6 — which OVERRULES wave 145's ruling 17
 * wait; contract C3 — lane 146C):
 *   "Welcome email shouldn't wait for a video so send welcome email out right away and put the welcome personal video in-app contact
 *   portal so the contact sees it right away." / "Welcome video is automatically sent in the portal regardless of the contact's
 *   preferences."
 *   → conversion → the welcome email + secure portal invite go NOW (an activation link, never a password) whatever the video's state;
 *     no welcome is HELD for a video or for a person to release it without one (the 145 `welcome_without_video` wait is retired);
 *   → C3 portalWelcomeVideoFor(svc, brokerageId, contactId): the agent's personal video appears in THAT contact's portal the moment
 *     it is validated, whatever the contact's CHANNEL preferences; accessibility shapes playback (captions / transcript, no forced
 *     autoplay with sound); pending / failed is never shown as complete; visible only to that contact (and its tenant) — another
 *     contact or another brokerage reads nothing;
 *   → the welcome drip's first hello still defers to the arbiter inside its window (green, preserve).
 *
 * Through the survivors at bf67aa63: lib/contact-promotion/conversion-welcome.ts (decideWelcomeTiming — the pure wait rule ruling 6
 * replaces; holdWelcomeForException), lib/campaign-sequences/first-touch-coordination.ts decideFirstTouch, the welcome composers
 * (password census). C3 binds by the spec's FILE + NAME; it is driven on an in-memory client seeded with the welcome-video ledger
 * (agent_intro_videos) and the render (ai_video_projects) — the result is read by MEANING (a playable URL or not), never by shape.
 *
 * MEASURED AT bf67aa63: decideWelcomeTiming HOLDS the welcome while the personal video renders ('hold_for_video') and holds it for a
 * human exception when no video can be made ('hold_for_exception', approval item 'welcome_without_video'); lib/portal/welcome-video.ts
 * does not exist.
 */
import { setSvc } from "./_harness"
import { listFiles, strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"
import { quiet } from "./wave145-harness"
import { CONTRACTS_146, bind146, canary146, errText, jsonOf } from "./wave146-harness"

// ── WAVE146 BIND (lane 146C notes, "## Canary requirements") ── not published at the time of writing; C3 is bound by the spec's name,
// ruling 6's timing by the survivor decideWelcomeTiming (re-bound to lane 146C's published name if it moves).

const isSend = (a: unknown) => /^send/.test(String((a as { action?: unknown } | null)?.action ?? ""))

export async function run() {
  const c = canary146("Welcome: the welcome email + secure invite go NOW (never held for a video) · the personal video appears in THAT contact's portal when validated, whatever the channel preferences, accessibly · pending/failed never complete · no cross-contact / cross-tenant access")

  // ── 1 · RULING 6: the welcome is IMMEDIATE — nothing the video does (rendering, already commissioned, impossible, refused) holds it ──
  const cw = await quiet(async () => import("../../lib/contact-promotion/conversion-welcome")) as unknown as Record<string, any>
  await c.check("146C", "THE WELCOME EMAIL GOES NOW, WHATEVER THE VIDEO IS DOING (ruling 6 — OVERRULES wave 145's ruling 17 wait: 'Welcome email shouldn't wait for a video so send welcome email out right away'): the welcome timing decision answers SEND for a render in flight, an already-commissioned video, an agent with no avatar and a refused render — the video's state is the PORTAL's concern, never the welcome's (controls: a stated no-video format and an excluded contact type also send)", () => {
    if (typeof cw.decideWelcomeTiming !== "function") return { ok: false, evidence: "decideWelcomeTiming is gone from lib/contact-promotion/conversion-welcome.ts — re-bind to lane 146C's published timing name" }
    const t = (v: Record<string, unknown>) => cw.decideWelcomeTiming(v) as { action: string; reason: string }
    const cases: Array<[string, Record<string, unknown>]> = [
      ["rendering", { commissioned: true, reason: "commissioned" }],
      ["already commissioned", { commissioned: false, reason: "already_commissioned" }],
      ["no avatar", { commissioned: false, reason: "agent_not_video_ready" }],
      ["render refused", { commissioned: false, reason: "render_refused" }],
      ["stated no video (control)", { commissioned: true, reason: "commissioned", statedNoVideo: true }],
      ["excluded type (control)", { commissioned: false, reason: "excluded_contact_type" }],
    ]
    const out = cases.map(([k, v]) => ({ k, a: t(v) }))
    return { ok: out.every((x) => isSend(x.a)), evidence: out.map((x) => `${x.k} → ${x.a.action}`).join("; ") }
  })

  // ── 1b · …driven through the conversion door itself (lane 146C's published names: deliverConversionWelcome(supabase, params,
  //        { sendWelcome, commissionVideo, recoverVideo, now }), claimFirstTouch in first-touch-coordination) — recorder seams only ──
  await c.check("146C", "THE CONVERSION DOOR SENDS THE WELCOME FIRST, THEN COMMISSIONS THE VIDEO — AND THE WELCOME IS THE ONE FIRST TOUCH (ruling 6: 'conversion → … secure portal invite + welcome email SENT NOW … the agent's personal video prepared asynchronously'; lane 146C item 2: no duplicate first touch): the send precedes the commission; the welcome is sent; the contact's first touch is claimed for email and a later SMS claim is refused; when the agent cannot make a video the welcome is STILL sent and the video's recovery is asked once; control: a failed send claims no first touch", async () => {
    const B = "aaaaaaaa-0146-4000-8000-0000000000c5"
    if (typeof cw.deliverConversionWelcome !== "function") return { ok: false, evidence: "deliverConversionWelcome is not exported" }
    const ftcm = await quiet(async () => import("../../lib/campaign-sequences/first-touch-coordination")) as unknown as Record<string, any>
    if (typeof ftcm.claimFirstTouch !== "function") return { ok: false, evidence: "claimFirstTouch is not in lib/campaign-sequences/first-touch-coordination.ts yet (lane 146C moved it there)" }
    const NOW = new Date("2026-10-29T15:00:00Z")
    const world = () => memSupabase({ contacts: [{ id: "K", contact_id: "cK", brokerage_id: B, agent_id: "AG", contact_type: "buyer", email: "k146c@example.test", first_touched_at: null, first_touch_channel: null, accessibility_preferences: {} }], agents: [{ id: "AG", user_id: "u-ag", brokerage_id: B }], agent_action_ledger: [], automation_errors: [], notifications: [], portal_contact_invites: [] }, { uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    const run = async (sendState: string, commission: Record<string, unknown>) => {
      const s = world(); setSvc(s)
      const order: string[] = []; let recovers = 0
      const deps = {
        sendWelcome: async () => { order.push("send"); return { state: sendState } },
        commissionVideo: async () => { order.push("commission"); return commission },
        recoverVideo: async () => { recovers++; return { action: "escalate", outcome: "escalated" } },
        now: () => NOW,
      }
      const r = await quiet(async () => cw.deliverConversionWelcome(s, { contactId: "K", agentId: "AG", agentUserId: "u-ag", brokerageId: B, contactType: "buyer", firstName: "Kim" }, deps)) as Record<string, any>
      const row = (s.tables.contacts ?? []).find((x) => x.id === "K") ?? {}
      return { s, r, order, recovers, row }
    }
    // The commission seam answers the full WelcomeAvatarVideoResult shape (the survivor's own type).
    const commission = (commissioned: boolean, reason: string) => ({ commissioned, reason, videoProjectId: commissioned ? "vp-146c" : null, situational: false, language: commissioned ? "en" : null, warnings: [] as string[] })
    const ok1 = await run("sent", commission(true, "commissioned"))
    const second = await quiet(async () => ftcm.claimFirstTouch(ok1.s, "contacts", { id: "K", brokerageId: B, at: new Date(NOW.getTime() + 600_000), channel: "sms" })) as Record<string, unknown>
    const noVideo = await run("sent", commission(false, "agent_not_video_ready"))
    const failed = await run("send_failed", commission(true, "commissioned"))
    const sentFirst = ok1.order.indexOf("send") >= 0 && ok1.order.indexOf("send") < ok1.order.indexOf("commission")
    const claimed = !!ok1.row.first_touched_at && ok1.row.first_touch_channel === "email"
    const ok = sentFirst && /sent/.test(String(ok1.r.emailState)) && /send_now/.test(String(ok1.r.timing)) && claimed && second.ok === false && /sent/.test(String(noVideo.r.emailState)) && noVideo.recovers === 1 && !failed.row.first_touched_at
    return { ok, evidence: `order ${ok1.order.join("→")}; email ${ok1.r.emailState}, timing ${ok1.r.timing}; first touch ${ok1.row.first_touch_channel ?? "∅"} at ${ok1.row.first_touched_at ?? "∅"}; later SMS claim → ${second.ok === false ? "refused" : "CLAIMED AGAIN"}; no-video agent → email ${noVideo.r.emailState}, recovery asked ${noVideo.recovers}×; failed send → first touch ${failed.row.first_touched_at ? "CLAIMED" : "not claimed"}` }
  })

  // ── 2 · …and no welcome is held for a person to release it without the video (the 145 wait is retired, callers migrated) ──
  const code = [...listFiles("lib", (f) => /\.tsx?$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))]
  // A CALL is any `holdWelcomeForException(` that is not its own declaration (the defining file's internal callers count too).
  const callsIn = (s: string) => (s.match(/\bholdWelcomeForException\s*\(/g) ?? []).length - (s.match(/\bfunction\s+holdWelcomeForException\s*\(/g) ?? []).length
  const holders = code.filter((f) => callsIn(strippedRepo(f) ?? "") > 0)
  const holdControl = /\bholdWelcomeForException\s*\(/.test(stripComments("await holdWelcomeForException(svc, x)")) && !/\bholdWelcomeForException\s*\(/.test(stripComments("// RETIRED: holdWelcomeForException(svc, x) — survivor lib/portal/welcome-video.ts"))
  c.rule("146C", "NO WELCOME IS HELD FOR A VIDEO, AND NONE WAITS ON A PERSON TO RELEASE IT WITHOUT ONE (ruling 6; lane 146C item 1: 'Retire the 145 welcome_without_video wait (tombstone naming the survivor)'): no code path in lib/ or app/ still files the welcome-without-video hold (holdWelcomeForException called nowhere — stripped source; positive control: a call is caught, a tombstone is not)",
    holders.length === 0 && holdControl, `callers of the hold: ${holders.join(", ") || "none"}; finder control ${holdControl}`)

  // ── 3 · C3 driven: the personal video in THAT contact's portal — validated → playable, accessibly; pending/failed → never complete;
  //        channel preferences never suppress it; another contact / another brokerage reads nothing ──
  const C3 = await bind146(CONTRACTS_146.C3_PORTAL_VIDEO)
  await c.check("146C", "C3 · portalWelcomeVideoFor SHOWS THE VALIDATED PERSONAL VIDEO TO THAT CONTACT ONLY, ACCESSIBLY, AND NEVER A FALSE 'COMPLETE' (ruling 6: 'appears in that contact's portal the moment it is validated … regardless of the contact's preferences … accessibility preferences still shape playback … never a false video-complete state … visible only to that contact and the relevant agent/tenant'): a contact whose video is validated gets a playable URL even with email opted out and SMS preferred; captions or a transcript ride it and nothing autoplays with sound; a contact whose render is still running or FAILED gets no playable URL (a pending / failed state, never complete); the same contact asked under ANOTHER brokerage, and another contact of the same brokerage with no video, get nothing playable", async () => {
    if (!C3.mod) return { ok: false, evidence: C3.evidence }
    const B = "aaaaaaaa-0146-4000-8000-0000000000c3", B2 = "aaaaaaaa-0146-4000-8000-0000000000c4"
    const A = "agent-146c"
    // The welcome-video ledger's trigger value is DATA the reader filters on — taken from the landed module when it exports it
    // (seed shape, never an assertion), else the live vocabulary's welcome trigger.
    const TRIGGER = String(C3.mod.PORTAL_WELCOME_VIDEO_TRIGGER ?? "contact_agent_assigned")
    const NOW = new Date()
    const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
    const contact = (id: string, over: Record<string, unknown> = {}) => ({ id, contact_id: `cc-${id}`, brokerage_id: B, agent_id: A, contact_type: "buyer", first_name: id, has_login: true, email_opt_out: false, preferred_contact_method: "email", accessibility_preferences: {}, ...over })
    const project = (id: string, contactId: string, over: Record<string, unknown> = {}) => ({ id, brokerage_id: B, agent_id: A, contact_id: contactId, video_type: "agent_intro", status: "completed", approval_status: "approved", compliance_status: "passed", provider_metadata: null, completed_at: minsAgo(5), video_url: `https://cdn.example.test/${id}.mp4`, thumbnail_url: null, script_content: "Welcome — I'm glad you're here.", video_metadata: {}, ...over })
    const ledger = (id: string, contactId: string, projectId: string | null, status: string, over: Record<string, unknown> = {}) => ({ id, brokerage_id: B, agent_id: A, contact_id: contactId, video_project_id: projectId, status, trigger: TRIGGER, delivery_channel: "portal", delivered_at: status === "delivered" ? minsAgo(5) : null, error_message: status === "failed" ? "render timed out" : null, created_at: minsAgo(10), ...over })
    const svc = memSupabase({
      contacts: [contact("k-ready", { email_opt_out: true, preferred_contact_method: "sms", accessibility_preferences: { captions: true } }), contact("k-render"), contact("k-failed"), contact("k-none")],
      ai_video_projects: [project("p-ready", "k-ready"), project("p-render", "k-render", { status: "rendering", video_url: null }), project("p-failed", "k-failed", { status: "failed", video_url: null })],
      agent_intro_videos: [ledger("l-ready", "k-ready", "p-ready", "delivered"), ledger("l-render", "k-render", "p-render", "rendering"), ledger("l-failed", "k-failed", "p-failed", "failed")],
      agents: [{ id: A, brokerage_id: B, user_id: "u-agent" }], brokerages: [{ id: B, name: "Harbor" }, { id: B2, name: "Elsewhere" }],
    }, { uuidIds: true })
    setSvc(svc)
    const ask = async (b: string, k: string) => { try { return { r: await quiet(async () => C3.mod!.portalWelcomeVideoFor(svc, b, k)), e: null as string | null } } catch (e) { return { r: null, e: errText(e) } } }
    const URL_RE = /https:\/\/cdn\.example\.test\/p-[a-z]+\.mp4/
    const playable = (x: { r: unknown }) => URL_RE.test(jsonOf(x.r))
    const claimsComplete = (x: { r: unknown }) => /"(state|status)"\s*:\s*"(complete|completed|delivered|ready|playable)"/.test(jsonOf(x.r))
    // The relevant AGENT: a render made by the contact's PREVIOUS agent is not this agent's welcome (seeded, then asked).
    svc.tables.contacts!.push(contact("k-prev"))
    svc.tables.ai_video_projects!.push(project("p-prev", "k-prev", { agent_id: "agent-old" }))
    svc.tables.agent_intro_videos!.push(ledger("l-prev", "k-prev", "p-prev", "delivered", { agent_id: "agent-old" }))
    const ready = await ask(B, "k-ready"), render = await ask(B, "k-render"), failed = await ask(B, "k-failed"), none = await ask(B, "k-none"), foreign = await ask(B2, "k-ready"), prev = await ask(B, "k-prev")
    // FAIL CLOSED: a refused read is never 'ready' (nobody checked ≠ checked and fine).
    const refusedSvc = memSupabase({ contacts: [contact("k-ready")], ai_video_projects: [project("p-ready", "k-ready")], agent_intro_videos: [ledger("l-ready", "k-ready", "p-ready", "delivered")] }, { refuse: { contacts: "permission denied for table contacts" } })
    let refused: { r: unknown; e: string | null }
    try { refused = { r: await quiet(async () => C3.mod!.portalWelcomeVideoFor(refusedSvc, B, "k-ready")), e: null } } catch (e) { refused = { r: null, e: errText(e) } }
    const readyJson = jsonOf(ready.r)
    const accessible = /vtt|caption|transcript/i.test(readyJson)
    const forcedSound = /"autoplay"\s*:\s*true/.test(readyJson) && !/"muted"\s*:\s*true/.test(readyJson)
    const ok = playable(ready) && accessible && !forcedSound && !playable(render) && !claimsComplete(render) && !playable(failed) && !claimsComplete(failed) && !playable(none) && !playable(foreign) && !playable(prev) && !playable(refused) && !claimsComplete(refused)
    return { ok, evidence: `validated (email opted out, SMS preferred, captions on) → ${ready.e ?? (playable(ready) ? "playable" : `NOT playable ${readyJson.slice(0, 80)}`)}, captions/transcript ${accessible}, autoplay-with-sound ${forcedSound}; rendering → ${render.e ?? (playable(render) ? "PLAYABLE" : claimsComplete(render) ? "CLAIMS COMPLETE" : "pending")}; failed → ${failed.e ?? (playable(failed) ? "PLAYABLE" : claimsComplete(failed) ? "CLAIMS COMPLETE" : "not complete")}; no video → ${playable(none) ? "PLAYABLE" : "nothing"}; another brokerage → ${foreign.e ?? (playable(foreign) ? "LEAKED" : "nothing")}; previous agent's render → ${playable(prev) ? "SHOWN" : "nothing"}; refused read → ${refused.e ?? (playable(refused) || claimsComplete(refused) ? "READY (fails open)" : "not ready")}` }
  })

  // ── 3b · the portal READBACK is the evidence of delivery; a failure is recorded, retried safely ONCE and escalated to a person ONCE
  //        (lane 146C's published names: placePortalWelcomeVideo, recoverPortalWelcomeVideo — same in-memory world as the C3 read) ──
  await c.check("146C", "'DELIVERED' ONLY AFTER THE PORTAL READS THE VIDEO BACK, AND A FAILURE REACHES A PERSON ONCE (ruling 6: 'portal readback recorded … Failure: portal still works, failure recorded, the existing manager retries safely, human escalation, never a false video-complete state'): placing a validated render marks it delivered with ONE executed ledger row (a second placement adds none); a still-queued render is NOT placed and stays as it was; a no-avatar failure with nothing to stand in escalates to ONE error record and ONE bell to the agent (a second pass adds nothing); a timed-out render's retry door is called exactly ONCE across two passes", async () => {
    if (!C3.mod || typeof C3.mod.placePortalWelcomeVideo !== "function" || typeof C3.mod.recoverPortalWelcomeVideo !== "function") return { ok: false, evidence: `${C3.evidence}; placePortalWelcomeVideo / recoverPortalWelcomeVideo ${C3.mod ? "not exported" : "—"}` }
    const B = "aaaaaaaa-0146-4000-8000-0000000000c6", A = "agent-146c-r"
    const TRIGGER = String(C3.mod.PORTAL_WELCOME_VIDEO_TRIGGER ?? "contact_agent_assigned")
    const NOW = new Date(), ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
    const s = memSupabase({
      contacts: [{ id: "k-r", contact_id: "ck-r", brokerage_id: B, agent_id: A, contact_type: "buyer", accessibility_preferences: {} }, { id: "k-q", contact_id: "ck-q", brokerage_id: B, agent_id: A, contact_type: "buyer", accessibility_preferences: {} }, { id: "k-f", contact_id: "ck-f", brokerage_id: B, agent_id: A, contact_type: "buyer", accessibility_preferences: {} }],
      agents: [{ id: A, user_id: "u-agent-r", brokerage_id: B }], users: [{ id: "u-agent-r", brokerage_id: B, user_type: "agent", platform_role: null }],
      ai_video_projects: [{ id: "p-r", brokerage_id: B, agent_id: A, contact_id: "k-r", video_type: "agent_intro", status: "completed", compliance_status: "passed", provider_metadata: null, completed_at: ago(5), video_url: "https://cdn.example.test/p-r.mp4", thumbnail_url: null, script_content: "Welcome." }, { id: "p-q", brokerage_id: B, agent_id: A, contact_id: "k-q", video_type: "agent_intro", status: "queued", compliance_status: null, provider_metadata: null, video_url: null }],
      agent_intro_videos: [
        { id: "l-r", brokerage_id: B, agent_id: A, contact_id: "k-r", video_project_id: "p-r", status: "rendering", trigger: TRIGGER, created_at: ago(10), delivered_at: null, error_message: null },
        { id: "l-q", brokerage_id: B, agent_id: A, contact_id: "k-q", video_project_id: "p-q", status: "queued", trigger: TRIGGER, created_at: ago(3), delivered_at: null, error_message: null },
        { id: "l-f", brokerage_id: B, agent_id: A, contact_id: "k-f", video_project_id: null, status: "failed", trigger: TRIGGER, created_at: ago(30), delivered_at: null, error_message: "agent has no avatar" },
      ],
      agent_action_ledger: [], automation_errors: [], notifications: [], welcome_personal_videos: [],
    }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    setSvc(s)
    const ledgerRows = () => (s.tables.agent_action_ledger ?? []).length
    const place = async (introVideoId: string, contactId: string, videoProjectId: string) => (await quiet(async () => C3.mod!.placePortalWelcomeVideo(s, { introVideoId, brokerageId: B, contactId, videoProjectId }))) as Record<string, unknown>
    const p1 = await place("l-r", "k-r", "p-r"); const afterFirst = ledgerRows()
    const p2 = await place("l-r", "k-r", "p-r"); const afterSecond = ledgerRows()
    const lr = (s.tables.agent_intro_videos ?? []).find((x) => x.id === "l-r") ?? {}
    const qBefore = jsonOf((s.tables.agent_intro_videos ?? []).find((x) => x.id === "l-q"))
    const pq = await place("l-q", "k-q", "p-q")
    const qAfter = jsonOf((s.tables.agent_intro_videos ?? []).find((x) => x.id === "l-q"))
    const recover = async (row: string, failureKind: string, retryDoor: unknown) => (await quiet(async () => C3.mod!.recoverPortalWelcomeVideo(s, { brokerageId: B, contactId: "k-f", agentId: A, introVideoId: row, failureKind, reason: "canary" }, { retryDoor }))) as Record<string, unknown>
    const e1 = await recover("l-f", "no_avatar", null)
    const errs1 = (s.tables.automation_errors ?? []).length, bells1 = (s.tables.notifications ?? []).length
    const e2 = await recover("l-f", "no_avatar", null)
    const errs2 = (s.tables.automation_errors ?? []).length, bells2 = (s.tables.notifications ?? []).length
    let doorCalls = 0
    const door = async () => { doorCalls++; return { ok: false, reason: "provider still down" } }
    await recover("l-f", "timeout", door); await recover("l-f", "timeout", door)
    const bell = (s.tables.notifications ?? [])[0] ?? {}
    const ok = p1.placed === true && lr.status === "delivered" && !!lr.delivered_at && afterFirst === 1 && afterSecond === afterFirst && p2.placed !== false && pq.placed === false && qBefore === qAfter
      && /escalat/.test(jsonOf(e1)) && errs1 === 1 && bells1 === 1 && bell.user_id === "u-agent-r" && errs2 === errs1 && bells2 === bells1 && /already/.test(jsonOf(e2)) && doorCalls === 1
    return { ok, evidence: `place ready → ${jsonOf(p1).slice(0, 60)} (row ${lr.status}, ledger rows ${afterFirst}); again → ledger ${afterSecond}; place queued → ${pq.placed === false ? "not placed, row unchanged " + (qBefore === qAfter) : "PLACED"}; no-avatar → ${jsonOf(e1).slice(0, 60)} (errors ${errs1}, bells ${bells1} to ${bell.user_id ?? "∅"}); again → ${jsonOf(e2).slice(0, 50)} (errors ${errs2}, bells ${bells2}); timeout retry door called ${doorCalls}× over two passes` }
  })

  // ── 4 · the portal component renders the C3 read (the asset reaches the contact's portal journey) ──
  const portalPages = listFiles("app/portal", (f) => /\.tsx?$/.test(f))
  const renders = portalPages.filter((f) => /\bportalWelcomeVideoFor\s*\(/.test(strippedRepo(f) ?? "") || /from\s+["']@\/lib\/portal\/welcome-video["']/.test(strippedRepo(f) ?? ""))
  const components = portalPages.filter((f) => /<video\b/.test(strippedRepo(f) ?? "") && /welcome/i.test(f))
  const tracks = [...renders, ...components].some((f) => /<track\b|captions|transcript/i.test(strippedRepo(f) ?? ""))
  // The reader GATES FIRST (the session's contact access, CLAUDE.md §4) and only then reads with the service client; no portal player
  // forces playback (no autoPlay anywhere a <video> is rendered under app/portal).
  const gated = renders.filter((f) => { const s = strippedRepo(f) ?? ""; const g = s.search(/\brequireContactAccess\s*\(/), r = s.search(/\bportalWelcomeVideoFor\s*\(/); return r < 0 || (g >= 0 && g < r) })
  const autoplaying = portalPages.filter((f) => { const s = strippedRepo(f) ?? ""; return /<video\b/.test(s) && /\bautoPlay\b(?!\s*=\s*\{\s*false\s*\})/.test(s) })
  c.rule("146C", "THE CONTACT'S PORTAL RENDERS THE WELCOME VIDEO FROM C3, GATED, WITH A TRANSCRIPT AND NO FORCED PLAYBACK (ruling 6: 'a standard component of the contact's portal journey … accessibility preferences still shape playback (captions/transcript; no forced autoplay with sound) … visible only to that contact'; contract C3 'and the portal component'): a page or component under app/portal reads portalWelcomeVideoFor (or imports lib/portal/welcome-video) only AFTER the session's contact-access gate, the player offers captions or a transcript, and no portal <video> autoplays",
    renders.length > 0 && tracks && gated.length === renders.length && autoplaying.length === 0, `portal readers of C3: ${renders.join(", ") || "none"} (gated first ${gated.length}/${renders.length}); welcome players: ${components.join(", ") || "none"}; captions/transcript ${tracks}; autoplaying players ${autoplaying.join(", ") || "none"}`)

  // ── 5 · PRESERVE: a secure activation link, never a password (wave 145 ruling 17's surviving half; ruling 6 'activation link, never a password') ──
  const welcomeFiles = ["lib/contact-promotion/conversion-welcome.ts", "lib/contact-promotion/welcome-avatar-video.ts", "lib/contact-promotion/portal-access.ts", "lib/kernel/client-welcome.ts", "lib/portal/portal-invite-core.ts", "lib/portal/welcome-video.ts"]
  const PASSWORD_MINT = /\b(generate\w*Password|random\w*Password|temp(orary)?_?[Pp]assword|initialPassword|password\s*:\s*(?!null\b|undefined\b)[\w"'`])/
  const present = welcomeFiles.filter((f) => strippedRepo(f) !== null)
  const mints = present.filter((f) => PASSWORD_MINT.test(strippedRepo(f) ?? ""))
  const pwControl = PASSWORD_MINT.test("const body = { email, password: generateTempPassword() }") && !PASSWORD_MINT.test("const link = createActivationLink(token)")
  c.rule("146C", "THE IMMEDIATE WELCOME CARRIES A SECURE ACTIVATION LINK, NEVER A PASSWORD (ruling 6: 'secure portal invite + welcome email SENT NOW (activation link, never a password)'; green, preserve): no welcome / invite / portal-video composer mints or embeds a password (positive control: a minted temp password IS caught; an activation link is not)",
    pwControl && present.length > 0 && mints.length === 0, `${present.length} composer file(s) read; password minted in ${mints.join(", ") || "none"}`)

  // ── 6 · PRESERVE: the welcome drip's first hello defers to the arbiter inside its window (lane 146C item 2; 145E Still open 2) ──
  const ftc = await quiet(async () => import("../../lib/campaign-sequences/first-touch-coordination")) as unknown as Record<string, any>
  await c.check("146C", "THE WELCOME DRIP'S FIRST HELLO IS THE ARBITER'S (lane 146C item 2: 'the welcome drip's first hello goes through the arbiter'; ruling 16 of wave 145 — speed-to-lead is the arbiter's decision, no duplicate sender): a drip enrollment inside the arbiter's window with no first touch on record DEFERS to the arbiter; a first touch already on record is never duplicated", async () => {
    if (typeof ftc.decideFirstTouch !== "function") return { ok: false, evidence: "decideFirstTouch is gone — re-bind to lane 146C's published name" }
    const now = new Date("2026-10-29T15:00:00Z")
    const { KernelEvent } = await quiet(async () => import("../../lib/kernel/events")) as unknown as { KernelEvent: Record<string, string> }
    const base = { isFirstStep: true, sequenceTriggerEvent: KernelEvent.CONTACT_CAPTURED, stepChannel: "email", enrolledAt: new Date(now.getTime() - 2 * 60_000).toISOString(), now }
    const inWindow = ftc.decideFirstTouch({ ...base, firstTouchedAt: null, firstTouchChannel: null }) as string
    const touched = ftc.decideFirstTouch({ ...base, firstTouchedAt: new Date(now.getTime() - 60_000).toISOString(), firstTouchChannel: "email" }) as string
    return { ok: /defer|arbiter/.test(inWindow) && /skip|duplicate/.test(touched), evidence: `in the window, no first touch → ${inWindow}; first touch on record → ${touched}` }
  })

  c.blind("C3 is driven on an in-memory client seeded with the welcome-video ledger (agent_intro_videos) and the render (ai_video_projects) under the live column names; if lane 146C's reader keys on a table or column this seed does not carry, the step reads 'not playable' and the evidence says so — the binding loop then reseeds from lane 146C's published requirements. Playability is read by MEANING (the seeded https URL appears in the result or not), never by the result's shape. The welcome SEND itself (deliverConversionWelcome → the email provider) is not run here — lane 146C's test:conversion-welcome / test:conversion-finality drive it; this canary asserts the timing decision and the absence of any hold. The 'relevant agent' half of 'visible only to that contact and the relevant agent/tenant' is not driven (no agent session is modelled).")
  return c.report([], 0)
}
