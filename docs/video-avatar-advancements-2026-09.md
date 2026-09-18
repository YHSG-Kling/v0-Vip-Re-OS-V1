# Video / avatar advancements — wave 72D (2026-09-17)

Research method: Exa web search, 5 queries, 2026-09-17 (sources cited inline,
all fetched live). This is additive to `docs/avatar-provider-recommendation-2026-09.md`
(wave 56 — HeyGen/Synthesia/Tavus/Hedra/Runway/Argil comparison, still current)
and `docs/live-agent-provider-recommendation-2026-09.md` (wave 60 — D-ID Express
v4 live-agent decision). **No provider was switched in code.** Constraints
carried from the lane brief: no HeyGen; D-ID Express v4 stays primary, Simli
stays the audio-to-video **backup** face-render provider behind
`lib/live-agent/face-render.ts` / `lib/providers/simli/client.ts`; the D-ID 428
consent gate is untouched and never weakened.

## 1. D-ID Express v4 — current state (confirmed 2026-09-17)

- **Two distinct products under the "V4" name**, and this repo already uses
  both correctly: **Expressive Avatars** (`/expressives`, one-way scripted
  render — `lib/did/index.ts`'s `isV4Expressive` branch,
  `lib/providers/dispatch.ts`'s matching branch) and **Expressive Visual
  Agents** (real-time, LiveKit-based, two-way conversational — `lib/did/agents.ts`,
  the website/widget/portal live-agent surface). d-id.com's own 2026-03-16
  launch post is explicit these are different deployment shapes of the same
  model, not two versions of the same product.
- Tech specs (d-id.com/v4-expressive-visual-avatars-tech-specs, 2026-03-16):
  end-to-end conversational latency **< 500 ms**, core model **< 120 ms**,
  **200+ FPS** diffusion pipeline, up to **4K** output, **5.7 LSE-D** lip-sync
  accuracy, ~3.5 GB GPU RAM per 4 concurrent sessions. Available on **all D-ID
  plans starting at $5.90/mo** (2026-03-16 announcement) — confirms the
  Express-v4-primary decision is not gated to an enterprise tier for the
  scripted-render path this OS uses most.
- **New since the wave-56/60 research**: MCP Apps (agents can call D-ID-API
  tools/actions mid-conversation), vision-enabled LLM frame analysis
  (`camera` mode — the agent reads the viewer's expressions/objects, not just
  audio), and inline media display (agent can show an image/form/chart inline
  during the conversation). **Self-hosted Expressive Avatars** (announced
  2026-07-23) is a NEW enterprise deployment option — run the same avatar
  model inside the tenant's own cloud (Azure/AWS/GCP marketplace,
  bring-your-own STT/LLM/TTS, unlimited concurrent sessions, <200 ms) for
  data-residency/compliance buyers. **Not evaluated for adoption this wave**
  — it changes the deployment topology (no more `DID_API_KEY` platform
  connector, per-tenant infra instead) and is a build, not a research item;
  flagged for a future wave if an enterprise brokerage's compliance
  requirement demands it.
- Agents SDK confirms the exact capability gate this repo's D-ID V4 docs
  already record: `publishMicrophoneStream`/`unpublishMicrophoneStream` and
  `sentiment`/`should_queue_speaks` on `speak()` are **V4-only**
  (`lib/did/agent-presenter.ts` already branches on this). No new SDK method
  surfaced that this repo doesn't already use.

## 2. Simli — current state as the confirmed BACKUP (2026-09-17)

- Simli is a **speech-to-video (STV) layer only** — it takes already-synthesized
  audio and returns a lip-synced face; it does not run its own STT/LLM/TTS.
  This matches `lib/providers/simli/client.ts`'s existing shape (audio in,
  video out) exactly — no scope drift needed to keep it as backup.
- Three integration depths confirmed: no-code **Widget**, managed **Simli
  Auto** (`POST /auto/start/configurable`: faceId + ttsProvider + language in
  one call), and low-level **SDK/API** (WebRTC via `/compose/token` +
  `/compose/webrtc/p2p`, or the `faces/trinity` custom-avatar endpoint this
  repo's `lib/providers/simli/faces.ts` already targets per the wave-62
  integration note).
