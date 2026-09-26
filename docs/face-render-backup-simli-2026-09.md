# Simli as the live-avatar BACKUP face renderer (2026-09-14)

Owner ruling (wave 62, verbatim): *"I think building simili [Simli] as a backup
makes more sense then heygen."* This supersedes the wave-60 stance of
"Simli suggested, not built". D-ID Express v4 stays PRIMARY. HeyGen is not
added (standing ruling).

Method: docs.simli.com fetched 2026-09-14 (skill: exa-search — `llms.txt`,
`compose-session-token`, `generate-trinity-face`, `check-trinity-generation-
status`, `preprocess-trinity-face-image`, `javascript`, `api_migration_guide`);
ecc `agentic-os` for the seam placement; `verification-loop` for the proof.
Companion: `docs/live-agent-provider-recommendation-2026-09.md` (the
landscape and why D-ID stays primary), `docs/twins-and-avatars-how-it-works-
2026-09.md` (how the twin the Simli face is built from is created and stored).

## 1. The fail-over chain, end to end

```
visitor opens Live tab / embed widget / site launcher
  → POST /api/did/agents/session   (portal)      ─┐  same brain, same voice,
  → POST /api/embed/session        (embed/site)  ─┘  same consent row
      1. ensureDIDAgent + issueClientKey  → D-ID Express v4 (PRIMARY)
      2. on D-ID init failure:
           resolveFaceRenderProvider(brokerage)   — m627 order, default ['did','simli']
           simliFaceRenderAdapter.startSession    — Simli (BACKUP)
      3. on Simli refusal: existing 502 → same-brain TEXT chat (wave 60)
```

Nothing on the D-ID success path changed. The Simli branch lives *inside*
the existing `if (!ensured.ok)` block on both doors and is proven there
(`test:face-render-seam` §doorsWired).

## 2. What Simli is given and what it is not

| Leg | Provider | Where |
|---|---|---|
| Brain (every turn) | ours — `/api/did/custom-llm`, gateway lane gemini-2.5-flash → gpt-5-mini | `app/api/live-agent/simli-turn` relays the visitor's text to it server-side with `DID_CUSTOM_LLM_KEY`; tenant from the `live_agent_sessions` row, never the body |
| Voice | the agent's ElevenLabs clone, `format=pcm_16000` | `app/api/internal/voice-tts` (new additive branch; mp3 default unchanged) |
| Face | Simli Trinity face built from the twin's own re-hosted still | `lib/providers/simli/faces.ts` |
| Transport | Simli LiveKit mode — no LiveKit/Daily infra of ours | `simli-client@3.x`, dynamic import in `SimliFaceSession.tsx` |
| Mic | browser SpeechRecognition → text → our brain | `SimliFaceSession.tsx` |

Simli never sees the brand prompt, the CRM, or a contact record. It receives
PCM audio and returns video frames. That is the whole integration surface.

## 3. Consent, identity, storage

- **Same consent row.** `ensureSimliFaceForAgent` reads `findVerifiedConsent`
  from `lib/did/consent.ts` — the one `agent_did_consents` check the D-ID
  428 gate uses — BEFORE any face is created. No consent → typed
  `ConsentRequired` refusal → text chat. The D-ID consent path
  (`app/api/did/create-avatar`, `lib/did/consent.ts`) was not edited.
- **Same identity row.** The Simli face id is cached on
  `agent_avatar_assets.simli_face_id` (m627, applied live 2026-09-14) — the
  row that already carries `did_avatar_id`, `did_agent_id`, `voice_id`. One
  twin, one row, three provider ids.
- **Source image.** The twin's own `avatar_url` (our `twin-avatars` bucket
  copy of the D-ID render), never a raw D-ID URL and never a video source.
- **Face creation is asynchronous** (Simli: "can take a couple of hours").
  A face enqueued on this session is *not* used on this session — the adapter
  refuses with "still generating" and the visitor gets text; the next
  session finds the cached id. The Simli endpoint is
  `POST /faces/trinity` (multipart `image`, query `face_name`, `gsVersion=GSA_1.0`)
  with `GET /faces/trinity/generation_status?face_id=` for status; both 200
  bodies are `schema: {}` in Simli's OpenAPI, so the id is read from the first
  present of `face_id | faceId | id | character_uid` and anything else is a
  typed `ProviderError`. Lane 62A's first draft posted to a guessed
  `/textToFace`; corrected at integration against the spec.

## 4. Cost and metering

- `SIMLI_USD_PER_STREAMING_MINUTE = 0.009` (render leg only, pay-as-you-go
  list price); `DID_USD_PER_STREAMING_MINUTE = 0.495` (derived, Scale plan).
- `estimateStreamingMinutesCostUsd(seconds, provider)` is provider-aware;
  `closeLiveAgentSession` books the vendor ledger under `row.provider`, and
  `listLiveAgentSessionsForBrokerage` prices mixed-provider totals per row.
- Simli enforces its own ceiling (`maxSessionLength` 30 min, `maxIdleTime`
  3 min) independent of our stale-session sweep, which now runs inside the
  5-minute `queue-drain` tick (lane 62B consolidation).

## 5. Vercel cron consequences of this wave

No new cron for Simli. The only new registry entry this wave is the daily
D-ID result-URL re-host sweep (+1 invocation/day, justified in
`docs/vercel-cron-usage-2026-09.md` §4); the live-agent session sweep was
folded into `queue-drain` (−288/day). Net registry change: −287/day.

## 6. What a live test needs (not run this wave)

`SIMLI_API_KEY`; one real agent with a verified `agent_did_consents` row and
a rendered `agent_avatar_assets.avatar_url`; then force the D-ID leg to fail
(unset `DID_API_KEY` in a preview deployment) and open the portal Live tab.
Expected: `provider: "simli"` in the session response on the SECOND visit
(the first enqueues the face and falls to text), a `live_agent_sessions` row
with `provider = 'simli'`, and a vendor-usage row at the Simli rate on close.

## 7. Blind spots

- No Simli session was run (no `SIMLI_API_KEY` in this environment).
- **RESOLVED (lane 63B, carried forward — verified live by lane 67C on
  6c75aef4):** the anonymous embed/site 401 above is fixed. `/api/embed/session`
  mints a `live_agent_sessions` row on the Simli fail-over leg
  (`provider: "simli"`) and returns its id as `liveSessionId`;
  `SimliFaceSession.tsx` sends that `liveSessionId` to
  `/api/internal/voice-tts`, which branches BEFORE requiring a Supabase
  session and resolves tenant/agent/voice OFF THE ROW via the one shared
  resolver `resolveOpenSimliSession` (`lib/did/live-session-metering.ts`) —
  never from the request body (CLAUDE.md §4). That resolver is the
  short-lived, session-scoped door this bullet used to ask for: it proves the
  row is OPEN (`status = 'active'`), is genuinely a SIMLI session (never a
  D-ID session's id), and its heartbeat is still fresh (`STALE_AFTER_MS` =
  10 min — the same threshold the sweeper uses), refusing 404/409 otherwise.
  No Supabase session ever reaches this branch; the portal's signed-in path
  is untouched (unchanged `else` branch, still `resolveSelfVoice(user.id)`).
  Proof: `test:face-render-seam` §voiceTts (`scripts/face-render-seam-simulator.ts`),
  73/73 passing, including the tenant-off-the-row control.
- Simli's "idle-state motion" weakness (vendor-acknowledged) is untested here.
- Trinity face-generation response fields are undocumented (`schema: {}`);
  the four-key fallback above is the honest reading, confirm on first use.
