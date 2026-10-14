# Twins and avatars — how it works (2026-09-14)

Six owner questions, answered from the code as it stands at HEAD `ae5776cb`
plus this wave's build. Every claim cites `file:line`. Written for a
non-engineer reader.

## 1. How a twin is created

An agent uploads a headshot **or** a short video clip in Settings → Voice &
Avatar / Twin Studio.

- **The source file lands in OUR Supabase bucket first**, not only on D-ID.
  `app/actions/twin-studio-upload.ts:126,135,138` creates/uses the
  `twin-avatars` bucket, uploads the bytes, and mints a public URL — *before*
  anything is sent to D-ID. `createTwinDraft` (`app/actions/twin-studio.ts:360-386`)
  then inserts a `pending` row on `agent_avatar_assets` carrying that
  `source_url`. So the answer to "is the source only on D-ID?" is **no** —
  the original photo/video is ours from the moment it's uploaded; D-ID is
  handed a copy to process. No build was needed here.
- **Consent gate (428).** `app/api/did/create-avatar/route.ts:78-104` — a
  video source requires a verified consent statement (`resolveConsentIdForAvatar`,
  `lib/did/consent.ts`) before anything is submitted to D-ID. Missing consent
  returns HTTP 428 with `needs_consent: true`; no provider quota is spent.
  **This gate was read, not edited, per this lane's brief.**
- **Submission.** The route posts to D-ID's `POST /scenes/avatars` (the
  Express/Instant-avatar family) through the one D-ID egress path,
  `didRequest` (`lib/did/gateway.ts`) — never a bespoke `fetch`
  (`app/api/did/create-avatar/route.ts:171-195`). The correlation id
  (`assetId`) is minted *before* the call so the webhook can always find the
  row (`:145-152`).
- **Async completion, one place.** Both the webhook
  (`app/api/webhooks/did/route.ts`) and the poll cron
  (`app/api/cron/poll-did-avatars`) hand off to the SAME function,
  `applyAvatarOutcome` (`lib/did/avatar-completion.ts:188-287`), so the two
  triggers can never drift. On `status:"done"` it downloads the D-ID image
  and **re-hosts it into our `twin-avatars` bucket**
  (`rehostAvatarImage`, `lib/did/avatar-completion.ts:75-145`) and only then
  writes `agent_avatar_assets.avatar_url` — the row never stores the D-ID
  URL as its permanent value on a clean run.

## 2. Which table(s) hold the twin ids

One table, `agent_avatar_assets` (columns confirmed against the live schema
cache, `scripts/schema-snapshot.ts:45`):

| column | what it is |
|---|---|
| `did_avatar_id` | D-ID's presenter id (`avt_…`, from `/scenes/avatars`) |
| `did_agent_id` | D-ID's conversational **Agent** id (from `/agents`, live-chat only — §5) |
| `voice_id` | the ElevenLabs cloned-voice id for this twin |
| `source_url` | our bucket's copy of the uploaded photo/video |
| `avatar_url` / `thumbnail_url` | our bucket's copy of the finished D-ID render |
| `status` | `pending \| processing \| ready \| failed` |

A second table, `agent_voice_profiles`, holds a **legacy, per-agent fallback**
(`did_avatar_id`, `did_photo_url`, `did_video_url`, `elevenlabs_voice_id`,
`avatar_url`) for agents who never went through Twin Studio
(`lib/did/agents.ts:54-56`, `lib/providers/dispatch.ts:1253-1257`). When a
twin has a `default` asset, `applyAvatarOutcome` mirrors the re-hosted URL
onto this row too (`lib/did/avatar-completion.ts:227-231`) so both tables
agree. `agent_did_consents` (schema cache) is the third table — the recorded
consent statements the 428 gate reads.

## 3. Which compositions use which media, and the decorative-PIP producers

`lib/video/presenter-media.ts:33-74` (`resolveAgentPresenterMedia`) is the
one resolver: it prefers a **ready, default** `agent_avatar_assets` row
(`did_avatar_id` → a pre-processed D-ID actor, fastest/most consistent),
falls back to `agent_voice_profiles`' photo/video, and returns
`canRender:false` when the agent has set up neither (graceful degrade, not a
silent failure).

