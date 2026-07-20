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

Run date: 2026-07-20 · registry as of round 42.

## Measured facts

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
- **8,876 route dispatches/day** across **1,056 of 1,440 active minutes**.
- Routes due per minute: **p50 = 5, p90 = 16, p99 = 52, max = 70**.
- Jobs per minute at 100 tenants (per-tenant cron = 100 jobs, global cron = 1 job):
  **p50 = 104, p90 = 214, p99 = 1,834, max = 2,643**.
- **Worst minute by routes: 06:00 UTC → 70 routes due at once** (2,446 jobs).
- **Worst minute by jobs: Monday 12:00 UTC → 2,643 jobs from 69 routes.**
- Top-5 stacked minutes (by jobs, 100 tenants):

  | minute (UTC) | routes due | jobs |
  |---|---|---|
  | Mon 12:00 | 69 | 2,643 |
  | 06:00 | 70 | 2,446 |
  | 00:00 | 65 | 2,342 |
  | 04:00 | 59 | 2,237 |
  | 08:00 | 65 | 2,144 |

  The `HH:00` minutes dominate: hourly (`0 * * * *`), every-2/4/6/12-hour (`0 */n`),
  and daily (`0 H * * *`) schedules all collide on minute :00. Minutes :15/:30/:45
  carry only the `*/15`-and-finer tier.

### Full-year sweep (calendar-stacked schedules: dom/month entries like board-packet, QBR, affiliate-commissions)
- 365 × 1,440 minutes swept; **the year-worst minute equals the Monday-noon worst:
  Monday 12:00 UTC → 69 routes, 2,643 jobs** (first occurrence 2026-01-05T12:00Z).
  Month-day-specific crons (board packet on the 1st/2nd, QBR in Jan/Apr/Jul/Oct 1–7,
  affiliate commissions on the 28th) do not overtake the Monday-noon stack.

## Per-tenant multipliers (the 72)
Full audited list is printed by the simulator (`[1 · per-tenant fan-out classification]`).
The heaviest contributors at the worst minute are the hourly/even-hour per-tenant crons
(`idle-hands`, `reverse-prospecting`, `closing-watchtower`, `appointment-noshow`,
`consent-recovery`, `bidding-war-concierge`, `approval-push`, `launch-war-room`,
`context-spine-refresh`, `financing-pit-stop`, `inventory-radar`, `listing-health-scan`,
`connector-health`) plus the `*/15`-tier per-tenant sweeps (`offer-net-sheet`,
`enrichment-processor`, `health-check`, `document-autofile`, `/api/alerts/cron`,
`tour-optimizer`, `speed-to-lead` at `*/2`) and the Monday-noon weeklies
(`referral-radar`, `commission-forecaster`) landing on top of the daily noon set
(`platform-sentinel`, `ads-manager-sweep`, `overnight-digest` at 12:30 excluded — :00 only).

## The first shard boundary (documented threshold — schedule math, not a benchmark)
At the year-worst minute the decomposition is:

```
jobs(N tenants) = 43 global routes + 26 per-tenant routes × N
                = 43 + 26·N
at N=100 → 2,643 jobs in the 12:00 UTC minute
```

Against a documented budget of **500 jobs/minute** (a *chosen* threshold parameter —
`LOAD_SIM_JOB_BUDGET`, default 500; it is not a measured capacity):

> **At 18 tenants, the Monday 12:00 UTC minute exceeds 500 jobs (43 + 26·18 = 511).**

That is the first shard boundary: beyond ~18 active tenants, if 500 per-tenant work
units per minute is the budget the platform wants to hold, the `HH:00` stack (and
Monday noon in particular) is where sharding starts — e.g. offsetting per-tenant crons
across minute offsets (`:07`, `:11`, …), hashing tenants into minute buckets, or
splitting the dispatcher's `:00` tick into staggered waves. The dispatcher itself fires
at most **70 route fetches in one tick** (06:00) regardless of tenant count — route
fan-out is constant in N; it is the *inside-route* per-tenant iteration that scales
with N.

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
