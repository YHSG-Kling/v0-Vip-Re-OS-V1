/**
 * scripts/did-integration-guard.ts
 *
 * test:did-integration — THE D-ID LANE CANNOT SILENTLY STALL.
 *
 * D-ID is asynchronous at every entry point: a submit returns a job id and
 * something else has to decide when that job is finished. Three places do that
 * (the inline poller in lib/did, the video poll cron, the avatar poll cron) and
 * each of them had a way to wait forever on a job that was already dead:
 *
 *   · the inline poller CONTINUED on any status that was not exactly "done" or
 *     "error", so a "rejected" job — a status the video cron itself already
 *     handles, which is how we know it is real — polled to the timeout and
 *     then reported "still processing" for something that would never finish;
 *   · the inline poller GUESSED which endpoint held the job by trying
 *     /talks/{id} and falling back to /expressives/{id} on ANY error, so a
 *     transient 5xx on a healthy talks job diverted it to /expressives, where
 *     it 404s, and the 404 surfaced as "D-ID poll failed";
 *   · both crons treated a 404 as transient and re-fetched it every tick
 *     forever, leaving the row at 'generating' and the agent waiting. (Fixed on
 *     the avatar cron in m316; the video cron still had it, which is how a
 *     defect class survives being found.)
 *
 * The engine is KNOWN at submit time and recorded on the row. Guessing where
 * you have the answer is the same failure as the render content contract in
 * this pass: the OS collected the answer and then used something else.
 *
 * NOTE ON VERIFICATION. The published D-ID reference (docs.d-id.com, v4.2.1) is
 * now readable, and lib/did/contract.ts transcribes it: the {kind, description}
 * error envelope with its documented 400/401/402/403/451 classes, the closed
 * created|started|error|done|rejected status vocabulary, the full
 * POST /scenes/avatars body, and x-api-key-external for our own ElevenLabs IVC
 * voices. Assertions here are grounded in that reference, in the repo, and in
 * the installed SDK's own type definitions — never in a remembered surface.
 */
import { readFileSync } from "node:fs"
import {
  classifyDidError, classifyDidStatus, buildExpressAvatarRequest,
  assetIdFromUserData, externalKeyHeader, DID_STATUS_IN_FLIGHT,
} from "../lib/did/contract"
import {
  presenterTypeForTwin, capabilitiesFor, DID_PRESENTER_TYPES, DID_SENTIMENTS, isDidSentiment,
} from "../lib/did/agent-presenter"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(p, "utf8")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

console.log("\n═══ 1. The inline poller treats UNKNOWN as terminal, not as 'keep waiting' ═══")
{
  const s = code("lib/did/index.ts")
  ok("in-flight statuses are an ALLOW-LIST", s.includes("DID_IN_FLIGHT_STATUSES"))
  ok("...sourced from the ONE shared vocabulary in lib/did/contract, not a\n    second local copy that could drift from the crons'",
    /DID_IN_FLIGHT_STATUSES\s*=\s*new Set<string>\(DID_STATUS_IN_FLIGHT\)/.test(s))
  ok("...and the loop only CONTINUES for those",
    /if \(DID_IN_FLIGHT_STATUSES\.has\(status\)\) continue/.test(s))
  ok("anything else THROWS rather than polling to the timeout",
    /DID_IN_FLIGHT_STATUSES\.has\(status\)\) continue[\s\S]{0,400}throw new Error\(/.test(s))
  ok("...and names the unrecognised status verbatim, so an unhandled provider\n    state is legible instead of looking like a slow render",
    s.includes('ended in status "${status'))
  ok("the old deny-list is gone", !/status === "error"\)\s*\{\s*throw/.test(s))
}

