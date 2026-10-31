# Voice provider recommendation — phone receptionist (wave 57, 2026-09-11)

Owner ruling, verbatim: *"no need to add heygen at this time if what we have
is advanced so make any upgrades like v3 and if voice between elevenlabs or
twilio"*. This is the ElevenLabs-vs-Twilio-native evaluation for the phone
receptionist, and what was wired as a result.

## 1. What the phone lane uses TODAY (before this wave)

Two transports, both Twilio-native, **neither ever spoke ElevenLabs**:

| Transport | Where | Voice used |
|---|---|---|
| `<Gather>` (serverless, turn-based) | `lib/voice/reception-brain.ts` `twimlGatherTurn`/`twimlTransfer`/`twimlHangup` | `Polly.Joanna-Neural` (Amazon, hardcoded default) |
| `<ConversationRelay>` (streaming, WebSocket) | `lib/voice/conversation-relay.ts` `twimlConnectRelay` | `en-US-Journey-O` (Google, hardcoded default), no `ttsProvider` set at all |

Both are used by `app/api/voice/twilio/inbound/route.ts`'s `answerTwiml`
(`relayConfigured()` picks the transport). **Outbound** AI-ISA calls
(`app/api/voice/twilio/outbound/route.ts`) use `twimlGatherTurn` unconditionally
— they never check `relayConfigured()` at all.

A genuine gap, not a design choice: `lib/voice/inbound-number-binding.ts`'s
`InboundIdentity.elevenlabsVoiceId` was already resolved every call
(`lib/voice/twilio-voice.ts` `resolveInboundContext` reads
`ai_identity_profiles.elevenlabs_voice_id`, the agent/team/brokerage-scoped
clone) — **and then discarded**. Nothing downstream ever read it. The same
shape repeats on the outbound ISA path: `lib/ai-isa/build-call-context.ts`
`buildCallContext` resolves a full `voiceConfig` (voice id + stability +
similarity, with a documented agent→team→brokerage→undefined priority) and
`app/api/voice/initiate-call/route.ts` never reads `callCtx.voiceConfig` —
only `firstMessage`/`systemPrompt` reach `placeOutboundAiCall`.

## 2. Can `<Say>` (the Gather lane) even speak ElevenLabs?

