# Wave 156 — scaling and CI: is keeping the app small hindering its capability?

Owner decision memo, lane 156L, 2026-11-25. Nothing was purchased, no ceiling was raised, and no CI file,
`tsconfig*.json` or `package.json` was edited. Every number below was measured in this lane unless it is
marked as quoted.

## 1. Short answer

**No capability was removed or hidden to fit the budget, and none needs to be.** The import budget went red
in this wave because of how the code was wired, not because the product grew too large. The cuts made here
are wiring changes: an importer that took one name from a re-export barrel now imports it from the module
that defines it, and one small ledger module moved out of a large registry. Those cuts lowered the heaviest
page by 36 modules and the union by 60 without deleting a line of product code. Section 6 explains what the
budget cannot fix and which decisions belong to the owner.

## 2. What each ceiling protects

`test:proxy-graph-budget` (`scripts/proxy-graph-budget-guard.ts`, walker `scripts/app-import-graph.ts`) counts
first-party modules that are reachable through static and dynamic imports. It does not measure bundle bytes.

| Ceiling | Value | What it stands in for |
|---|---|---|
| `PROXY_GRAPH_BUDGET` | 40 | The edge middleware compile (`proxy.ts`). One edge into it (wave 100) pulled in 823 modules and caused three exit-134 aborts in a row. |
| `APP_ENTRY_GRAPH_BUDGET` | 1,300 | One heavy page. Each heavy page adds to the server compile worker's peak heap, and the client part of its graph is parsed twice (rsc + ssr). |
| `APP_UNION_GRAPH_BUDGET` | 5,300 | Every module the server build worker compiles. This is the closest first-party proxy for the heap peak of the full single-pass build. |

The full single-pass `next build` runs only on the owner's larger runner (`BUILD_RUNNER`, which is empty
today). CI compiles two halves instead (`next-build-half`, lever (d) in `.github/workflows/build.yml`). The
bracket quoted from `build.yml` and CLAUDE.md §8: each half peaks at 14.1–14.7 GB RSS on a 15 GiB runner and
finishes only by swapping. A run whose swap thrashes is cancelled at 40 minutes (run 43986529213), and an
unchanged re-run passed. The type-check is split in two (`tsconfig.app.json`, 11.47 GB peak RSS, then
`tsconfig.scripts.json`, 8.03 GB peak RSS; CLAUDE.md §7, measured 2026-11-20).

## 3. Measurements (this lane, using the walker's own algorithm)

| | Pre-wave (quoted from the brief) | Start of Batch 2 (`b261c474`) | After 156L |
|---|---|---|---|
| `app/crm/page.tsx` | 1,300 | **1,307** (red) | **1,271** |
| `app/dashboard/agent/page.tsx` | | 1,282 | 1,227 |
| `app/dashboard/listings/[id]/lifecycle/page.tsx` | | 1,271 | 1,241 |
| `app/dashboard/marketing/studio/page.tsx` | | 1,235 | 1,200 |
| `app/api/marketing/content-command/route.ts` | | 1,213 | 1,177 |
| Union of 1,024 app entries | 5,272 | **5,306** (red) | **5,246** |

The "after" column includes +3 modules for re-hosting "Add a form or packet" in FormWizard (brief step 4) and
+1 for the new ledger leaf. Both budget rules are now green: heaviest entry 1,271 of 1,300 (29 modules of
headroom), union 5,246 of 5,300 (54 of headroom). `scripts/wave156-l-guard.ts` re-derives every number above
on each run and pins none of them.

### Why a CRM page reached 1,307 modules

- A 392-module strongly connected core sits at the centre. Through it, every heavy page reaches the same
  **1,040-module closure**. The loop runs `lib/kernel/action-ledger.ts → tenant-policy → emit →
  notification-engine → event-reactor → (every reactor, producer and provider) → … → lib/ai/models.ts →
  resource-allocation → action-ledger`.
- So any server action that writes a receipt, emits an event or calls a model reaches the whole core. That
  is legitimate runtime coupling: the event reactor really does dispatch to every manager. It is **not** a
  constant or a type pulling in a subsystem.
- The CRM page's own share is about 267 modules: its components, the server actions they call, and FormWizard
  (49 modules).
- Dominator, edge-cut and "pure symbol" scans over that share found very little to cut. Only four
  single-module cuts would save 2 modules each.
