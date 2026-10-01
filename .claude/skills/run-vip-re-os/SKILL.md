---
name: run-vip-re-os
description: Run, build, smoke-test, and drive the VIP Agents AI real-estate CRM (Next.js + Supabase kernel app). Use when asked to run / start / build / test / smoke / drive / screenshot this app, or to validate a lead/offer/listing/transaction flow end-to-end against the live database.
---

# Run VIP Agents AI (v0-Vip-Re-OS-V1)

Next.js 16 (App Router, Turbopack) + Supabase real-estate CRM built on a "kernel OS"
event architecture (`lib/kernel/`). State lives in Supabase (project ref
`hrvaqgvukzxfskkcrwbt`); auth is Supabase + Google OAuth.

**Read this first — how this app is actually driven here.** In the agent sandbox you
**cannot** run the UI (the dev server is SIGTERM-killed and no browser binary is
installable — see Gotchas). What you **can** do, and what nearly every PR in this repo
touches, is the **kernel/schema layer**: drive the real business flows against the live
Supabase via the **Supabase MCP `execute_sql`** tool. The driver is
[`.claude/skills/run-vip-re-os/flows.sql`](.claude/skills/run-vip-re-os/flows.sql) —
verified flows (lead→contact pipeline, transaction creation, listing-agreement-signed)
with built-in cleanup. Paths below are relative to the repo root.

## Prerequisites
- Node 22 / npm 10 (`node -v` → v22.22.2, `npm -v` → 10.9.7), already present.
- The Supabase MCP server (tool prefix `mcp__…__execute_sql`) pointed at project
  `hrvaqgvukzxfskkcrwbt`. This is the privileged handle the app's server layer uses.

## Build / typecheck (verified)
```bash
npm install            # also run automatically by the SessionStart hook
npx tsc --noEmit       # type-check; expect zero output (clean)
```

