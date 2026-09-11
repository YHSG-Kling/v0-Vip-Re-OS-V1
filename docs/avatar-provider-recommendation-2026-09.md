# Avatar provider recommendation — wave 56

Owner ruling (wave 56, 2026-09-11), verbatim: "if there is another provider
that will achieve this [real-looking avatar video], then make sure you give
your suggestions." This is research + a recommendation only — **no provider
was changed in code**. The current stack (D-ID Talks/Clips API +
ElevenLabs, `lib/providers/dispatch.ts:dispatchVideoViaDID`,
`lib/voice/elevenlabs-tts.ts`, realism knobs centralized in
`lib/video/realism-profile.ts`) is untouched by this task.

Research method: Exa web search, 7 queries, 2026-09-11. Sources and
publish dates are cited inline; all URLs were live at fetch time.

## What "current" means today

- Render path: `lib/providers/dispatch.ts` → D-ID `/talks` (photo source)
  or `/clips` (video source), both async/poll — no webhook is used, the
  caller polls. ElevenLabs `eleven_multilingual_v2` generates narration
  first, uploaded to Supabase storage, then handed to D-ID as `audio_url`.
- Consent gate: `app/api/did/create-avatar/route.ts` (`resolveConsentIdForAvatar`
  / `consentRequiredFor`, `lib/did/consent.ts`) returns HTTP **428** with
  `needs_consent: true` when a video-source avatar has no D-ID `consent_id`
  on file — a spoken-passcode-on-camera flow. This gate is explicitly
  **not to be weakened** (wave 50 + wave 55 + wave 56 rulings) regardless
  of which provider is chosen.
- Cost logged today: `~$0.30/render` combined D-ID + ElevenLabs
  (`dispatch.ts:1380`, flat estimate, not the true per-minute D-ID rate).

## Comparison