- The real excess came from two other patterns:
  - **Re-export barrels.** An importer named one function in `lib/buyer-lifecycle/index.ts`,
    `lib/auth/client.ts`, a component `os/index.ts` or `lib/security/index.ts`, and the barrel pulled in every
    sibling.
  - **One registry used as a library.** `lib/kernel/os-health.ts` and `lib/intelligence/manager-standup.ts`
    imported the reaper REGISTRY, which lazily imports about 25 reapers, just to reach its two ledger
    functions.

## 4. What was cut (each a separate commit; the product behaves exactly as before)

1. **The six barrels on the CRM path.** 26 importers now name the module that defines each binding. The guard
   proves the target exports every name. crm 1,307 → 1,293 and union 5,306 → 5,295.
2. **43 more barrels across the app.** 62 importers. Barrels with a `"use client"` or `"use server"`
   directive, or with a side-effect import, were excluded by rule. Four barrels that scripts stub by name were
   left alone: `lib/kernel` (`import "server-only"`), `lib/brokerage`, `lib/identity` and `lib/buyer-offer`.
   Union 5,295 → 5,244 (5,245 once one importer of `lib/communications` went back to the barrel, because test:deal-desk stubs that module by path).
3. **The reaper_runs ledger** (`recordReaperRun`, `loadRecentReaperActivity`) moved verbatim to
   `lib/intelligence/reaper-runs-ledger.ts`. It is re-exported from `reaper-net.ts`, with a tombstone at
   `reaper-net.ts:271`. Every heavy entry dropped by about 25 modules.
4. **FormWizard hosts "Add a form or packet" again** (brief step 4). crm 1,268 → 1,271.
5. **One client → server-secret path closed.** `tech-stack-client.tsx` ("use client") imported two data tables
   from a module that reaches `lib/supabase/service.ts`, which reads `SUPABASE_SERVICE_ROLE_KEY`. The server
   page now passes the tables as props. This was the only such path among 1,293 client modules.

Every edit is line-neutral: no cited `file:line` moved. Nothing was deleted, and no export was added or
removed.

## 5. What could NOT be reduced, and why the union only falls by moving or removing real code

- **The 1,040-module core** is shared by every heavy page. It cannot shrink by cutting import edges, because
  its edges are real calls: event dispatch, receipts and model routing. The only ways to shrink it change the
  architecture (option (c) below).