- **Trinity-1** (Gaussian-splat avatar model) is Simli's current avatar
  engine, marketed at **< $0.01/streaming-minute** — materially cheaper than
  D-ID's Scale-tier derived rate (`DID_USD_PER_STREAMING_MINUTE = 0.495`,
  `lib/video/realism-profile.ts`), which is the correct shape for a
  **fail-over** provider: cheap, fast to spin up, lower fidelity than the
  primary. Free tier: ~$10 credit + 50 min/month. Volume/enterprise pricing
  is negotiated, not published (confirmed unresolved by two independent
  2026-04-12 sources) — consistent with wave 62's "UNRESOLVED — fetch
  Simli's real contract from docs first" posture, still the right call.
- No new capability surfaced that changes the D-ID-primary / Simli-backup
  architecture this repo already implements; this section is a confirmation,
  not a build item.

## 3. ElevenLabs v3 — audio tags, dialogue mode, dubbing (2026-09-17)

The repo already adopted v3 for narration lanes (`elevenLabsModelForLane`,
`withNaturalPauses`, `ELEVENLABS_REALISM_VOICE_SETTINGS` — wave 55/57) and
this wave's fix (§ below) closed the one call site that had NOT been upgraded
(`lib/did/index.ts::generateVideo`). Three capabilities confirmed current and
**not yet used anywhere in this repo**:

- **Audio tags** (`[whispers]`, `[sighs]`, `[laughs]`, `[excited]`) are
  bracketed inline performance directives, GA on the public API since March
  2026 (elevenlabs.io/blog/v3-audiotags). `withNaturalPauses` already inserts
  v3's own pacing markup at sentence/paragraph boundaries — audio tags are a
  DIFFERENT, additive layer (emotional direction, not pause timing) that no
  script generator in this repo emits. **Advancement opportunity, not built
  this wave**: `lib/video/script-compliance.ts` / the AI-authored script
  prompts could be extended to emit a *small, curated* tag vocabulary
  (`[warmly]`, `[pause]`, `[chuckles]`) for avatar narration specifically —
  scoped carefully, since v3 "will sometimes speak a tag aloud as text
  instead of interpreting it" when the tag doesn't match the voice's range
  (elevenlabs.io/blog/v3-audiotags), which is a new AI-tell risk
  (`scanForAiTells` in `lib/video/realism-profile.ts` would need a positive
  control for a literal `[tag]` leaking into spoken output before this ships).
- **Text to Dialogue** (multi-speaker mode, up to 32-speaker diarization on
  Scribe v2, a *separate* `POST /v1/text-to-dialogue`-shaped endpoint from
  `/text-to-speech/:voice_id`) generates a structured array of
  `{speaker_id, text}` turns into one cohesive conversational audio file with
  automatic turn-taking/interruptions. **No use case in this repo yet** — every
  avatar/reel narration here is single-speaker. The nearest fit would be
  `PartnersMeetingReel`'s "weekly recap show" narration if it were ever voiced
  by more than one presenter, or a two-agent testimonial format; neither
  exists today, so this is recorded as a **future capability**, not a gap.
- **Dubbing API v2** (`POST /v1/dubbing`, 90+ languages, automatic voice
  cloning of the original speaker, full-mix audio-in/audio-out — no stem
  separation needed) is architecturally different from this repo's existing
  multilingual path (`lib/video/multilingual-reel.ts` — script translated via
  the AI gateway, THEN synthesized fresh per locale). Dubbing takes a
  **finished** video/audio file and re-voices it, preserving the original
  performance's emotion/timing — useful for re-voicing an *already-rendered*
  D-ID avatar clip into a second language without re-running the whole
  render/consent/compositing pipeline. **Advancement opportunity, not built**:
  would let a completed English `TeammateExplainerReel` become a Spanish one
  in one dubbing call instead of a full second D-ID + Remotion pass — real
  cost/latency win for the multilingual-reel lane, but a genuinely new
  provider integration (new adapter, new vendor-spend line, edit-endpoint is
  enterprise-only per `elevenlabs.io/dubbing-api`), correctly out of scope
  for an audit-and-fix wave.

## 4. Remotion 4.x — confirmed current, no upgrade needed

Installed: `remotion` / `@remotion/bundler` / `@remotion/cli` /
`@remotion/media` / `@remotion/renderer` all at **4.0.521** — this matches the
version pinned in the vendored `remotion-best-practices` skill
(`.claude/skills/remotion-best-practices/remotion-captions/REFERENCE.md`
header: `version: 4.0.521`), i.e. **the repo is already on the current
release this session's skill knows about.** No version-gap finding.

- `calculateMetadata()` — confirmed still the correct **non-adoption**
  documented at `remotion/Root.tsx:400-467`: it exists for dynamic
  duration/props from data fetching, and every avatar-fronted composition in
  this repo is sized to FIXED geometry the render cache and
  `test:remotion-setup` §3 key on (`remotion_compositions.duration_frames`
  field-for-field). Nothing in the 2026 docs changes that trade-off.