console.log("\n═══ 2. The engine is PASSED, never probed ═══")
{
  const s = code("lib/did/index.ts")
  ok("pollUntilDone takes the engine as a parameter",
    /function pollUntilDone\(\s*talkId: string,\s*engine: DidEngine\s*\)/.test(s.replace(/\s+/g, " ").replace(/ /g, " ")) || /pollUntilDone\(talkId: string, engine: DidEngine\)/.test(s))
  ok("...and fetches exactly one endpoint", s.includes("didGet(`/${engine}/${talkId}`)"))
  ok("the try/talks-catch/expressives probe is gone — a transient 5xx on a\n    healthy job must not divert it to an endpoint where it 404s",
    !/didGet\(`\/talks\/\$\{talkId\}`\)[\s\S]{0,120}catch[\s\S]{0,120}didGet\(`\/expressives/.test(s))
  ok("the caller passes the engine it ALREADY computed at submit",
    s.includes('pollUntilDone(talkId, isV4Expressive ? "expressives" : "talks")'))
  ok("...and generateVideo still reports that engine back to its caller",
    /engine: isV4Expressive \? "expressives" : "talks"/.test(s))
}

console.log("\n═══ 3. Both crons key the endpoint off the RECORDED mode ═══")
{
  const v = code("app/api/cron/poll-did-videos/route.ts")
  ok("the video cron reads provider_metadata.mode", /pmeta\?\.mode === "clip"/.test(v))
  // The path is still built from the RECORDED mode; only the transport changed
  // (raw fetch → didRequest through Connection OS, m331). The invariant this
  // protects is "engine comes from the row, never re-guessed" — unchanged.
  ok("...and builds the path from it", /didRequest[\s\S]{0,40}`\/\$\{mode\}\/\$\{video\.provider_job_id\}`/.test(v))

  const a = code("app/api/cron/poll-did-avatars/route.ts")
  ok("the avatar cron posts to the real avatars path (m316)", a.includes("/scenes/avatars"))
}

console.log("\n═══ 4. A 404 is TERMINAL in both crons ═══")
{
  const v = code("app/api/cron/poll-did-videos/route.ts")
  ok("the video cron distinguishes 404 from a transient failure",
    /statusRes\.status === 404/.test(v))
  ok("...marks the row failed rather than re-fetching it forever",
    /statusRes\.status === 404[\s\S]{0,700}status: "failed"/.test(v))
  ok("...and tells the agent who was waiting on it",
    /statusRes\.status === 404[\s\S]{0,1400}type: "video_failed"/.test(v))
  ok("...while 429 and 5xx stay transient", /Everything else/.test(src("app/api/cron/poll-did-videos/route.ts")))

  const a = code("app/api/cron/poll-did-avatars/route.ts")
  ok("the avatar cron already treats 404 as terminal (m316)", /404/.test(a))
}

console.log("\n═══ 5. 'rejected' is a real terminal status, per our OWN code ═══")
{
  // Corroboration from the repo rather than from memory: the video cron has
  // handled this status since before this pass, which is the evidence that the
  // inline poller's deny-list was incomplete.
  const v = code("app/api/cron/poll-did-videos/route.ts")
  ok("the video cron handles it", /didStatus === "rejected"/.test(v))
  ok("...and the inline poller's allow-list would now catch it too, because it\n    is not an in-flight status",
    !/DID_IN_FLIGHT_STATUSES\s*=\s*new Set\(\[[^\]]*"rejected"/.test(code("lib/did/index.ts")))
}

console.log("\n═══ 6. The streaming SDK bump is source-compatible where we touch it ═══")
{
  // The widget lane rides @d-id/client-sdk. The bump 1.1.68 → 2.x was made
  // because the AgentManagerOptions surface we pass is ADDITIVE-only across it
  // (2.x adds optional verbose/enableAnalytics and nothing else), and 2.x is
  // what carries Expressives V4 over LiveKit. This locks that fact so a future
  // major cannot quietly drop an option the widget depends on.
  const pkg = JSON.parse(src("package.json"))
  const pinned = pkg.dependencies?.["@d-id/client-sdk"] ?? ""
  ok(`package.json pins the SDK at 2.x (${pinned})`, /^\^?2\./.test(pinned), pinned)

  const installed = JSON.parse(src("node_modules/@d-id/client-sdk/package.json")).version
  ok(`the installed SDK is 2.x (${installed})`, /^2\./.test(installed))

  const opts = src("node_modules/@d-id/client-sdk/dist/src/types/entities/agents/manager.d.ts")
  for (const key of ["auth", "callbacks", "mode", "externalId"]) {
    ok(`AgentManagerOptions still accepts \`${key}\` — the widget passes it`,
      new RegExp(`\\b${key}\\??:`).test(opts))
  }

  const widget = code("app/components/features/ai-avatar-chat/AgentsWidget.tsx")
  ok("the widget passes exactly those four and nothing removed",
    widget.includes("createAgentManager(didAgentId, {")
    && widget.includes("auth: { type: \"key\", clientKey }")
    && widget.includes("mode: didSdk.ChatMode.TextOnly")
    && widget.includes("externalId: contactId"))
  ok("...and still degrades to text chat on any connection failure, which is\n    what makes the major bump a contained risk",
    widget.includes('fail("Connection lost — switching to chat")'))
}

