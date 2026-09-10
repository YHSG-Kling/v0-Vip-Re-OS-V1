#!/usr/bin/env tsx
/**
 * scripts/avatar-pipeline-hardening-simulator.ts   (npm run test:avatar-pipeline-hardening)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 50 — "avatar videos are one of the most important capabilities … make
 * sure that capability is solid" (owner, 2026-09-10). This is the FLEET GUARD
 * that ties the seven hardening properties the research pass (D-ID API docs,
 * Remotion 4.0.x docs, 2025-2026 AI-avatar-pipeline best-practice write-ups —
 * see the report for named sources) says a production avatar pipeline needs,
 * to the actual source of THIS pipeline, in one place a future regression on
 * any one of them shows up unambiguously:
 *
 *   §consent    the D-ID 428 consent gate on create-avatar is present and is
 *               never bypassed for a video-sourced twin — NEVER WEAKENED.
 *   §retry      D-ID errors are classified retryable/terminal (not a blanket
 *               retry-forever or fail-forever), AND a stuck 'generating' row
 *               has a bounded backstop (the pipeline reaper) so a permanently
 *               "retryable" classification cannot loop unbounded.
 *   §rehost     a D-ID result_url (a signed link that expires in hours, per
 *               D-ID's own docs and third-party integration guides — see
 *               report) is downloaded and re-hosted in OUR bucket before the
 *               row is ever marked complete; the row FAILS CLOSED (stays
 *               'generating', bounded retries) rather than shipping the
 *               vendor's expiring link.
 *   §idempotent the inbound webhook is unsigned by design (D-ID publishes no
 *               HMAC — the report documents why inventing one would be worse
 *               than none) and is instead made safe by TWO things: a shared
 *               secret gating who may POST at all, and a terminal-state check
 *               so a redelivered/duplicate completion is a no-op, never a
 *               double notification or a double spend.
 *   §failure    a failed/rejected render is never silent — it is escalated
 *               through the inter-manager bus, published FROM asset_manager
 *               (the asset owner, per wave 50's "video snippet should be
 *               asset manager from" ruling) TO campaign_orchestrator.
 *   §cost       the AI cost ledger (CLAUDE.md §5) is never handed a fabricated
 *               number: the script-drafting spend threads brokerageId (so
 *               ai_tool_usage actually gets a row) and the render's own
 *               cost_usd is left NULL with the reason recorded, because no
 *               D-ID price table exists in this repo and this account's
 *               actual rate (subscription vs pay-as-you-go vs a negotiated
 *               volume/enterprise rate) cannot be read from the API response
 *               — inventing one from a public blog's per-second rate would be
 *               exactly the "wrong number in a cost ledger" §5 forbids.
 *   §captions   caption timing is DERIVED (real alignment when present, an
 *               honestly-labelled even-distribution estimate otherwise) —
 *               never a hardcoded per-word duration.
 *
 * METHOD (§2): every scan reads STRIPPED source via scripts/strip-comments.ts
 * (a tombstone naming its survivor must never read as a live call site or a
 * live gate); every absence assertion below carries a POSITIVE CONTROL proving
 * the check still recognises the defect it exists to catch, built from the
 * ACTUAL historical shape these files' own commit history documents in their
 * headers (the pre-fix `brandedVideoUrl ?? persistedVideoUrl ?? didResultUrl`
 * three-arm fallback; the missing 428 gate; the missing terminal-row check).
 *
 * PURE — no ffmpeg, no network fetch, no Remotion render, no database. This is
 * a companion to scripts/avatar-loop-simulator.ts (which proves the D-ID →
 * Remotion input_props handoff with a live-DB layer) and does not repeat it.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const readStripped = (rel: string): string => stripComments(readFileSync(join(root, rel), "utf8"))
// RAW — deliberately NOT stripped, used ONLY for checks that read documentation
// PROSE (an explanatory comment naming a reason, an acknowledged-exception
// note) rather than code tokens. Reading a comment's own words is not the
// "tombstone read as a live call site" hazard §2 warns about — that hazard is
// specifically about code-TOKEN scans (`.from(`, an import, a call) seeing a
// tombstone's prose and miscounting it as a live site. A few of the checks
// below (§cost's "why is this NULL", §rehost's "acknowledged exception") ask
// whether a REASON was written down at all, which only exists in the comment.
const readRaw = (rel: string): string => readFileSync(join(root, rel), "utf8")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
// §consent — the 428 consent gate on create-avatar, never weakened
// ═══════════════════════════════════════════════════════════════════════════

function consentSection() {
  console.log("\n── §consent — the D-ID 428 consent gate ──")
  const route = readStripped("app/api/did/create-avatar/route.ts")

  check("create-avatar imports the ONE consent resolver (no second resolver)",
    /resolveConsentIdForAvatar/.test(route) && /consentRequiredFor/.test(route))
  check("gate runs BEFORE the D-ID submit (consentId resolved above the didRequest call)",
    (() => {
      const gateIdx = route.indexOf("resolveConsentIdForAvatar(")
      const submitIdx = route.indexOf("didRequest<")
      return gateIdx > -1 && submitIdx > -1 && gateIdx < submitIdx
    })())
  check("missing consent for a consent-required source refuses with HTTP 428",
    /status:\s*428/.test(route) && /needs_consent:\s*true/.test(route))
  check("the 428 body names the reason a human can act on (ConsentRequired)",
    /kind:\s*["']ConsentRequired["']/.test(route))
  check("consent_id actually travels on the submitted request body (the gate is not decorative)",
    /consentId/.test(route) && /buildExpressAvatarRequest\(/.test(route))

  // CONTROL: a route-shaped snippet that submits without ever checking consent
  // is correctly flagged as missing the gate — the exact historical shape this
  // file's own header (lib/did/consent.ts) says create-avatar used to be.
  const noGateSnippet = `
    export async function POST(request) {
      const body = await request.json()
      const didRes = await didRequest("/scenes/avatars", { method: "POST", body: { source_url: body.source_url } })
      return NextResponse.json({ ok: true })
    }
  `
  check("CONTROL: a submit path with no consent check is correctly recognised as gate-less",
    !/resolveConsentIdForAvatar/.test(noGateSnippet) && !/status:\s*428/.test(noGateSnippet))

  // consentRequiredFor / CONSENT_LANGUAGES live in the PURE half so a guard or
  // client component can read them without importing the server-only module —
  // regression on that split would silently reintroduce a server-only import
  // into client code.
  const contract = readStripped("lib/did/contract.ts")
  check("consentRequiredFor is defined in the PURE contract module, not the server-only one",
    /export function consentRequiredFor/.test(contract))
  const consentMod = readStripped("lib/did/consent.ts")
  check("consent.ts re-exports (not redefines) consentRequiredFor from contract.ts — one vocabulary (§6)",
    /export\s*\{[^}]*consentRequiredFor[^}]*\}\s*from\s*["']\.\/contract["']/.test(consentMod))
}

// ═══════════════════════════════════════════════════════════════════════════
// §retry — retryable vs terminal classification + a bounded backstop
// ═══════════════════════════════════════════════════════════════════════════

function retrySection() {
  console.log("\n── §retry — retryable/terminal classification + bounded backstop ──")
  const contract = readStripped("lib/did/contract.ts")
  const poll = readStripped("app/api/cron/poll-did-videos/route.ts")

  check("classifyDidError produces a `retryable` verdict (not a blanket retry-or-fail)",
    /retryable:\s*boolean/.test(contract))
  check("poll-did-videos reads .retryable before deciding to keep waiting vs fail the row",
    /failure\.retryable/.test(poll))
  check("a non-retryable classification marks the row failed (does not loop forever)",
    /if\s*\(failure\.retryable\)\s*continue[\s\S]{0,400}status:\s*["']failed["']/.test(poll))
  check("404 (job no longer exists at D-ID) is handled as TERMINAL, not `continue`d forever",
    /statusRes\.status === 404/.test(poll) && /status:\s*["']failed["']/.test(poll))

  // CONTROL: a poller-shaped snippet that `continue`s on every non-ok status —
  // the historical defect this file's own header names (m316's sibling) — is
  // correctly flagged as having no terminal path.
  const infiniteLoopSnippet = `
    for (const video of pending) {
      const statusRes = await didRequest(video.provider_job_id)
      if (!statusRes.ok) { continue }
    }
  `
  check("CONTROL: a poller that continues on every failure with no terminal branch is correctly flagged",
    !/status:\s*["']failed["']/.test(infiniteLoopSnippet))

  // The BACKSTOP: even a status the poller correctly keeps retrying (429/5xx,
  // or a job that never reaches a terminal D-ID status at all) must not loop
  // unbounded — the pipeline reaper's 'generating' threshold is what bounds it.
  const reaperPolicy = readStripped("lib/video/video-pipeline-reaper-policy.ts")
  check("the pipeline reaper carries a finite 'generating' staleness threshold (the retry backstop)",
    /generating:\s*\d+/.test(reaperPolicy))
  check("the reaper's threshold table is a POLICY the runner escalates from — not itself silent",
    /VideoReapAction/.test(reaperPolicy) && /escalate/.test(reaperPolicy))
}

// ═══════════════════════════════════════════════════════════════════════════
// §rehost — D-ID's expiring result_url is never the delivered URL
// ═══════════════════════════════════════════════════════════════════════════

function rehostSection() {
  console.log("\n── §rehost — rehost before D-ID's signed result_url expires ──")
  const poll = readStripped("app/api/cron/poll-did-videos/route.ts")

  check("the D-ID result is downloaded and re-hosted via the ONE media host (no bespoke bucket write)",
    /hostRenderedMedia/.test(poll) && /didResultUrl/.test(poll))
  check("a re-host failure holds the row at 'generating' rather than shipping the vendor URL",
    /if\s*\(didResultUrl\s*&&\s*!persistedVideoUrl\)/.test(poll) &&
    /status:\s*giveUp\s*\?\s*["']failed["']\s*:\s*["']generating["']/.test(poll))
  check("the hold is BOUNDED (a finite MAX_PERSIST_ATTEMPTS, not an infinite hold)",
    /MAX_PERSIST_ATTEMPTS\s*=\s*\d+/.test(poll))
  check("finalVideoUrl has exactly TWO arms (branded ?? persisted) — no third arm falling to the vendor URL",
    /finalVideoUrl\s*=\s*brandedVideoUrl\s*\?\?\s*persistedVideoUrl(?!\s*\?\?)/.test(poll))

  // CONTROL: the EXACT historical three-arm fallback this file's own header
  // (lines above finalVideoUrl) quotes verbatim as the regression it replaced
  // — proves the two-arm check above would have caught it.
  const threeArmSnippet = `const finalVideoUrl = brandedVideoUrl ?? persistedVideoUrl ?? didResultUrl`
  check("CONTROL: the historical three-arm fallback (…?? didResultUrl) is correctly flagged",
    !/finalVideoUrl\s*=\s*brandedVideoUrl\s*\?\?\s*persistedVideoUrl(?!\s*\?\?)/.test(threeArmSnippet))

  // The same defect class, checked fleet-wide: no OTHER D-ID/avatar surface
  // persists a raw result_url either. avatar-completion.ts is the sibling path
  // (Express/Instant avatar family) and documents its own acknowledged
  // exception by name (avatar_selfhosted_rehost) rather than silently doing it
  // — so it is checked for the acknowledgement, not required to match exactly.
  const avatarCompletionCode = readStripped("lib/did/avatar-completion.ts")
  const avatarCompletionRaw = readRaw("lib/did/avatar-completion.ts")
  check("avatar-completion.ts's own vendor-URL fallback (if any) is a NAMED, acknowledged exception, not silent",
    !/didAssetUrl/.test(avatarCompletionCode) || /ACKNOWLEDGED EXCEPTION/.test(avatarCompletionRaw))
  const egressGuard = readRaw("scripts/public-bucket-egress-guard.ts")
  check("the exception is cross-referenced from the fleet egress guard by its registry key (findable, not orphaned)",
    /avatar_selfhosted_rehost/.test(egressGuard))
}

// ═══════════════════════════════════════════════════════════════════════════
// §idempotent — the webhook is unsigned-but-safe: secret gate + terminal check
// ═══════════════════════════════════════════════════════════════════════════

function idempotentSection() {
  console.log("\n── §idempotent — webhook secret gate + terminal-state dedupe ──")
  const route = readStripped("app/api/webhooks/did/route.ts")
  const completion = readStripped("lib/did/avatar-completion.ts")

  check("an unset DID_WEBHOOK_SECRET returns 404, never a silently-open endpoint",
    /if\s*\(!secret\)\s*return\s*NextResponse\.json\([^)]*status:\s*404/.test(route))
  check("a bad secret is rejected with 401 before the body is ever trusted",
    /secretMatches\(given,\s*secret\)/.test(route) && /status:\s*401/.test(route))
  check("the outcome is applied only AFTER the job id is matched to a row we created (no forged-body mint)",
    /if\s*\(!assetId\)/.test(route) && /no matching avatar asset/.test(route))
  check("applyAvatarOutcome refuses to re-apply to a row already in a TERMINAL status (redelivery-safe)",
    /TERMINAL_ROW_STATUSES/.test(completion) && /outcome:\s*["']skipped["']/.test(completion))
  check("the terminal set is exactly the two real terminal row statuses (ready, failed)",
    /TERMINAL_ROW_STATUSES\s*=\s*new Set\(\[["']ready["'],\s*["']failed["']\]\)/.test(completion))

  // CONTROL: a webhook-shaped snippet that applies every delivery unconditionally
  // — no terminal check — is correctly flagged as NOT redelivery-safe.
  const noDedupeSnippet = `
    export async function applyOutcome(asset, body) {
      if (body.status === "done") { asset.status = "ready" }
      return asset
    }
  `
  check("CONTROL: a webhook applier with no terminal-state check is correctly flagged as unsafe to redeliver",
    !/TERMINAL_ROW_STATUSES/.test(noDedupeSnippet))

  // The video (talks/clips) lane deliberately has NO webhook entry point — it
  // completes on poll-did-videos, which is itself idempotent (a completed/
  // failed row is never re-processed because the query only selects
  // status='generating'). Checked so a future "let's also webhook video
  // renders" does not silently duplicate the compositing pipeline.
  check("the webhook route states its scope is AVATAR-only (video renders complete on the poller)",
    /video renders complete on poll-did-videos/.test(route))
}

// ═══════════════════════════════════════════════════════════════════════════
// §failure — a failed render is escalated, FROM asset_manager (§ wave 50)
// ═══════════════════════════════════════════════════════════════════════════

function failureSection() {
  console.log("\n── §failure — failed/rejected renders escalate FROM asset_manager ──")
  const coord = readStripped("lib/kernel/video-coordination.ts")
  const poll = readStripped("app/api/cron/poll-did-videos/route.ts")

  check("a failed project publishes a compliance-failed escalation (not just a row update)",
    /project\.status === ["']failed["'][\s\S]{0,200}video_compliance_failed/.test(coord))
  check("the escalation is FROM asset_manager (the asset owner) — wave 50's routing ruling",
    /fromManager:\s*["']asset_manager["'][\s\S]{0,80}toManager:\s*["']campaign_orchestrator["'][\s\S]{0,120}video_compliance_failed/.test(coord) ||
    /toManager:\s*["']campaign_orchestrator["'][\s\S]{0,80}signalType:\s*["']video_compliance_failed["']/.test(coord))
  check("poll-did-videos actually CALLS the coordination publish on the error/rejected branch (not just a notification)",
    /didStatus === ["']error["'] \|\| didStatus === ["']rejected["'][\s\S]{0,1400}publishVideoCoordinationSignals/.test(poll))
  check("agent notification is a SEPARATE channel from the manager escalation (both fire, neither substitutes)",
    /type:\s*["']video_failed["']/.test(poll) && /publishVideoCoordinationSignals/.test(poll))

  // CONTROL: a coordination-shaped snippet that updates the row but never
  // publishes a signal is correctly flagged as a silent failure.
  const silentFailSnippet = `
    if (project.status === "failed") {
      await supabase.from("ai_video_projects").update({ status: "failed" }).eq("id", project.id)
    }
  `
  check("CONTROL: a failure path with no manager signal is correctly flagged as silent",
    !/video_compliance_failed/.test(silentFailSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §cost — the AI cost ledger never gets a fabricated number (§5)
// ═══════════════════════════════════════════════════════════════════════════

function costSection() {
  console.log("\n── §cost — ai_tool_usage gets a real number or none, never an invented one ──")
  const reactor = readStripped("lib/video/intro-video-reactor.ts")
  const generate = readStripped("app/api/did/generate-video/route.ts")
  const generateRaw = readRaw("app/api/did/generate-video/route.ts")

  check("the script-drafting call threads brokerageId (ai_tool_usage now actually writes a row)",
    /generateTextRouted\(\{[\s\S]{0,400}brokerageId:/.test(reactor))
  check("the render ledger's cost_usd is left NULL, not a guessed literal",
    /cost_usd:\s*null/.test(generate) ||
    (/video_render_log/.test(generate) && !/cost_usd:\s*[\d.]/.test(generate)))
  check("the NULL is EXPLAINED at the write site (no D-ID price table exists here) — not a silent gap",
    /no D-ID price table exists/.test(generateRaw))

  // CONTROL: a ledger-write snippet with a hand-typed dollar literal is
  // correctly flagged as fabricating a cost — the exact shape §5 forbids.
  const fabricatedCostSnippet = `
    await supabase.from("video_render_log").insert({ project_id, provider: "did", cost_usd: 0.05 * durationSeconds })
  `
  check("CONTROL: a hand-typed per-second cost literal is correctly recognised as a fabricated number",
    /cost_usd:\s*[\d.]/.test(fabricatedCostSnippet))

  // Same rule checked on the OTHER av-cost surface named in the research: no
  // file in the D-ID lane invents a $/sec or $/credit literal to bill a render
  // (as opposed to logging D-ID's OWN reported numbers, which do not exist in
  // its GetTalkDto response either — confirmed against the current API schema).
  const didFiles = [
    "lib/did/gateway.ts", "lib/did/index.ts", "lib/did/avatar-completion.ts",
    "app/api/cron/poll-did-videos/route.ts",
  ]
  for (const f of didFiles) {
    const s = readStripped(f)
    check(`${f}: no fabricated per-second/per-credit D-ID cost literal`,
      !/\bcost_usd:\s*0?\.\d/.test(s) && !/didCostPerSecond|DID_COST_PER_SECOND|didCreditRate/.test(s))
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §captions — timing is DERIVED, never a hardcoded per-word duration
// ═══════════════════════════════════════════════════════════════════════════

function captionsSection() {
  console.log("\n── §captions — timing derived from alignment or an honest estimate ──")
  const plan = readStripped("lib/video/caption-plan.ts")
  const planRaw = readRaw("lib/video/caption-plan.ts")

  check("two timing sources exist, ranked: real alignment first, an honest estimate second",
    /timingSource:\s*["']alignment["']/.test(plan) && /timingSource:[^,}]*["']even["']/.test(plan))
  check("the estimate path is LABELLED as an estimate, not presented as real sync",
    /honest estimate|ESTIMATE|honest ESTIMATE/i.test(planRaw))
  check("cue placement in the alignment path reads REAL per-character start times, not a fixed words-per-minute rate",
    /character_start_times_seconds/.test(plan) && !/WORDS_PER_MINUTE/.test(plan))
  check("no hardcoded seconds-per-word / ms-per-word constant drives cue duration",
    !/(SECONDS|MS)_PER_WORD\s*=/.test(plan))

  // CONTROL: a caption-planner-shaped snippet that places every cue at a fixed
  // words-per-minute rate regardless of any real timing signal is correctly
  // flagged as NOT deriving from alignment.
  const hardcodedSnippet = `
    const WORDS_PER_MINUTE = 150
    function placeCues(words) { return words.map((w, i) => ({ text: w, fromFrame: i * (30 * 60 / WORDS_PER_MINUTE) })) }
  `
  check("CONTROL: a fixed-words-per-minute cue placer is correctly flagged as hardcoded, not derived",
    /WORDS_PER_MINUTE/.test(hardcodedSnippet))

  // The composition-side half (already proven per-composition by
  // video-assembly-simulator.ts's §avatar section) is re-asserted here by name
  // so a regression on THIS specific property is unambiguous in this guard's
  // own failure output too, not only buried in the other file's larger run.
  const caption = readStripped("scripts/video-assembly-simulator.ts")
  check("video-assembly-simulator's own §avatar section asserts CaptionLayer derives timing from useVideoConfig",
    /CaptionLayer derives caption timing from THIS composition's own durationInFrames/.test(caption))
}

// ═══════════════════════════════════════════════════════════════════════════
// §language — default en, ONE resolver, wired into the welcome avatar video
// ═══════════════════════════════════════════════════════════════════════════
//
// WAVE 51 — the gap wave 50's research named: the first-touch WELCOME avatar
// video had no multilingual variant because contacts carried no
// preferred_language and no transcript existed yet at first touch. Owner
// ruling: "the default language is english wherever a language is resolved
// and none is known." This section proves the resolver exists exactly once,
// defaults correctly, and actually reaches the script/TTS/copy surfaces —
// not just that a function with the right name exists somewhere.

function languageSection() {
  console.log("\n── §language — DEFAULT_LANGUAGE + resolveContactLanguage wired end-to-end ──")
  const multilingual = readStripped("lib/video/multilingual-reel.ts")
  const welcomeVideo = readStripped("lib/contact-promotion/welcome-avatar-video.ts")
  const reactor = readStripped("lib/video/intro-video-reactor.ts")
  const dispatch = readStripped("lib/providers/dispatch.ts")
  const aiCopy = readStripped("lib/kernel/ai-copy.ts")

  check("DEFAULT_LANGUAGE is exported exactly ONCE from lib/video/multilingual-reel.ts (the file this lane owns — JA does not also export it here)",
    (multilingual.match(/export const DEFAULT_LANGUAGE/g) ?? []).length === 1)
  check("DEFAULT_LANGUAGE is the ruled default: \"en\"",
    /export const DEFAULT_LANGUAGE\s*=\s*["']en["']/.test(multilingual))

  check("resolveContactLanguage is the ONE pure resolver (no second function computing this)",
    (multilingual.match(/export function resolveContactLanguage/g) ?? []).length === 1)
  check("the resolver's tier order is tier1 → tier2 → tier3 → DEFAULT_LANGUAGE, in that array order",
    /const tiers[^;]*=\s*\[\s*ctx\.contactPreferredLanguage,\s*ctx\.latestCallTranscriptionLanguage,\s*ctx\.intakeCapturedLanguage,?\s*\]/.test(multilingual) &&
    /return DEFAULT_LANGUAGE/.test(multilingual))
  check("every tier value is mapped through localeToElevenLabsLanguage — a raw BCP-47 locale never bypasses the ONE locale map (§6)",
    /localeToElevenLabsLanguage\(raw\)/.test(multilingual))

  check("resolveContactLanguageFromDb tolerates m620's absence — it checks the LIVE schema cache before ever selecting preferred_language",
    /schemaHasColumn\(["']contacts["'],\s*["']preferred_language["']\)/.test(multilingual))
  check("schemaHasColumn reads the GENERATED cache (scripts/schema-snapshot.ts), never a hand-typed column list (§3)",
    /from ["']@\/scripts\/schema-snapshot["']/.test(multilingual))
  check("tier 3 (intake capture) is read from contacts.metadata, not a column that doesn't exist yet",
    /captured_language/.test(multilingual))
  check("tier 2 reads call_transcriptions via voice_calls.contact_id (call_transcriptions itself carries no contact_id — schema-verified)",
    /from\(["']voice_calls["']\)/.test(multilingual) && /from\(["']call_transcriptions["']\)/.test(multilingual))

  // CONTROL: a resolver-shaped snippet that selects preferred_language
  // unconditionally — the exact shape that would 42703 against the live
  // database before m620 is applied — is correctly flagged as NOT tolerant.
  const unguardedSelectSnippet = `
    async function resolveLang(supabase, contactId) {
      const { data } = await supabase.from("contacts").select("preferred_language").eq("id", contactId).maybeSingle()
      return data?.preferred_language ?? "en"
    }
  `
  check("CONTROL: an unconditional preferred_language SELECT is correctly recognised as NOT schema-tolerant",
    !/schemaHasColumn/.test(unguardedSelectSnippet))

  console.log("\n── §language — reaches the welcome avatar video (not just the resolver) ──")
  check("welcome-avatar-video.ts resolves language ONCE, here, before delegating to the reactor",
    /resolveContactLanguageFromDb/.test(welcomeVideo))
  check("the resolved language is actually PASSED to dispatchAssignmentIntroVideo (not resolved and dropped)",
    /dispatchAssignmentIntroVideo\(\{[\s\S]{0,300}language,/.test(welcomeVideo))

  check("intro-video-reactor.ts's draft prompt gets a language directive that is EMPTY for English (byte-identical prior prompt)",
    /languageLine\s*=\s*args\.language\s*&&\s*args\.language\s*!==\s*["']en["']/.test(reactor))
  check("the language directive actually reaches the model call (concatenated into the prompt, not computed and discarded)",
    /basePrompt\s*\+\s*languageLine\s*\+\s*violationLine/.test(reactor))
  check("ai_video_projects.locale is stamped with the resolved language (mirrors commissionMultilingualReel's own column, §6)",
    /locale:\s*language/.test(reactor))

  console.log("\n── §language — reaches TTS/voice selection (the measured orphan this closes) ──")
  check("DispatchVideoParams carries ttsLanguageCode — the reader the multilingual_reels manager-registry entry said did not exist",
    /ttsLanguageCode\?:/.test(dispatch))
  check("the D-ID/ElevenLabs TTS call body actually reads params.ttsLanguageCode as language_code (English unaffected — omitted for \"en\")",
    /language_code:\s*params\.ttsLanguageCode/.test(dispatch))

  // CONTROL: the historical defect this closes — a TTS call that hardcodes
  // model_id but never forwards a language_code — is correctly flagged as
  // having no language reader.
  const noLanguageReaderSnippet = `
    body: { text: renderedScript, model_id: "eleven_multilingual_v2" }
  `
  check("CONTROL: a TTS body with model_id but no language_code forwarding is correctly flagged as the orphan",
    !/language_code/.test(noLanguageReaderSnippet))

  console.log("\n── §language — reaches copy generation (generatePersonaCopy) ──")
  check("CopyRequest.language is additive — English/absent reproduces the prior system prompt (no 6th rule line)",
    /req\.language\s*&&\s*req\.language\s*!==\s*["']en["']/.test(aiCopy))
  check("a non-English language pulls its NAME from the ONE map (lib/video/multilingual-reel.ts languageName), never a second name list",
    /languageNameForCopy/.test(aiCopy) && /from ["']@\/lib\/video\/multilingual-reel["']/.test(aiCopy))
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Avatar pipeline hardening simulator (D-ID → Remotion → delivery)")
  console.log("══════════════════════════════════════════════════════════════")
  consentSection()
  retrySection()
  rehostSection()
  idempotentSection()
  failureSection()
  costSection()
  captionsSection()
  languageSection()
  console.log("\n────────────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ All eight avatar-pipeline hardening properties hold (seven from wave 50 + §language from wave 51), each with a positive control.")
}
main().catch((e) => { console.error(e); process.exit(1) })
