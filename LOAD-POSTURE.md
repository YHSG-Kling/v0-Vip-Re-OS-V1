# LOAD-POSTURE — the per-minute cron dispatcher, measured as schedule math

**What this is:** the measured load posture of the per-minute cron dispatcher
(`lib/kernel/cron-dispatch.ts` — one Vercel cron, `/api/cron/dispatch`, fanning out the
whole registry). Every number below comes from a run of
`scripts/dispatcher-load-simulator.ts` (`npx tsx scripts/dispatcher-load-simulator.ts`),
which executes the **real `CRON_REGISTRY` and the real `isDue()` matcher** over a
simulated 24 hours of minutes (plus a full-year sweep for calendar-stacked schedules)
with a **synthetic 100-tenant multiplier** on the crons that fan out per tenant.

**What this is NOT:** a network load test. No HTTP was fired, no route executed, no DB
was touched, and no route latencies were measured. These are schedule-math facts about
*how many things become due at once* — the honest precursor to a real load test, not a
substitute for one. There are **no invented benchmarks** in this file; the one tunable
(the jobs-per-minute budget) is labeled as a documented threshold parameter, not a
measurement.

Run date: 2026-07-20 · registry as of round 43 (post-stagger). Round-42 numbers are
kept below as the **before** column.

## Round 43 — cron staggering (before/after)

Round 42 measured that the `HH:00` minutes dominated: hourly, every-n-hour, daily and
weekly per-tenant crons all collided on minute :00, and Monday 12:00 UTC stacked 26
per-tenant multipliers at once. Round 43 **re-minuted 70 of the 72 per-tenant crons**
onto spread offsets (each line marked `(staggered r43)` in the registry). Every cron's
**period is unchanged** — a daily cron is still daily, an hourly cron still hourly, a
`*/15` cron still fires every 15 minutes (as a phase-shifted comma list, e.g.
`1,16,31,46`); only the minute-of-hour moved, never the hour, so every documented
business window (office-hours 13:00/19:00 UTC drops, client-pulse Friday 16:00/18:00,
quiet-hour-sensitive sends) is preserved. The two unmoved per-tenant crons are
`speed-to-lead` (`*/2` — the deliberate every-2-minute floor) and `appointment-whisper`
(`*/10`).

| metric (100 synthetic tenants) | before (round 42) | after (round 43) |
|---|---|---|
| worst minute (by jobs) | Mon **12:00** UTC → **2,643** jobs / 69 routes | Mon **06:00** UTC → **246** jobs / 48 routes |
| year-worst minute | 2026-01-05 12:00 → 2,643 jobs | 2026-09-28 06:00 → **247** jobs (Monday 06:00 + `affiliate-commissions` on the 28th) |
| worst-minute decomposition jobs(N) | 43 + **26**·N | 47 + **2**·N |
| per-tenant multipliers at the worst minute | 26 | **2** (speed-to-lead + appointment-whisper) — **−92%** |
| first shard boundary (500 jobs/min budget) | **18 tenants** | **227 tenants** |
| jobs/minute p50 / p90 / p99 / max | 104 / 214 / 1,834 / 2,643 | 104 / 213 / **234** / **246** |
| routes/minute p50 / p90 / p99 / max | 5 / 16 / 52 / 70 | 5 / 16 / 36 / **48** |
| route dispatches/day | 8,876 | **8,876 (identical — proof no period changed)** |
| active minutes/day | 1,056 / 1,440 | 1,320 / 1,440 (same work, spread wider) |