- `<Video>` from `@remotion/media` (not `<OffthreadVideo>`) is already the
  library's own recommended path ("For new video usage, prefer `<Video>` from
  `@remotion/media`" — remotion.dev/docs/offthreadvideo) and this repo already
  uses it exclusively (`remotion/_BrollLayer.tsx`, confirmed 0 `OffthreadVideo`
  call sites repo-wide). **Already on the modern API — no migration needed.**
- `premountFor` (the lane brief's explicit ask): confirmed via GitHub
  releases (`@remotion/media: Fix premount buffering state`,
  `@remotion/example: Add premounting repro composition`) as an
  ACTIVE area of `@remotion/media` development, but it is a `<Player>`/Studio
  playback-preroll affordance (buffers a video ahead of when its `<Sequence>`
  mounts, for scrubbing/preview smoothness) — this product renders
  **headlessly via `@remotion/renderer`** with no `<Player>` or Studio surface
  reachable (the SAME "no interactive surface" fact `remotion/Root.tsx`'s own
  header already documents for `<Interactive.Div>`, 2026-09-02). `premountFor`
  has no effect on a `renderMedia()` render — confirmed unreachable for this
  product, not a gap.
- `@remotion/effects` (`noiseDisplacement()`, alpha masking) and
  `@remotion/shapes` (effects/outline/sequence support) are packages this
  repo does **not** install. `_BrollLayer.tsx`'s film-grain/vignette treatment
  is hand-rolled CSS (`FILM_GRAIN_BACKGROUND_IMAGE`, a tiled SVG noise data
  URI). `@remotion/effects noiseDisplacement()` is a plausible cleaner
  replacement for that hand-rolled layer — **not built this wave**: it is a
  new package (`npm install @remotion/effects`), and per the wave-71/72
  integration lesson, a new dependency needs a `serverExternalPackages` +
  webpack-externals pin and a heap measurement before it is safe to add
  (`.github/workflows/build.yml`) — out of scope for a lane forbidden from
  editing `package.json`. Recorded as a clean future swap, not a defect.

## 5. Alternative avatar/video providers (not HeyGen) — pricing update

Extends wave 56's comparison table with two providers not covered there, plus
a Simli/Trinity-1 pricing anchor:

| Provider | Capability | Price (2026-09, self-serve) | SDK/API | Verdict |
|---|---|---|---|---|
| **D-ID Express v4** (current, primary) | Scripted `/expressives` render + real-time Visual Agents; 4K, <500ms conversational, 5.7 LSE-D lip-sync | All plans incl. $5.90/mo; API pay-as-you-go ≈ $3.00/min at low volume, ~$0.50/min at Scale-tier full utilization (wave 61 derivation) | REST (`/talks`,`/clips`,`/expressives`,`/scenes/avatars`); no first-party Node SDK (confirmed wave 60) | **Keep as primary.** Cheapest mature option at this product's render-and-deliver shape; consent flow (`consent_id`) is API-native and already what our 428 gate proxies. |
| **Simli (Trinity-1)** (current, backup) | Real-time speech-to-video only (audio→lip-synced face); Widget/Auto/SDK depths | < $0.01/streaming-min (Trinity-1), ~$10 + 50 min/mo free | `simli-client` (installed) + REST (`/compose/token`, `/faces/trinity`) | **Keep as backup.** Cheapest fail-over rate found anywhere in this survey; correctly scoped as a face-only layer, never the primary (lower independently-reported fidelity than D-ID). |
| **Colossyan** | Scripted avatar video, 130-300+ stock avatars, instant avatar-from-phone-recording, 80+ languages, API for triggered/personalized video at scale | Starter $27-29/mo; Professional $59-99/mo (10 min NEO2); Enterprise custom (~$2,500/mo mid-market per a 2026-07 estimate); API access is an Enterprise add-on (360 min/yr baseline) | REST API (no-code trigger + template personalization) | **Not adopted.** L&D/training-video positioning (SCORM export, branching scenarios) is off-target for a real-estate marketing reel; per-minute economics (~$0.12/min at scale per one 2026 estimate) are competitive with D-ID's Scale tier but API access is Enterprise-gated, same practical barrier wave 56 found for Synthesia. |
| **Akool** | Streaming + talking avatars, face swap, live face-swap, video translation, credit-based | Free tier; paid seat plans from ~$21/mo; credits: 1080p streaming ≈ 1.2 credits/10s, talking-avatar 1080p ≈ 5 credits/10s, 4K ≈ 2x | Credit-metered REST API, Enterprise API concurrency up to 10 | **Not adopted.** Credit-per-10-seconds billing is harder to forecast against this OS's per-render vendor-ledger shape than D-ID's per-minute rate; face-swap/live-swap feature set is off-mission (this product needs consented likeness avatars, not identity-swapping) and raises its own separate consent-policy question this research did not clear. |

**No change to the recommendation**: D-ID Express v4 primary + Simli backup,
confirmed again this wave as the correct cost/consent/fidelity balance for an
async render-and-deliver real-estate marketing pipeline. Neither Colossyan
nor Akool clears the bar wave 56 already set (API-native consent flow
at least as rigorous as the 428 gate, real per-render cost predictability,
fit for one-way scripted delivery rather than live/training/identity-swap
use cases).

## 6. Fixes made this wave (see the lane report for file:line detail)

1. **Consent-gate side door closed.** `agent_voice_profiles.did_video_url`
   (writable with zero consent check via `POST /api/agent/update-video-profile`)
   was read as a fallback avatar SOURCE by `lib/video/presenter-media.ts`,
   `lib/providers/dispatch.ts`, and — through it — `lib/did/index.ts::generateVideo()`,
   the pipeline every other avatar-video call site (Director render worker,
   partners-meeting, assistant-starter, the workflow adapter,
   avatar-track-submit) funnels through. None of those checked for a verified
   `agent_did_consents` row before submitting a video-sourced avatar to D-ID —
   the exact 428 gate `app/api/did/create-avatar` enforces for the SAME kind
   of source, reachable through a door that never asked. New module
   `lib/did/avatar-consent-gate.ts` (imports `consent.ts`'s READ export only,
   never its write path) closes both call sites, fail-closed.
2. **Realism-parity gap in the main render pipeline.** `lib/did/index.ts::generateVideo()`
   — used by more avatar-video call sites than `dispatch.ts` — was still on
   ElevenLabs' bare API defaults (`stability: 0.5, similarity_boost: 0.75`, no
   `style`/`use_speaker_boost`, no `model_id`, no natural-pause pacing) and a
   bare `{result_format, stitch}` D-ID config (no `fluent`, no `pad_audio`),
   while `dispatch.ts`'s outreach-email path already had the full wave-55/57
   realism upgrade. Brought to parity: `DID_TALK_REALISM_CONFIG` spread,
   `ELEVENLABS_REALISM_VOICE_SETTINGS` + `elevenLabsModelForLane("avatar_narration")`
   + `apply_text_normalization`, `withNaturalPauses` script pacing.

