# Vercel cron usage + billing audit (2026-09-14)

Owner question (wave 62): *"vercel cron usage and billing should be
considered… we don't want the charges outweighing the build."*

Measured by `scripts/cron-cost-census.ts` (`npm run test:cron-cost`), which
simulates every `CRON_REGISTRY` schedule against the full 2026 calendar
through this repo's own tested cron field matcher (`lib/kernel/
cron-dispatch.ts`'s `cronFieldMatches` — never a second hand-rolled cron
parser, CLAUDE.md §6). Re-run it any time; the numbers below are its
2026-09-14 output, **after** the one consolidation in §4.

## 1. Facts this audit treats as ground truth

From vercel.com/docs, verified 2026-09-14 — no number below this line is
invented:

- Cron jobs are included on every Vercel plan, capped at 100/project. This
  repo already works around that cap the way `lib/kernel/cron-dispatch.ts`'s
  own header explains: **one** `vercel.json` cron (`* * * * *`,
  `/api/cron/dispatch`) fans out to a registry of 213 schedules internally.
- Pro gives per-minute cron precision (needed here — 15 of the 213 entries
  are sub-5-minute).
- **A cron invocation is billed exactly like any other Vercel Function
  invocation**: Pro on-demand invocations from **$0.60 per million**, plus
  **Active CPU** time and **Provisioned Memory** (GB-hours) while the
  function actually runs.
- Pro includes a **$20/mo** usage credit; a team's default on-demand budget
  is **$200/mo**.

Consequence for this repo's bill: it is **not** "1 cron job." It is the tick
itself (1,440 invocations/day, fixed, regardless of what's due) **plus every
internal `fetch()` call the dispatcher fans out** (`cron-dispatch.ts:397` —
each dispatched route is its own separate Function invocation, billed
separately) **plus each of those functions' own CPU/memory**.

## 2. Totals (2026-09-14, post-consolidation)

| | /day | /month (×30.44 avg) |
|---|---:|---:|
| Dispatcher tick (`/api/cron/dispatch`, fixed) | 1,440.0 | 43,800 |
| 214 registered routes (simulated, full 2026 calendar; incl. the +1.0/day rehost sweep, §4) | 9,384.1 | 285,431 |
| **Grand total** | **10,824.1** | **329,231** |

**Invocation-only cost** at the one rate we were given ($0.60/M):
**≈ $0.20/month** — comfortably inside the $20/mo Pro credit and the $200/mo
team default budget, on invocations alone.

**CPU/memory is intentionally NOT priced in dollars here.** Vercel's
Active-CPU $/ms and Provisioned-Memory $/GB-hour rates were not in the facts
this audit was handed, and CLAUDE.md §2 is explicit that a number a guard
cannot see is not a number it reports — inventing a rate would look like a
measurement and be a guess. What *is* measurable and reported: **5 routes**
carry an elevated 3008MB memory reservation in `vercel.json`'s `functions`
block — these are the compute-cost outliers to watch, ranked by how often
they run:

| Route | Schedule | Invocations/mo | Note |
|---|---|---:|---|
| `/api/cron/poll-did-videos` | `*/2 * * * *` | 21,900 | D-ID video render polling, `maxDuration: 300` |
| `/api/cron/listing-promo-hybrid-composite` | `*/2 * * * *` | 21,900 | ffmpeg composite render, `maxDuration: 300` |
| `/api/internal/remotion/render-just-listed` | not a cron (internal) | — | Chromium render, `maxDuration: 300` |
| `/api/internal/remotion/render-newsletter-video` | not a cron (internal) | — | Chromium render, `maxDuration: 300` |
| `/api/internal/remotion/render-composition` | not a cron (internal) | — | Chromium/ffmpeg render, `maxDuration: 300` |

The two CRON_REGISTRY entries in that list run every 2 minutes at up to 300s
duration and 3008MB reserved — if they routinely run anywhere near their
`maxDuration` ceiling, that pair is the actual place a bill would grow past
the invocation floor above, not the per-minute tick. **Unresolved**: the
real average execution time and actual memory *used* (vs. reserved) for
these two are not observable from source and would need Vercel's own
Runtime Logs / Observability to price honestly — flagged for the integrator
rather than guessed at.

## 3. Breakdown

### By owner (`CRON_MANAGER`)

| Manager | Entries | /day | /month |
|---|---:|---:|---:|
| asset_manager | 13 | 3,315.1 | 100,836 |
| ai_isa | 21 | 1,920.9 | 58,426 |
| campaign_orchestrator | 35 | 1,366.1 | 41,553 |
| data_steward | 36 | 980.1 | 29,813 |
| cron_manager | 11 | 538.1 | 16,369 |
| deal_coordinator | 19 | 419.0 | 12,745 |
| listing_concierge | 17 | 341.4 | 10,385 |
| shopping_agent | 11 | 274.1 | 8,339 |
| ads_manager | 7 | 107.1 | 3,259 |
| recruiting_manager | 9 | 53.4 | 1,625 |
| compliance_officer | 5 | 49.3 | 1,499 |
| sphere_of_influence | 14 | 10.6 | 322 |
| finance_manager | 15 | 7.6 | 232 |

`asset_manager` (video/render pipeline) is the single biggest slice, mostly
from the five-crons-every-5-minutes render/poll queue and the two
every-2-minute D-ID/composite pollers above.

### By frequency bucket

| Bucket | Entries | /day | /month |
|---|---:|---:|---:|
| sub-5-min (interval ≤5min) | 15 | 6,672.0 | 202,940 |
| 5-14-min | 15 | 1,536.0 | 46,720 |
| 15-59-min | 31 | 936.0 | 28,470 |
| few-hourly (≥2, <20×/day) | 27 | 154.0 | 4,684 |
| daily | 79 | 79.0 | 2,403 |
| weekly | 41 | 5.8 | 178 |
| monthly-or-rarer | 5 | 0.2 | 6 |

**The sub-5-minute bucket is 15 entries out of 213 (7%) but 71% of
registry-driven invocations/month** (202,940 of 285,401) — this is where
consolidation pays off, not the long tail of dailies/weeklies.

### The 15 sub-5-minute entries (the actual cost driver)

| Schedule | Route | Owner |
|---|---|---|
| `*/2 * * * *` | `/api/cron/intro-video-email-backfill` | ai_isa |
| `*/2 * * * *` | `/api/cron/listing-promo-hybrid-composite` | asset_manager |
| `*/2 * * * *` | `/api/cron/listing-promo-social-publish` | campaign_orchestrator |
| `*/2 * * * *` | `/api/cron/poll-did-videos` | asset_manager |
| `*/2 * * * *` | `/api/cron/speed-to-lead` | ai_isa |
| `*/3 * * * *` | `/api/cron/poll-did-avatars` | asset_manager |
| `*/5 * * * *` | `/api/cron/campaign-sequence-steps` | campaign_orchestrator |
| `*/5 * * * *` | `/api/cron/queue-drain` | cron_manager |
| `*/5 * * * *` | `/api/cron/composition-render-queue` | asset_manager |
| `*/5 * * * *` | `/api/cron/director-reel-render` | asset_manager |
| `*/5 * * * *` | `/api/cron/listing-promo-render` | asset_manager |
| `*/5 * * * *` | `/api/cron/newsletter-video-render` | asset_manager |
| `*/5 * * * *` | `/api/cron/portal-stream-projector` | data_steward |
| `*/5 * * * *` | `/api/cron/webhook-deliveries` | data_steward |
| `*/5 * * * *` | `/api/cron/ai-callback-dispatch` | ai_isa |

None of the `*/2` entries are candidates to slow down: three are the D-ID
async-render poll loop (video/avatar generation is genuinely latency
sensitive at that cadence) and two (`speed-to-lead`,
`intro-video-email-backfill`) are speed-to-lead-class first-touch loops
where the owner ruling (§5, CLAUDE.md) already prices fast lead response
above a few dollars of Function invocations. **None flagged for slowdown.**

## 4. Consolidation done this wave

**`/api/cron/live-agent-session-sweep`** (`*/5 * * * *`, owner
`cron_manager`) was folded into **`/api/cron/queue-drain`** (also
`*/5 * * * *`, also `cron_manager`) as a 6th called drain
(`drainLiveAgentSessionSweep`, `app/api/cron/queue-drain/route.ts`):

- Same owner, same cadence — the sweep's own 10-minute staleness window
  (`lib/did/live-session-metering.ts::sweepStaleLiveAgentSessions`) is
  unchanged; it just runs *inside* an existing tick instead of *alongside*
  it.
- One fewer Vercel Function invocation per tick: **−288/day, −8,760/mo**
  registry invocations (confirmed by the census: 214 → 213 entries,
  9,671.1/day → 9,383.1/day, exactly −288.0/day).
- Tombstones naming the survivor (`app/api/cron/queue-drain/route.ts:
  drainLiveAgentSessionSweep`) are at: `lib/kernel/cron-dispatch.ts` (the
  deleted `CRON_REGISTRY` entry's old spot), `lib/kernel/manager-registry.ts`
  (both the deleted `CRON_MANAGER` entry's old spot and an addendum on the
  `live_agent_metering` MAINTENANCE_DOMAINS entry), and the folded call site
  itself.
- `scripts/live-agent-identity-simulator.ts`'s `§sweeper` checks were
  UPDATED (not deleted) to assert the folded shape — `CRON_REGISTRY` no
  longer carries the standalone path, `queue-drain` still does on a 5-minute
  schedule, and `queue-drain`'s route body calls
  `sweepStaleLiveAgentSessions()`. Full proof still passes: 80/80 (was
  78/78 before the two new sweeper assertions).
- `scripts/cron-cost-baseline.json`'s ratchet was **deliberately lowered**
  this run (the DROP that CLAUDE.md §1 requires a tombstoned survivor for,
  not a silent number move) from unset to `9383.052`/day — any future PR
  that raises it must justify the raise here.

### Raise justified in the same wave (integration, 2026-09-14)

**`/api/cron/did-result-url-rehost-sweep`** (`0 9 * * *`, owner
`asset_manager`, lane 62C) was added after this baseline was written:
**+1.0/day, +30/mo** — the daily safety net that re-hosts any row still
carrying a raw `d-id.com` presigned URL (which expires in hours) into our
own bucket. Daily, not sub-5-minute, is the cheapest cadence that still
sits inside that expiry window; folding it into an existing daily tick
was considered and rejected because the only other `asset_manager` daily
entries run at 06:00/07:00 and this sweep must run AFTER the overnight
`poll-did-videos` retries have had their five ticks. Baseline raised
`9383.052` → `9384.052`/day for that reason and no other.

### Raise justified — lane 75C (2026-09-18)

**`/api/cron/listing-appointment-reminders`** (`0 13 * * *`, owner
`listing_concierge`) was added: **+1.0/day, +30/mo** — the listing
appointment's 5-day/2-day/morning-of reminder cadence (owner ruling wave 75:
"the workflow creates the follow up until the appt"). Daily is sufficient
for a day-granularity 3-tier cadence — no sub-hour polling is needed, and
folding it into an existing `listing_concierge` daily tick was considered
and rejected: the existing daily entries (`listing-health-scan`,
`listing-propensity`, `seller-updates`) each own a DIFFERENT table/read
shape, and coupling this sweep's failure mode to theirs would widen every
other daily job's blast radius for a one-table, low-volume read. Baseline
raise (`9384.052` → `9385.052`/day) is left to the integrator's
`--write-baseline` run (lane rule: lanes do not regenerate baselines) —
`npx tsx scripts/cron-cost-census.ts` currently reports `CRON_COST_FAIL` on
this exact +1.0/day delta until that run happens.

### Considered and explicitly NOT consolidated

- **Scraping crons** (`/api/cron/lead-scraping` and everything the frozen
  list names) — untouched, per lane rules.
- **Table-write overlap candidates** the census flagged (advisory, not a
  verdict — see script header for the heuristic's blind spots):
  - `content_topic_bank` / `content_topic_sources`, written by
    `content-intel-reddit`, `content-intel-rss`, `content-intel-exa`,
    `content-intel-apify` — four DIFFERENT ingestion sources feeding one
    shared content bank by design (each source has its own rate limits and
    failure modes; merging them would couple four independent external APIs
    into one cron's failure blast radius). **Reviewed, left separate.**
  - `ai_video_projects`, written by `listing-promo-hybrid-composite`,
    `poll-did-videos`, `director-reel-render` — three STAGES of the same
    video pipeline (poll → render → composite), not duplicate sweeps of the
    same state. **Reviewed, left separate.**
  - `listing_promo_videos`, written by `listing-promo-hybrid-composite` and
    `listing-promo-social-publish` — composite-then-publish, same pipeline
    shape. **Reviewed, left separate.**
  - `agent_avatar_assets`, written by `poll-did-avatars` (polls creation
    status) and `did-agent-sync` (PATCHes the live D-ID Agent record) —
    different purposes on the same table. **Reviewed, left separate.**
- **"No `.from()` detected" (54 entries)** — advisory worklist, not audited
  route-by-route this wave (out of scope for a billing census); most are
  expected to call into a `lib/` helper that does the real read/write, an
  `.rpc()`, or a pure external side effect (email/SMS/webhook/Remotion
  render) with no direct Supabase table touch in the route file itself. Left
  **unresolved** rather than guessed at — a future lane can run
  `npx tsx scripts/cron-cost-census.ts --list` and work the list down.

## 5. Blind spots (published beside every count, CLAUDE.md §2)

- CPU/Active-CPU/Provisioned-Memory dollar cost is not estimated (§2 above)
  — a documented gap, not a hidden zero.
- "No `.from()` detected" only looks for literal `.from("table")` in the
  route file itself — a call into a `lib/` helper, an `.rpc()`, or a
  non-Supabase side effect all correctly show zero and are **not** proof of
  a no-op tick.
- Table-write-overlap only sees literal string table names; a runtime-built
  `.from(tableVar)` is invisible (undercounts, never over-accuses).
- The calendar simulation uses 2026 (the year in the owner's ruling); no
  registered schedule restricts to `dom=29-31` with `month=2`, so this
  repo's numbers are unaffected by leap-year edge cases in practice.
- Real Vercel execution duration (Active CPU) per route is not observable
  from source — the elevated-memory table in §2 names the routes to check
  against Vercel's own Runtime Logs, not a substitute for them.

## 6. Re-running this audit

```
npx tsx scripts/cron-cost-census.ts          # report + ratchet check
npx tsx scripts/cron-cost-census.ts --list   # + full flag listings
npx tsx scripts/cron-cost-census.ts --write-baseline  # deliberately raise/lower the ratchet
```

`npm run test:cron-cost` runs the ratchet check (no `--list`) as part of the
guard chain (once registered — see the integrator note in the wave 62 lane
report).
