#!/usr/bin/env tsx
/**
 * scripts/render-from-approval-simulator.ts — test:render-from-approval (wave 87, lane 87D)
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER (2026-09-28): avatar + automated videos are the most important
 * capability; "d-id is always first and the perferred"; scripts, avatar use and
 * video creation at an advanced level; b-roll / images / music / intro / outro /
 * branding correctly calculated with voiceover or avatar; keep cost down.
 * Lane 86F3's open item: "render-from-approval needs an avatar choice + a
 * session-free render path".
 *
 * RULES, each executed with a positive control (the finder still sees the defect):
 *   §host      D-ID twin first; no twin, or a video-sourced twin with no consent → voiceover
 *   §plan      the approved script is the narration VERBATIM; the shape by rule; a script
 *              longer than every band on its host is REFUSED, never trimmed
 *   §structure hook ≤ 2 s (5 words at 150 wpm), value beats, one closing ask — advisory
 *   §core      the server-only core EXECUTED on a fake client: approval → commission
 *              dispatched (avatar); missing twin → voiceover; not approved / foreign
 *              tenant → refused before any spend; a live render is never duplicated; a
 *              failed one is retried under a new key
 *   §watchdog  a stalled 'generating' row is written 'failed' + reason, tenant-pinned,
 *              status-guarded, counted; a refused stamp escalates nothing
 *   §wiring    both approval writers EMIT the dispatching event; the hub reaction renders;
 *              the render worker voices the voiceover host, reads its stamps, drives the
 *              watchdog; the Director speaks the approved narration
 *   §frame     the talking head's strap clears the caption band and leaves; the topic
 *              strip and the disclosure footer sit inside the safe insets; the hook is
 *              the first frame's display line (all found by the lane's real render)
 *   §writers   the studio script writer and the topic runner carry the structure
 *              directive in the prompt and the structure backstop after it
 * NO network, NO database. BLIND SPOTS (published): the render itself (Chromium +
 * ffmpeg) is proven by the lane's harness ($S/87d-render/), not here; the live
 * D-ID / ElevenLabs calls are not exercised; the watchdog's cross-tenant read is
 * proven on a fake client, not against the live index.
 */
import { readFileSync } from "node:fs"
import { blankStrings, stripComments } from "./strip-comments"
import {
  approvalRenderDiscriminator, approvedTextHash, chooseApprovalRenderHost, planApprovalRender, priorAttemptVerdict,
} from "../lib/video/approval-render-plan"
import {
  assessScriptStructure, hookWordBudget, onScreenCopyFromScript, shortFormStructureDirective, SHORT_FORM_HOOK_MAX_SECONDS, spokenWords,
} from "../lib/video/script-structure"
import { cinemaCaptionStyle, cinemaLowerThirdPlacement } from "../lib/video/cinema-finish"
import { safeInsets } from "../lib/video/body-visual-model"
import { COMPOSITION_DURATION_RULES, compositionBookends, compositionKeepsBrandIntro, narrationStartFrame, HOOK_FIRST_MAX_SPEECH_ONSET_SECONDS } from "../lib/video/duration-model"
import { stitchedIntroCategory } from "../lib/remotion/render-decision"
import { hookStingFrames } from "../lib/video/script-structure"
import { renderApprovedVideoScript } from "../lib/video/render-from-approval"
import { reapStaleVideoWorkflows, sweepStuckVideoRenders } from "../lib/video/video-pipeline-reaper"

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const code = (p: string) => blankStrings(stripComments(read(p)))
const stripped = (p: string) => stripComments(read(p))

const GOOD = "Pricing high rarely pays. Homes priced right in week one draw more showings and stronger offers. Overpriced homes sit, then chase the market down. Want a no-pressure look at where yours fits?"