Proof: `scripts/avatar-pipeline-hardening-simulator.ts` §sideDoor (19 new
assertions, each with a positive control against the pre-fix literal shape) —
`npm run test:avatar-pipeline-hardening` (241 passed, 0 failed).

## Unresolved / recorded rather than guessed

- D-ID self-hosted Expressive Avatars pricing is not published (annual
  platform license + on-demand minutes, quote-only) — cannot be compared
  numerically to the current API path without a vendor quote.
- Simli's negotiated volume/enterprise rate is not published anywhere found
  (two independent 2026-04-12 sources both confirm this) — same posture wave
  62 already recorded.
- ElevenLabs Text-to-Dialogue's exact per-request pricing was not surfaced in
  this wave's sources (blog post says "API access... coming soon / contact
  sales" on one page and "now available" on another — the pages disagree on
  GA date, flagged rather than resolved).
- Whether audio-tag prompting is safe to add to this repo's compliance-first
  script writer without a new `scanForAiTells` control for a leaked literal
  tag is unresolved — named as the blocker in §3, not built. **RESOLVED wave
  73D** (the very next wave, 2026-09-18, commit `d4b2b4fb`): `ALLOWED_V3_EXPRESSIVE_TAGS`
  (laughs/chuckles/sighs/whispers), `MAX_EXPRESSIVE_TAGS_PER_100_WORDS`,
  `enforceExpressiveAudioTagBudget` (caps tags on the v3 lane, strips them
  entirely elsewhere), and `scanForAiTells`'s leaked-bracket-tag check now
  exist in `lib/video/realism-profile.ts`. Lane 74D's re-audit (below) found
  and closed the one gap this created: the budget-capped script (which may
  still carry an authorized tag) was never stripped before reaching
  `buildCaptionPlan`'s even-distribution fallback — a literal `[laughs]`
  could have rendered as an on-screen caption.