`presenterTypeForTwin` (`lib/did/agent-presenter.ts`) is the ONE place that
reads a `did_avatar_id` and decides which D-ID family it is (`talk` / `clip`
/ `expressive`) — used by both the live-agent builder
(`lib/did/agents.ts:81,228,241`) and the async render dispatcher
(`lib/providers/dispatch.ts:1380`), so the render engine and the live-chat
engine can never disagree about what a given twin actually is.

**Compositions render `AvatarPIP`** (`remotion/components/AvatarPIP.tsx`) —
consumed by `PartnersMeetingReel`, `MarketUpdateReel`,
`ListingPresentationSlide`, `AgentExplainerReel`, `BuyerConsultationSlide`,
`EquityReportReel`, `ExplainerAnimReel`. Every one of them takes
`avatarVideoUrl: string | null` — **null is the deliberate "decorative /
not-yet-rendered" state**, not a bug: the producer stages the composition
request with `avatarVideoUrl: null`, submits the D-ID render separately, and
`app/api/cron/poll-did-videos`'s avatar→Remotion handoff
(`:641-647`, `lib/video/avatar-render-orchestrator.ts`) fills the real URL in
once D-ID finishes. Producers that stage `null` at request time:
`lib/video/promo-composition.ts:352`, `lib/video/listing-pitch-reel.ts:94`,
`lib/video/avatar-explainer.ts:494`,
`lib/listing-presentation/section-render.ts:259`,
`lib/buyer-consultation/consultation-render.ts:399`,
`lib/agents/seller-update-reel-producer.ts:125`,
`lib/kernel/deal-room-reel.ts:88` (and the pure `null` used in
`remotion/Root.tsx`'s dev/preview compositions and
`app/actions/superadmin/go-live-readiness.ts:77`'s pipeline probe, which
deliberately never renders a real avatar).

## 4. The async render path and the re-host step

Three doors submit to D-ID and all three converge on the SAME poller:

- `app/api/did/generate-video/route.ts` (the wizard) — claims a render slot
  atomically (`:272-302`), submits `/talks` or `/clips`
  (`:389-426`), then **stamps `provider_job_id` + `provider_metadata.provider:"did"`**
  on `ai_video_projects` (`:449-470`) and a `video_render_log` row (`:500-507`)
  — the two facts `poll-did-videos` needs to find and track the job.
- `app/actions/video-generation.ts:generateVideoFromScript` — the other live
  D-ID door — does the same stamp (`:1702-1713`, comment at `:1696`
  names the exact `poll-did-videos` selection predicate it satisfies).
- `lib/providers/dispatch.ts:dispatchVideoViaDID` (`:1206-1441`) — the
  system-only, manager-driven path (chapter videos, intro/anniversary
  videos, D-ID hybrid composites, workflow adapters, AI-ISA nudges). It
  submits directly to `/talks` / `/clips` / `/expressives`
  (`:1403-1410`) and returns the raw D-ID job id as `messageId`; **every
  caller then stamps that id onto `ai_video_projects.provider_job_id`
  itself** — verified live in `lib/video/intro-video-reactor.ts:955-961`
  ("LINK THE RENDER TO THE POLLER" — the exact predicate `poll-did-videos`
  selects on is quoted in that comment).

`app/api/cron/poll-did-videos/route.ts` is the single re-host point for every
one of those three doors (`status='generating' AND provider_job_id IS NOT
NULL AND provider_metadata->>'provider'='did'`, `:117-123`). On `done`:

1. Downloads `result_url` / `thumbnail_url` and calls the **one media host**,
   `hostRenderedMedia` (`lib/remotion/media-host.ts:65-130`), into the
   `video-assets` bucket (`:255-290`).
2. Composites brand overlay / b-roll / intro-outro (`:300-449`).
3. **Fails closed** if the re-host itself failed: the row is kept at
   `generating` (not marked complete) and retried up to 5 ticks, never
   `completed` with a raw D-ID URL in `video_url` (`:488-527`, the comment
   there names the exact defect this guards: a signed URL expiring in
   24-48h fanning out into email/SMS/social drafts and a public
   lead-magnet page before anyone noticed).