// ── §host ─────────────────────────────────────────────────────────────────────
console.log("§host — D-ID first")
check("a ready, consented twin → the AVATAR host", chooseApprovalRenderHost({ canRender: true, consentOk: true }).host === "avatar")
check("no twin → the VOICEOVER host, reason names the missing twin", (() => { const h = chooseApprovalRenderHost({ canRender: false, consentOk: false, reason: "no avatar" }); return h.host === "voiceover" && /no D-ID twin/.test(h.reason) })())
check("a video-sourced twin with no verified consent → voiceover (the consent gate is never bypassed)", (() => { const h = chooseApprovalRenderHost({ canRender: true, consentOk: false, reason: "consent" }); return h.host === "voiceover" && /consent/.test(h.reason) })())

// ── §structure ────────────────────────────────────────────────────────────────
console.log("§structure — hook ≤ 2 s, value, one ask")
check(`the hook budget derives from the ONE pace: ${hookWordBudget()} words in ${SHORT_FORM_HOOK_MAX_SECONDS}s`, hookWordBudget() === Math.floor((2 / 60) * 150))
const good = assessScriptStructure(GOOD)
check("a well-shaped script: hook within budget, value beats, a closing ask, no warnings", good.hookWithinBudget && good.valueBeats === 2 && good.ctaPresent && good.warnings.length === 0, good)
const longHook = assessScriptStructure("Hi everyone, it's great to be here with you today talking about the market. Prices moved. Call me.")
check("CONTROL a greeting-length opener is flagged as a slow hook", !longHook.hookWithinBudget && longHook.warnings.some((w) => /spoken hook/.test(w)), longHook.warnings)
const noAsk = assessScriptStructure("Rates moved. Inventory is up. Days on market grew.")
check("CONTROL a script that asks for nothing is flagged", !noAsk.ctaPresent && noAsk.warnings.some((w) => /asks for nothing/.test(w)), noAsk.warnings)
const copy = onScreenCopyFromScript(GOOD, "Why sellers price right first")
const scriptWords = new Set(spokenWords(GOOD.toLowerCase().replace(/[.,?!]/g, "")))
const screenWords = [copy.hook, ...copy.bullets].join(" ").toLowerCase().replace(/[.,?!…]/g, "").split(/\s+/).filter(Boolean)
check("on-screen copy is cut VERBATIM from the approved text (no model-authored overlay)", screenWords.every((w) => scriptWords.has(w)), screenWords.filter((w) => !scriptWords.has(w)))
check("on-screen hook ≤ 6 words and beats ≤ 6 words each", spokenWords(copy.hook.replace("…", "")).length <= 6 && copy.bullets.every((b) => spokenWords(b.replace("…", "")).length <= 6), copy)
check("the directive names the hook budget and one persona-aware ask", /5 words or fewer/.test(shortFormStructureDirective({ durationSeconds: 45, persona: "seller" })) && /homeowner/.test(shortFormStructureDirective({ durationSeconds: 45, persona: "seller" })))