- **The union counts real code.** A barrel seam lowers the union only when the barrel was in the union solely
  as a pass-through. The remaining union is product modules. A duplicate merge removes at most one module per
  pair.
  - The rename/near-duplicate scan here (component name collisions, exported-function similarity) found no
    provable whole-module duplicate except two modules whose exports have zero callers (re-exported only by `lib/brokerage/index.ts`): `lib/brokerage/get-required-state.ts` (a second source for the primary state)
    and `get-required-providers.ts`. Removing them is held because of the orphan-export baseline (an INTEGRATOR
    decision).
  - Function-level duplicates found: `runFfmpeg` in `lib/podcast/episode-audio-measure.ts` and
    `lib/video/tv-spot-measure.ts` (lane 156S's files), and `isSystemGateEnabled` / `getEnabledSystemGates` in
    both lifecycle-definition modules. Merging these does not remove a module.
- **The net-sheet duplicate (brief step 2) was NOT merged in this lane.** The CMA net sheet and the engine have
  different input contracts:
  - The CMA sheet (`lib/cma/net-sheet-math.ts` via `app/actions/cma-presentation/net-sheet-calculator.ts`)
    takes brokerage default rates, a regional closing-cost band and a percent fallback.
  - The engine (`lib/calculators/engine.ts` seller_net_sheet) refuses a missing title/escrow quote and
    computes transfer tax by jurisdiction.
  - The portal calculator (`app/components/portal/NetSheetCalculator.tsx`) still defaults to 6% commission
    and falls back to 2% closing costs, and it treats prorations as a seller CREDIT, which the engine cannot
    take (negative inputs are refused).

  Merging changes what sellers see on three surfaces, so it is a product change and not a seam. It needs the
  owner to answer one question: may a seller-facing net sheet show a figure the seller did not enter, if it is
  cited (the regional band, the agreed commission from the listing agreement)? The engine says no; the CMA
  sheet says yes.

## 6. Options, with costs (public prices, read 2026-11-25; nothing bought)

| Option | What it buys | Cost / risk |
|---|---|---|
| **(a) Larger CI runner** (`BUILD_RUNNER`). GitHub larger runners: Linux 8-core / 32 GB at **$0.022/min**, 16-core / 64 GB at **$0.042/min** (x64). Arm64 is $0.014 and $0.026. Source: https://docs.github.com/en/billing/reference/actions-runner-pricing and https://docs.github.com/en/actions/reference/runners/larger-runners | The full single-pass build fits with 2× headroom (14.7 GB peak vs 32 GB). It ends the swap-thrash cancellations. | About $0.66–1.32 for a 30-minute build at 8 / 16 cores. At 20 builds a day that is about $13–26 a day. Requires a GitHub Team or Enterprise Cloud org; drawn from included minutes first. **The owner's purchase.** |
| **(b) Smaller shared core** | Every heavy page drops as the 1,040 closure shrinks. | Requires breaking the event-reactor cycle: emitters must not statically or dynamically import every reactor. That means a dispatch registry that cron/queue workers load instead of the request path. This is a multi-wave architecture change, and its behaviour risk lands on autonomy and arbitration (lanes 156M/156S own those files). |
| **(c) Separately deployed workers** (cron workers, render worker) that the app calls over HTTP or a queue instead of importing | Removes cron-only and render-only subsystems from the app compile. The union could fall by hundreds of modules. | Needs hosting for a second deployable, a signed internal API, and durable queue semantics (lifecycle_events + reaper already exist). The Remotion render worker is the best first candidate (lane 156S's domain). Cost is the worker's hosting; not priced here. |
| **(d) TypeScript project references** | Bounded type-check units (app, scripts, workers, shared types) that build in sequence with `.tsbuildinfo` reuse. Peak heap becomes the largest unit, not the whole. | A patch is sketched below. It is **untested**: a whole-program `tsc` is forbidden on lane machines. `composite` requires `declaration` emit and explicit `include` of everything a project imports, so the first run will surface cross-project imports that must become a shared project. |
| **(e) Recalibrate the union ceiling** | Honest headroom if the measured build peak shows room. | The **owner's call**. Evidence that would justify it: a full single-pass build's peak RSS on the target runner, logged per wave in the `build.yml` bracket, against the union count at that commit. Raise only by the module count the measured headroom supports. Never use it to land a red wave. |

### (d) Ready-to-apply sketch (do not apply without measuring)

```jsonc
// tsconfig.shared.json  (new)  — pure types + pure leaves both sides import
{ "extends": "./tsconfig.json", "compilerOptions": { "composite": true, "declaration": true, "emitDeclarationOnly": true, "noEmit": false, "outDir": ".tsbuild/shared" },
  "include": ["types/**/*.d.ts", "lib/**/*-types.ts", "lib/calculators/engine.ts"] }
// tsconfig.app.json   — add:  "compilerOptions": { "composite": true, "noEmit": false, "emitDeclarationOnly": true, "declaration": true, "outDir": ".tsbuild/app" },
//                             "references": [{ "path": "./tsconfig.shared.json" }]
// tsconfig.scripts.json — add: "references": [{ "path": "./tsconfig.app.json" }]   (scripts import app/lib)
// package.json: "type-check": "tsc -b tsconfig.scripts.json"   (one umbrella build; cross-project errors still fail)
```

Measurement commands (run alone on the 16 GB box, one at a time, per CLAUDE.md §7):

```
/usr/bin/time -v npx tsc -b tsconfig.scripts.json --extendedDiagnostics 2>&1 | grep -E "Memory used|Maximum resident|Elapsed"
/usr/bin/time -v npx tsc -b tsconfig.scripts.json --extendedDiagnostics 2>&1 | grep -E "Memory used|Maximum resident|Elapsed"   # warm: .tsbuildinfo reuse
```

Compare against today's two programs (11.47 GB / 8.03 GB peak RSS, 295 s + 117 s).

## 7. A durable checkpoint during hour-long guard runs (ephemeral containers)

- The full chain (`npm run guard`, 1,016 steps, about an hour) dies with its container, and the work dies with
  it.
- Options, in order of how little they need:
  1. Commit locally after every lane commit. This needs no authorization but does not survive the container.
  2. Push a work-in-progress branch (e.g. `wip/wave-156-<lane>`) after each green slice. This survives the
     container but **needs the owner's authorization** (CLAUDE.md: never push unasked).
  3. Have the chain runner write `progress.txt` + `summary.txt` (as the integrator's `chain-all.sh` already
     does) and start from a step number (`chain-all.sh <label> <first-step>`). This resumes a chain in a new
     container, but only if (2) carried the commit there.
- Recommendation: the owner authorizes (2) for integrator-only WIP branches that are never merged directly.
  Nothing was pushed in this lane.

## 8. State of the tree after this lane

Both budget rules are green with 29 / 54 modules of headroom. Batch 2's other lanes will add modules. Each new
module, page or route file counts against the union. The next wave should take option (c) for the render
worker, or option (a), before the headroom is used up.