| Dimension | **D-ID** (current) | **HeyGen** (Avatar IV/V) | **Synthesia** (Express-2) | **Tavus** | **Hedra** | **Runway Act-Two** | **Argil** | **ElevenLabs v3** (voice only) |
|---|---|---|---|---|---|---|---|---|
| Photorealism / "would a viewer know it's AI" | Weakest of the mainstream set. Multiple independent 2026 tests: "D-ID avatars are visibly a step below Synthesia and HeyGen... surrounding facial animation feels mechanical... Viewers will recognize these as AI" (launchstackhub.com, 2026-05-18). Frame-by-frame scoring 87% vs HeyGen 94% / Synthesia 91% (kompozy.io, 2026-05-06). | Rated most lifelike of the batch-render tier in 3 independent 2026 comparisons: "more lifelike than Synthesia's... closer to a real person on a video call" (launchstackhub.com); "HeyGen closed the realism gap meaningfully" and now beats Synthesia on short/medium-form (aitoolanalysis.com, 2026-06-17, updated from a 2026-05-01 note). | Category-leading on *scripted, corporate-tone* realism; Express-2 avatars "cross the uncanny valley convincingly" under 90s, still show tells at 5+ min (aitoolanalysis.com). Slightly more "presenter," less "person you know," per ngram.com 2026-09-01. | Real-time conversational only — architecturally a live CVI (Phoenix-4/Raven-1/Sparrow-1), not built for a one-way rendered send (tavus.io/blog, 2026-06-11). Off-topic for our render-and-email use case. | "Independent testing flags low resolution and bitrate, and slow latency" (meetcody.ai, 2026-08-28). Below D-ID on fidelity for a single-photo source. | Performance-capture (you drive a character with your own face), not enrollment-based cloning of a real person's likeness on request — "different paradigm," explicitly ruled out of personal-avatar comparisons for that reason (ctaio.dev, 2026-04-11). Wrong shape for this product. | "Fails enterprise compliance posture: creator-tier product" per a 2026-04-11 vendor-screening pass; avatar fidelity itself is decent (4.3/5) but thin governance story. | N/A (audio only) — but materially more expressive than the `eleven_multilingual_v2` model already in use: audio tags (`[whispers]`, `[sighs]`), 70+ languages vs 29, "breathtaking" emotional range (elevenlabs.io/v3). |
| Lip-sync | "Accurate," but D-ID's own editor/API is "intentionally thin" and surrounding motion is what fails, not the sync itself (kompozy.io). | "Best in class" across two independent rankings (kompozy.io; launchstackhub.com). | "Very strong," "no longer drifts during consonant clusters" as of Avatar Studio 3.0 (shiporskip.io, undated 2026). | Strong in real-time mode; not the relevant axis for scripted render. | Not independently praised; resolution/bitrate flagged as the weak point. | N/A — different product shape. | Not independently benchmarked in sources found. | N/A. |
| API availability for autonomous server-side generation | **Best of the batch-render set.** REST `/talks` + `/clips`, async job + poll, SDKs, webhook callback support documented; "the most comprehensive and developer-friendly of the three [D-ID/HeyGen/Synthesia]" (khaby.ai, 2026-03-06). This is why it was chosen originally. | Fully async REST (`POST /v3/videos`, poll `GET /v3/videos/{id}`, **`callback_url` webhook** — our current D-ID integration only polls, so this would be a net upgrade in wiring). API ships on the Creator tier, not gated to Enterprise (developers.heygen.com). | API access gated to Creator+/Enterprise; "Direct API access is limited to Enterprise plans... out of reach for individual developers and startups" (khaby.ai). Would need an upgraded contract. | Full API, but for live sessions/minutes, not scripted batch renders at our volume shape. | Public API, but priced from the same Studio credit pool with no separately published per-minute API rate (versusref.com, "Aug 24" 2026 data). | No enrollment/cloning API in the relevant sense. | API present on paid tiers; least-documented of the set. | GA over the standard TTS endpoint (elevenlabs.io/v3: "Public API for Eleven v3 is now available") — same endpoint shape we already call. |
| Consent / likeness policy (must keep 428-gate-equivalent rigor) | Own consent_id flow, spoken passcode + verification, gates avatar creation — what our 428 gate proxies (docs.d-id.com/docs/v3-instant-avatar-quickstart). | **Directly comparable, API-native, and available to all customers (not enterprise-only) at Level 1**: `POST /v3/avatars/{group_id}/consent` starts a hosted webcam flow, the subject reads a displayed statement on camera, `consent_status` gates video generation until `approved` (developers.heygen.com/docs/avatar-consent). Published biometric-privacy notice with GDPR Art. 9 explicit-consent basis and defined retention/deletion (heygen.com/biometric-privacy-notice). This is a same-shape, same-rigor replacement for our 428 gate if ever adopted — nothing here calls for weakening it. | Live-recorded consent video required, identity-matched to the source footage, upload-only forbidden — same rigor as D-ID/HeyGen (docs.synthesia.io/docs/personal-avatars). API access to this flow is Enterprise-gated, which is a practical barrier, not a policy gap. | Consent model not documented in sources found for scripted/API cloning at our tier. | Consent/likeness policy not documented in sources found — flagged as a gap, do not treat as cleared. | Not an enrollment-cloning product; different consent surface (you are always the performer). | "Thin on enterprise compliance posture" was the explicit disqualifier in one screening pass (ctaio.dev) — do not adopt without a documented consent flow. | N/A (voice consent is the existing ElevenLabs voice-clone flow, unchanged). |
| Per-minute cost (self-serve / API, 2026) | Studio $0.59–$1.00/min; **API $0.05/sec = $3.00/min pay-as-you-go**, volume packs down to ~$2.67/min at $2,000 (heyfish.ai, 2026-03-24). Our current cost-log constant ($0.30/render, not /min) undercounts this materially — flagged, not fixed, in this task. | Creator tier ≈ **$0.97/min effective** (600 credits/$29 ≈ 30 min Avatar IV) — cheaper than D-ID's API rate at comparable volume (kompozy.io). | $1.80–$2.90/min self-serve (launchstackhub.com); most expensive of the batch-render set at low volume. | $0.32–$0.59/min blended, but that is a *conversational-minute* price, not comparable unit economics to a one-way render (kompozy.io). | ~$0.07/min effective, cheapest, but quality/consent tradeoffs above (meetcody.ai). | N/A. | ~$1.56/min (kompozy.io). | Included in existing ElevenLabs relationship; TTS pricing itself unchanged by moving multilingual_v2 → v3 (elevenlabs.io/pricing/api: $0.10/1k chars either model over API). |
| Latency (render turnaround) | 30–90 sec typical render (kompozy.io). | 1–3 min for a 30s clip on Avatar IV (kompozy.io) — slower than D-ID per this source, though webhook delivery removes the need to poll. | 5–15 min (optimized for L&D batch, not fast turnaround). | Sub-300ms for live conversation; irrelevant to batch render timing. | Not published. | N/A. | 30–90 sec, "fastest-in-class" claim (kompozy.io). | N/A. |
| Multilingual | 120+ languages claimed by vendor; D-ID's own docs note non-Latin-script lip-sync lags HeyGen/Synthesia (launchstackhub.com). | 175+ languages, widest coverage that "actually holds quality" per one source (kompozy.io). | 140–160+, "best Personal Avatar quality... deepest enterprise integration" (aitoolanalysis.com). | 30–42+, narrower by design (latency budget prioritized over coverage). | Not a differentiator; relies on ElevenLabs/MiniMax TTS pass-through. | N/A. | Not documented at depth. | 70+ languages on v3 vs **29** on the `eleven_multilingual_v2` model this codebase calls today (elevenlabs.io/v3 vs help.elevenlabs.io model docs) — this is the most concrete, lowest-risk upgrade surfaced by this research, and it doesn't touch the avatar vendor at all. |