// ── §plan ─────────────────────────────────────────────────────────────────────
console.log("§plan — the shape by rule, never a trim")
const row = { id: "s1", title: "Why sellers price right first", script_content: GOOD, script_type: "agent_intro" }
const pa = planApprovalRender(row, "avatar")
check("avatar + agent_intro → the talking head, the approved text as narrationScript VERBATIM", pa.ok && pa.plan.compositionId === "AgentTalkingHeadReel" && pa.plan.content.narrationScript === GOOD && pa.plan.content.captionScript === GOOD, pa.ok ? pa.plan.compositionId : pa.reason)
check("the talking head's topic strip is the TITLE, not a repeat of the first caption", pa.ok && pa.plan.content.caption === "Why sellers price right first")
const pv = planApprovalRender(row, "voiceover")
check("voiceover → the kinetic-text composition with its content contract filled", pv.ok && pv.plan.compositionId === "NewsletterDigestVideo" && typeof pv.plan.content.subject === "string" && Array.isArray(pv.plan.content.sectionTitles), pv.ok ? pv.plan.compositionId : pv.reason)
const words150 = Array.from({ length: 36 }, (_, i) => `Beat ${i} matters here.`).join(" ") + " Want the checklist?"
const pLong = planApprovalRender({ ...row, script_content: words150 }, "avatar")
check("an intro too long for the welcome band (60 s) is carried as an explainer (90 s), not trimmed", pLong.ok && pLong.plan.compositionId === "AgentExplainerReel" && pLong.plan.content.narrationScript === words150, pLong.ok ? pLong.plan.compositionId : pLong.reason)
const tooLong = Array.from({ length: 80 }, (_, i) => `Beat ${i} matters here.`).join(" ")
const pRefuse = planApprovalRender({ ...row, script_content: tooLong }, "avatar")
check("a script longer than every band on its host is REFUSED with the reason (never trimmed after approval)", !pRefuse.ok && /never trimmed/.test(pRefuse.reason), pRefuse.ok ? "planned" : pRefuse.reason)
check("an empty approved script is refused", !planApprovalRender({ ...row, script_content: "  " }, "avatar").ok)
const k0 = approvalRenderDiscriminator("s1", GOOD, 0), k1 = approvalRenderDiscriminator("s1", GOOD, 1), kEdit = approvalRenderDiscriminator("s1", `${GOOD} Edited.`, 0)
check("the key is per (script, approved text); a retry after a failure gets a new key", k0 !== k1 && k0 !== kEdit && /^approved_script:s1:/.test(k0) && /:r1$/.test(k1))
check("a prior live attempt blocks a duplicate; failed ones are counted for the retry key", priorAttemptVerdict(["failed", "queued"]).live && !priorAttemptVerdict(["failed", "failed"]).live && priorAttemptVerdict(["failed", "failed"]).failed === 2)

// ── a fake client (tables in memory; eq on columns and on a->>b json paths) ──
type Row = Record<string, any>
function fakeSvc(tables: Record<string, Row[]>, opts: { refuseUpdate?: boolean } = {}) {
  const log: Array<{ table: string; op: string; filters: Array<[string, string, unknown]>; patch?: Row }> = []
  const get = (r: Row, k: string) => k.includes("->>") ? (r[k.split("->>")[0]] ?? {})[k.split("->>")[1]] : r[k]
  function builder(table: string) {
    const filters: Array<[string, string, unknown]> = []
    let op = "select"; let patch: Row | undefined; let limitN = Infinity
    const rows = () => (tables[table] ?? []).filter((r) => filters.every(([f, k, v]) =>
      f === "eq" ? get(r, k) === v : f === "in" ? (v as unknown[]).includes(get(r, k)) : f === "lt" ? String(get(r, k)) < String(v) : f === "notnull" ? get(r, k) != null : true))
    const run = () => {
      log.push({ table, op, filters: [...filters], patch })
      if (op === "update") {
        if (opts.refuseUpdate) return { data: null, error: { message: "permission denied (fake)" } }
        const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return { data: hit.map((r) => ({ id: r.id })), error: null }
      }
      return { data: rows().slice(0, limitN), error: null }
    }
    const b: any = {
      select: () => b, order: () => b,
      eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return b },
      in: (k: string, v: unknown[]) => { filters.push(["in", k, v]); return b },
      lt: (k: string, v: unknown) => { filters.push(["lt", k, v]); return b },
      not: (k: string) => { filters.push(["notnull", k, null]); return b },
      limit: (n: number) => { limitN = n; return b },
      update: (p: Row) => { op = "update"; patch = p; return b },
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error } },
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { from: (t: string) => builder(t), log }
}