4. Only once bytes are in our bucket does the row flip to `completed` with
   `video_url` = our bucket's URL (`:532-569`).

The D-ID **webhook** (`app/api/webhooks/did/route.ts`) is scoped to the
**avatar family only** — it explicitly ignores a video-render payload
(`:73-81`, "video renders complete on poll-did-videos") because duplicating
the re-host/composite/handoff pipeline into a second entry point is exactly
the drift this codebase has already paid for once.

**Verdict on the owner's D-ID fact**: every currently-reachable render path
already re-hosts before persisting a durable URL, and fails closed rather
than store the vendor's URL when the re-host fails. **What was missing** was
a *runtime* backstop for a row that slipped through anyway (a legacy row
from before either fail-closed contract existed, or a future regression) —
built this wave: `lib/did/result-url-rehost-sweep.ts` +
`app/api/cron/did-result-url-rehost-sweep` (daily; see §6 of this doc for
the registration and the cost justification).

## 5. How the live/streaming avatar works

Owner ruling (wave 58): D-ID Express **v4 Agents** on three surfaces —
public website, embeddable widget, client portal — never a fourth
agent-creation path (`lib/did/agents.ts:56-61`).

- **One D-ID Agent per twin.** `ensureDIDAgent` (`lib/did/agents.ts:201-286`)
  is idempotent: cache-hit returns the twin's cached `did_agent_id`
  (`agent_avatar_assets.did_agent_id`) or the legacy per-agent one
  (`agent_voice_profiles.did_agent_id`); cache-miss creates a D-ID Agent via
  `POST /agents` with the twin's presenter + ElevenLabs voice +
  `llm.provider:"custom"` pointed at **our own brain**,
  `/api/did/custom-llm` (`lib/did/agents.ts:169-193`). `syncDIDAgent`
  (`:318-343`) is the PATCH half — called by the `did-agent-sync` cron
  (every 4h, `cron_manager`) so a re-trained twin, a new voice clone, or an
  edited personality doesn't keep talking through a stale D-ID Agent record.
- **Connecting.** `app/api/did/agents/session/route.ts` resolves the
  contact's assigned agent → `ensureDIDAgent` → `issueClientKey`
  (`lib/did/agents.ts:364-382`, a short-lived, origin-locked `client_key` —
  the master `DID_API_KEY` never reaches the browser). The browser's
  `@d-id/client-sdk` (WebRTC/LiveKit) then talks directly to D-ID's Agents
  Cloud.
- **The brain.** Every conversational turn is a per-turn HTTPS call from
  D-ID to `/api/did/custom-llm` — our brand voice, brokerage
  knowledge/FAQ, and contact context are injected there, per turn (not
  baked into the Agent once at creation).
- **Metering.** `lib/did/live-session-metering.ts` (`startLiveAgentSession`)
  opens a `live_agent_sessions` row per connection; a 2-minute
  browser heartbeat keeps it alive; `app/api/cron/live-agent-session-sweep`
  (every 5 min, `cron_manager`) closes any session whose heartbeat has gone
  silent for >10 minutes at the heartbeat-derived duration — the crashed-tab
  case the client's own end-beacon can never cover
  (`app/api/cron/live-agent-session-sweep/route.ts:11-30`).
- **No new artifact is "lost" on this path** — nothing is rendered to an S3
  URL; the conversation is a live stream with no `result_url` to expire.

## 6. Are we still pulling content suggestions, including competitor high-viral posts?

**Yes — five writers, one shared table, one promoter, and five consuming
surfaces**, all currently scheduled:

| hop | file | verdict |
|---|---|---|
| writer (organic topics) | `app/api/cron/content-intel-exa` (06:30/14:30 UTC), `-reddit` (06:00), `-rss` (07:00), `-apify` (07:30) | live, `CRON_REGISTRY` |
| writer (competitor ads, incl. high-viral) | `app/api/cron/competitor-ads-exa` (11:00 daily) → `lib/competitive-intel/exa-competitor-ads.ts:77` — Exa neural search over the **public** Meta Ad Library + Google Ads Transparency Center pages, 2 searches/competitor/day; Exa's relevance-ranking *is* the "what's performing" filter (no impression API needed) | live |
| table | `content_topic_bank` (organic) + `competitor_ads` (competitor) | both written |
| promoter | `lib/competitive-intel/promote-to-topic-bank.ts:41-77` — top-N by `engagement_score` (per-watchlist threshold), paraphrased (never verbatim) into `content_topic_bank`, `categories:['competitor_intel']` | live, idempotent |
| reader | `lib/content-intel/topic-bank.ts:pickTopics` — brokerage-local + fresh + geo-matched scoring | live |
| surface | podcast (`app/actions/podcast-generation.ts`), newsletter (`app/actions/ai-newsletter.ts`), blog (`app/actions/blog.ts`), farm mail (`lib/farm-mail/dispatch-farm-mail.ts`), AI-ISA contact reels (`lib/ai-isa/contact-reel-situation.ts`), marketing-agent weekly read (`lib/agents/marketing-agent.ts`) | live, all consume `content_topic_bank` |

No hop is missing; nothing was built for this loop. **Cost per run**: no Exa
price table exists anywhere in this repo (checked — CLAUDE.md §2: recording
"unresolved" rather than inventing a number). What IS derivable from the
code: `content-intel-exa` runs 1 Exa search per active `content_topic_sources`
row per tick (×2 ticks/day); `competitor-ads-exa` runs 2 Exa searches per
active `competitor_brokerages` watchlist row per day. The per-search dollar
cost is the integrator's call, same as the D-ID pricing precedent
(CLAUDE.md's wave-61 note) — **unresolved** here rather than guessed.

`lib/marketing/trigger-match.ts` stays **KEPT, NOT WIRED** per standing
owner ruling — not touched this wave.

## What was built this wave

- `lib/did/result-url-rehost-sweep.ts` — reuses `hostRenderedMedia`
  (video/thumbnail bytes) and `rehostAvatarImage` (twin image bytes)
  verbatim; no third download-and-store implementation. Scans
  `ai_video_projects` (`status='completed'`) and `agent_avatar_assets`
  (`status='ready'`) / `agent_voice_profiles` for any `d-id.com` /
  `api.d-id.com` URL still on the row, re-hosts it, and reports failures
  through `collectError` (never a hand-rolled `automation_errors` insert).
- `app/api/cron/did-result-url-rehost-sweep` — thin cron wrapper, same shape
  as `live-agent-session-sweep`.
- Registered: `lib/kernel/cron-dispatch.ts` `CRON_REGISTRY`
  (`"0 9 * * *"` — **daily**, not sub-5-minute: owner ruling this wave says
  cron cost must be justified against invocations/day, and a slipped-through
  D-ID URL has a multi-hour window before expiry per the avatar-pipeline-
  hardening domain's own cited number, so once a day is comfortably inside
  that window); `lib/kernel/manager-registry.ts` `CRON_MANAGER`
  (`asset_manager` — same owner as the two happy paths it backstops) and
  `MAINTENANCE_DOMAINS.twin_lifecycle` (proof: `test:twin-lifecycle`).
- `scripts/twin-lifecycle-simulator.ts` — proves (1) no source call-site
  stores a raw D-ID result URL on a row without passing through
  `hostRenderedMedia`/`rehostAvatarImage` first, with a positive-control
  specimen proven caught; (2) the sweep cron is registered in both
  `CRON_REGISTRY` and `CRON_MANAGER`; (3) the content-suggestion loop has a
  writer, a table, and a surface at every hop, each with a positive control.

## Unresolved

- Exa's per-search dollar cost — no price table in this repo (§6 above).
- `agent_avatar_assets.avatar_url`'s public-vs-signed classification carries
  its own pre-existing unresolved note (`lib/did/avatar-completion.ts:130-139`)
  — a voice/face URL's privacy classification is a product call, not
  re-litigated here.
- Whether D-ID's account-level rate limit differs from this app's own
  `live_agent_sessions` meter — no D-ID rate-limit doc found (documented as
  unresolved already in `lib/did/agents.ts:34-40`).