## Recommendation

**Keep D-ID as the sole avatar-render provider for this wave — do not switch.**
The comparison does not produce a clean win: HeyGen is rated more lifelike in
every 2026 source found and has an API-native, all-customers-tier consent
flow that is at least as rigorous as the current 428 gate, which makes it the
only alternative that clears both the realism bar and the consent-rigor bar
the owner requires. But nothing in this research shows D-ID has become
*unfit* — it remains the cheapest, most API-mature, most developer-documented
option for exactly the async render-and-deliver shape this OS uses, and nothing
found justifies a mid-migration provider swap this wave.

**Concrete next-step suggestions, in priority order, none applied in this task:**

1. **Add HeyGen as a second provider, behind a per-brokerage/per-tier flag**,
   for sends where realism is the deciding factor (e.g. the first welcome
   video a new lead ever sees). This is additive, not a switch — D-ID keeps
   serving the default/high-volume path. See adapter shape below.
2. **Same-provider advancement, no vendor change**: evaluate moving the
   ElevenLabs TTS call in `dispatchVideoViaDID` (`dispatch.ts:1286-1308`)
   from `eleven_multilingual_v2` to `eleven_v3` for markets/scripts where the
   79-language coverage or `[audio tags]` emotional range would measurably
   help — v3's public API is now GA at the same `$0.10/1k chars` rate, so
   this is a config change to an existing provider, not a new integration.
   Left as a finding, not built, because it changes voice output shape
   (audio-tag prompting is a different scripting discipline — see
   `elevenlabs.io/docs/best-practices#prompting-eleven-v3-alpha`) and Task A
   is research-only.
3. **Fix the cost-log constant**: `dispatch.ts:1380`'s
   `estimatedCost: 0.3 /* ~$0.30/render */` is a flat per-render guess against
   a provider that actually bills $0.05/sec — a render longer than ~6 seconds
   of audio already undercounts. Not fixed here (out of Task A's scope: "do
   NOT change providers in code"), but named because §3 of CLAUDE.md makes a
   wrong ledger number a wrong invoice.
4. **Investigate D-ID's own V4 Expressive tier** (d-id.com/news, 2026-03-16:
   "up to 4K... sub-0.5-second... highly accurate lip sync") before evaluating
   any other vendor again — this is the *same* provider we already integrate,
   so it carries none of the consent/compliance-reset risk a vendor switch
   would. Unresolved whether V4 Expressive is reachable through the `/talks`
   and `/clips` REST endpoints this codebase calls (V4 is marketed primarily
   as the "Visual Agents" / real-time product) or requires a different
   endpoint — D-ID's public docs fetched for this task did not resolve that,
   so this is flagged "unresolved," not claimed as a drop-in win.

## Adapter shape, if HeyGen is ever added (not built)

