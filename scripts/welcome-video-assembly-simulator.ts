#!/usr/bin/env tsx
/**
 * scripts/welcome-video-assembly-simulator.ts   (npm run test:welcome-video-assembly)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WELCOME VIDEO IS AN ASSEMBLED VIDEO, NOT A BARE TALKING HEAD.
 *
 * OWNER RULING, verbatim: "the video for the welcome email/portal info for the
 * newly converted lead to contact, finishes and then embeds into the email.
 * usually the did avatar url is taken from the user's settings (twin studio
 * created), then remotion assembles the complete video together (I know this was
 * completely built using the managers)."
 *
 * He was right that it was built. Traced end to end, every part existed:
 *
 *   Twin Studio → agent_voice_profiles (elevenlabs_voice_id, did_photo_url,
 *   did_video_url) → lib/video/presenter-media resolves it → the intro reactor
 *   GATES on it and refuses honestly when it is absent → /api/did/generate-video
 *   submits → /api/cron/poll-did-videos polls → on completion it calls
 *   enqueueAvatarCompositionForProject, which wires the avatar URL into a
 *   Remotion render's input_props → composition-render-queue drains it →
 *   render-composition brands, uploads, and stamps the composite back onto the
 *   project → intro-video-email-backfill embeds it in the welcome email.
 *
 * ONE LINK WAS MISSING. enqueueAvatarCompositionForProject fires only when
 * `ai_video_projects.provider_metadata.target_composition_id` is set, and
 * lib/video/intro-video-reactor.ts contained ZERO occurrences of that key — it
 * wrote provider_metadata with the provider, the mode and the talk id and no
 * target. So every welcome video ever made hit
 * `skipped: "no target_composition_id — not a composition request"` and shipped
 * as a bare D-ID talking head: no Remotion assembly, no brand chrome.
 *
 * WHAT THIS HARNESS PROVES (two-sided — every absence assertion has a control
 * that makes the finder demonstrate it can still see the defect):
 *
 *   Layer 1  the composition request the reactor now stamps, and the cases where
 *            it correctly refuses to stamp one.
 *   Layer 2  the caption is a VERBATIM slice of the compliance-gated script —
 *            the assembly step authors no client-facing copy (§5).
 *   Layer 3  the CLEAN un-branded cut is the avatar track, never the pre-branded
 *            one (Remotion applies its own chrome; two bands is the defect).
 *   Layer 4  the composite-wait state machine, both sides, including every way
 *            it must NOT stall the welcome email forever.
 *   Layer 5  the wiring, read from STRIPPED source (CLAUDE.md §2 — a tombstone
 *            is not a call site), with a positive control per matcher.
 *
 * PURE — no database, no provider. The paid providers (D-ID, Remotion/Lambda)
 * are never called: the D-ID submission is represented by the provider_metadata
 * the reactor writes, and the Remotion render by the remotion_composition_renders
 * row shape the classifier reads.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  INTRO_VIDEO_COMPOSITION,
  buildIntroCompositionRequest,
  describeIntroCompositionGap,
  declaresAvatarComposition,
  resolveAvatarCompositeState,
  enqueueAvatarCompositionForProject,
  buildAvatarRenderRow,
  COMPOSITE_WAIT_MS,
  type CompositeRenderProbe,
} from "../lib/video/avatar-render-orchestrator"
import { missingContentProps, CONTENT_CONTRACT } from "../lib/remotion/content-contract"
import { VIDEO_FINISH_SPEC } from "../lib/video/finish-spec"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
/** Every source scan reads STRIPPED source. A tombstone is not a call site. */
const src = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

/**
 * A FAKE supabase client, not a live one and not a provider.
 *
 * The two functions under test here are the real product entry points — the ones
 * poll-did-videos, the email backfill and playable-video actually call — so they
 * take a client. Faking it exercises the real code path (including the reads,
 * the ordering and the `{ data, error }` destructuring) without a database and
 * without spending a cent at D-ID or Remotion Lambda. `error` is settable so the
 * "supabase-js RESOLVES refusals" path can be driven too.
 */
