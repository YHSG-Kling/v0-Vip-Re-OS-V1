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
import { avatarDurationOverrunSeconds } from "../lib/video/script-structure"

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

  // Wave 52: DEFAULT_LANGUAGE is DEFINED once in lib/video/language-vocabulary.ts (pure,
  // zero imports — a "use client" selector may import it) and RE-EXPORTED by
  // multilingual-reel.ts; the definition count is asserted across BOTH files.
  const vocabulary = readStripped("lib/video/language-vocabulary.ts")
  check("DEFAULT_LANGUAGE is defined exactly ONCE across the vocabulary module and multilingual-reel.ts",
    (vocabulary.match(/export const DEFAULT_LANGUAGE/g) ?? []).length === 1 &&
    (multilingual.match(/export const DEFAULT_LANGUAGE/g) ?? []).length === 0 &&
    /export \{[^}]*DEFAULT_LANGUAGE[^}]*\} from ["']@\/lib\/video\/language-vocabulary["']/.test(multilingual))
  check("DEFAULT_LANGUAGE is the ruled default: \"en\"",
    /export const DEFAULT_LANGUAGE\s*=\s*["']en["']/.test(vocabulary))

  check("resolveContactLanguage is the ONE pure resolver (no second function computing this)",
    (multilingual.match(/export function resolveContactLanguage/g) ?? []).length === 1)
  check("the resolver's tier order is tier1 → tier2 → tier3 → DEFAULT_LANGUAGE, in that array order",
    /const tiers[^;]*=\s*\[\s*ctx\.contactPreferredLanguage,\s*ctx\.latestCallTranscriptionLanguage,\s*ctx\.intakeCapturedLanguage,?\s*\]/.test(multilingual) &&
    /return DEFAULT_LANGUAGE/.test(multilingual))
  check("every tier value is mapped through localeToElevenLabsLanguage — a raw BCP-47 locale never bypasses the ONE locale map (§6)",
    /localeToElevenLabsLanguage\(raw\)/.test(multilingual))

  check("resolveContactLanguageFromDb tolerates m620's absence — it checks the LIVE schema cache before ever selecting preferred_language",
    /schemaHasColumn\(["']contacts["'],\s*["']preferred_language["']\)/.test(multilingual))
  check("schemaHasColumn reads the GENERATED cache (scripts/schema-snapshot.ts), never a hand-typed column list (§3) — LAZY import (wave 52: kept out of module scope so client bundles importing this file's pure helpers never inline the ~180KB cache)",
    /import\(["']@\/scripts\/schema-snapshot["']\)/.test(multilingual))
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
  // WAVE 52 CORRECTED THIS ASSERTION (§2 — "a count that moves is the finding").
  // It used to require `language_code: params.ttsLanguageCode` verbatim in the
  // D-ID/ElevenLabs TTS body. Exa research against ElevenLabs' own API
  // reference (recorded in lib/voice/elevenlabs-tts.ts's file header) found
  // that was WRONG: ElevenLabs enforces `language_code` on Turbo v2.5/Flash
  // v2.5 ONLY — the plain /convert endpoint this call hits 400s if you send it
  // with `eleven_multilingual_v2` (the model this call hardcodes), so the
  // former "wired" state was a LATENT BUG that would have broken every
  // non-English avatar video the moment a contact actually had a resolved
  // language. The fix removes the forward entirely and relies on the
  // translated text's own auto-detection — so the assertion now proves the
  // ABSENCE, with the same rationale recorded in the source as its positive
  // control.
  check("the D-ID/ElevenLabs TTS call body does NOT forward language_code to eleven_multilingual_v2 (ElevenLabs 400s on that combination — see the file's own header finding)",
    !/language_code:\s*params\.ttsLanguageCode/.test(dispatch) &&
    /DELIBERATELY NEVER sent here/.test(readRaw("lib/providers/dispatch.ts")))
  check("ttsLanguageCode stays a documented field on DispatchVideoParams (informational / future use), not silently deleted",
    /ttsLanguageCode\?:\s*string \| null/.test(dispatch))

  // CONTROL: the historical defect this closes — a TTS call that hardcodes
  // model_id but never forwards a language_code — is correctly flagged as
  // having no language reader.
  const noLanguageReaderSnippet = `
    body: { text: renderedScript, model_id: "eleven_multilingual_v2" }
  `
  check("CONTROL: a TTS body with model_id but no language_code forwarding is correctly flagged as the orphan",
    !/language_code/.test(noLanguageReaderSnippet))

  // CONTROL, the other direction: a TTS body that DOES forward language_code
  // to eleven_multilingual_v2 is correctly flagged as the wave-52 defect this
  // section now refuses — proves the new absence-assertion isn't just always
  // true, it recognises the exact pre-fix shape as broken.
  const reintroducedDefectSnippet = `
    body: { text: renderedScript, model_id: "eleven_multilingual_v2", language_code: params.ttsLanguageCode }
  `
  check("CONTROL: re-introducing language_code: params.ttsLanguageCode is correctly flagged as the regression",
    /language_code:\s*params\.ttsLanguageCode/.test(reintroducedDefectSnippet))

  console.log("\n── §language — reaches copy generation (generatePersonaCopy) ──")
  check("CopyRequest.language is additive — English/absent reproduces the prior system prompt (no 6th rule line)",
    /req\.language\s*&&\s*req\.language\s*!==\s*["']en["']/.test(aiCopy))
  check("a non-English language pulls its NAME from the ONE map (lib/video/multilingual-reel.ts languageName), never a second name list",
    /languageNameForCopy/.test(aiCopy) && /from ["']@\/lib\/video\/multilingual-reel["']/.test(aiCopy))
}

// ═══════════════════════════════════════════════════════════════════════════
// §research — wave 52 Exa finding: language_code is model-gated, not universal
// ═══════════════════════════════════════════════════════════════════════════
//
// Proves the shared primitive (lib/voice/elevenlabs-tts.ts) carries the
// language-enforcement allowlist and actually applies it at all THREE call
// sites (convert, convert-with-timestamps, stream) — not just documented in
// the header while the code still sends the param unconditionally.

function researchSection() {
  console.log("\n── §research — ElevenLabs language_code is sent ONLY to enforcement-capable models ──")
  const tts = readStripped("lib/voice/elevenlabs-tts.ts")

  check("LANGUAGE_ENFORCEMENT_MODELS is defined as a Set (one place, §6)",
    (tts.match(/const LANGUAGE_ENFORCEMENT_MODELS\s*=\s*new Set/g) ?? []).length === 1)
  check("the allowlist names Turbo v2.5 / Flash v2.5 (ElevenLabs' documented enforcement models)",
    /eleven_turbo_v2_5/.test(tts) && /eleven_flash_v2_5/.test(tts))
  check("eleven_multilingual_v2 is NOT in the enforcement allowlist (the model this repo actually uses for avatar reels)",
    !new RegExp(String.raw`LANGUAGE_ENFORCEMENT_MODELS\s*=\s*new Set\(\[[^\]]*eleven_multilingual_v2`).test(tts))

  check("languageCodeField is the ONE gate (§6) — one definition + all three TTS call sites route through it, none re-implements the check",
    (tts.match(/languageCodeField\(/g) ?? []).length === 4)
  check("no call site spreads `language_code: input.languageCode` unconditionally anymore (the pre-fix shape)",
    !/\.\.\.\(input\.languageCode\s*\?\s*\{\s*language_code:\s*input\.languageCode\s*\}/.test(tts))

  // POSITIVE CONTROL (§2): a version of the guard that (wrongly) admits
  // multilingual_v2 into the allowlist is correctly recognised as broken —
  // proves the "is NOT in the allowlist" assertion above is actually reading
  // the Set's contents, not just checking the constant exists.
  const brokenAllowlistSnippet = `const LANGUAGE_ENFORCEMENT_MODELS = new Set(["eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_multilingual_v2"])`
  check("CONTROL: an allowlist that (wrongly) includes eleven_multilingual_v2 is correctly flagged",
    new RegExp(String.raw`LANGUAGE_ENFORCEMENT_MODELS\s*=\s*new Set\(\[[^\]]*eleven_multilingual_v2`).test(brokenAllowlistSnippet))

  // CONTROL: a synthesis call that ignores the model and always forwards
  // language_code is the exact historical shape that would 400 against
  // ElevenLabs' /convert endpoint for multilingual_v2 — confirm the "no
  // unconditional spread" check above would have caught it.
  const unconditionalSpreadSnippet = `
    body: { text: input.text, model_id: input.modelId ?? "eleven_monolingual_v1", ...(input.languageCode ? { language_code: input.languageCode } : {}) }
  `
  check("CONTROL: the pre-fix unconditional spread is correctly recognised as the defect",
    /\.\.\.\(input\.languageCode\s*\?\s*\{\s*language_code:\s*input\.languageCode\s*\}/.test(unconditionalSpreadSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §reelProducers — the four prepareReelVoiceover callers now resolve/pass a
// language (task item 2, wave 52) — the gap the wave-51 manager-registry
// entry named "STILL UNRESOLVED"
// ═══════════════════════════════════════════════════════════════════════════

function reelProducersSection() {
  console.log("\n── §reelProducers — listing-pitch/deal-room resolve per-contact; board-packet/partners-meeting use DEFAULT_LANGUAGE ──")
  const reelVoiceover = readStripped("lib/video/reel-voiceover.ts")
  const listingPitch = readStripped("lib/video/listing-pitch-reel.ts")
  const dealRoom = readStripped("lib/kernel/deal-room-reel.ts")
  const boardPacket = readStripped("lib/kernel/board-packet-reel.ts")
  const partnersMeeting = readStripped("lib/intelligence/partners-meeting.ts")

  // prepareReelVoiceover itself: the languageCode param now also selects the
  // MODEL (not just a param the API would silently drop for the default
  // model) — the wave-52 fix this whole section depends on.
  check("prepareReelVoiceover switches to MULTILINGUAL_TTS_MODEL when a non-default languageCode is resolved (not just forwarding the code to the English-only default model)",
    /const modelId = languageCode \? MULTILINGUAL_TTS_MODEL : undefined/.test(reelVoiceover))
  check("both TTS calls (with-timestamps AND the plain fallback) receive modelId — a fallback that dropped it would silently revert to the English-only model",
    (reelVoiceover.match(/,\s*languageCode,\s*modelId\s*\}\)/g) ?? []).length === 2)

  const contactFacing: Array<[string, string]> = [
    ["listing-pitch-reel.ts (seller-facing pitch video)", listingPitch],
    ["deal-room-reel.ts (client's weekly deal update)", dealRoom],
  ]
  for (const [label, src] of contactFacing) {
    check(`${label} resolves the contact's language via resolveContactLanguageFromDb`,
      /resolveContactLanguageFromDb/.test(src))
    check(`${label} passes languageCode into its prepareReelVoiceover call`,
      /prepareReelVoiceover\(\{[\s\S]{0,400}languageCode/.test(src))
    check(`${label} translates the narration BEFORE synthesis when non-default (translateReelScript, not just a language_code hint)`,
      /translateReelScript/.test(src))
  }

  const internal: Array<[string, string]> = [
    ["board-packet-reel.ts (broker/board report)", boardPacket],
    ["partners-meeting.ts (the AI team's weekly show, to the brokerage's own people)", partnersMeeting],
  ]
  for (const [label, src] of internal) {
    check(`${label} passes languageCode: DEFAULT_LANGUAGE explicitly (never a second "en" literal, §6)`,
      /languageCode:\s*DEFAULT_LANGUAGE/.test(src))
    check(`${label} imports DEFAULT_LANGUAGE from the ONE constant's home (static or dynamic import — both are one binding, never a redeclared "en")`,
      /import\s*\{[^}]*DEFAULT_LANGUAGE[^}]*\}\s*from\s*["']@\/lib\/video\/multilingual-reel["']/.test(src) ||
      /(?:await )?import\(["']@\/lib\/video\/multilingual-reel["']\)/.test(src))
  }

  // POSITIVE CONTROL (§2): the ORIGINAL wave-51 gap this section closes —
  // a prepareReelVoiceover call with no languageCode at all — is correctly
  // recognised as unwired, proving the pattern checks above aren't vacuously
  // true on any prepareReelVoiceover call shape.
  const unwiredCallSnippet = `
    const vo = await prepareReelVoiceover({
      brokerageId: p.brokerageId, narration: (props as any).narration,
      voiceId: identity.voiceId, renderKey: "pitch-" + p.appointmentId.slice(0, 8),
    })
  `
  check("CONTROL: a prepareReelVoiceover call with no languageCode is correctly recognised as the pre-fix (unwired) shape",
    !/prepareReelVoiceover\(\{[\s\S]{0,400}languageCode/.test(unwiredCallSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §anniversary — the greeting is resolved per contact, not English-hardcoded
// (task item 3, wave 52)
// ═══════════════════════════════════════════════════════════════════════════

function anniversarySection() {
  console.log("\n── §anniversary — the happy-anniversary greeting is localized per contact ──")
  const script = readStripped("lib/video/anniversary-script.ts")
  const reactor = readStripped("lib/video/intro-video-reactor.ts")
  const equity = readStripped("lib/kernel/anniversary-equity.ts")
  const touchpoints = readStripped("app/actions/lifetime-customer-touchpoints.ts")

  check("anniversaryGreeting/safeAnniversaryFallback stay PURE (no I/O) — the file's own architecture contract is unbroken",
    !/await\s|gatewayChat|createServiceClient/.test(script))
  check("opensWithAnniversaryGreeting accepts an optional `greeting` for a language-agnostic fallback match (not English-regex-only)",
    /function opensWithAnniversaryGreeting\(script: string \| null \| undefined, greeting\?: string\)/.test(script))
  check("the fallback match normalizes with the Unicode letter/number classes (\\p{L}/\\p{N}) — works for non-Latin scripts too",
    /\\p\{L\}/.test(script) && /\\p\{N\}/.test(script))

  check("intro-video-reactor.ts localizes the greeting BEFORE it is interpolated into the \"open with exactly this greeting\" prompt line",
    /const greeting = args\.trigger === ["']home_anniversary["']\s*\n?\s*\?\s*await localizedAnniversaryGreeting/.test(reactor))
  check("the SAME localized `greeting` variable is reused at the final enforceAnniversaryGreeting call (not a second, re-computed English greeting)",
    /enforceAnniversaryGreeting\(text\.trim\(\),\s*greeting\)/.test(reactor))
  check("the compliance-degrade fallback path (safeAnniversaryFallback) is ALSO localized, not left English-only when the equity claim fails the gate",
    /localizedAnniversaryGreeting\(englishFallback, language\)/.test(reactor))
  check("localizedAnniversaryGreeting degrades to English on a translation failure (never throws, never blocks the video)",
    /catch \{\s*\n?\s*return englishGreeting\s*\n?\s*\}/.test(reactor))

  check("anniversary-equity.ts (the primary dispatcher) resolves the contact's language before calling dispatchAnniversaryVideo",
    /resolveContactLanguageFromDb/.test(equity) && /dispatchAnniversaryVideo\(\{[\s\S]{0,300}language,/.test(equity))
  check("lifetime-customer-touchpoints.ts's sendAnniversaryMessage ALSO resolves language (the second dispatcher wave 51/52 found unwired)",
    /resolveContactLanguageFromDb/.test(touchpoints) && /dispatchAnniversaryVideo\(\{[\s\S]{0,300}language,/.test(touchpoints))

  // POSITIVE CONTROL (§2): the ORIGINAL defect — the prompt's "word for word"
  // instruction interpolating the UNLOCALIZED English greeting regardless of
  // languageLine's own "write the ENTIRE script in <language>" instruction —
  // is correctly recognised as the bilingual-mashup bug this section closes.
  const preFixPromptSnippet = `
    const greeting = anniversaryGreeting({ firstName: args.firstName, yearsHeld: args.yearsAgo ?? null })
    \`Open with exactly this greeting, word for word: "\${greeting}"\`
  `
  check("CONTROL: interpolating the raw (unlocalized) anniversaryGreeting() output directly is correctly recognised as the pre-fix shape",
    /const greeting = anniversaryGreeting\(\{ firstName: args\.firstName, yearsHeld: args\.yearsAgo \?\? null \}\)/.test(preFixPromptSnippet) &&
    !/await localizedAnniversaryGreeting/.test(preFixPromptSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §durationOverrun — wave 53 avatar re-audit item 2: the MEASURED D-ID
// duration is compared to the pre-synthesis (word-count-ESTIMATE) budget, so
// a translated script that speaks slower/faster than WORDS_PER_MINUTE=150 in
// its own language produces a WARNING + a ledger stamp instead of a silent
// mid-sentence crop under AgentTalkingHeadReel's hard trimAfter={BODY}.
// ═══════════════════════════════════════════════════════════════════════════

function durationOverrunSection() {
  console.log("\n── §durationOverrun — the estimate vs. the D-ID measurement (wave 53) ──")
  const structure = readStripped("lib/video/script-structure.ts")
  const reactor = readStripped("lib/video/intro-video-reactor.ts")
  const poller = readStripped("app/api/cron/poll-did-videos/route.ts")

  check("the reactor stamps narration_budget_seconds onto ai_video_projects.video_metadata (the estimate, persisted for later comparison)",
    /narration_budget_seconds:\s*introNarrationBudget\(\)\.budgetSeconds/.test(reactor))
  check("script-structure.ts exports a PURE avatarDurationOverrunSeconds reader (one vocabulary, §6 — not a second arithmetic re-implemented at the call site)",
    /export function avatarDurationOverrunSeconds\(/.test(structure))
  check("avatarDurationOverrunSeconds is additive-safe: a non-finite/absent budget or actual returns 0 (not measurable ≠ overran)",
    /if \(typeof actualSeconds !== "number" \|\| !Number\.isFinite\(actualSeconds\)\) return 0/.test(structure) &&
    /if \(typeof budgetSeconds !== "number" \|\| !Number\.isFinite\(budgetSeconds\)\) return 0/.test(structure))

  check("poll-did-videos SELECTs video_metadata (the budget is unreadable without it)",
    /\.select\("id, agent_id, brokerage_id[\s\S]{0,300}video_metadata/.test(poller))
  check("poll-did-videos imports avatarDurationOverrunSeconds and calls it with D-ID's own measured `duration`",
    /avatarDurationOverrunSeconds\(duration, narrationBudgetSeconds\)/.test(poller))
  check("an overrun is WARNED (console.warn), never silently swallowed",
    /console\.warn\(\s*\n?\s*`\[poll-did-videos\] project \$\{video\.id\}: D-ID rendered/.test(poller))
  check("an overrun is STAMPED onto video_metadata.avatar_duration_overrun_seconds — a count that moves is the finding (§2), not a log line nobody reads twice",
    /avatar_duration_overrun_seconds:\s*avatarOverrunSeconds/.test(poller))
  check("the stamp write's own refusal is READ (§3) rather than swallowed",
    /if \(overrunErr\) \{\s*\n\s*console\.error\(`\[poll-did-videos\] could not stamp the overrun/.test(poller))
  check("the whole check is gated on the field being present (typeof === \"number\") — every non-intro/anniversary video_metadata row (no such key) is untouched, byte-identical to before this existed",
    /if \(typeof narrationBudgetSeconds === "number"\)/.test(poller))
  check("the comparison sits BEFORE the avatar→Remotion handoff, not after — the measurement is never skipped by an early handoff failure/return",
    poller.indexOf("avatarDurationOverrunSeconds(duration, narrationBudgetSeconds)") <
    poller.indexOf("enqueueAvatarCompositionForProject(video.id, supabase)"))

  // POSITIVE CONTROLS (§2)
  check("CONTROL: a render that measured well within its budget reports 0 (no false positive)",
    avatarDurationOverrunSeconds(9, 11.2) === 0)
  check("CONTROL: a render that measured 4s over its budget (past the 1s tolerance) reports the real overrun, not a rounding artifact",
    avatarDurationOverrunSeconds(15.4, 11.2) === 3.2)
  check("CONTROL: no budget recorded (an ordinary, non-avatar video_metadata row) reports 0 rather than a spurious overrun",
    avatarDurationOverrunSeconds(30, null) === 0)
  check("CONTROL: no measured duration yet (still polling) reports 0 rather than a spurious overrun",
    avatarDurationOverrunSeconds(null, 11.2) === 0)
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
  researchSection()
  reelProducersSection()
  anniversarySection()
  durationOverrunSection()
  console.log("\n────────────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ All twelve avatar-pipeline hardening properties hold (seven from wave 50 + §language from wave 51 + §research/§reelProducers/§anniversary/§durationOverrun from wave 52-53), each with a positive control.")
}
main().catch((e) => { console.error(e); process.exit(1) })