**No.** Twilio's own `<Say>` reference
(twilio.com/docs/voice/twiml/say/text-speech, fetched 2026-09-11) documents
exactly two voice providers for `<Say>`: Google and Amazon Polly. ElevenLabs
is not in that list. ElevenLabs is reachable **only** through
`<ConversationRelay>`'s `ttsProvider`/`voice` attributes. This is a hard
structural fact, not a config gap: the outbound `<Gather>` lane and the
`/turn` webhook (both transports' mid-call turns) cannot speak ElevenLabs
without first migrating onto ConversationRelay.

## 3. ElevenLabs via ConversationRelay — what the research found

twilio.com/docs/voice/twiml/connect/conversationrelay and
twilio.com/docs/voice/conversationrelay/voice-configuration (fetched
2026-09-11):

- `<ConversationRelay>` takes `ttsProvider` (`Google` | `Amazon` |
  `ElevenLabs`) and `voice`.
- ElevenLabs-specific tuning rides **inside** the `voice` string itself:
  `<voiceId>-<model>-<speed>_<stability>_<similarity>`, e.g.
  `ZF6FPAbjXT4488VcRRnw-flash_v2_5-1.2_1.0_1.0` (Twilio's own worked example,
  twilio.com/en-us/blog/integrate-elevenlabs-voices-with-twilios-conversationrelay,
  2025-05-29). Supported model suffixes: `flash_v2`, `turbo_v2_5`,
  `turbo_v2`, and the default `flash_v2_5`.
- `elevenlabsTextNormalization` (`on`/`auto`/`off`) has a
  **ConversationRelay-specific quirk**: *"`auto` has the same effect as `off`
  for Conversation Relay voice calls"* — unlike the direct ElevenLabs API,
  where `auto` genuinely means "decide per request." Forwarding this repo's
  direct-API constant (`ELEVENLABS_TEXT_NORMALIZATION = "auto"`) into
  ConversationRelay would silently mean OFF.
- SSML support differs by provider: Google/Amazon honor the full SSML tag
  set; **ElevenLabs via ConversationRelay only supports `<break>`, and only
  for `en-US`.**
- Latency/quality: Twilio's own core-latency guide
  (twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents,
  2025-11-17) reports ConversationRelay end-to-end at p50 ≈ 491 ms / p95 ≈ 713 ms
  across "leading STT and TTS providers including Amazon, Deepgram,
  ElevenLabs, Google." A third-party 2026 comparison
  (tools.inyourleague.net, 2026-03-18) puts ElevenLabs' MOS naturalness score
  (4.5–4.7) above Amazon Polly (3.8–4.2) and roughly level with or above
  Google (4.0–4.4), at a comparable TTFB once Flash v2.5 is selected (~75ms
  model inference per ElevenLabs' own figures).
- **`ai_identity_profiles.voice_provider`'s live CHECK constraint admits ONLY
  `'elevenlabs'`** (`scripts/vendor-retirement-guard.ts`: *"voice_provider
  vocabulary is ElevenLabs only, matching the live CHECK"*) — the owner
  already retired the alternative voice vendor from the product. This is not
  a live choice between vendors; ElevenLabs is the platform's one storable
  voice provider. What was missing was the **wire**, not a decision.

## 4. Recommendation (and what was wired this wave)

**Use ElevenLabs via ConversationRelay, with Flash v2.5 for the model.**
Matches the existing DB-level vendor decision, gives every phone call the
SAME realism-tuned voice settings (`ELEVENLABS_REALISM_VOICE_SETTINGS`,
`lib/video/realism-profile.ts`) the avatar/reel narration already uses, and
lets a brokerage/agent's own cloned voice answer the phone — today the phone
receptionist sounds like a generic Twilio voice even when the SAME agent's
avatar videos sound like them.

**Wired this wave** (`lib/voice/conversation-relay.ts`
`conversationRelayTtsAttrs`, called from
`app/api/voice/twilio/inbound/route.ts`'s `answerTwiml`):

- `ttsProvider="ElevenLabs"`, `voice="<voiceId>-flash_v2_5-1.0_<stability>_<similarity>"`
  built from the ONE realism constant, using the resolved
  brokerage/team/agent clone id when one exists, else ElevenLabs' own stock
  voice (`FALLBACK_VOICE_ID` — the same fallback every other realism-tuned
  caller uses, §6).
- `elevenlabsTextNormalization="on"` explicitly (the `auto`-means-`off`
  ConversationRelay quirk above).
- **Fallback to Twilio-native Google** ONLY when `ELEVENLABS_API_KEY` is
  unset/unreachable — never a per-tenant vendor preference, matching the
  DB's own ElevenLabs-only constraint.
- Covers both scopes that already answer through `answerTwiml`: the
  PLATFORM's own line and every tenant brokerage/agent line — but **only**
  when `relayConfigured()` is true (`CONVERSATION_RELAY_WSS_URL` +
  `RELAY_SHARED_SECRET` set — the relay companion, `tools/relay-companion`,
  must be deployed). Unset, the call still answers correctly on the
  `<Gather>` lane exactly as before — a fully additive change.

**NOT wired this wave (documented gap, not silently accepted):**

- **Outbound AI-ISA calls** (`app/api/voice/twilio/outbound/route.ts`) never
  check `relayConfigured()` — they are Gather-lane only, so they
  structurally cannot speak ElevenLabs regardless of this wave's change (§2
  above). `buildCallContext`'s resolved `voiceConfig` remains discarded.
  Migrating outbound onto ConversationRelay is a genuine follow-up (a new
  "place an outbound call that answers into ConversationRelay" flow, not a
  one-line wire) — out of scope for this wave's effort budget. Recorded here
  rather than silently left for the next reader to rediscover.
- The `/turn` webhook (the Gather lane's mid-call turns, shared by inbound
  and outbound) is unaffected — the transport-level voice is set once per
  call at `<Connect><ConversationRelay ttsProvider… voice…>`, not per turn,
  so no further wiring is needed there once a call is on ConversationRelay.

## 5. D-ID V4 Expressive (adjacent finding, task item 4)

Reachable, but **not** as an addition to `DID_TALK_REALISM_CONFIG`
(`lib/video/realism-profile.ts`) — V4 submits to a structurally different
endpoint (`/expressives`, a `presenter_id`-keyed request) than `/talks`/
`/clips` (a `source_url`-keyed request), and is **already wired** at
`lib/did/index.ts`'s `generateVideo()`, gated by
`lib/did/agent-presenter.ts`'s `presenterTypeForTwin` (the `"@avt_"` id
marker). Custom/personal V4 avatars are documented as an **Enterprise-plan-only**
feature (d-id.com/ai-avatars/'s comparison table) — this account's D-ID plan
tier is not visible from here, so whether our agents can even mint a V4
`presenter_id` today is **unresolved**.

The real, closeable gap this wave found and fixed:
`lib/providers/dispatch.ts`'s `dispatchVideoViaDID` (the agent-outreach
EMAIL avatar-video path) never selected `agent_voice_profiles.did_avatar_id`
at all, so it could never detect an agent who has upgraded to a V4
Expressive avatar — every outreach video silently used the older `/talks`/
`/clips` path regardless. Fixed by selecting `did_avatar_id` and branching
through the same `presenterTypeForTwin` detector `lib/did/index.ts` already
uses (one detector, two callers, §6) — see `lib/video/realism-profile.ts`'s
"§ D-ID V4 EXPRESSIVE — REACHABILITY FINDING" header for the full research.

## Sources (all Exa-fetched/searched 2026-09-11 unless a publish date is shown)

- twilio.com/docs/voice/twiml/connect/conversationrelay
- twilio.com/docs/voice/conversationrelay/voice-configuration
- twilio.com/docs/voice/conversationrelay/websocket-messages
- twilio.com/docs/voice/twiml/say/text-speech
- twilio.com/en-us/blog/integrate-elevenlabs-voices-with-twilios-conversationrelay (2025-05-29)
- twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents (2025-11-17)
- tools.inyourleague.net/en/elevenlabs-vs-polly-vs-google-tts-vs-azure-speech-comparison-en/ (2026-03-18)
- coval.ai/blog/best-text-to-speech-providers-in-2026-how-to-choose-(and-why-vendor-benchmarks-lie)/ (2026-06-01)
- elevenlabs.io/docs/overview/models, elevenlabs.io/docs/eleven-api/choosing-the-right-model
- help.elevenlabs.io "What is Eleven v3", "What models do you offer and what is the difference between them?"
- d-id.com/introducing-v4-expressive-avatars/ (2026-02-02), d-id.com/ai-avatars/ (2026-01-04)
- docs.d-id.com (Videos V4 OpenAPI; createtalk reference)