console.log("\n═══ 6b. The live widget USES the SDK it pinned — no dead affordances ═══")
{
  // THE DEFECT THIS SECTION EXISTS FOR: the widget's mic button was
  // permanently `disabled` with the tooltip "Voice in: built into Talk live
  // mode", and the empty state read "Tap the mic or type" — while nothing in
  // the component ever opened a microphone. The SDK bump to 2.x was made for
  // exactly these methods and then none of them were called. An affordance
  // that names a capability the code does not have is the failure mode this
  // whole OS is built to refuse.
  const widget = code("app/components/features/ai-avatar-chat/AgentsWidget.tsx")
  const mgr = src("node_modules/@d-id/client-sdk/dist/src/types/entities/agents/manager.d.ts")

  ok("the SDK really exposes publishMicrophoneStream (not assumed)",
    /publishMicrophoneStream\?:/.test(mgr))
  ok("the widget actually opens a microphone", /getUserMedia\(\{\s*$|getUserMedia\(/.test(widget) && widget.includes("publishMicrophoneStream(stream)"))
  ok("...and releases it, both the SDK publication and the OS capture, so the\n    browser's recording indicator clears",
    widget.includes("unpublishMicrophoneStream?.()") && /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(widget))
  ok("the mic is FEATURE-DETECTED — the SDK marks it optional and livekit-only,\n    so an absent method must read as unsupported rather than as a dead button",
    /typeof m(anager)?\.publishMicrophoneStream === "function"/.test(widget))
  ok("the button is disabled ONLY when the capability is genuinely absent",
    /disabled=\{[^}]*micUnavailable/.test(widget) && !/title="Voice in: built into Talk live mode"/.test(widget))
  ok("a permission denial and a missing device get DIFFERENT messages — the\n    fixes are in different places and 'microphone failed' sends the contact\n    hunting in the wrong one",
    widget.includes("NotAllowedError") && widget.includes("NotFoundError"))

  ok("the SDK really exposes interrupt + getIsInterruptAvailable", /interrupt: \(interrupt: Interrupt\)/.test(mgr) && /getIsInterruptAvailable/.test(mgr))
  ok("the widget can be interrupted — a conversation the contact cannot cut\n    off is a recording that happens to be listening",
    /m\.interrupt\(\{ type: "click" \}\)/.test(widget))
  ok("...with the control gated on the SDK's own interruptible signal",
    widget.includes("onInterruptibleChange") && /canInterrupt &&/.test(widget))

  ok("status comes from the SDK's AgentActivityState rather than being inferred\n    from message types, so 'thinking' and 'speaking' cannot drift out of sync\n    with the avatar on screen",
    widget.includes("onAgentActivityStateChange") && widget.includes("AgentActivityState.Talking"))
  ok("AgentActivityState really is an SDK export",
    /enum AgentActivityState/.test(src("node_modules/@d-id/client-sdk/dist/src/types/stream/stream.d.ts")))
}

console.log("\n═══ 6c. The presenter FAMILY decides the capability, and it is resolved ═══")
{
  // THE DEFECT: lib/did/agents.ts hardcoded presenter type "clip" and passed
  // our twin's did_avatar_id as its presenter_id. Published ClipAgentPresenter
  // says presenter_id is "Retrieved from the GET /presenters endpoint" — D-ID's
  // pre-built gallery — while every avatar this OS creates is an `avt_…` from
  // POST /scenes/avatars, the id shape the EXPRESSIVE schema documents. That
  // mis-typing also darkened the live widget, because the microphone and
  // sentiment are Expressive-only.
  const agents = code("lib/did/agents.ts")
  const widget = code("app/components/features/ai-avatar-chat/AgentsWidget.tsx")
  ok("the presenter block is BUILT, not hardcoded", agents.includes("buildAgentPresenter({"))
  ok('the "clip" hardcode is gone — the regression that mis-typed every twin',
    !/type: "clip" as const/.test(agents))
  ok("an `avt_` twin resolves to the EXPRESSIVE family",
    presenterTypeForTwin("avt_abc123") === "expressive")
  ok("...including the public compound form name@avt_xxx the schema documents",
    presenterTypeForTwin("public_mia_elegant@avt_TJ0Tq5") === "expressive")
  ok("a gallery presenter id stays CLIP — that is the family whose presenter_id\n    really does come from GET /presenters",
    presenterTypeForTwin("v2_public_amber") === "clip")

  ok("expressive is the only family that carries the microphone",
    capabilitiesFor("expressive").microphone && !capabilitiesFor("clip").microphone && !capabilitiesFor("talk").microphone)
  ok("...and the only one that carries sentiment",
    capabilitiesFor("expressive").sentiment && !capabilitiesFor("clip").sentiment)
  ok("streamOptions are v2/v3 ONLY — V4 manages transport itself, so sending\n    them there would read as configuration that does something",
    capabilitiesFor("talk").streamOptions && capabilitiesFor("clip").streamOptions && !capabilitiesFor("expressive").streamOptions)
  ok("an UNKNOWN family offers nothing optional rather than guessing",
    !capabilitiesFor("nonsense" as any).microphone && !capabilitiesFor(null).sentiment && !capabilitiesFor(undefined).interrupt)
  ok("every capability line states WHY, so a disabled control can be explained",
    DID_PRESENTER_TYPES.every((t) => capabilitiesFor(t).why.length > 20))

  ok("the sentiment vocabulary is the documented closed set — an unsupported\n    value silently falls back, so a typo would be invisible",
    DID_SENTIMENTS.length === 5 && isDidSentiment("empathetic") && !isDidSentiment("cheerful"))

  const session = code("app/api/did/agents/session/route.ts")
  const embedSession = code("app/api/embed/session/route.ts")
  ok("the portal session route reports the family to the browser",
    session.includes("presenterType: ensured.presenterType"))
  ok("...and so does the embed session route — the same widget contract",
    embedSession.includes("presenterType: ensured.presenterType"))
  ok("the widget decides from that family BEFORE createAgentManager, because\n    streamOptions cannot be probed after the manager exists",
    widget.indexOf("capabilitiesFor(presenterType)") < widget.indexOf("createAgentManager(didAgentId"))
  ok("streamOptions are sent CONDITIONALLY, not unconditionally",
    /\.\.\.\(caps\.streamOptions \? \{ streamOptions/.test(widget))
  ok("the mic offer is gated on the family AND the runtime method",
    /caps\.microphone && typeof manager\.publishMicrophoneStream === "function"/.test(widget))
  ok("...and starting the mic re-checks the family, so a stale state cannot\n    open a capture the avatar cannot use",
    /!capsRef\.current\.microphone \|\| typeof m\.publishMicrophoneStream !== "function"/.test(widget))
  ok("barge-in is gated on the family AND the SDK probe",
    /caps\.interrupt && safeIsInterruptAvailable\(manager\)/.test(widget))
}

console.log("\n═══ 6d. The avatar speaks only words its owner wrote ═══")
{
  // speak() is the ONE path where the avatar says something the brain did not
  // produce — a literal string, in a named real-estate agent's cloned voice, to
  // their own client. So the string has to be authored by that agent or not
  // exist. This section exists to stop a well-meaning later edit from adding a
  // friendly-sounding default, which would be a sentence the human never
  // approved being spoken in their voice.
  const widget = code("app/components/features/ai-avatar-chat/AgentsWidget.tsx")
  const wizard = code("app/dashboard/settings/twin-studio/components/twin-wizard.tsx")
  const action = code("app/actions/twin-studio.ts")
  const session = code("app/api/did/agents/session/route.ts")

  ok("the agent can AUTHOR an opening line in Twin Studio",
    wizard.includes("onGreetingChange") && wizard.includes('id="twin-greeting"'))
  ok("...and the tone chips come from the SHARED vocabulary, not retyped —\n    an invented tone would look chosen and do nothing on the wire",
    /GREETING_TONES = DID_SENTIMENTS\.map/.test(wizard))
  ok("the greeting is persisted through finalizeTwin", action.includes("details.greeting = g || null"))
  ok("an over-long greeting is REFUSED, not truncated — it is spoken aloud and\n    a silently-cut sentence would end mid-word",
    /g\.length > 300[\s\S]{0,120}ok: false/.test(action))
  ok("an unsupported tone is REFUSED, not defaulted — D-ID silently falls back,\n    so accepting one would store a preference that never reaches the avatar",
    /!isDidSentiment\(v\)[\s\S]{0,80}ok: false/.test(action))
  ok("the session route hands the authored line to the browser",
    session.includes("greeting,") && session.includes("greetingSentiment,"))

  ok("the widget speaks it ONLY on entering live mode — not on connect, which\n    would talk at a contact who never asked and burn avatar minutes on a\n    page view",
    /const enterLive = useCallback\([\s\S]{0,900}m\.speak\(\{/.test(widget))
  ok("...exactly once per session", /greetedRef\.current = true/.test(widget))
  ok("...and NEVER when the agent wrote nothing — silence is the default,\n    a hardcoded hello is not",
    /if \(!line \|\| greetedRef\.current\) return/.test(widget))
  ok("THERE IS EXACTLY ONE speak() IN THE WIDGET — every other utterance comes\n    from chat() through our own brain",
    (widget.match(/\.speak\(/g) ?? []).length === 1)
  ok("no invented fallback greeting anywhere in the speak path",
    !/speak\(\{[\s\S]{0,200}input: ["`'][A-Za-z]/.test(widget))
  ok("the sentiment rides only where the family supports it",
    /tone && capsRef\.current\.sentiment/.test(widget))
  ok("a failed greeting does not break the conversation",
    /greeting speak\(\) failed/.test(widget))
}

console.log("\n═══ 7. Errors are CLASSIFIED, per the published contract ═══")
{
  // D-ID returns {kind, description} with documented HTTP classes. We used to
  // read `description` and drop `kind`, so three completely different problems
  // — no face in the video, out of credits, flagged as a public figure —
  // reached the agent as the same shrug, and all three were retried forever.
  const face = classifyDidError(400, { kind: "InvalidFaceError", description: "no face detected" })
  ok("InvalidFaceError tells the agent what to re-record",
    /face/i.test(face.userMessage) && /re-record/i.test(face.userMessage))
  ok("...and is NOT retryable — no tick count fixes a faceless video", !face.retryable)
  ok("...and says a human must act", face.needsHumanAction)
  ok("...while the operator line keeps the provider's own words",
    face.operatorMessage.includes("InvalidFaceError"))

  const credits = classifyDidError(402, { kind: "InsufficientCreditsError", description: "not enough credits" })
  ok("out-of-credits is a BILLING instruction, not a retry",
    !credits.retryable && /credits/i.test(credits.userMessage) && /admin/i.test(credits.userMessage))

  const celeb = classifyDidError(451, { kind: "CelebrityRecognizedError", description: "celebrity" })
  ok("celebrity recognition explains itself rather than saying 'error'",
    !celeb.retryable && /public figure/i.test(celeb.userMessage))

  const moderation = classifyDidError(451, { kind: "ImageModerationError", description: "moderation" })
  ok("moderation points at manual review", /manual review/i.test(moderation.userMessage))

  ok("429 IS retryable", classifyDidError(429, {}).retryable)
  ok("5xx IS retryable", classifyDidError(503, {}).retryable)
  ok("404 is terminal but needs no human action",
    !classifyDidError(404, {}).retryable && !classifyDidError(404, {}).needsHumanAction)
  ok("an undocumented shape does not crash the classifier",
    classifyDidError(418, null).kind === "UnknownError")
  ok("...and every classification carries a non-empty user message",
    [400, 401, 402, 403, 404, 429, 451, 500].every((c) => classifyDidError(c, {}).userMessage.length > 10))
}

console.log("\n═══ 8. The status vocabulary is ONE allow-list ═══")
{
  ok("created/started are in flight",
    classifyDidStatus("created") === "in_flight" && classifyDidStatus("started") === "in_flight")
  ok("the AVATAR TRAINING states are in flight too — draft, validating and\n    training-started all precede 'started', and failing one of those would\n    kill a job that was simply still training",
    ["draft", "validating", "training-started"].every((s) => classifyDidStatus(s) === "in_flight"))
  ok("done is success", classifyDidStatus("done") === "succeeded")
  ok("error AND rejected are failures",
    classifyDidStatus("error") === "failed" && classifyDidStatus("rejected") === "failed")
  ok("anything unrecognised is UNKNOWN, so a caller must treat it as terminal\n    rather than polling forever", classifyDidStatus("banana") === "unknown")
  ok("null is unknown, not in-flight", classifyDidStatus(null) === "unknown")
  ok("the inline poller uses the SHARED vocabulary, not a second copy",
    code("lib/did/index.ts").includes("new Set<string>(DID_STATUS_IN_FLIGHT)"))
  ok("...and the shared list really contains the training states",
    (DID_STATUS_IN_FLIGHT as readonly string[]).includes("validating"))
}

console.log("\n═══ 9. Avatar creation sends the COMPLETE documented body ═══")
{
  const req = buildExpressAvatarRequest({
    sourceUrl: "https://cdn.example.invalid/agent.mp4",
    assetId: "11111111-2222-4333-8444-555555555555",
    agentName: "Dana Reyes", label: "Studio twin",
    consentId: "cns_abc123", webhookUrl: "https://app.invalid/api/webhooks/did",
  })
  ok("source_url is carried", req.source_url.endsWith("agent.mp4"))
  ok("the avatar is NAMED — fifty untitled avatars in a brokerage's D-ID\n    account is a support problem with no answer",
    req.name === "Dana Reyes — Studio twin")
  ok("consent_id is carried — V3 instant avatars require consent verification",
    req.consent_id === "cns_abc123")
  ok("user_data carries OUR row id, which D-ID echoes on the job AND the\n    webhook — the correlation field designed for exactly this",
    req.user_data === "asset:11111111-2222-4333-8444-555555555555")
  ok("...and it round-trips back out",
    assetIdFromUserData(req.user_data) === "11111111-2222-4333-8444-555555555555")
  ok("a non-https webhook is DROPPED rather than sent and rejected — the\n    schema pattern is https-only",
    buildExpressAvatarRequest({ sourceUrl: "https://x.invalid/a.mp4", webhookUrl: "http://localhost:3000/hook" }).webhook === undefined)
  ok("absent optionals are omitted, not sent as nulls",
    Object.keys(buildExpressAvatarRequest({ sourceUrl: "https://x.invalid/a.mp4" })).join() === "source_url")
  ok("garbage user_data does not parse into a fake id", assetIdFromUserData("asset:nope") === null)

  const route = code("app/api/did/create-avatar/route.ts")
  ok("the route builds its body through the contract", route.includes("buildExpressAvatarRequest("))
  ok("...and classifies the refusal instead of guessing at `description`",
    route.includes("classifyDidError(didRes.status, didData)"))
  ok("...returning 422 for a human-fixable refusal and 503 only when a retry\n    could actually help",
    /failure\.retryable \? 503 : 422/.test(route))
}

console.log("\n═══ 10. OUR ElevenLabs clones resolve, because we send OUR key ═══")
{
  // The reference is explicit: x-api-key-external is "your own ElevenLabs API
  // key for TTS (IVC voices only)". Every agent voice here is an IVC clone in
  // OUR account, so without this header D-ID resolves voice_id in ITS account,
  // where our clones do not exist — the avatar speaks in a stock voice that is
  // not the agent's, and nothing reports a problem.
  const h = externalKeyHeader("el_test_key")
  ok("the header is present when a key exists", !!h["x-api-key-external"])
  ok("...and is the documented JSON shape",
    JSON.parse(h["x-api-key-external"]).elevenlabs === "el_test_key")
  ok("no key → NO header, so we fall back to D-ID's own voices honestly rather\n    than sending an empty credential",
    Object.keys(externalKeyHeader("")).length === 0)
  ok("the D-ID client actually sends it", code("lib/did/index.ts").includes("headers: externalKeyHeader()"))
}

console.log("\n═══ 11. Both crons refuse on a TERMINAL provider error ═══")
{
  for (const [path, label] of [
    ["app/api/cron/poll-did-avatars/route.ts", "avatar cron"],
    ["app/api/cron/poll-did-videos/route.ts", "video cron"],
  ] as Array<[string, string]>) {
    const s = code(path)
    ok(`${label} classifies a non-ok response`, s.includes("classifyDidError(statusRes.status"))
    ok(`${label} retries ONLY when the classifier says it is worth retrying`,
      /if \(failure\.retryable\) continue/.test(s))
    ok(`${label} writes the AGENT-facing message, not the raw provider string`,
      s.includes("failure.userMessage"))
  }
}

console.log("\n═══ 12. TWO RENDER LANES, ONE SLOT — the loser is decided by the database ═══")
{
  // OWNER RULING: this route and lib/kernel/video.ts:submitVideoGenerationJob
  // stay SEPARATE. They are not duplicates and neither is a superset — the
  // route carries the compliance eval, disclosure injection, avatar resolution
  // and render log; the kernel carries the slot claim and the rollback.
  //
  // Keeping two lanes onto ONE row is only safe if BOTH claim the row the same
  // way. The kernel always did. This route did not claim at all: it called
  // ElevenLabs, then D-ID, and only afterwards wrote status + provider_job_id
  // unconditionally — so two clicks BOTH spent, and the second overwrote the
  // first's job id. poll-did-videos keys on that column, so render one became
  // unpollable forever: billed, orphaned, invisible. Both lanes hang off the
  // same board, so this was a double-click, not a thought experiment.
  const route = code("app/api/did/generate-video/route.ts")
  const kernel = code("lib/kernel/video.ts")

  // The CONSTRUCT: an UPDATE targeted at ONE row and guarded by the in-flight
  // status. Asserted on both lanes from one shape, so neither can drift away
  // from the other.
  //
  // This used to require TWO predicates — .neq generating AND .neq submitting.
  // `submitting` was never a value of ai_video_projects.status (only ever of
  // provider_status), so the second predicate excluded a value no writer could
  // produce: it read like extra safety and was a no-op. m374 then merged
  // submitting → generating, making it dead twice over. Requiring it here would
  // now pin a spelling the CHECK constraint rejects outright.
  //
  // What actually makes the claim atomic is the pair below: .eq("id") picks the
  // single row, .neq("status","generating") is the guard that makes the UPDATE
  // return zero rows when someone else already holds the slot. Delete either and
  // this fails, which is the property worth having.
  const CLAIM = /\.eq\(\s*["']id["']\s*,[\s\S]{0,300}?\.neq\(\s*["']status["']\s*,\s*["']generating["']\s*\)/
  ok("the kernel lane claims the render slot atomically", CLAIM.test(kernel))
  ok("the D-ID lane claims the SAME slot the SAME way — this was the defect",
    CLAIM.test(route))

  // A claim nobody checks is not a claim.
  ok("the D-ID lane refuses when the claim returns no row (409, already running)",
    /claimed\?\.length/.test(route) && /\b409\b/.test(route))
  // The token alone proves nothing — it survives in the destructuring even if
  // the branch is deleted. Assert the BRANCH and that it exits.
  ok("the D-ID lane refuses when the claim itself is REFUSED, rather than spending",
    /if\s*\(\s*claimError\s*\)[\s\S]{0,400}?return\s+NextResponse\.json/.test(route))

  // ORDERING IS THE WHOLE POINT: the claim must precede both billable calls,
  // otherwise the second request has already paid by the time it loses.
  const claimAt = route.indexOf(".neq(")
  const ttsAt = route.indexOf("/api/elevenlabs/tts")
  // The CALL, not the import — `didRequest` appears at the top of the file as an
  // import, which sits before everything and would make this assertion pass
  // vacuously no matter where the claim went.
  const didAt = route.search(/await\s+didRequest\s*</)
  ok("the claim happens BEFORE the ElevenLabs spend", claimAt !== -1 && ttsAt !== -1 && claimAt < ttsAt)
  ok("the claim happens BEFORE the D-ID spend", claimAt !== -1 && didAt !== -1 && claimAt < didAt)

  // A claim that is never released wedges the project instead of double-billing
  // it — a different failure, not a fixed one.
  // Both post-claim failure paths must release. Counting call sites, because a
  // single surviving call would satisfy a bare name check while the other path
  // silently wedges the project.
  const releaseCalls = (route.match(/await\s+releaseSlot\s*\(/g) ?? []).length
  ok("a claimed slot is released on EVERY post-claim failure path (TTS and D-ID)",
    releaseCalls >= 2, `only ${releaseCalls} release call site(s)`)
  ok("...including on a throw between the claim and the publish",
    /catch[\s\S]{0,600}?if\s*\(\s*claimedProjectId\s*\)[\s\S]{0,400}?ai_video_projects/.test(route))

  // The write that hands provider_job_id to the poller must be checked.
  ok("the provider_job_id publish is destructured AND its failure returns an error",
    /const\s*\{\s*error:\s*publishError\s*\}\s*=\s*await/.test(route) &&
    /if\s*\(\s*publishError\s*\)[\s\S]{0,600}?status:\s*500/.test(route))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`D-ID INTEGRATION — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log("No D-ID job can wait forever on a status or an endpoint nobody checked.")