Stagger design (why it doesn't re-stack): `speed-to-lead` owns the even minutes, so
every other per-tenant cron was placed to collide with **at most one** other per-tenant
cron. The five hourly per-tenant crons took distinct odd minutes (:05 :07 :17 :35 :47,
deadline-watcher :45); the `*/30` tier took odd phase pairs (:25/:55, :27/:57,
:23/:53); the five `*/15` crons took disjoint phase sets (1,16,31,46 · 3,18,33,48 ·
6,21,36,51 · 11,26,41,56 · 13,28,43,58); the every-n-hour tier kept its hour pattern
and took distinct minutes (:15 :52 :08 :24 :38 :44 :14 :34); dailies/weeklies moved to
:12/:22/:32/:42/:54 (or :15 at odd hours), distinct within each hour+weekday. Minute
:37 is deliberately left empty at all hours (the dispatch simulator's quiet-minute
regression pins 01:37 as silent). Result: **no minute of the year carries more than 2
per-tenant multipliers.**

## Measured facts (after — round 43)

### Registry
- **188 registered schedules** (`CRON_REGISTRY.length`), all 188 resolved to real route
  files by the simulator's drift check.
- **72 of 188 crons are per-tenant multipliers** — their routes iterate every brokerage
  (classification: static scan for a `from("brokerages")` list read without single-row
  narrowing, `activeSubscriberBrokerageIds`, or an explicit per-brokerage loop). This
  is a **heuristic** classification; the simulator prints the full audited list with
  the matched signal per cron.
- 116 crons are global (platform-wide sweeps, queue drains, single-row probes).

### 24h minute sweep (Monday 2026-07-20 UTC — Mondays stack the weekly schedules)
- **8,876 route dispatches/day** across **1,320 of 1,440 active minutes**.
- Routes due per minute: **p50 = 5, p90 = 16, p99 = 36, max = 48**.
- Jobs per minute at 100 tenants (per-tenant cron = 100 jobs, global cron = 1 job):
  **p50 = 104, p90 = 213, p99 = 234, max = 246**.
- **Worst minute by routes AND by jobs: 06:00 UTC → 48 routes, 246 jobs.**
- Top-5 stacked minutes (by jobs, 100 tenants):

  | minute (UTC) | routes due | jobs |
  |---|---|---|
  | Mon 06:00 | 48 | 246 |
  | 08:00 | 46 | 244 |
  | Mon 12:00 | 45 | 243 |
  | 00:00 | 44 | 242 |
  | 07:00 | 41 | 239 |

  The `HH:00` minutes still carry the **global** cron stack (up to ~47 one-job routes),
  but the per-tenant multipliers are gone from :00 — every top minute is now
  `~45 globals + 2×N`, dominated by the two unmoved fine-grained per-tenant sweeps
  (`speed-to-lead`, `appointment-whisper`), not by the :00 pile-up.

### Full-year sweep (calendar-stacked schedules: dom/month entries like board-packet, QBR, affiliate-commissions)
- 365 × 1,440 minutes swept; **year-worst minute: 2026-09-28 (a Monday) 06:00 UTC →
  49 routes, 247 jobs** — the Monday-06:00 stack plus the monthly
  `affiliate-commissions` global (`0 6 28 * *`) landing on the same minute. Month-day
  crons add **+1 job**, not another multiplier.

## Per-tenant multipliers (the 72)
Full audited list is printed by the simulator (`[1 · per-tenant fan-out classification]`).
After round 43 the only per-tenant crons on any shared minute are `speed-to-lead`
(`*/2`, even minutes) plus at most one staggered cron; the heavy hourly/step/daily
per-tenant crons each own a minute offset (see the stagger-design paragraph above and
the `(staggered r43)` markers in `lib/kernel/cron-dispatch.ts`).

## The first shard boundary (documented threshold — schedule math, not a benchmark)
At the year-worst minute the decomposition is:

```
before (r42): jobs(N) = 43 global + 26 per-tenant × N = 43 + 26·N   → 2,643 at N=100
after  (r43): jobs(N) = 47 global +  2 per-tenant × N = 47 +  2·N   →   247 at N=100
```

Against a documented budget of **500 jobs/minute** (a *chosen* threshold parameter —
`LOAD_SIM_JOB_BUDGET`, default 500; it is not a measured capacity):

> **Before: at 18 tenants the Monday 12:00 UTC minute exceeded 500 jobs (43 + 26·18 = 511).**
> **After: the boundary moves to 227 tenants (47 + 2·227 = 501) — a 12.6× headroom gain
> from re-minuting alone, with zero behavior change to any cron's cadence.**

Beyond ~227 tenants the next levers are the ones round 42 named: hashing tenants into
minute buckets inside the fine-grained per-tenant sweeps (`speed-to-lead`,
`appointment-whisper`), or sharding the dispatcher tick. The dispatcher itself now
fires at most **48 route fetches in one tick** (down from 70) regardless of tenant
count — route fan-out is constant in N; it is the *inside-route* per-tenant iteration
that scales with N.

## Honest limits
- Per-tenant classification is a static-scan heuristic (auditable list in the sim
  output); a route that fans out via a non-brokerage table would be undercounted, and
  a route that reads the brokerage list but early-exits per tenant is counted at full
  weight.
- "Jobs" are schedule-math work units (route × tenant), not measured executions; real
  cost per job varies by orders of magnitude across routes.
- No conclusions about wall-clock capacity are made here — the 55s per-route fetch
  timeout in `dispatchDueCrons` is the only hard runtime constant, and validating it
  requires a real load test against a deployed environment.
- Staggering moved minutes, never hours: schedules whose route headers document a
  business window (e.g. office-hours "morning/afternoon drops", client-pulse Friday
  afternoon) still fire inside that window, at most 54 minutes later than before.
