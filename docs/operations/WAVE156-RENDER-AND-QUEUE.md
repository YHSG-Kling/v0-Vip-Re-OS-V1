# Wave 156 — render lifecycle, the render queue at scale, and the paid media doors (lane 156S)

Proof: `scripts/wave156-s-guard.ts` (`test:wave156-s`, in-memory database, counted provider stubs — no provider, no live
database, no deployment was touched). "Simulated" below never means "live verified".

## 1. The lifecycle as it is in code

`draft → render queued → rendering → playable verified → approved / published`

| Stage | Where it lives | What makes it true |
|---|---|---|
| draft | `ai_video_projects.status` `draft` / `scripting` / `script_ready`; `video_scripts_library` | a script exists — it is **never** a video: `resolvePlayableVideo` answers `none`, `decidePlatformVariant` refuses `playable: false` |
| render queued | `remotion_composition_renders.render_status = 'queued'` (`recordRenderQueued`) | a producer queued a row |
| rendering | `claimQueuedRender` (`lib/remotion/registry.ts`, called by the render route) — guarded on id + `queued`; `claimed_at` stamped by the m933 trigger | exactly one tick wins the claim |
| playable verified | `hostRenderedMedia` (`lib/remotion/media-host.ts`) runs `probePlayableOutput` before the bytes are stored; only then can `render_status = 'succeeded'` be written | a container a player can open (ftyp / moov / mdat / duration > 0) |
| approved / published | `lib/video/video-staging.ts`, the YouTube rail, social drafts through `decidePlatformVariant` | an assigned approver |

Recovery: `recoverStalledRenders` (a claim older than three route lifetimes → `failed render_stalled`), `requeueFailedRenders`
(bounded, terminal classes refused), `lib/remotion/render-escalation.ts` (an unplayable output is raised to the Asset Manager in
the same request), the failure census in the queue tick. A render that exhausts its retries stays `failed` with its reason, and
the canonical resolver reports that reason — it never reads as `ready`.

## 2. What changed in this lane

1. **Fair claiming.** The queue tick took the globally oldest queued row; one tick renders one row, so one tenant's batch held
   every other tenant behind it. `chooseFairRender` (`lib/remotion/render-decision.ts`) + `pickNextQueuedRender`
   (`lib/remotion/registry.ts`): least-recently-served tenant (claims in the last hour), then its least-recently-served desk
   (`scope_type:scope_id`), then that desk's oldest row. A refused recent-claims read falls back to oldest-first and is
   reported; a refused queue read picks nothing and is reported.
2. **The claim is one driven function** (`claimQueuedRender`), called line-neutrally by the render route.
3. **The paid egress door** — `runPaidEgress` (`lib/vendor-governance/budget-gate.ts`): budget before the call → action receipt
   (`withActionLedger`) → spend booked only on success, under the idempotency key. Wired: ElevenLabs buffered / timestamped /
   stream (`runTtsDoor`), D-ID `generateVideo` (with `idempotencyKey`), `generateImage` (spend stays on `ai_tool_usage`),
   tenant-attributed `webSearch`.
4. **Honest social video transport** — the listing-promo drafter decides each media platform through `decidePlatformVariant`
   and attaches the reel; Instagram (export / handoff), Pinterest (image-only) and unconnected platforms get no draft and the
   reason is in the cron's response.

## 3. Measured queue behavior (driven, in memory)

World: a multi-location brokerage (3 office desks as team scopes) queued 90 renders first, a team queued 6, a solo agent 1.
Drained one claim per tick (the cron's real rhythm):

| Measure | Oldest-first (before) | Fair pick (after) |
|---|---|---|
| ticks until the solo agent's render is claimed | 96 | 2 |
| ticks until the team's first render is claimed | 90 | 1 |
| rows claimed / rows queued | 97 / 97 | 97 / 97 |
| cross-tenant claims | 0 | 0 |
| office desks inside the big tenant, first 6 claims | — | each desk twice |
| two ticks racing for one row | — | one winner |
| a dead claim under two concurrent sweeps | — | recovered once, requeued once |

Throughput is unchanged (one render per tick); only the order changed. "Ticks before first claim" counts claims made before that tenant's first (0-based). Paid-door census (§C): 28 egress sites to classified vendors, 15 billable, 16 billable doors — 4 through the composition, 12 named.

## 4. What is still isolated today, and what a separate render worker would need (owner-held)

Rendering runs **inside** the Vercel function `app/api/internal/remotion/render-composition` (Chromium via
`@sparticuz/chromium-min`, `maxDuration = 300`), one row per cron tick, serialized on purpose (Chromium + ffmpeg share the
function's memory). Nothing in the source claims a hosted (Lambda) render — the guard checks that, with a control.

A separate render worker would need, all owner-held:
- **Hosting**: Remotion Lambda (an AWS account, region, the deployed function + site bucket) or a container worker; Vercel
  keeps coordinating (the queue, the claim, the receipt) and the worker returns the bytes or a URL to the same
  `finalizeCoordinatedRender` → `hostRenderedMedia` path, so "playable verified" stays one host's decision.
- **License**: Remotion's company license (Remotion is free only for individuals and small companies; a company license is
  required beyond that) — not verified here; the owner must confirm the license tier before any hosted render.
- **Spend**: worker compute is a new paid door — it must go through `runPaidEgress` like every other render spend.
- No Remotion package was added in this lane.

## 5. The paid doors — denominator and what remains (round 2)

`runPaidEgress` lives in `lib/vendor-governance/paid-egress.ts`, a module of its own because `budget-gate.ts` is on the
proxy's read path (the paywall) and this composition reaches the action ledger; `budget-gate.ts` imports exactly what it did
before (proxy.ts reaches 23 first-party modules, as at base).

`test:wave156-s` §C derives 14 billable doors from comment-stripped source; 10 go through the composition:
ElevenLabs buffered / timestamped / stream, D-ID `generateVideo`, the D-ID generate-video route, the D-ID create-avatar route,
the ElevenLabs voice-clone route, speech-to-text (`transcribeMediaUrl`, both vendors), Simli face creation, Simli session token
(podcast narration now calls `synthesizeSpeech`, so it is no longer an egress of its own). Each is driven four ways in §D/§F:
over budget → 0 provider calls; success → booked once; a failed call → nothing booked; a replay under one key → one charge.
Two doors (speech-to-text, create-avatar) keep their own inline budget gate, pinned by `test:transcription-source` and
`test:did-integration`, and hand its verdict to the composition (`preflight`) — they refuse before the composition, so their
refusal is the response, not a ledger row.

Named, 4: `lib/providers/dispatch.ts` `dispatchVideoViaDID` (lane 156M's file — the exact change is in the guard's NAMED entry),
and three transports inside doors (the Tavily transport under `webSearch`, the two image transports under `generateImage`).
Platform-paid research (no tenant) has no tenant ceiling — a research cap is owner-held.

## 6. Personal videos

Every render addressed to one contact is hosted in the private `personal-videos` bucket (`renderHostBucketFor`). Round 2
closed the last public path: `lib/did/index.ts` `generateVideo` in synchronous mode now takes `addresseeContactId` and hosts
private; the workflow video step (`lib/workflow/adapters/video.ts`) files the render as the `ai_video_projects` row addressed to
the contact and hands later steps the delivery door with a share grant for that contact
(`lib/storage/signed-doc-url.ts` `grantDoorLinksInText`, the same door `lib/video/client-video-delivery.ts` emails). With no
sealing secret it refuses with the reason and hands on no URL. Driven in `test:wave156-s` §G.