## 7. Lane 74D re-audit (2026-09-18, ≤3 Exa calls) — provider pricing re-check after wave 73D

Owner brief: re-check D-ID Express pricing/features, Simli, and one alternative,
after the google-fonts + ElevenLabs v3 audio-tag wave (73D). Research method:
3 Exa web searches (`web_search_exa`), 2026-09-18 — no fetch beyond the search
snippets was needed; every figure below is quoted directly from a source dated
within the last six weeks.

**D-ID Express v4 — UNCHANGED, re-confirmed.** The Spatius pricing breakdown
this repo has relied on since wave 61 was re-published 2026-09-07 (11 days
before this check) with the IDENTICAL table this repo's `DID_USD_PER_STREAMING_MINUTE`
constant derives from: Build $18/64 credits (32 streaming min), Launch
$50/$99/$149 (90/180/270 min), Scale $198/$248/$297 (400/500/600 min),
Enterprise custom. D-ID's own 2026-03-16 V4 launch post (re-surfaced by this
search) still confirms "all D-ID plans starting from as little as $5.90 a
month" for V4 access. **No pricing or feature change found — the derived
constant is still current.**

**Simli — UNCHANGED on price, ONE clarification.** Trinity-1 still marketed at
"less than $0.01 per streaming minute," $10 signup credit + 50 free
minutes/month, confirmed by a 2026-08-25 independent review (aitwin.me) and
Simli's own site. **Clarification found** (codeables.dev, 2026-04-12, Simli-
authored): production/enterprise procurement DOES get DPA, SOC2-equivalent,
and SLA documentation "shared directly by the team during procurement" — this
was previously recorded as "no public security docs," which is still true, but
"unavailable" would overstate the gap; a brokerage's compliance team CAN get
these under NDA once volume justifies the conversation. Worth noting if a
tenant's security review ever blocks Simli-as-backup adoption. No code change
— Simli is unused today (still zero live SIMLI_API_KEY sessions, per
`docs/face-render-backup-simli-2026-09.md`).

**Tavus — the one alternative, priced for the first time in this repo's docs.**
Tavus is a bundled, real-time Conversational Video Interface (CVI): perception
(Raven-1) + turn-taking (Sparrow-1/2) + LLM orchestration + TTS + rendering
(Phoenix-4) in ONE metered minute, unlike D-ID (rendering-focused; this repo
supplies its own LLM via `/api/did/custom-llm` + ElevenLabs TTS separately) or
Simli (rendering-only STV layer, explicitly "bring your own STT/LLM/TTS").
Confirmed pricing (tavus.io/pricing + Spatius's 2026-09-04 mirror, consistent
across both): Free/Basic (25 conversational min/mo), Starter $59/mo (100 min
included, $0.35-0.37/min overage), Growth $397/mo (1,250 min, $0.31-0.32/min
overage — two sources disagree on the exact 2nd decimal, flagged rather than
resolved), Business $975/mo (4,000 min, ~$0.26/min), Enterprise custom
(SOC2/HIPAA). Every conversation carries a 30-second minimum charge, billed
from connect (not from first word), a real cost risk for a short "just
checking availability" caller pattern this repo's receptionist/ISA lanes
produce often.

**Verdict — NOT adopted, D-ID Express v4 stays primary + Simli backup.**
Tavus's own per-minute rate ($0.26-0.59 depending on volume) lands in the SAME
range as D-ID's Scale-tier derived rate (~$0.50/min) — but Tavus's number
already includes the LLM + TTS this repo pays for SEPARATELY under D-ID
(AI Gateway tokens + ElevenLabs), so switching would not obviously be cheaper
once those are added back, and would mean giving up the brand-voice-cascade
custom LLM brain (`loadBrandVoicePrompt`) for Tavus's own Persona/Replica
config — an architecture change, not a drop-in swap, and out of scope for an
audit wave. The 30-second-per-call minimum is also a worse fit than D-ID's
per-second-class metering for this OS's expected call pattern (many short
availability/hours-check calls). Recorded as a priced, considered alternative
— not a recommendation to switch.

**Unresolved (this re-check):** Tavus's Growth-tier overage rate is stated as
both $0.31/min and $0.32/min across two sections of its OWN pricing page (per
an independent August-2026 audit of that page, revenueflow.com) — a written
quote would be needed before sizing any real deployment, moot here since
Tavus is not being adopted. Simli's real negotiated enterprise rate remains
unpublished (still true as of this check, same as wave 62/72D).
