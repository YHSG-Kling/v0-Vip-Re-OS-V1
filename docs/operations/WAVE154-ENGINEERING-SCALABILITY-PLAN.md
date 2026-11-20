# Wave 154 — engineering scalability plan (K4)

Lane 154K, 2026-11-18. Nothing here changes a threshold, a cap or a runner. The runner size is the owner's decision.
No whole-project type-check or build was run to write this; every figure is quoted from where it was already measured.

## 1. What is already measured

| fact | value | where it is recorded |
|---|---|---|
| whole-project `tsc --noEmit` | aborted at 12,288 MB (12.05 GB used); passed at a 14,000 MB cap; "Memory used: 13087618K", peak RSS 12.86 GB; 13,943 files / 1.90 M lines | CLAUDE.md §7 (wave 153, 2026-11-16) |
| type-check cap now | 14,336 MB in `npm run guard`, `guards.yml`, `e2e.yml`. CLAUDE.md calls this "the last bump a 16 GB box can take" | CLAUDE.md §7 |
| `next build` compile | exit 134 "Ineffective mark-compacts" with COMMITTED heap at about 90% of the cap. The floor went from 7.2 GB to 8.5 GB (measured twice, within 1 MB) to 8.72 GB | `.github/workflows/build.yml` bracket comments (lines ~56–110) |
| half builds | `next-build-half` matrix (`dashboard` / `rest`, build.yml:735–776) at 14,336 MB; compile worker peak RSS 14.1–14.7 GB on a 15 GiB runner, so a half finishes only on swap. Second symptom: silent stall until the 40-minute timeout (run 43986529213) | CLAUDE.md §8, build.yml:750 |
| a third matrix entry | measured; does not lower the peak in proportion | CLAUDE.md §8 |
| module graph | 1,018 app entries reach a union of **5,259** first-party modules (wall 5,300). The heaviest entry is under the 1,300 wall (about 1,290) | `test:proxy-graph-budget` run by this lane at 055167e9 + 154K patch |

What `scripts/proxy-graph-budget-guard.ts` measures: it walks static AND dynamic `import()` / `require()` edges over comment-blanked
source, starting at proxy.ts (budget 40) and at every app/ entry. It caps the heaviest single entry (1,300) and the union of all
entries (5,300). It is the proxy for what one webpack compile has to hold. It is not a byte or heap measurement.

## 2. Import-direction evidence (grep-level, measured at 055167e9)

| edge | files | reading |
|---|---|---|
| scripts/ → lib/ | 861 of 1,216 scripts | expected: guards and simulators import the code they judge |
| scripts/ → app/ | 35 | guards that run server actions / routes |
| lib/ or app/ → scripts/ | 7 (all `@/scripts/check-vocabularies`, the generated CHECK cache) | the ONLY reverse edge |
| lib/ → app/ | 19 files | the layering leak that blocks a clean lib project |
| remotion/ → app/ or lib/ (alias) | 0 | remotion is a leaf; app/lib reach it through 7 relative or alias imports |

So scripts/ splits off cleanly once one generated file moves. lib/ does not split cleanly from app/ yet.

## 3. Staged plan

**Stage 0: exclude scripts/ from the app type-check (low risk, biggest single win).** Today `tsconfig.json` includes
`**/*.ts`, so the app check also type-checks 1,216 script files (CLAUDE.md §7 counts about 1,221). Steps:
- Move the generated vocabulary cache the app reads (`scripts/check-vocabularies.ts`, 7 importers) to a generated module under
  `lib/` and leave a re-export shim at the old path so its generator and its guard keep working.
- Add `tsconfig.app.json` (app, lib, components, hooks, remotion, types; excludes `scripts/**`) and `tsconfig.scripts.json`
  (scripts + the app/lib files they import, `noEmit`).
- `npm run type-check` runs both, one after the other, never in parallel (CLAUDE.md §7).

What it buys: each program holds about 1,200 fewer root files and their own declarations. The peak becomes the larger of the two
programs, not their sum. The size of the saving is unmeasured. Measure it with `--extendedDiagnostics` on the same box class
before anyone touches a cap.

**Stage 0 is DONE (wave 155, measured 2026-11-20, each program alone on the box).** One program: 14,021 files, 13.18 GB peak
RSS, 367 s. Two programs, one after the other: app 12,632 files / 11.47 GB / 295 s, then scripts 9,607 files / 8.03 GB / 117 s.
Both 0 errors; together they load exactly the 6,771 first-party files the one program loaded (0 missing, 0 extra). Peak
1.71 GB lower for 45 s more. The generated vocabulary cache did not need to move: excluding `scripts/` removes ROOTS, and a
script the app imports is still loaded by import. `test:type-check-coverage` holds the partition. The cap was not touched.

**Stage 1: project references for the leaves.** `remotion/` (0 alias imports out) and `types/` become `composite` projects
with `declaration` output, and app references them. This buys incremental `.tsbuildinfo` reuse in CI, and remotion stops being
re-checked on every app change.

**Stage 2: break the 19 lib → app edges.** Each one is a lib module importing an `app/actions` or `app/components` file. Move the
shared helper down into lib/ (the survivor rule, CLAUDE.md §1) and leave a tombstone. Once lib/ imports nothing from app/, lib/
can become its own referenced project, the largest remaining split. Guard it with a census in the style of the existing
`test:server-only-boundary` that fails on a new lib → app import (positive control: a fixture import).

**Stage 3: next build graph weight.** The build compiles what the 1,018 entries reach (union 5,259). Low-risk levers, none
of which touch a budget:
- Hot-path heavy imports become dynamic `import()` behind an existing boundary. They still count toward the union, but the
  compile can split them into separate chunks.
- The two halves stay. A third entry was measured not to help (CLAUDE.md §8), so do not add more halves.
- Watch the heaviest five entries in the `test:proxy-graph-budget` output. Any new module on them should be a dynamic import.

**Stage 4: modularization candidates (low risk, measured size).** `lib/kernel/manager-registry.ts` and
`lib/kernel/signal-registry.ts` are imported widely. A split into per-domain data files plus a typed index would cut what each
importer drags in, but only the integrator edits them, so this belongs to a convergence wave. `lib/kernel/event-reactor.ts` (4,700+
lines) is shared by several lanes per wave. Per-family consumer modules reached through a dynamic dispatch table would cut both
merge contention and the per-entry graph.

## 4. What each stage buys, and what it does not

| stage | buys | does not buy |
|---|---|---|
| 0 | headroom under the 14,336 type-check cap without a new cap | any change to `next build` memory |
| 1 | incremental CI type-checks; remotion isolation | a smaller app program |
| 2 | lib as its own program (the real type-check split) | build-time savings by itself |
| 3 | build compile headroom on the current runner | a whole-graph single pass on a 15 GiB runner (that needs the owner's `BUILD_RUNNER`) |
| 4 | smaller per-entry graphs, fewer merge conflicts | anything this wave; it is convergence work |

Order: Stage 0 first, since it is reversible and measurable in one run. Re-measure, record the number in CLAUDE.md §7 beside the
existing bracket, then decide on Stage 2. Do not change the 1,300 / 5,300 walls or the 14,336 cap to absorb growth.
