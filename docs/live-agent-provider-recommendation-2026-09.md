# Live "view agent" talk / chat — provider recommendation (2026-09-12)

Owner question (wave 60): *"be sure that we are using the best provider and
cost effective like d-id/twilio/elevenlabs for live (view agent) talk/live
talk/chat… if there is another provider that will achieve this, then make
sure you give your suggestions."*

Method: Exa web search (skill: exa-search) over 2026 comparisons
(meetcody.ai 2026-08-28, docket.io 2026-08-04, anam.ai/compare, codeables
2026-03/04, callsphere 2026-03-25, kompozy 2026-05-06), D-ID's pricing, V4
launch (2026-03-16) and self-hosting (2026-07-23) pages; ecc `agentic-os` and
`product-capability` lenses for the surface breakdown. Companion docs:
`docs/ai-agent-surfaces-2026-09.md` (text brain per surface),
`docs/twilio-vs-elevenlabs-voice-2026-09.md` (phone), 
`docs/avatar-provider-recommendation-2026-09.md` (async avatar video, no HeyGen).

## 1. What "live talk" is in this OS

Three surfaces already open the same live agent (wave 58): public website
(`SiteChatLauncher`), embed widget (`app/embed/[publicId]`), and the client
portal Live tab. The **brain is ours** (`app/api/did/custom-llm`, gateway
lane gemini-2.5-flash → gpt-5-mini), the **voice is the agent's ElevenLabs
clone** (same voice as phone and videos), and the **face** is D-ID Express v4
via `@d-id/client-sdk` (LiveKit-based Expressives, mic input, always-on
fluent mode). The only provider-owned leg is the face render + WebRTC
transport. That is the leg this document is about.

## 2. 2026 landscape (published figures, list prices)

| Provider | Mode | Avatar source | Transport / frameworks | Published latency | Price (render leg) | Consent |
|---|---|---|---|---|---|---|
| **D-ID Express v4** (current) | Agent (bundled) or BYO brain | one image | WebRTC (Janus / LiveKit for V4), `@d-id/client-sdk`, no LiveKit/Pipecat plugin | "low latency", no figure; rated slowest in independent tests | ~$0.35/min blended; plans from $5.90/mo; minutes expire monthly; API and Studio share one balance | 428 consent gate (ours) + D-ID likeness terms |
| **Simli** | Audio-to-Video (render only) or Agent | one photo | WebRTC (Daily), LiveKit + Pipecat plugins, no-code widget, "Simli Auto" | < 300 ms speech-to-video | **$0.009/min** render only (STT/LLM/TTS/transport extra) | consent at avatar creation |
| **Anam (Cara-4, Jul 2026)** | Agent, BYO LLM | one photo | WebRTC (Pion), LiveKit plugin (Aug 2025) | sub-1 s conversation, 150–180 ms server | $0.18–0.24/min blended; ~5 concurrent sessions on ~$299/mo | SOC 2 II, HIPAA, ZDR |
| **Tavus (Phoenix-4 CVI)** | Agent (bundled LLM/TTS/perception) | 2-min recording + live webcam consent | WebRTC (Daily), LiveKit + Pipecat | sub-600 ms; 55 ms floor prediction | $0.32 (Growth $395/mo, 15 concurrent) – $0.59/min; 30 s minimum, 6 s rounding | strict, recorded |
| **Beyond Presence** | S2V or Agent | short video | WebRTC (LiveKit), Pipecat | < 100 ms inference, ≤ 250 ms global | €0.087–0.175 S2V / €0.175–0.35 agent | recorded |
| HeyGen LiveAvatar | Agent + A2V | 2-min video + consent | WebSocket/WebRTC (LiveKit), Pipecat, TEN | ~471 ms TTFB (disputed) | Lite ≈ ½ Full | recorded, live outside Enterprise | **excluded by owner ruling** |

Two facts from every 2026 source matter more than the sticker: (1) **the
end-to-end number the visitor feels is 600 ms – 1.5 s and is dominated by
turn-taking + LLM + TTS, not the face render**; (2) **if you already own a
working voice agent, buy an Audio-to-Video API, not an Agent API** — you keep
the brain, the voice and the compliance gates, and pay only for the face.

## 3. Recommendation

**Keep D-ID Express v4 as the live agent this wave. Do not switch.** It is
integrated on all three surfaces with the consent gate, the persona cascade,
callback tasks and the 4-hourly agent sync already built and proven
(`test:did-live-agent`, 50 checks); V4 is on every D-ID plan; and the same
D-ID account renders the async avatar videos, so one vendor relationship
covers both the live and the recorded face. Nothing in the research shows
D-ID unfit; it shows D-ID *priciest per render minute and least measured on
latency*, which is a reason to instrument, not to migrate mid-production.

**What to build now (wave 60 lane A), provider-neutral:**

1. **Meter live minutes to the tenant.** Live sessions are platform-paid
   (§5). Every session start/end must book a vendor-usage row (`did`,
   `streaming_minutes`, estimated `$0.35/min` list until the contract rate is
   known) keyed on the brokerage from the embed/portal session — never the
   body — so the overage projection sees it.
2. **Instrument the turn.** Log custom-llm turn latency (`execution_time_ms`)
   and D-ID session init success/failure so the provider decision becomes a
   measured one within a month of production traffic.
3. **Fail over to text.** If the D-ID session does not initialise (quota,
   concurrency cap, key), the launcher must open the same brain as a text
   chat automatically — the visitor always gets a full conversation.
4. **Identity consistency proof.** The live agent's voice id, avatar image and
   brand prompt must equal the ones the phone lane and the video lane use
   (one persona across text, voice, avatar, video).

**Suggestions if D-ID's measured latency or cost proves unacceptable (not
built; behind a `face-render` seam only if adopted):**

- **Simli Audio-to-Video** — cheapest render leg by 30–40× ($0.009/min),
  < 300 ms, single-photo avatar, LiveKit/Pipecat plugins. Fits this OS
  exactly because the brain and voice are already ours. Cost of adoption:
  a LiveKit (or Daily) transport we do not run today, STT for the visitor's
  mic, and a second consent flow.
- **Anam Cara-4** — best quality/latency claims with BYO LLM, SOC 2/HIPAA/ZDR;
  concurrency caps are low at entry tiers.
- **Tavus** — highest bundled quality but bundles a brain and TTS we would
  not use, strict recorded consent, highest overage.

## 4. Consistency ruling (unchanged)

One persona per agent: the same name, photo/twin, ElevenLabs cloned voice
and brand-voice prompt in the text chat, the phone receptionist, the live
avatar and every rendered video. Providers are swappable underneath; the
identity is not.

## 5. Blind spots

D-ID's per-plan streaming-minute allotment, API rate limits and the V4
custom-avatar tier are still not published in a machine-readable place
(pricing pages render client-side); the ~$0.35/min figure is a 2026
third-party blended estimate, not D-ID's contract rate. No live session was
run in this wave (no D-ID credentials in the session); latency claims are the
vendors' own.