function fakeClient(tables: {
  ai_video_projects?: any[]
  remotion_composition_renders?: any[]
  renderError?: { message: string } | null
  onInsert?: (table: string, row: any) => void
}) {
  const inserted: Array<{ table: string; row: any }> = []
  const api: any = {
    inserted,
    from(table: string) {
      const q: any = {
        _rows: (tables as any)[table] ?? [],
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: q._rows[0] ?? null, error: null }),
        single: async () => ({ data: q._rows[0] ?? null, error: null }),
        insert(row: any) {
          inserted.push({ table, row })
          tables.onInsert?.(table, row)
          return {
            select: () => ({
              single: async () => ({ data: { id: "render-1" }, error: null }),
            }),
          }
        },
        then(res: any, rej: any) {
          const err = table === "remotion_composition_renders" ? (tables.renderError ?? null) : null
          return Promise.resolve({ data: err ? null : q._rows, error: err }).then(res, rej)
        },
      }
      return q
    },
  }
  return api
}

/** A compliance-clean welcome script, in the shape draftScript returns. */
const GATED_SCRIPT =
  "You told us you're hoping to be in a place before the school year starts, and that's " +
  "exactly the timeline I work best on. I'm Dana, the agent your search is assigned to, " +
  "and my job is to make the next ninety days feel simple. Reply here and we'll find " +
  "twenty minutes this week."

const PARAMS = {
  projectId:     "11111111-1111-1111-1111-111111111111",
  script:        GATED_SCRIPT,
  agentName:     "Dana Reyes",
  agentPhotoUrl: "https://storage.test/dana.jpg",
  brand: {
    primaryColor: "#0F172A", accentColor: "#F59E0B",
    brokerageName: "Harbour & Co.", showEhoMark: true,
  },
}

// ── Layer 1 ─────────────────────────────────────────────────────────────────
function layer1_request() {
  console.log("\n[Layer 1 · the composition request that was never made]")

  const req = buildIntroCompositionRequest(PARAMS)
  check("a welcome video now REQUESTS a Remotion composition", req !== null)
  if (!req) return

  check("...and the composition is AgentTalkingHeadReel",
    req.target_composition_id === INTRO_VIDEO_COMPOSITION && req.target_composition_id === "AgentTalkingHeadReel",
    req.target_composition_id)

  // EVIDENCE, not preference: the finish spec classifies this composition as the
  // personal one-to-one avatar video, which is what a welcome video is.
  check("...chosen on evidence — finish-spec says this composition is the avatar-led\n    personal message (presenter=did_talking_head), not the circle-PIP explainer",
    VIDEO_FINISH_SPEC[INTRO_VIDEO_COMPOSITION]?.presenter === "did_talking_head",
    JSON.stringify(VIDEO_FINISH_SPEC[INTRO_VIDEO_COMPOSITION]))
  check("...and it carries brand chrome the bare D-ID cut does not (bookends + outro QR)",
    VIDEO_FINISH_SPEC[INTRO_VIDEO_COMPOSITION]?.bookends === true
    && VIDEO_FINISH_SPEC[INTRO_VIDEO_COMPOSITION]?.qr === true)

  check("the key the handoff actually reads is present",
    declaresAvatarComposition(req) === true)

  // entity_type/entity_id is what threads the finished composite back onto the
  // PROJECT row — the column the welcome email and the portal card read.
  check("entity_type='video_project' — without it render-composition never stamps the\n    composite onto ai_video_projects.video_url and the email reads nothing",
    req.entity_type === "video_project")
  check("entity_id is the project id", req.entity_id === PARAMS.projectId)

  const props = req.input_props
  check("the composition's content contract is satisfied (renderer would not cancel it)",
    missingContentProps(INTRO_VIDEO_COMPOSITION, props).length === 0,
    missingContentProps(INTRO_VIDEO_COMPOSITION, props).join(","))
  check("agentName is the real resolved name", props.agentName === "Dana Reyes")
  check("brand block rides along", (props.brand as any)?.brokerageName === "Harbour & Co.")
  check("the avatar URL is NOT pre-stamped — the handoff merges it on completion,\n    which is where the clean-vs-branded choice is made",
    !("avatarVideoUrl" in props))

  // POSITIVE CONTROLS — prove the refusals are real refusals.
  const noName = buildIntroCompositionRequest({ ...PARAMS, agentName: "   " })
  check("CONTROL: an unresolvable agent name refuses the request rather than queueing\n    a render the content contract would cancel", noName === null)
  check("...and it names the prop it could not supply",
    describeIntroCompositionGap({ ...PARAMS, agentName: "" }).includes("agentName"),
    describeIntroCompositionGap({ ...PARAMS, agentName: "" }).join(","))

  const noScript = buildIntroCompositionRequest({ ...PARAMS, script: "" })
  check("CONTROL: an empty script refuses (no caption ⇒ nothing to put on screen)", noScript === null)

  const noProject = buildIntroCompositionRequest({ ...PARAMS, projectId: "" })
  check("CONTROL: no project id refuses (nothing to thread the composite back to)", noProject === null)

  check("CONTROL: the contract this builder checks is the SAME one render-composition\n    enforces, and it really does require these three props",
    JSON.stringify(CONTENT_CONTRACT[INTRO_VIDEO_COMPOSITION]?.required) === JSON.stringify(["hook", "agentName", "caption"]),
    JSON.stringify(CONTENT_CONTRACT[INTRO_VIDEO_COMPOSITION]?.required))
}