async function core() {
  console.log("§core — the server-only core, executed")
  const B = "b-tenant", AGENT = "agent-1", USER = "user-1"
  const base = () => ({
    video_scripts_library: [{ id: "s1", brokerage_id: B, title: "Why sellers price right first", script_content: GOOD, script_type: "agent_intro", approval_status: "approved", agent_id: AGENT, created_by: USER, listing_id: null, contact_id: null }],
    agents: [{ id: AGENT, user_id: USER, brokerage_id: B }],
    ai_video_projects: [] as Row[],
  })
  const calls: any[] = []
  const commission: any = async (situation: any, opts: any) => { calls.push({ situation, opts }); return { ok: true, status: "staged", videoProjectId: "vp-1", compositionId: situation.facts.customPlan.compositionId } }
  const deps = (twin: { canRender: boolean; consentOk: boolean; reason?: string }) => ({
    commission, twin: async () => twin, postcheck: async () => ["Brand voice: advisory note (fake)"], loadOverrides: async () => null,
  })

  // A — approval → render dispatched on the avatar host (D-ID first)
  let r = await renderApprovedVideoScript(fakeSvc(base()), B, { scriptId: "s1", approvedByUserId: "approver-1" }, deps({ canRender: true, consentOk: true }))
  const a = calls[0]
  check("POSITIVE CONTROL approval → render DISPATCHED: one commission, avatar host, staged", r.ok && r.status === "staged" && r.host === "avatar" && calls.length === 1, r)
  check("the commission speaks the approved text verbatim and gates the approved hook (no model redraft)", a?.opts.spokenScript === GOOD && (await a?.opts.copyGenerator({})).body === "Pricing high rarely pays")
  check("the commission is autonomous, metered under its own feature, keyed per approved text, learning frozen", a?.opts.autonomous === true && a?.opts.meterFeature === "video_approval_render" && /^approved_script:s1:/.test(a?.opts.idempotencyDiscriminator) && a?.opts.formatLearning === false)
  check("the users.id crossed from agents.id fronts it (never substituted); tenant is the handed brokerage", a?.opts.agentUserId === USER && a?.opts.brokerageId === B && r.agentUserId === USER)
  check("post-check + structure warnings ride the staged row (compliance-first, advisory)", Array.isArray(a?.opts.complianceWarnings) && a.opts.complianceWarnings.includes("Brand voice: advisory note (fake)") && a?.opts.extraMetadata?.approved_text_hash === approvedTextHash(GOOD) && a?.opts.extraMetadata?.render_host === "avatar")

  // B — missing twin → voiceover
  calls.length = 0
  r = await renderApprovedVideoScript(fakeSvc(base()), B, { scriptId: "s1" }, deps({ canRender: false, consentOk: false, reason: "no avatar" }))
  check("POSITIVE CONTROL missing twin → the VOICEOVER path (kinetic text under the agent's voice)", r.ok && r.host === "voiceover" && calls[0]?.situation.facts.customPlan.compositionId === "NewsletterDigestVideo" && calls[0]?.opts.extraMetadata.render_host === "voiceover", r)

  // C — not approved: refused before any spend
  calls.length = 0
  const pending = base(); pending.video_scripts_library[0].approval_status = "pending_review"
  r = await renderApprovedVideoScript(fakeSvc(pending), B, { scriptId: "s1" }, deps({ canRender: true, consentOk: true }))
  check("a script that is not approved is REFUSED and nothing is commissioned", !r.ok && r.status === "refused" && calls.length === 0 && /not approved/.test(r.reason))

  // D — foreign tenant
  r = await renderApprovedVideoScript(fakeSvc(base()), "other-tenant", { scriptId: "s1" }, deps({ canRender: true, consentOk: true }))
  check("a script outside the handed tenant is refused (the read is tenant-pinned)", !r.ok && r.status === "refused" && calls.length === 0)

  // E — a live prior render is never duplicated; a failed one is retried under r1
  const live = base(); live.ai_video_projects.push({ id: "vp-live", brokerage_id: B, status: "generating", video_metadata: { approved_script_id: "s1", approved_text_hash: approvedTextHash(GOOD) } })
  r = await renderApprovedVideoScript(fakeSvc(live), B, { scriptId: "s1" }, deps({ canRender: true, consentOk: true }))
  check("a live render of the same approved text → already_staged, no second commission", r.ok && r.status === "already_staged" && r.videoProjectId === "vp-live" && calls.length === 0)
  const failed = base(); failed.ai_video_projects.push({ id: "vp-old", brokerage_id: B, status: "failed", video_metadata: { approved_script_id: "s1", approved_text_hash: approvedTextHash(GOOD) } })
  r = await renderApprovedVideoScript(fakeSvc(failed), B, { scriptId: "s1" }, deps({ canRender: true, consentOk: true }))
  check("a FAILED prior attempt is retried under a new key (:r1)", r.ok && /:r1$/.test(calls[0]?.opts.idempotencyDiscriminator ?? ""), calls[0]?.opts.idempotencyDiscriminator)

  // F — the Director refuses → the outcome carries the refusal
  calls.length = 0
  const blocked: any = async () => ({ ok: false, status: "blocked", reason: "video_excluded_by_tier" })
  r = await renderApprovedVideoScript(fakeSvc(base()), B, { scriptId: "s1" }, { ...deps({ canRender: true, consentOk: true }), commission: blocked })
  check("a Director refusal (tier excludes video) is returned as blocked with its reason — never read as staged", !r.ok && r.status === "blocked" && /excluded/.test(r.reason))

  // G — an author with no agents row in the tenant is refused
  const orphan = base(); orphan.agents = []
  r = await renderApprovedVideoScript(fakeSvc(orphan), B, { scriptId: "s1" }, deps({ canRender: true, consentOk: true }))
  check("an agents.id not in the tenant is refused (identity resolved in-tenant, never substituted)", !r.ok && r.status === "refused" && /not in brokerage/.test(r.reason))

  // ── §watchdog ──
  console.log("§watchdog — no row stranded")
  const now = new Date("2030-01-01T12:00:00Z")
  const old = new Date(now.getTime() - 4 * 3_600_000).toISOString()
  const fresh = new Date(now.getTime() - 10 * 60_000).toISOString()
  const vids = () => ({ ai_video_projects: [
    { id: "stuck", brokerage_id: B, agent_id: null, status: "generating", updated_at: old, title: "Stuck" },
    { id: "young", brokerage_id: B, agent_id: null, status: "generating", updated_at: fresh, title: "Young" },
    { id: "done", brokerage_id: B, agent_id: null, status: "completed", updated_at: old, title: "Done" },
  ] })
  const t1 = vids(); const s1 = fakeSvc(t1)
  const rep = await reapStaleVideoWorkflows(B, s1 as any, { now })
  const stuck = t1.ai_video_projects.find((v) => v.id === "stuck") as Row
  const upd = s1.log.find((l) => l.op === "update")
  check("POSITIVE CONTROL failure → TERMINAL status: a 4 h 'generating' row is written 'failed' with the reason", rep.escalated === 1 && stuck.status === "failed" && /stalled in 'generating'/.test(stuck.error_message), { rep, stuck })
  check("the failed stamp is tenant-pinned AND status-guarded (a row the poller just finished is never clobbered)", !!upd && upd.filters.some(([f, k, v]) => f === "eq" && k === "brokerage_id" && v === B) && upd.filters.some(([f, k, v]) => f === "eq" && k === "status" && v === "generating"))
  check("a young in-flight row and a finished row are left alone", t1.ai_video_projects.find((v) => v.id === "young")!.status === "generating" && t1.ai_video_projects.find((v) => v.id === "done")!.status === "completed")
  const t2 = vids(); const rep2 = await reapStaleVideoWorkflows(B, fakeSvc(t2, { refuseUpdate: true }) as any, { now })
  check("a REFUSED stamp escalates nothing and is counted (no 'flagged' notice for a row still stuck)", rep2.escalated === 0 && (rep2.refused ?? 0) === 1, rep2)
  const t3 = vids(); const sw = await sweepStuckVideoRenders(fakeSvc(t3) as any, { now })
  check("the watchdog driver finds the tenant holding a stale row and runs the ONE reaper for it", sw.tenants === 1 && sw.escalated === 1 && !sw.error, sw)
}

