# Twilio vs. ElevenLabs for voice + calls — 2026-09 research

Owner's question (wave 58, verbatim): *"we moved to twilio… since we use twilio for
the phone IVR we thought we could just use one provider for voice and calls — your
opinion."*

**Short answer: yes — one provider, and it is Twilio.** Twilio is the carrier (the
phone numbers, PSTN, AMD, recording, compliance webhooks this repo's whole
`voice_calls` ledger and TCPA gate stack are built on). ElevenLabs stays as the
*voice engine* riding **inside** Twilio's own transport (`<ConversationRelay
ttsProvider="ElevenLabs">`) — which this repo already wired in wave 57
(`conversationRelayTtsAttrs`) and extended this wave to the outbound lane and to a
realistic AMD voicemail `<Play>`. That is "one provider for voice and calls" in the
literal sense the owner asked for: **one vendor bill for telephony, one vendor bill
for voice quality, zero new accounts, zero rebuild of the compliance stack.** The
alternative — routing calls through ElevenLabs' own Conversational AI agent runtime
with Twilio merely as a SIP trunk — is not cheaper, does not remove a vendor (Twilio
is still required as the carrier either way), and would require re-platforming this
repo's own reception brain, TCPA gates, and call ledger onto ElevenLabs' agent/tool
system. Detailed reasoning and numbers below. No code was changed by this research —
see the companion wave-58 build (`lib/voice/render-voice-drop.ts`,
`app/api/voice/twilio/outbound/route.ts`, `OutboundCallBrief.elevenlabsVoiceId`) for
what shipped behind the existing seams.

All figures below are self-serve, publicly listed rates as of the source dates
cited; Twilio and ElevenLabs both offer negotiated enterprise/committed-use
discounts not reflected here (typically 15-35% off list per Twilio's own
enterprise page).

---

## 1. Capability matrix

| Capability | Twilio-native | Twilio + ElevenLabs (ConversationRelay) | ElevenLabs Conversational AI 2.0 |
|---|---|---|---|
| Owns the phone number / PSTN | ✅ | ✅ (same) | ❌ — "bring your own telephony"; ElevenLabs is not a carrier ([elevenlabs.io/agents/integrations/twilio](https://elevenlabs.io/agents/integrations/twilio)) |
| Inbound calls | ✅ | ✅ | ✅ (native Twilio integration + SIP trunking, both directions — [elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration)) |
| Outbound calls | ✅ | ✅ | ✅ (same doc; also `agents/references/outbound-calls.md`, and full SIP trunking outbound since Conversational AI **2.0**, May 2025 — v1 was "Twilio inbound only") |
| Voice engine | Twilio TTS (Basic/Standard/Neural/Generative — Polly + Google) | **ElevenLabs** (`ttsProvider="ElevenLabs"`, Flash 2.5 default, or `flash_v2`/`turbo_v2_5`/`turbo_v2` via the voice-id suffix) — same engine as (c) | ElevenLabs (Eleven v3 / Flash v2.5 / Turbo v2.5) |
| STT | Twilio-native `<Gather input="speech">`, or Deepgram/Google via ConversationRelay | Deepgram (default since Sept 12 2025) or Google | ElevenLabs' own ASR pipeline |
| Turn-taking / barge-in | `<Gather>`: none (post-utterance only); ConversationRelay: `interruptible`/`interruptSensitivity` attrs, this repo's own `composePacingRule` | same as native ConversationRelay | ElevenLabs' **dedicated turn-taking model** (2.0's headline feature — purpose-built, not a generic interrupt flag) |
| Median end-to-end latency | n/a (turn-based `<Gather>` is a full round trip, ~1-2s) | ConversationRelay ~491ms median ([versusref.com](https://www.versusref.com/voice-ai/tools/twilio-conversationrelay/), Jul 30 2026); Flash v2.5 TTFB ~75ms | Sub-100ms cited by ElevenLabs and independent reviews ([digitalbydefault.ai](https://digitalbydefault.ai/blog/elevenlabs-conversational-ai-voice-agents-2026), 2026-04-15; [litmustools.com](https://litmustools.com/review/elevenlabs-agents/), 2026-06-29) |
| Automatic language detection mid-call | Google/Amazon only, manual switch | ✅ `multi` mode — **requires** Deepgram STT + ElevenLabs TTS (Twilio will terminate the session on any other provider combo — [docs.twilio.com/voice/twiml/connect/conversationrelay](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay)) | ✅ integrated automatic language detection, 70+ languages, mid-call character switching |
| RAG / knowledge base | Bring your own (this repo: `loadInventoryContext` per-turn) | same (brain stays in-app) | Integrated RAG, low-latency, in-platform |
| Function/tool calling | Bring your own (this repo: `VoiceTurnAction` — book/rsvp/seller_lead/callback/transfer) | same | Native tool system |
| AI→human handoff | Build your own (this repo: `redirectLiveCallToDial` + warm-bridge conference) | same | Native handoff to your own SIP/webhook target; no Flex-equivalent of its own |
| Managed no-code agent builder | "AI Assistants" — **discontinued**, retiring July 2026 ([twilio.com/code-exchange/ai-assistants-samples](https://www.twilio.com/code-exchange/ai-assistants-samples); error 99002 confirms discontinuation) → superseded by **Twilio Agent Connect (TAC)**, GA 2026-05-06 at SIGNAL 2026 ([twilio.com/en-us/changelog/twilio-agent-connect-is-now-generally-available](https://www.twilio.com/en-us/changelog/twilio-agent-connect-is-now-generally-available)) — a **self-hosted** Python/TS SDK, model-agnostic (OpenAI/Bedrock/Anthropic/LangChain), ConversationRelay-only mode for voice | n/a — this repo already built the equivalent in-house (`reception-brain.ts` + `signal-routing.ts`), see §4 | ElevenLabs' own no-code Agents dashboard (persona, tools, knowledge config UI) |
| Real-time conversation analytics | **Conversation Intelligence** — GA 2026-05-06, language operators (sentiment, summary, custom), real-time triggers | same (Twilio-side, transport-independent — this repo's `intelligenceService` TwiML attribute already threads it into `<ConversationRelay>`) | ElevenLabs' own post-call analytics dashboard; no live in-call operator equivalent published |
| Call quality telemetry (jitter/packet loss/MOS) | **Voice Insights** — per-second (SDK) / 10-second (SIP/carrier) sampling | same | not published |
| Compliance certifications | SOC 2 Type II, HIPAA, GDPR, ISO 27001, PCI DSS (ConversationRelay; HIPAA needs Security/Enterprise Edition) | same, transport is Twilio's | SOC 2 Type 2, ISO 27001/42001, PCI DSS 4.0 L1, HIPAA-eligible w/ BAA (per [litmustools.com](https://litmustools.com/review/elevenlabs-agents/)) |
| Voicemail drop (`<Play>` a pre-rendered clip on AMD) | ✅ native `<Play>`/AMD combo, this repo's mechanism (§4) | ✅ same — AMD/`<Play>` is orthogonal to which transport handles the *live* leg | Not applicable in the same shape — no AMD/`<Play>` primitive of its own; would need its own outbound-answering-machine logic layered on top of Twilio's AMD anyway since ElevenLabs doesn't own the PSTN leg |
| Verify / Lookup (number validation, fraud, line type) | ✅ Twilio-only — no ElevenLabs equivalent | ✅ same | — |

---

## 2. Cost per call minute

Numbers exclude the LLM/reasoning cost (this repo's own AI gateway call), which is
identical across all three scenarios and orthogonal to the voice/telephony choice.
"Blended telephony" below = a mix of inbound local ($0.0085/min) and outbound local
($0.014/min) — this repo's ISA calls are mostly outbound, so real blended cost skews
toward the outbound figure; $0.011/min is a rough midpoint.

### (a) Twilio-only (native TTS + Conversational Intelligence)

| Line item | Rate | Source |
|---|---|---|
| Telephony (blended local) | ~$0.011/min | [apio.sh/apis/twilio-conversationrelay](https://apio.sh/apis/twilio-conversationrelay) (2026), citing twilio.com/en-us/voice/pricing/us |
| TTS — Neural (`<Say>`, Polly Neural/Google Neural2) | ~$16/1M chars ≈ **$0.012/min** at ~750 spoken chars/min (~150 wpm) | [awesomeagents.ai/pricing/voice-tts-pricing](https://awesomeagents.ai/pricing/voice-tts-pricing/) (2026-04-19) |
| TTS — Generative (Polly Generative/Google Chirp3-HD, **Public Beta**) | ~$30/1M chars ≈ ~$0.0225/min (beta pricing may change) | [docs.twilio.com/voice/twiml/say/text-speech](https://www.twilio.com/docs/voice/twiml/say/text-speech) |
| AMD (per call, not per minute) | $0.0075/call | [twilio.com/en-us/voice/pricing/us](https://www.twilio.com/en-us/voice/pricing/us) |
| Voice Insights (optional) | $0.0024/min (first 100K min/mo tier) | [twilio.com/en-us/voice/pricing/us](https://www.twilio.com/en-us/voice/pricing/us) |
| Conversation Intelligence (optional, per operator execution) | $0.005/1K chars Twilio-authored; $0.002 in / $0.018 out custom | [twilio.com/en-us/products/conversational-ai/pricing](https://www.twilio.com/en-us/products/conversational-ai/pricing) |

**All-in estimate: ~$0.013-0.015/min** bare (Neural TTS, AMD amortized, no
Intelligence/Insights), **~$0.03-0.05/min** with Conversation Intelligence +
Voice Insights turned on. Cheapest of the three, but the voice is Neural
Polly/Google — solid for IVR, noticeably less expressive than ElevenLabs on a
sales/nurture call (MOS ~3.8-4.4 vs ElevenLabs' 4.5-4.7 — §3).

### (b) Twilio telephony + ElevenLabs voice via ConversationRelay (what this repo now does, both directions)

| Line item | Rate | Source |
|---|---|---|
| ConversationRelay orchestration | $0.07/min | [twilio.com/en-us/products/conversational-ai/pricing](https://www.twilio.com/en-us/products/conversational-ai/pricing) — "Conversation Relay: $0.07/minute (voice costs calculated separately)" |
| Telephony (blended local) | ~$0.011/min | same as (a) |
| ElevenLabs TTS itself | **No separate ElevenLabs invoice** — ElevenLabs is a first-class `ttsProvider` inside ConversationRelay with no ElevenLabs account required; Twilio's own service "nutrition facts" label the base model as "ElevenLabs Text-To-Speech: Flash 2 and Flash 2.5" as part of the *Programmable Voice* product, not a pass-through bill | [docs.twilio.com/voice/twiml/connect/conversationrelay](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay) nutrition-facts JSON |

**All-in estimate: ~$0.081/min.** "Voice costs calculated separately" on Twilio's
pricing page refers to the **telephony leg** (PSTN/SIP/WebRTC minutes), not a
second ElevenLabs bill — confirmed by ConversationRelay's own default-voice table
listing ElevenLabs voice IDs as the **default** for nearly every locale with no
separate provider toggle or account-linking step, unlike (c) below where linking a
real ElevenLabs account is the first setup step. (Caveat: no line-item breakdown of
what fraction of the $0.07/min is STT vs. TTS vs. orchestration has been published;
if Twilio's enterprise contracts price ElevenlLabs usage separately at volume, that
would change this, so confirm at committed-use tier before treating this as final.)

### (c) ElevenLabs Conversational AI 2.0 with Twilio SIP/native integration

| Line item | Rate | Source |
|---|---|---|
| ElevenLabs Agents (Business tier, 12,375 min/mo included) | $990/mo ⇒ ~$0.08/min effective; overage $0.08/min flat; burst (over concurrency) $0.16/min | [litmustools.com/review/elevenlabs-agents](https://litmustools.com/review/elevenlabs-agents/) (2026-06-29), [cloudtalk.io/blog/elevenlabs-pricing](https://www.cloudtalk.io/blog/elevenlabs-pricing/) (2026-06-14) |
| Telephony — still Twilio, "bring your own" | ~$0.011/min (PSTN) or ~$0.004/min (native SIP interface) | same Twilio rate card; ElevenLabs is not the carrier |
| LLM | billed separately by the LLM provider, same as (a)/(b) | ElevenLabs' own docs, stated plainly |

**All-in estimate: ~$0.084-0.091/min** (Business tier + PSTN), or **~$0.08/min
flat** if routed over a discounted native-SIP interface instead of PSTN minutes.
Two vendor invoices (ElevenLabs subscription + Twilio telephony) instead of one.

### Bottom line on cost

(b) and (c) land within a few tenths of a cent of each other and both cost roughly
**5-6x** scenario (a)'s bare rate — the premium is for ElevenLabs' voice quality,
not for which company routes the request. **(b) is at least as cheap as (c) while
requiring only ONE vendor account for voice+telephony** (Twilio), not two. That is
the concrete answer to "one provider."

---

## 3. Realism ranking

1. **ElevenLabs (Eleven v3 / Flash v2.5 / Turbo v2.5)** — MOS 4.5-4.7, the
   consistent quality leader across every 2026 benchmark surveyed
   ([texttolab.com](https://texttolab.com/blog/elevenlabs-vs-amazon-polly), 2026-06-10;
   [inyourleague.net](https://tools.inyourleague.net/en/elevenlabs-vs-polly-vs-google-tts-vs-azure-speech-comparison-en/),
   2026-03-18). Identical whether reached via Twilio ConversationRelay (b) or
   ElevenLabs' own runtime (c) — same underlying model, so **no realism difference
   between (b) and (c)**; the realism gain over (a) is what the extra ~$0.065/min
   buys, not which vendor owns the pipe.
2. **Twilio Generative voices (Polly Generative / Google Chirp3-HD)** — "genuinely
   better" than Neural, "closes the gap with mid-tier premium providers" per
   independent reviews, but still Public Beta on Twilio and English-only for Polly
   Generative.
3. **Twilio Neural voices (Polly Neural / Google Neural2/WaveNet)** — "good, clear
   but flat… like a competent GPS voice," per [texttolab.com](https://texttolab.com/blog/elevenlabs-vs-amazon-polly).
   Fine for IVR menus and transactional confirmations; not what the owner meant by
   "must not think it was made with AI" for a nurture/sales call.
4. **Twilio Basic/Standard voices** — "clearly synthetic," bottom tier.

---

## 4. What this repo already has (and what wave 58 added)

- `lib/voice/twilio-voice.ts` — the Twilio-native turn-based `<Gather>` reception
  lane; `resolveInboundContext` walks the agent→team→brokerage `ai_identity_profiles`
  cascade for identity, tone, and `elevenlabs_voice_id`.
- `lib/voice/conversation-relay.ts` — `conversationRelayTtsAttrs` (wave 57):
  resolves `ttsProvider`/`voice`/`elevenlabsTextNormalization` from the SAME
  `elevenLabsModelForLane` selector the video pipeline uses (`ELEVENLABS_PHONE_MODEL_ID`
  = `eleven_flash_v2_5`, ElevenLabs' own real-time recommendation), with a Google
  fallback gated ONLY on `ELEVENLABS_API_KEY` reachability — never a vendor
  preference. `relayConfigured()` is the transport switch (`CONVERSATION_RELAY_WSS_URL`
  + `RELAY_SHARED_SECRET`); unset, the repo runs the plain `<Gather>` lane with zero
  code changes needed.
- `lib/voice/reception-brain.ts` — the engine-agnostic brain: system prompt, legal
  disclosures, `VoiceTurnAction` (book / rsvp / seller_lead / callback / transfer /
  hangup). This IS this repo's own equivalent of Twilio Agent Connect's tool system
  and ElevenLabs Agents' persona/tool config — built in-house, already live, and not
  something either vendor's newer "Agent" product would replace without a rewrite.
- `app/api/voice/twilio/*` — inbound, outbound, turn, status, recording, intelligence
  webhooks; `app/api/voice/relay/plan/route.ts` is the ConversationRelay
  companion-facing brain endpoint (secret-gated) that runs the exact same
  planners/actors as the `<Gather>` turn route — zero drift by construction.
- `lib/ai-isa/*` — the AI-ISA outreach/nurture layer that calls `placeOutboundAiCall`;
  `build-call-context.ts` resolves a per-call `voiceConfig` (agent clone → brokerage
  default) that, **as of this wave**, actually reaches the call (it used to be
  computed and dropped — see the companion build's `OutboundCallBrief.elevenlabsVoiceId`).
- `lib/video/call-analysis.ts` / `call-analyses` — transcript-based post-call
  intelligence (objections, urgency, coaching score) already exists as this repo's
  OWN implementation of what Twilio Conversation Intelligence's language operators
  would provide — built before Conversation Intelligence reached GA, and
  functionally overlapping with it today.
- **This wave (58) additionally shipped, behind these exact seams, no provider
  switch**: an outbound ConversationRelay transport (`app/api/voice/twilio/outbound/route.ts`
  now offers the SAME transport switch the inbound lane has always had), the
  resolved-voice wire (`OutboundCallBrief.elevenlabsVoiceId`, threaded from
  `buildCallContext`'s `voiceConfig` through to both the ConversationRelay leg and
  the new voicemail-drop render), and `lib/voice/render-voice-drop.ts` — a realistic,
  pre-rendered ElevenLabs `<Play>` for the AMD-voicemail case (Twilio's own AMD
  best-practices doc explicitly recommends exactly this shape: `<Play>` a
  pre-rendered file rather than `<Say>` live TTS into a voicemail box, because
  "voicemail systems hate streaming TTS… render once, store, play the file" —
  [twilio.com/docs/voice/answering-machine-detection-faq-best-practices](https://www.twilio.com/docs/voice/answering-machine-detection-faq-best-practices)).

---

## 5. Other Twilio capabilities surveyed, not yet wired here

- **Conversational Intelligence** (GA 2026-05-06) — real-time language operators
  (sentiment, summary, custom extraction) with in-call trigger rules. This repo's
  `call-analyses` pipeline covers similar ground post-hoc; Conversational
  Intelligence's *in-call* triggers (e.g., auto-flag a Fair Housing risk phrase the
  instant it's spoken, not after the call ends) are a real capability gap worth a
  future BUILD — `intelligenceService` is already threaded into
  `twimlConnectRelay` but no operator rules are configured.
- **Voice Insights** — call-quality telemetry (jitter/packet loss/MOS). Not
  currently surfaced anywhere in this repo's voice dashboards; a candidate BUILD if
  call-quality complaints ever need root-causing.
- **Twilio Verify / Lookup** — phone validity, line-type intelligence, SIM-swap and
  SMS-pumping fraud scoring. No overlap with ElevenLabs. Worth a future look for
  `lib/communication/phone-reachability.ts` / the TCPA gate stack (e.g., refusing to
  dial a number Lookup flags as a non-fixed VoIP/burner line before it ever reaches
  `runOutboundCallGates`) — out of scope for this wave.
- **Twilio Agent Connect (TAC)** — GA 2026-05-06, the successor to the now-discontinued
  "AI Assistants." A self-hosted, model-agnostic SDK with built-in Conversation
  Memory/Orchestrator integration and a packaged Studio/Flex handoff tool. Not
  recommended as an adoption target: this repo already owns an equivalent
  reception-brain + signal-routing stack, tuned to real-estate compliance (Fair
  Housing, TCPA, disclosure) that TAC knows nothing about, and TAC's main structural
  offer — cross-channel Conversation Memory/Orchestrator — duplicates this repo's
  own contact/lead timeline. Adopting TAC would mean re-platforming working code for
  a generic memory layer this repo's Supabase schema already is.

---

## 6. Recommendation

**Stay exactly on the path wave 57/58 already built: Twilio owns the call (numbers,
PSTN, AMD, recording, TCPA/compliance webhooks); ElevenLabs owns the voice, riding
inside Twilio's own ConversationRelay transport, gated purely on `ELEVENLABS_API_KEY`
reachability.** Concretely, this means:

1. **Do not migrate to ElevenLabs Conversational AI 2.0 as the call platform.** It
   is not the carrier (still needs Twilio underneath for the actual phone number and
   PSTN leg — "bring your own telephony"), is not cheaper (§2: ~$0.084-0.091/min vs.
   ~$0.081/min), and would require rebuilding this repo's TCPA gate stack, AMD/voicemail
   logic, recording pipeline, and reception brain against ElevenLabs' agent/tool
   system instead of the Twilio webhooks they are built on today. It trades a
   finished, compliance-hardened integration for a second vendor bill and a rewrite,
   for the SAME underlying voice quality this repo already gets for less.
2. **Do not adopt Twilio Agent Connect** as a framework. It solves problems (memory,
   orchestration, model-agnostic tool calling) this repo already solved with its own
   schema and `reception-brain.ts` — adopting it would mean migrating working,
   compliance-specific logic onto a generic layer with no real-estate awareness.
3. **Do** finish rolling the ConversationRelay transport out everywhere a call is
   placed or answered (this wave closed the outbound gap — inbound already had it),
   and **do** keep the AMD-voicemail `<Play>` upgrade (this wave) as the honest,
   pre-rendered alternative to a robotic `<Say>` when a machine picks up — this
   matches Twilio's own published best practice for the exact scenario.
4. **Consider, as separate future work (not required to answer "one provider")**:
   Conversation Intelligence in-call operators for real-time Fair Housing/compliance
   flagging (this repo currently only catches these patterns post-call), and Twilio
   Lookup's line-type intelligence ahead of the outbound gate stack to avoid dialing
   known-bad numbers before TCPA/suppression even runs.

**Net: one provider for voice and calls, in the sense that matters — one carrier
relationship (Twilio), one voice-quality vendor relationship (ElevenLabs, already
paid for and already the SAME engine this repo's avatar/reel video uses) — rather
than one company for everything, which neither vendor's current product actually
offers without giving up something this repo has already built and paid for.**