## Run (agent path) — drive the real flows
The driver is SQL executed via the Supabase MCP (it runs privileged, bypassing RLS —
the same access the app's `createServiceClient` uses). Run each numbered block of
`flows.sql` with `mcp__<supabase>__execute_sql` (project_id `hrvaqgvukzxfskkcrwbt`).
It uses the seed fixtures already in the DB — brokerage
`b0000000-0000-0000-0000-000000000001`, agent `c0000000-0000-0000-0000-000000000002` —
tags every row, and deletes them at the end.

Three flows, each with a VERIFY and CLEANUP:
1. **Lead pipeline** — `raw_scraped_leads` → promote → `leads` (`unconsented` →
   `isa_qualifying` → `consented`) → assignment creates+links a `contact`. Expect the
   final row: `processing_status=promoted, lifecycle_state=assigned, tcpa_consent=true`,
   `contact_id` set, `agent_id` = the **agents.id** (never a users.id).
2. **Transaction create** — `contact_id` = primary client; `deal_type ∈ {buyer,seller,
   dual}`, `status ∈ {lead,qualifying,active,under_contract,closing,closed,lost}`,
   `deal_name` NOT NULL. (Old `buyer_side`/`pre_listing`/`new` or columns
   `buyer_id`/`transaction_type` FAIL — that's the regression guard.)
3. **Listing agreement signed** — only `LISTING_AGREEMENT_INITIATED` advances to
   `LISTING_AGREEMENT_SIGNED` + `status=coming_soon` (NOT `MLS_ACTIVE`).

Always finish with the final cleanup-guard SELECT (expect every count = 0). This whole
driver was run end-to-end in-session with all-zero leftovers.

## Run the REAL functions (MCP replay bridge) — wave 91, lane 91D
`*.supabase.co` is refused by the sandbox egress proxy and no service key exists, so
supabase-js cannot run here. `mcp-bridge/` runs the app's real server functions
in-process anyway: `@/lib/supabase/{service,server}` resolve to a bridge client that
turns every query builder into SQL; the agent executes each batch with
`execute_sql` and feeds the answer back (`run.ts <scenario> --ingest answer.json`).
Writes whose result is unused are deferred and batched; each statement runs in its
own subtransaction under `service_role` or `authenticated` + JWT claims (so RLS applies);
a refusal is replayed at its own index. `journey-wave91.ts` is the prospect →
lifetime-customer scenario. Traps paid for: un-awaited background chains reorder calls
between runs — `quiesce()` after every step and identity-keyed replay handle it, but a
cache recorded before those existed must be discarded (never replay a stale write);
`auth.admin.*` is EMULATED on `auth.users` for demo emails only (no mail is sent);
all `fetch` is refused (no Stripe/AI/mail call). Cleanup: `cleanup-template.sql`
pattern in the lane-91D notes (per-table ROW_COUNT, passes until stable).

### Wave 93 (lane 93D) additions — `journey-wave93.ts`, 825 calls end to end
- **Shadowed reads.** A read scoped to the walk's brokerage (`setScopeBrokerage`) or to a
  walk-owned id (`setScopeIds(col, ids)`, `setScopeTextIds(col, values)` for text columns;
  `autoScope` adds every id an INSERT returns) is answered EMPTY locally when the last id
  census proved that table holds none of them and nothing pending can have changed it
  (`shadowEmptyOk`). A write on a trigger-free table (`TRIGGER_TABLES`, read from pg_trigger
  2026-10-01 — refresh it if triggers change) cannot stale another table's census. Shadowed
  answers are cached with label `shadow:empty`, so the audit shows which ones were local.
- **The census answer.** Return `=` when the table list is unchanged (md5 of the sorted list
  is compared). Return `+a,b` for additions. Return the full list when anything was removed.
- **Volatile keys.** From `meta.msFrom` on, `"…_ms":N` and 13-digit epoch-ms values within
  30 days are normalised in the replay key, the same as wall-clock countdowns. Without this,
  `processing_time_ms` drift re-issued an already-applied INSERT.
- **Other cache fixes.** A pending READ from the last run is recomputed rather than replayed.
  From `meta.starFrom` on, a `select("*")` by id records its shape.
- **Run the batch exactly as printed.** Never hand-rewrite the DO-wrapper writes into CTEs.
  You may change only the final SELECT, for a fingerprint, but if that SELECT errors the
  whole request rolls back. Re-run it verbatim.
- **Trap: reuse by call number.** After a rewind, the newest cached answer for call N can
  belong to a DIFFERENT statement. Before copying an answer forward, check its sig/SQL.
  The lane's `reuse.cjs` prints its source row for this reason.
- **Trap: an app change mid-walk shifts every later call index.** For example, adding a read
  in `notification-engine` broke replay at call 26. Defer such changes until the walk ends,
  or rewind to the first call they touch.
- **Cleanup.** A whole-schema DO-block delete timed out at 60 s and rolled back. Use explicit
  per-group CTE deletes with `RETURNING` counts instead. Prove inserted = deleted, and
  prove 0 residual against every tag predicate and every `brokerage_id` table.

## Run (UI / human path) — NOT available in the sandbox
The app needs Supabase env. Fetch it with the Supabase MCP and write `.env.local`
(gitignored):
```bash
# mcp__<supabase>__get_project_url        -> NEXT_PUBLIC_SUPABASE_URL
# mcp__<supabase>__get_publishable_keys   -> NEXT_PUBLIC_SUPABASE_ANON_KEY (anon)
# .env.local: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
npm run dev            # boots locally with env (Turbopack); needs a real machine, not this sandbox
```
On a real machine, log in via Google, then the changed surfaces to click:
`/dashboard/buyers` → redirects to `/crm?contact_type=buyer`; New Transaction → creates a
linked contact; listing e-sign → "coming soon". The deployed app (old code) is live at
`https://v0-supabase-client-initialization.vercel.app/login` (verified 200 via the Vercel MCP).

## Browser driver (screenshots)
A headless-Chromium driver is committed:
[`.claude/skills/run-vip-re-os/browser-shot.cjs`](.claude/skills/run-vip-re-os/browser-shot.cjs).
It uses `@sparticuz/chromium` because that package ships the browser binary inside the
npm package — the sandbox egress allowlist blocks `cdn.playwright.dev` and apt, but npm
is allowed, so this is the only Chromium that installs here.
```bash
npm i @sparticuz/chromium puppeteer-core   # one-time
node .claude/skills/run-vip-re-os/browser-shot.cjs http://localhost:3000/login /tmp/app-shot.png
```
Verified working in-sandbox against an allowlisted host (rendered + screenshotted
`https://github.com`, status 200). It prints status/title/clickables and writes a
full-page PNG. **Reachability:** point it at `localhost` (the dev server, on a machine
where that runs) — `*.vercel.app` returns the proxy "Host not in allowlist" page from the
agent sandbox, so the deployed app is only browser-reachable from your own machine.

## Gotchas (sandbox battle scars)
- **No browser from the usual sources.** Egress is an **allowlist**: npm/pypi/github are
  allowed; `cdn.playwright.dev`, `vercel.com`, `*.vercel.app`, and Ubuntu PPAs return
  `403 'Host not in allowlist'`. Chromium therefore must come via npm
  (`@sparticuz/chromium`); Playwright's download and `apt-get chromium` both fail. The
  egress proxy also does TLS interception, so the browser needs `ignoreHTTPSErrors`.
- **Dev server is SIGTERM-killed** (exit 144) in the agent sandbox — it dies before
  Turbopack finishes compiling (memory is fine at 14GB free; it's a command-runtime
  policy). It boots normally on a real machine / Vercel.
- **No service-role key** is exposed by the Supabase MCP (`get_publishable_keys` returns
  only anon/publishable). `.env.local` uses the anon key as a placeholder so
  `createServiceClient()` doesn't throw at init, but server admin writes are degraded —
  which is why the **MCP `execute_sql` driver (privileged)** is the real harness here.
- **Live DB is mostly seeded, not empty.** Reuse the seed brokerage/agent above; do NOT
  delete seed rows. Always clean up tagged test rows (the driver does).
- **Branch previews on Vercel auto-cancel** (every one is `CANCELED` at queue time);
  production deploys from a different branch and runs old code.

## Troubleshooting
- `Your project's URL and Key are required to create a Supabase client!` on every route
  → `.env.local` missing `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY`; fetch via the Supabase MCP.
- `execute_sql` flow fails on `deal_type`/`status`/`lifecycle_state` → you used a
  non-canonical value; check the table's CHECK constraint (the driver uses the valid set).
- A test row lingered → re-run the final cleanup-guard block of `flows.sql`.