function wiring() {
  console.log("§wiring — emitters, reaction, worker, Director")
  const gen = code("app/actions/video-generation.ts")
  const agg = code("lib/kernel/approval-queue-aggregator.ts")
  const emits = (s: string) => /recordLifecycleEvent\(/.test(s) && /EVENT_TYPES\.VIDEO_SCRIPT_APPROVED/.test(s)
  check("the gated approval writer EMITS video.script_approved through the dispatching core", emits(gen))
  check("the queue approval (applyMarketingAssetApproval) EMITS it for kind video_script, tenant from the row", emits(agg) && /kind === "video_script"/.test(stripped("lib/kernel/approval-queue-aggregator.ts")))
  const rawOnly = `await supabase.from("lifecycle_events").insert({ event_type: eventType })`
  check("CONTROL the pre-87D shape (a raw ledger insert, nothing dispatched) is caught by the emitter rule", !emits(rawOnly))
  const react = code("lib/video/video-event-reactions.ts")
  check("the hub reaction RENDERS (renderApprovedVideoScript) and fails loudly when it could not", /renderApprovedVideoScript\(/.test(react) && /success: false/.test(react))
  const coreSrc = read("lib/video/render-from-approval.ts")
  check("the core is server-only and never builds the cookie client", /^\s*import "server-only"/m.test(stripComments(coreSrc)) && !/@\/lib\/supabase\/server/.test(stripComments(coreSrc)))
  const worker = code("app/api/cron/director-reel-render/route.ts")
  const iStage = worker.indexOf("stageVoiceoverNarration("), iInsert = worker.indexOf(`from("remotion_composition_renders").insert(`)
  const workerRaw = stripped("app/api/cron/director-reel-render/route.ts")
  const iInsertRaw = workerRaw.indexOf(`from("remotion_composition_renders").insert(`)
  check("the render worker VOICES the voiceover host before it enqueues the composition", iStage > 0 && workerRaw.indexOf("stageVoiceoverNarration(") < iInsertRaw && iInsertRaw > 0 && iInsert !== -2 && /prepareReelVoiceover\(/.test(workerRaw) && /input_props: staged\.props/.test(workerRaw))
  check("the worker drives the stuck-render watchdog every tick", /sweepStuckVideoRenders\(svc\)/.test(workerRaw))
  check("the D-ID handoff stamp and the terminal stamp are READ (no bare await on a status write)", /const \{ error: stampErr \} = await svc\.from\("ai_video_projects"\)/.test(workerRaw) && /if \(stampErr\)/.test(workerRaw) && /const \{ error \} = await svc\.from\("ai_video_projects"\)\s*\.update\(\{ status: "failed"/.test(workerRaw))
  const bare = `await svc.from("ai_video_projects")\n    .update({ status: "failed", error_message: reason })\n    .eq("id", id)`
  check("CONTROL a bare terminal stamp (the pre-87D fail()) is not mistaken for a read one", !/const \{ error \} = await svc\.from\("ai_video_projects"\)\s*\.update\(\{ status: "failed"/.test(bare))
  const dir = stripped("lib/video/video-director.ts")
  check("the Director speaks the approved narration when handed one (script_content), else its gated hook", /script_content: opts\.spokenScript\?\.trim\(\) \|\| hookLine/.test(dir))
  check("the reaper's failed stamp is .select()-counted and only a landed stamp escalates", /\.eq\("status", r\.status\)\s*\.select\("id"\)/.test(stripped("lib/video/video-pipeline-reaper.ts")))
}

function frame() {
  console.log("§frame — the talking head, as the real render found it")
  for (const [w, h] of [[1080, 1080], [1080, 1920], [1920, 1080]] as Array<[number, number]>) {
    const cap = cinemaCaptionStyle(w, h)
    const band = Math.ceil(cap.fontSize * cap.lineHeight * 2 + cap.padY * 2 + cap.tickHeight + cap.tickGap)
    const p = cinemaLowerThirdPlacement(w, h, 30)
    check(`${w}×${h}: the strap sits ABOVE a two-line caption band (${p.bottom}px ≥ ${cap.bandBottom + band}px) and leaves after ${p.holdFrames / 30}s`, p.bottom >= cap.bandBottom + band && p.holdFrames === 120)
    check(`CONTROL ${w}×${h}: the pre-87D placement (the safe bottom inset) collides with the caption band`, safeInsets(w, h).bottom < cap.bandBottom + band)
  }
  const ath = stripped("remotion/AgentTalkingHeadReel.tsx")
  check("the strap is placed and timed by cinemaLowerThirdPlacement", /bottom=\{strap\.bottom\}/.test(ath) && /holdFrames=\{strap\.holdFrames\}/.test(ath))
  check("no typed 24 px edge offsets remain (topic strip and disclosure footer inside the safe insets)", !/top: 24,/.test(ath) && !/bottom: 24,/.test(ath) && /top: safe\.top/.test(ath) && /bottom: safe\.bottom, left: safe\.left/.test(ath))
  // 87D2 — the hook is no longer on a cover card: it is the sting's headline over
  // the first spoken words (the rule is "the hook opens the film", not a font step).
  check("the hook headline opens the film (the hook sting, from frame 0) with no delayed fade of its own", /\{stingFrames > 0 && \([\s\S]{0,1400}\{hook\}/.test(ath) && !/interpolate\(frame, \[5, 20\]/.test(ath))
  const lt = stripped("remotion/components/LowerThird.tsx")
  check("LowerThird slides OUT after holdFrames (absent → unchanged for its other caller)", /exitStart = typeof holdFrames === "number"/.test(lt) && /translate: `\$\{enter \+ exit\}px`/.test(lt))
}

function hookFirst() {
  console.log("§hook-first — the talking head speaks from frame 0 (87D2)")
  check("the talking head is declared hook-first with a ZERO-frame cover; its narration starts at frame 0",
    // The flag off the table (wave 90 follow-up: compositionOpensOnHook is tombstoned) AND the
    // stitch decision its successor makes from it — no brand intro in front of the hook.
    COMPOSITION_DURATION_RULES.AgentTalkingHeadReel.hookFirst === true && !compositionKeepsBrandIntro("AgentTalkingHeadReel")
    && compositionBookends("AgentTalkingHeadReel").introFrames === 0 && narrationStartFrame("AgentTalkingHeadReel") === 0)
  check(`the rule's own number: the first word within ${HOOK_FIRST_MAX_SPEECH_ONSET_SECONDS}s (narration start / fps)`, narrationStartFrame("AgentTalkingHeadReel") / 30 <= HOOK_FIRST_MAX_SPEECH_ONSET_SECONDS)
  const row = (id: string) => ({ composition_id: id, stock_intro_category: "brand_intro" })
  check("NO brand intro clip is stitched in front of a hook-first film (the live row's brand_intro is dropped; the outro stands)", stitchedIntroCategory(row("AgentTalkingHeadReel")) === null)
  check("CONTROL a SEATED-purpose composition (the partners' recap) keeps its registered brand intro — wave 89: every scroll-format composition opens on its hook (scripts/video-hook-window-guard.ts)", stitchedIntroCategory(row("PartnersMeetingReel")) === "brand_intro" && stitchedIntroCategory(row("AgentExplainerReel")) === null)
  const s = (x: string) => stripped(x)
  check("the coordinator, the render-cache predictor and the readiness pass all ask the ONE decision (stitchedIntroCategory)",
    /const introCategory = stitchedIntroCategory\(composition\)/.test(s("lib/remotion/render-coordinator.ts"))
    && /const introCategory = stitchedIntroCategory\(composition\)/.test(s("lib/remotion/render-cache.ts"))
    && /stitchedIntroCategory\(c\)/.test(s("lib/video/plan-asset-readiness.ts"))
    && !/pickStockAsset\([^)]*composition\.stock_intro_category/.test(s("lib/remotion/render-coordinator.ts") + s("lib/remotion/render-cache.ts")))
  // The sting lasts as long as the HOOK is said — derived from real media, in order.
  const script = "Pricing high rarely pays. Homes priced right draw more offers. Want a look?"
  const cues = [{ text: "Pricing high", fromFrame: 0, durationFrames: 20 }, { text: "rarely pays.", fromFrame: 20, durationFrames: 25 }, { text: "Homes priced right", fromFrame: 45, durationFrames: 30 }]
  const byCues = hookStingFrames({ script, cues, bodyFrames: 400, fps: 30, wordsPerMinute: 135 })
  check("sting from the word-timed cues: ends where the hook's last word ends (45 f; clamped ≥ 1.2 s = 36 f)", byCues.source === "cues" && byCues.frames === 45, byCues)
  const byClip = hookStingFrames({ script, avatarDurationSeconds: 8, bodyFrames: 400, fps: 30, wordsPerMinute: 135 })
  check("no cues → the hook's share of the MEASURED clip (4/13 × 8 s ≈ 74 f)", byClip.source === "measured_clip" && Math.abs(byClip.frames - Math.round((4 / 13) * 8 * 30)) <= 1, byClip)
  const byPace = hookStingFrames({ script, bodyFrames: 400, fps: 30, wordsPerMinute: 135 })
  check("nothing measured → the host pace (the estimate rung is labelled as such)", byPace.source === "estimate" && byPace.frames === Math.round((4 / 135) * 60 * 30), byPace)
  check("the sting never outlasts HOOK_STING_MAX_SECONDS or the body", hookStingFrames({ script: "one two three four five six seven eight nine ten eleven twelve. Go.", bodyFrames: 60, fps: 30, wordsPerMinute: 135 }).frames === 60
    && hookStingFrames({ script: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen. Go.", avatarDurationSeconds: 60, bodyFrames: 900, fps: 30, wordsPerMinute: 135 }).frames === 90)
  const ath = stripped("remotion/AgentTalkingHeadReel.tsx")
  check("the composition has no silent cover tile (no Sequence at frame 0 of length COVER), times the sting with hookStingFrames, and the strap follows the sting",
    !/<Sequence from=\{0\} durationInFrames=\{COVER\}>/.test(ath) && /hookStingFrames\(\{ script: captionScript \?\? hook, cues: captionsCues/.test(ath) && /<Sequence from=\{stingFrames\} layout="none">/.test(ath))
  check("CONTROL the pre-87D2 cover tile is recognised by that finder", /<Sequence from=\{0\} durationInFrames=\{COVER\}>/.test(`<Sequence from={0} durationInFrames={COVER}>`))
}

function writers() {
  console.log("§writers — the shape in the prompt, the backstop after it")
  const gs = stripped("app/actions/video/generate-script.ts")
  const iDir = gs.indexOf("shortFormStructureDirective({"), iCall = gs.indexOf("generateAIResponse({")
  check("the studio writer carries the structure directive in its system prompt, BEFORE the model call", iDir > 0 && iCall > 0 && iDir < iCall)
  check("…and the structure backstop joins the advisory warnings (never a hold)", /const structureHits = assessScriptStructure\(script\)\.warnings/.test(gs) && /\.\.\.structureHits,/.test(gs))
  const tr = stripped("lib/video/topic-video-runner.ts")
  check("the autonomous topic writer carries the directive too", /shortFormStructureDirective\(\{ durationSeconds: planned\.plan\.band\.targetSeconds, persona: side \}\)/.test(tr))
}

async function main() {
  await core()
  wiring()
  frame()
  hookFirst()
  writers()
  console.log(`\nrender-from-approval: ${pass} passed, ${fail} failed (denominator ${pass + fail})`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