// ── Layer 2 ─────────────────────────────────────────────────────────────────
function layer2_compliance() {
  console.log("\n[Layer 2 · §5 compliance-first survives the assembly step]")

  // Read through the PRODUCT surface — the caption is whatever the request the
  // reactor stamps actually carries, not a helper called in isolation.
  const captionOf = (script: string) =>
    String(buildIntroCompositionRequest({ ...PARAMS, script })?.input_props.caption ?? "")

  const caption = captionOf(GATED_SCRIPT)
  check("the on-screen caption is a VERBATIM slice of the gated script — the assembly\n    authors no client-facing copy a compliance gate never saw",
    caption.length > 0 && GATED_SCRIPT.replace(/\s+/g, " ").startsWith(caption.replace(/…$/, "")),
    caption)
  check("...capped at the composition's own 12-word readability limit",
    caption.replace(/…$/, "").split(" ").filter(Boolean).length <= 12,
    String(caption.split(" ").length))
  check("...it is the OPENING of the script, so the strip and the voice agree",
    GATED_SCRIPT.startsWith(caption.replace(/…$/, "").split(" ")[0]))
  check("CONTROL: a long script really is truncated — a cap that silently passed the\n    whole paragraph through would fail here",
    captionOf("one two three four five six seven eight nine ten eleven twelve thirteen fourteen")
      === "one two three four five six seven eight nine ten eleven twelve…")
  check("CONTROL: no script ⇒ no request at all, never a stand-in sentence",
    buildIntroCompositionRequest({ ...PARAMS, script: "   " }) === null)

  // The hook and CTA are fixed template chrome — nothing about the recipient.
  const req = buildIntroCompositionRequest(PARAMS)!
  check("the hook is fixed template chrome, not authored copy about the recipient",
    req.input_props.hook === "MEET YOUR AGENT")
  check("the CTA is fixed template chrome too", req.input_props.ctaLabel === "Reply to set up a time")

  // ORDER MATTERS: the request must be built AFTER the pre-flight gate, from the
  // gated script, never before it.
  // CALL SITES, not import lines. The first cut of this assertion searched for
  // the bare identifiers and found them in the IMPORT BLOCK, where they appear
  // in alphabetical-ish order regardless of what the function body does — so it
  // reported a correct ordering while the request block was deleted. Both
  // needles now carry their opening paren.
  const reactor  = src("lib/video/intro-video-reactor.ts")
  const gateAt   = reactor.indexOf("runWithComplianceRedraft({")
  const buildAt  = reactor.indexOf("buildIntroCompositionRequest(")
  const stampAt  = reactor.indexOf("provider_metadata: {")
  check("the reactor builds the request AFTER evaluateOutbound + the redraft gate",
    gateAt > -1 && buildAt > -1 && gateAt < buildAt, `gate@${gateAt} build@${buildAt}`)
  check("...and BEFORE the provider_metadata stamp that carries it to the handoff",
    buildAt > -1 && stampAt > -1 && buildAt < stampAt, `build@${buildAt} stamp@${stampAt}`)
  check("CONTROL: those needles are call sites, not import lines — the import block\n    alone does not satisfy them",
    'import { buildIntroCompositionRequest, runWithComplianceRedraft } from "x"'
      .indexOf("buildIntroCompositionRequest(") === -1)
  check("...and the composition step does not bypass the gate — evaluateOutbound is\n    still the only path to a submitted script",
    reactor.includes("evaluateOutbound") && reactor.includes("compliance failed after redraft"))

  // The prior lane's ADDITIVE situation threading must be untouched: omitting a
  // situation has to reproduce the earlier prompt byte-for-byte.
  check("the situation block is still ADDITIVE — omitted ⇒ empty string, prompt unchanged",
    reactor.includes('args.situation && args.situation.facts.length > 0')
    && reactor.includes('args.situation && args.situation.complianceDirectives.length > 0'))
  check("...and the fair-housing rules still reach the WRITING prompt, not just the scan",
    reactor.includes("RULES THAT GOVERN WHAT YOU MAY WRITE")
    && reactor.includes("Avoid any reference to protected characteristics"))
  // THE RULE, NOT THE COUNT. This asserted `=== 2` — one per draft call site —
  // and went red when the second call site was deleted for being a script the
  // reactor paid for and threw away (§5). §2: assert the rule and DERIVE the
  // number, so the check is "every draftScript call threads the situation",
  // whatever the number of them turns out to be. Zero call sites still fails.
  const draftSites = (reactor.match(/(?<!function\s)draftScript\(\s*\{/g) ?? []).length
  const situationThreads = (reactor.match(/situation:\s*input\.situation/g) ?? []).length
  check("...the situation is threaded into EVERY draftScript call site",
    draftSites > 0 && situationThreads === draftSites,
    `${situationThreads} threads / ${draftSites} call sites`)
}

// ── Layer 3 ─────────────────────────────────────────────────────────────────
async function layer3_cleanTrack() {
  console.log("\n[Layer 3 · the CLEAN cut is the avatar track — never double-branded]")

  const branded = "https://storage.test/agent-videos/a/p.branded.mp4"
  const clean   = "https://storage.test/agent-videos/a/p.mp4"

  // Driven through the REAL handoff (the one poll-did-videos calls) against a
  // fake client. No D-ID submission, no Remotion render, no database.
  const project = (meta: any, videoUrl: string | null) => ({
    id: PARAMS.projectId, brokerage_id: "brk", agent_id: null,
    video_url: videoUrl, provider_metadata: meta,
  })
  const enqueue = async (meta: any, videoUrl: string | null) => {
    const c = fakeClient({ ai_video_projects: [project(meta, videoUrl)] })
    const res = await enqueueAvatarCompositionForProject(PARAMS.projectId, c)
    return { res, row: c.inserted[0]?.row }
  }

  const both = await enqueue(
    { target_composition_id: INTRO_VIDEO_COMPOSITION, clean_video_url: clean }, branded)
  check("the handoff enqueues a render for a project that declared an assembly",
    both.res.ok === true, both.res.ok ? "" : both.res.skipped)
  check("the clean un-branded cut wins over the branded project URL — Remotion adds\n    its own chrome, so a pre-branded source would carry two attribution bands",
    both.row?.input_props?.avatarVideoUrl === clean, String(both.row?.input_props?.avatarVideoUrl))

  const noClean = await enqueue({ target_composition_id: INTRO_VIDEO_COMPOSITION }, branded)
  check("CONTROL: with no clean copy persisted the branded cut is the fallback —\n    a double band beats no video",
    noClean.row?.input_props?.avatarVideoUrl === branded)

  const nothing = await enqueue({ target_composition_id: INTRO_VIDEO_COMPOSITION }, null)
  check("CONTROL: nothing at all ⇒ the handoff skips instead of enqueueing a render\n    with no avatar track",
    nothing.res.ok === false && /no avatar video URL/.test((nothing.res as any).skipped))

  const blank = await enqueue(
    { target_composition_id: INTRO_VIDEO_COMPOSITION, clean_video_url: "   " }, branded)
  check("CONTROL: a blank clean_video_url is not a clean copy",
    blank.row?.input_props?.avatarVideoUrl === branded)

  // THE ORIGINAL DEFECT, reproduced: metadata with no target is skipped.
  const bare = await enqueue({ provider: "did" }, branded)
  check("CONTROL: the ORIGINAL defect — provider_metadata with no target_composition_id\n    is skipped, which is what every welcome video used to hit",
    bare.res.ok === false && /no target_composition_id/.test((bare.res as any).skipped),
    bare.res.ok ? "it enqueued anyway" : (bare.res as any).skipped)

  // And the request the reactor now stamps clears exactly that gate.
  const real = await enqueue(
    { provider: "did", ...buildIntroCompositionRequest(PARAMS)!, clean_video_url: clean }, branded)
  check("the reactor's request clears that gate and targets AgentTalkingHeadReel",
    real.res.ok === true && real.row?.composition_id === INTRO_VIDEO_COMPOSITION,
    String(real.row?.composition_id))
  check("...and the composition's content props ride through to the render row",
    real.row?.input_props?.hook === "MEET YOUR AGENT"
    && real.row?.input_props?.agentName === "Dana Reyes"
    && typeof real.row?.input_props?.caption === "string")

  // The writer of clean_video_url is poll-did-videos, and it must write it BEFORE
  // it calls the handoff — otherwise the preference above has nothing to prefer.
  const poll = src("app/api/cron/poll-did-videos/route.ts")
  const writeAt  = poll.indexOf("clean_video_url:")
  const handAt   = poll.indexOf("enqueueAvatarCompositionForProject")
  check("poll-did-videos writes clean_video_url onto provider_metadata",
    writeAt > -1)
  check("...before it hands off to the composition enqueue",
    writeAt > -1 && handAt > -1 && writeAt < handAt, `write@${writeAt} hand@${handAt}`)
  check("CONTROL: the matcher can still see the defect it was written for",
    src("app/api/cron/poll-did-videos/route.ts").replace("clean_video_url:", "xx_gone:").indexOf("clean_video_url:") === -1)

  // The reactor must not ask D-ID for a pre-branded render. usage_intent drives
  // the burn-in; 'public_marketing' keeps the clean copy alongside it.
  const reactor = src("lib/video/intro-video-reactor.ts")
  check("the reactor requests usage_intent='public_marketing' (the branded cut is a\n    SIBLING of the clean copy, not a replacement for it)",
    /usage_intent:\s*"public_marketing"/.test(reactor))

  // The row the handoff builds must carry the avatar URL into input_props.
  const row = buildAvatarRenderRow({
    brokerageId: "b", agentId: "u", compositionId: INTRO_VIDEO_COMPOSITION,
    avatarVideoUrl: clean, entityType: "video_project", entityId: PARAMS.projectId,
  })
  check("the enqueued render carries the clean avatar URL into input_props",
    (row.input_props as any).avatarVideoUrl === clean)
  check("...and carries entity_type/entity_id through to render-composition",
    row.entity_type === "video_project" && row.entity_id === PARAMS.projectId)
  check("...flagged used_did_avatar so the coordinator and tier gate see an avatar render",
    row.used_did_avatar === true && row.render_status === "queued")
}

// ── Layer 4 ─────────────────────────────────────────────────────────────────
async function layer4_compositeWait() {
  console.log("\n[Layer 4 · wait for the ASSEMBLED cut, but never forever]")

  const NOW   = Date.parse("2026-08-25T12:00:00Z")
  const fresh = new Date(NOW - 60_000).toISOString()
  const stale = new Date(NOW - COMPOSITE_WAIT_MS - 60_000).toISOString()
  const DECLARED = { provider: "did", target_composition_id: INTRO_VIDEO_COMPOSITION }

  // Driven through the REAL resolver — the one the email backfill and
  // playable-video call — against a fake render table. No DB, no provider.
  const state = async (
    meta: any, completedAt: string | null, renders: CompositeRenderProbe[], renderError?: { message: string },
  ) => resolveAvatarCompositeState(
    { id: PARAMS.projectId, provider_metadata: meta, completed_at: completedAt },
    fakeClient({ remotion_composition_renders: renders, renderError: renderError ?? null }),
    NOW,
  )

  check("a project that never asked for an assembly is not made to wait",
    (await state({ provider: "did" }, stale, [])).state === "not_requested")

  check("declared + not yet enqueued + fresh ⇒ PENDING (do not mail the avatar track)",
    (await state(DECLARED, fresh, [])).state === "pending")
  check("declared + queued ⇒ PENDING",
    (await state(DECLARED, fresh, [{ render_status: "queued", output_url: null }])).state === "pending")
  check("declared + rendering ⇒ PENDING",
    (await state(DECLARED, fresh, [{ render_status: "rendering", output_url: null }])).state === "pending")
  check("declared + D-ID still in flight (no completed_at) ⇒ PENDING, never overdue",
    (await state(DECLARED, null, [])).state === "pending")

  const landed = await state(DECLARED, fresh, [{ render_status: "succeeded", output_url: "https://cdn/composite.mp4" }])
  check("succeeded + output URL ⇒ LANDED", landed.state === "landed")
  check("...and it hands back the COMPOSITE url, not the avatar track",
    landed.state === "landed" && landed.outputUrl === "https://cdn/composite.mp4")
  check("a retry leaves two rows — the SUCCEEDED one wins over a newer queued one",
    (await state(DECLARED, fresh, [
      { render_status: "queued", output_url: null },
      { render_status: "succeeded", output_url: "https://cdn/composite.mp4" },
    ])).state === "landed")

  // Every way the wait must END. A welcome that never arrives is worse than an
  // un-assembled one.
  for (const status of ["failed", "cancelled"]) {
    const v = await state(DECLARED, fresh, [{ render_status: status, output_url: null }])
    check(`CONTROL: a '${status}' render ⇒ ABANDONED — the D-ID cut ships rather than\n    the welcome silently never being sent`,
      v.state === "abandoned" && v.reason.length > 0, v.state)
  }
  check("CONTROL: 'cancelled' is what the content contract stamps on a REFUSED render,\n    so a contract refusal cannot strand the welcome email",
    (await state(DECLARED, fresh, [{ render_status: "cancelled", output_url: null }])).state === "abandoned")
  check("CONTROL: succeeded with NO output url ⇒ ABANDONED, not a silent stall",
    (await state(DECLARED, fresh, [{ render_status: "succeeded", output_url: null }])).state === "abandoned")
  check("CONTROL: never enqueued and overdue ⇒ ABANDONED (a refused insert cannot\n    park the welcome email forever)",
    (await state(DECLARED, stale, [])).state === "abandoned")
  check("CONTROL: stuck in 'queued' past the bound ⇒ ABANDONED",
    (await state(DECLARED, stale, [{ render_status: "queued", output_url: null }])).state === "abandoned")

  // supabase-js RESOLVES refusals (CLAUDE.md §3) — a refused read must never
  // read as "landed", and must not stall forever either.
  const refused = await state(DECLARED, fresh, [], { message: "permission denied" })
  check("a REFUSED render read fails closed — pending, not a shipped avatar track",
    refused.state === "pending")
  check("...and says the read was refused rather than swallowing it",
    refused.state === "pending" && /permission denied/.test(refused.reason), (refused as any).reason)
  check("...and still self-heals: a permanently refused read goes ABANDONED at the\n    bound, so a broken read cannot silence the welcome email forever",
    (await state(DECLARED, stale, [], { message: "permission denied" })).state === "abandoned")

  check("the declaration predicate is exact — a blank target is not a declaration",
    declaresAvatarComposition({ target_composition_id: "  " }) === false
    && declaresAvatarComposition({ target_composition_id: "AgentTalkingHeadReel" }) === true
    && declaresAvatarComposition(null) === false)
}

// ── Layer 5 ─────────────────────────────────────────────────────────────────
function layer5_wiring() {
  console.log("\n[Layer 5 · the wiring, read from STRIPPED source]")

  const reactor  = src("lib/video/intro-video-reactor.ts")
  const backfill = src("app/api/cron/intro-video-email-backfill/route.ts")
  const playable = src("lib/video/playable-video.ts")
  const poll     = src("app/api/cron/poll-did-videos/route.ts")
  const orch     = src("lib/video/avatar-render-orchestrator.ts")

  // THE MISSING LINK, restored.
  check("the intro reactor builds a composition request", reactor.includes("buildIntroCompositionRequest("))
  check("...and spreads it into provider_metadata, where the handoff reads it",
    /provider_metadata:\s*\{[\s\S]{0,600}?\.\.\.\(compositionRequest \?\? \{\}\)/.test(reactor))
  check("CONTROL: the matcher above still recognises the ORIGINAL defect — a\n    provider_metadata with no composition request reads as unwired",
    !/provider_metadata:\s*\{[\s\S]{0,600}?\.\.\.\(compositionRequest \?\? \{\}\)/.test(
      reactor.replace("...(compositionRequest ?? {})", "")))

  // The handoff's gate is the thing that used to skip.
  check("the handoff still gates on target_composition_id (this is what was skipping)",
    orch.includes("no target_composition_id — not a composition request"))

  // §6 — ONE spelling of "is a composite owed".
  check("poll-did-videos asks the shared predicate, not its own inline test",
    poll.includes("declaresAvatarComposition(video.provider_metadata)"))
  check("...and no inline target_composition_id test survives anywhere outside the\n    module that owns the key",
    !/target_composition_id\s*\)?\s*$/m.test(poll.split("\n").filter((l) => l.includes("hasPendingComposite")).join("\n"))
    && !poll.includes("!!(video.provider_metadata as any)?.target_composition_id"))
  check("CONTROL: that matcher can still see the inline form it replaced",
    "const x = !!(video.provider_metadata as any)?.target_composition_id"
      .includes("!!(video.provider_metadata as any)?.target_composition_id"))

  // THE EMBED — the reader must wait for the assembled cut.
  check("the welcome-email backfill resolves the composite state",
    backfill.includes("resolveAvatarCompositeState("))
  // ...and skips the tick while the assembly is pending.
  //
  // This was pinned to the inline spelling `composite.state === "pending" … continue`,
  // which both halves of this cron have since moved past: each now hands the
  // composite state to a PURE classifier and carries out its verdict, which is a
  // better shape and made the pinned assertion go red for the usual §2 reason —
  // because the work finished. The RULE is what is asserted now: the composite
  // state is fed to a decision function, and a 'wait' verdict ends the tick for
  // that row without any delivery happening.
  const feedsClassifier =
    /composite:\s*(state\.state|composite\?\.state)/.test(backfill) ||
    /composite,\s*$/m.test(backfill)
  check("...feeds the composite state into the delivery decision rather than acting\n    on the raw row",
    feedsClassifier && /classify[A-Za-z]*\(\{/.test(backfill))
  check("...and a 'wait' verdict ends the tick for that row — no send, no stamp",
    (backfill.match(/verdict\.action === "wait"[\s\S]{0,220}?continue/g) ?? []).length >= 2,
    String((backfill.match(/verdict\.action === "wait"[\s\S]{0,220}?continue/g) ?? []).length))
  check("CONTROL: the matcher still fails on a loop that ignores the verdict",
    !/verdict\.action === "wait"[\s\S]{0,220}?continue/.test(
      'const verdict = classifyX({}); await send()'))
  // ...and hands on the RESOLVED deliverable, not the raw row snapshot.
  //
  // This used to be pinned to `embedVideoInEmail(baseHtml, deliverableUrl)`,
  // which was the spelling from when this cron authored and sent its own mail.
  // It no longer writes client-facing copy at all — the welcome composer does —
  // so the rule is now "the composite's own output URL is preferred over the
  // project row's column", which is the same defect stated independently of who
  // renders the email.
  check("...and hands on the resolved deliverable, preferring the composite's own URL",
    /compositeUrl\s*\?\?\s*(\(?\s*)?r\.project(\?)?\.video_url/.test(backfill))
  check("CONTROL: the matcher still recognises the ORIGINAL defect — using\n    project.video_url on its own",
    !/compositeUrl\s*\?\?\s*(\(?\s*)?r\.project(\?)?\.video_url/.test(
      "const url = r.project.video_url"))
  check("...it reads the two columns the state machine needs",
    backfill.includes("provider_metadata") && backfill.includes("completed_at"))

  // THE PORTAL CARD — the same resolver every sender goes through.
  check("playable-video (the ONE resolver every sender uses) is composite-aware",
    playable.includes("resolveAvatarCompositeState("))
  check("...pending ⇒ in_progress, so no sender ships the un-assembled cut",
    /composite\.state === "pending"\) return \{ state: "in_progress"/.test(playable))
  check("...landed ⇒ the composite URL",
    /composite\.state === "landed" && composite\.outputUrl/.test(playable))
  check("the welcome/portal reader still reaches it through resolvePlayableVideo",
    src("lib/kernel/welcome-personal-video.ts").includes("resolvePlayableVideo("))

  // THE PRECONDITION IS NOT PAPERED OVER.
  check("the twin-studio precondition still REFUSES honestly — no stock face in a\n    'personal' welcome",
    reactor.includes("agent has no voice/avatar profile — Settings → Voice & Avatar"))
  check("...and the refusal is a hard return, not a fallback video",
    /agent voice\/avatar profile not configured/.test(reactor))
  check("CONTROL: no generic/stock avatar fallback was introduced",
    !/fallback[_ ]?avatar|stock[_ ]?avatar|DEFAULT_AVATAR/i.test(reactor))

  // THE ANNIVERSARY LANE IS NO LONGER EXEMPT.
  //
  // This used to assert the assembly was requested "for the ASSIGNMENT trigger
  // ONLY — the anniversary lane keeps its own (unwired) EquityReportReel
  // intent". That was a WAYPOINT, and CLAUDE.md §2 says not to pin to one: the
  // "own intent" was `AnniversaryEquityReelInput`, a type with no writer
  // anywhere in the tree and no reader in the reactor, so the exemption
  // preserved nothing and left the anniversary shipping the identical bare
  // talking head the welcome used to ship. The type is now a tombstone and the
  // trigger is passed through to the ONE builder.
  check("the assembly request is NOT gated on a single trigger any more",
    !/input\.trigger === "contact_agent_assigned"\)\s*\{[\s\S]{0,900}?buildIntroCompositionRequest/.test(reactor))
  check("...the trigger is threaded into the request so the chrome is chosen, not guessed",
    /buildIntroCompositionRequest\(/.test(reactor) && /trigger:\s*input\.trigger/.test(reactor))
  check("...and the orphaned equity-reel intent is gone, with a tombstone naming its survivor",
    !/AnniversaryEquityReelInput/.test(reactor)
    && raw("lib/video/intro-video-reactor.ts").includes("TOMBSTONE (orphan doctrine §1.3)")
    && raw("lib/video/intro-video-reactor.ts").includes("lib/video/video-director.ts"))
  check("CONTROL: that matcher still recognises the trigger gate it replaced",
    /input\.trigger === "contact_agent_assigned"\)\s*\{[\s\S]{0,900}?buildIntroCompositionRequest/.test(
      'if (input.trigger === "contact_agent_assigned") {\n  x = buildIntroCompositionRequest(p)\n}'))

  // ONE DRAFT PER ATTEMPT (§5 — the ledger feeds the invoice).
  const draftCalls = (reactor.match(/(?<!function\s)draftScript\(\s*\{/g) ?? []).length
  check("the reactor makes exactly ONE draftScript call site — the compliance loop's,\n    not a second one bought and discarded",
    draftCalls === 1, `${draftCalls} call sites`)
  check("CONTROL: the counter still sees a second call site when one is added",
    ((reactor + "\n  script = await draftScript({ violations: [] })").match(/(?<!function\s)draftScript\(\s*\{/g) ?? []).length === 2)

  // No second orchestrator (§6).
  const orchestratorFiles = ["lib/video/avatar-render-orchestrator.ts"]
  check("no second avatar→Remotion orchestrator was created — the existing handoff\n    is reused",
    orchestratorFiles.every((f) => raw(f).includes("enqueueAvatarCompositionForProject"))
    && !reactor.includes("remotion_composition_renders"),
    reactor.includes("remotion_composition_renders") ? "the reactor enqueues its own render" : "")
}

async function main() {
  console.log("══════════════════════════════════════════════════════════")
  console.log(" Welcome video assembly simulator (D-ID track → Remotion)")
  console.log("══════════════════════════════════════════════════════════")
  layer1_request()
  layer2_compliance()
  await layer3_cleanTrack()
  await layer4_compositeWait()
  layer5_wiring()
  console.log("\n──────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ The welcome video requests its Remotion assembly, the clean cut is the")
  console.log("    avatar track, and the email + portal wait for the assembled deliverable.")
}
main().catch((e) => { console.error(e); process.exit(1) })