`DispatchVideoParams` (`lib/providers/dispatch.ts:1124-1155`) has no
provider discriminator today — `dispatchVideo` always calls
`dispatchVideoViaDID` unconditionally (`dispatch.ts:1196-1198`, comment:
"the avatar/explainer video engine is D-ID + ElevenLabs ONLY. No provider
selection, no HeyGen cost-fallback."). A `provider` field would need to:

- Resolve via the SAME `resolveProvider({ providerType: "video", ... })`
  cascade already called at `dispatch.ts:1187` — `kernel/providers.ts`
  already has the user → team → brokerage → superadmin → system-default
  chain; a HeyGen branch reads `providerKey` from that cascade instead of
  hardcoding D-ID, exactly the same pattern `dispatchEmail`/`dispatchSMS`
  already use for their providers.
- Add `dispatchVideoViaHeyGen({ params, providerKey })` alongside
  `dispatchVideoViaDID`, resolving the agent's HeyGen `avatar_group_id` +
  `consent_status` from a HeyGen-specific column set on
  `agent_voice_profiles` (mirroring `did_photo_url` / `did_video_url` /
  `elevenlabs_voice_id`), gated the same way the existing 428 flow gates
  D-ID: no `consent_status === "approved"` → the caller gets the
  needs-consent shape, never a silent fallback to an unconsented render.
- Use HeyGen's `callback_url` on video creation instead of polling —
  a genuine improvement over the current D-ID polling loop, worth building
  independent of whether HeyGen is adopted (D-ID also supports webhooks
  per some sources; unresolved whether our /talks or /clips calls presently
  use one — grep shows none).
- Keep `logVendorUsage` at `dispatch.ts:1376` provider-keyed
  (`vendorName: "heygen"`), not merged into the D-ID cost line, so per-tier
  ROI is measurable before any default-path decision.

Per Task A's instruction, a TODO comment describing this adapter shape was
**not added** to `dispatch.ts`: the file already carries an explicit,
current comment at line 1196 stating "No provider selection, no HeyGen
cost-fallback" as a deliberate business-locked decision — that comment
already serves as the "not wired, here's why" marker the instruction asked
for, and duplicating it as a second TODO would be a second spelling of the
same fact (CLAUDE.md §6). The recommendation above stands as the adapter
spec if/when the owner decides to unlock provider selection here.

## Sources (all fetched via Exa web_search, 2026-09-11)

- ngram.com/blog/d-id-vs-synthesia (2026-09-01)
- stackscored.com/pricing/ai-video-generation/compare/d-id-vs-synthesia (2026-04-21)
- khaby.ai/blog/heygen-vs-synthesia-vs-d-id (2026-03-06)
- launchstackhub.com/blog/synthesia-vs-heygen-vs-d-id (2026-05-18)
- aitoolanalysis.com/synthesia-review (2026-06-17, updated from 2026-05-01)
- versusref.com/avatar-video/hedra-vs-tavus (undated, "Aug 24" 2026 data points)
- meetcody.ai/blog/real-time-ai-avatar-models-compared (2026-08-28)
- ctaio.dev/en/labs/my-ai-clone/video-avatars (2026-04-11)
- kompozy.io/ai-video-generation/avatar-video-comparison (2026-05-06)
- khaby.ai/compare/runway-vs-tavus (2026-03-06)
- tavus.io/blog/ai-avatar-generator (2026-06-11)
- elevenlabs.io/pricing/api, elevenlabs.io/v3, elevenlabs.io/blog/eleven-v3,
  help.elevenlabs.io (model docs) — undated/rolling, fetched live
- d-id.com/pricing/api, heyfish.ai/d-id-pricing-2026 (2026-03-24),
  d-id.com/news/v4-expressive-visual-agents (2026-03-16),
  docs.d-id.com/docs/v3-instant-avatar-quickstart
- developers.heygen.com/docs/avatar-consent, .../avatar-iv,
  .../generate-avatar-video, .../reference/create-video,
  heygen.com/biometric-privacy-notice, heygen.com/blog/announcing-the-avatar-iv-api
- docs.synthesia.io/docs/personal-avatars
- shiporskip.io/compare/framer-vs-synthesia-avatar-studio-3-real-time-lip-sync
- percify.io/blog/beginners-guide-to-ai-avatar-platforms-with-best-lip-sync-for-marketing-teams (2026-04-21)

## Unresolved

- Whether D-ID's V4 Expressive engine is reachable through the existing
  `/talks`/`/clips` endpoints or is a separate product surface — write
  "unresolved" per §1 rather than guess; worth a direct D-ID support/sales
  query before any code change.
- Whether our current `/talks`/`/clips` calls use a webhook or only poll —
  not confirmed by grep of `dispatch.ts`; if polling-only, that's an
  independent latency/reliability finding regardless of vendor choice.
- Hedra's and Argil's documented consent/likeness policy for enrollment-style
  cloning — no source found in this pass; treat as a gap, not a clearance,
  if either is ever considered.
