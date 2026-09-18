# Lane B cost ledger consolidation — working notes

Branch: `claude/settings-consolidation-ui-0cd7lo`
Files owned by this lane: `app/actions/ai-content-generation.tsx`,
`app/api/ai/generate-content/route.ts`,
`app/dashboard/content/panels/performance-costs-panel.tsx` (+ this notes file).

---

## 1. `calculateAICost` carries NOTHING unique — established by reading both

Read in full:

- SURVIVOR `lib/ai/cost-tracking.ts::calculateCost(model: AIModel, inputTokens, outputTokens): number`
  — returns **CENTS**, `Math.ceil`'d. Backed by `getModelPricing()`: 10 models keyed on
  the `AIModel` union the system actually emits, each with dated provider pricing
  (`lastUpdated: "2026-02-20"`) and a link to the provider pricing page. Unknown model →
  `console.warn` + return `0` (it refuses to invent a charge).

- LOSER `app/actions/ai-content-generation.tsx::calculateAICost(usage, model = "openai/gpt-4o"): Promise<number>`
  — returns **DOLLARS**. A 4-row inline table keyed
  `"openai/gpt-4o"`, `"openai/gpt-4o-mini"`, `"gemini-2.0-flash"`, `"anthropic/claude-sonnet-4.5"`.
  Unknown key silently falls through to `pricing["openai/gpt-4o-mini"]`.

Difference audit — every behaviour of the loser, and where it lands on the survivor:

| loser behaviour | survivor |
| --- | --- |
| takes `{promptTokens, completionTokens, totalTokens}` | takes positional `(model, in, out)`. `totalTokens` was **accepted but never read** by the loser — it computes from prompt+completion only. Nothing lost. |
| `promptTokens \|\| 0` / `completionTokens \|\| 0` defaults | caller-side `?? 0`; preserved at the call site in `logGenerationCost`. |
| per-1M-token rate arithmetic, prompt + completion | identical arithmetic. |
| returns dollars, unrounded | returns cents, `Math.ceil`. Converted `/100` at the call site. **This is the platform's own accounting basis** (`ai_tool_usage.cost_cents`), so matching it is the point, not a regression. |
| unknown model → gpt-4o-mini rates | unknown model → `0` + warn. Strictly more honest; and unknown models can no longer happen for the real path, which now passes the canonical `response.costCents`. |
| `async` (a `"use server"` export) | plain sync function. It was never awaited across a network boundary for any reason; being a server action was incidental. |

Verdict: **no unique capability.** Every rate in its 4-row table is duplicated verbatim in
`getModelPricing()` under the canonical key (`openai/gpt-4o` 2.50/10.00 == `gpt-4o`;
`openai/gpt-4o-mini` 0.15/0.60 == `gpt-4o-mini`; `gemini-2.0-flash` 0.075/0.30 == `gemini-flash`;
`anthropic/claude-sonnet-4.5` 3.0/15.0 == `claude-sonnet`). The loser is the same four prices
under names the system never emits. Nothing to port.

## 2. External-caller grep — VERIFIED, not trusted to the baseline

`grep -rn calculateAICost` over the repo excluding `.next/`:

```
scripts/content-lane-ledger-simulator.ts:149   assertion "calculateAICost is gone from the content lane"
scripts/content-lane-ledger-simulator.ts:150   !/export\s+async\s+function\s+calculateAICost/.test(laneBSrc)
scripts/orphan-export-baseline.json:4643       category-C orphan entry
docs/content-generation-audit.md:96,274        prose
app/actions/ai-content-generation.tsx          the definition + its ONE internal caller (logGenerationCost)
```

**Zero code callers outside the file.** The only executable references are in the
parallel lane's simulator, which ASSERTS THE DELETION — it fails if the symbol comes back.
The orphan baseline listed it as category C; that matched reality here, but it was
re-verified rather than trusted.

Note: `calculateAICost` was an `async` export in a `"use server"` file, i.e. a
server action with a public RPC id. It is now unreachable from the client too.

## 3. Before/after — MEASURED

Script: `scratchpad/cost-proof.mjs`, both price tables reproduced verbatim from source.
One realistic generation, **3000 input / 1200 output tokens**.

Headline case — `claude-sonnet`, the `AI_TASK_ROUTING` default for
`listing_description`, `blog_post_generation`, `email_generation`,
`social_post_generation`:

```
ai_tool_usage.cost_cents (logAIUsage, canonical) : 3 cents
content_generation_logs.cost_usd  BEFORE         : $0.001170
content_generation_logs.cost_usd  AFTER          : $0.030000
understated BEFORE                               : 25.6x
AGREEMENT AFTER: cost_usd * 100 === cost_cents   -> YES (equal by construction)
```

Every emitted `AIModel`, same 3000/1200 call:

| model | canonical $ | OLD booked $ | understated | in old table? |
|---|---|---|---|---|
| claude-sonnet | 0.03000 | 0.00117 | 25.6x | NO |
| claude-opus | 0.14000 | 0.00117 | **119.7x** | NO |
| claude-haiku | 0.01000 | 0.00117 | 8.5x | NO |
| gpt-4o | 0.02000 | 0.00117 | 17.1x | NO |
| gpt-4-turbo | 0.07000 | 0.00117 | 59.8x | NO |
| gpt-4o-mini | 0.01000 | 0.00117 | 8.5x | NO |
| gemini-pro | 0.01000 | 0.00117 | 8.5x | NO |
| gemini-flash | 0.01000 | 0.00117 | 8.5x | NO |
| perplexity-sonar | 0.01000 | 0.00117 | 8.5x | NO |
| perplexity-sonar-pro | 0.03000 | 0.00117 | 25.6x | NO |

**Key-namespace overlap: 0 of 10.** Every real model missed the 4-row table and
fell through to `pricing["openai/gpt-4o-mini"]`. `$0.00117` is literally the same
number for all ten, which is the tell.

### Rounding, disclosed
`cost_cents` is `Math.ceil`'d per call. `claude-haiku` at 200/100 tokens truly costs
`$0.000175` and books as **1 cent** — overstated 57.1x on that one call. That is the
platform's own accounting basis (identical to what `increment_ai_usage_monthly` and the
`ai_tokens_monthly` fair-use counter consume), which is exactly why it is the right
source — but `avg_cost_per_generation` is a CEILING, never below $0.01 on a non-empty
month. The panel now labels it `Avg each (max)` and says so in a caption.

## 4. Live schema + boundary verification (project `hrvaqgvukzxfskkcrwbt`)

`ai_tool_usage`: `created_at` is **`timestamp without time zone`, DEFAULT `now()`**, and the
database `TimeZone` is **UTC** — so stored values are UTC wall-clock with the zone stripped.

**Proven hazard** (why the bounds changed shape):
```
'2026-08-01T06:00:00.000Z'::timestamp  ->  2026-08-01 06:00:00   -- offset DISCARDED, not converted
'2026-08-01T00:00:00'::timestamp       ->  2026-08-01 00:00:00
```
The old code built bounds with `new Date(y, m, 1)` (midnight **local**) then `.toISOString()`'d
them. On any server not running in UTC that shifts the month boundary by the offset and
silently moves generations into the neighbouring month.

**Fix:** compute in UTC via `Date.UTC`, emit with **no zone designator** (`.toISOString().slice(0,19)`
→ `YYYY-MM-DDTHH:MM:SS`). No offset for Postgres to drop. The half-open
`[startOfMonth, startOfNextMonth)` shape is unchanged.

**Boundary probe, `BEGIN; … ROLLBACK;`** — 5 rows spanning the edges:

| inserted `created_at` | feature | expected | matched |
|---|---|---|---|
| 2026-07-31T23:59:59 | listing_description | OUT | out |
| 2026-08-01T00:00:00 | listing_description | IN | **in** |
| 2026-08-31T23:59:59 | blog_post_generation | IN (old `lte` bug dropped this) | **in** |
| 2026-09-01T00:00:00 | listing_description | OUT | out |
| 2026-08-15T12:00:00 | lead_analysis | OUT (not a content feature) | out |

Result `matched_rows = 2, cents = 5, toks = 8400` — exactly right.
Rollback confirmed afterwards: **0 probe rows, table back to its original 23 rows.**

Live `ai_tool_usage` content (pre-rollout, 23 rows): `generate_json`/gpt-4o x20,
`blog_generation`/gpt-4o x2, `ai_reply_coach`/claude-sonnet x1. None are in
`CONTENT_GENERATION_FEATURES` (note `blog_generation` != `blog_post_generation`), so the
content panel correctly reads $0 today. `content_generation_logs` = 0 rows.

## 5. What changed, file by file

### `app/actions/ai-content-generation.tsx`
- **DELETED** `calculateAICost` (whole function + its 4-row table), replaced by a
  ONE PRICE TABLE comment block recording the survivor, the measurements, and why
  nothing was ported.
- Imports `calculateCost` + `AIModel` from `@/lib/ai/cost-tracking` and
  `CONTENT_GENERATION_FEATURES` from `@/lib/ai/content-features`.
- `logGenerationCost` gains an optional **`costUsd`** param. Cost resolution, in order:
  1. `costUsd` supplied (finite, >= 0) → booked verbatim. This is `response.costCents/100`,
     the same figure `ai_tool_usage` holds → the ledgers agree **by construction**.
  2. else `model` supplied → `calculateCost(model as AIModel, promptTokens||0, completionTokens||0) / 100`
     (canonical table; returns CENTS, converted). Unknown model → `calculateCost` warns and
     returns 0. It refuses to guess; the old one silently charged mini rates.
  3. else → 0.
  **Failure logs still book $0**, unchanged: the catch blocks pass neither model nor cost,
  because a throw can precede the model call.
- `logGenerationCost` header rewritten: `content_generation_logs` is **no longer the cost
  source of record**, but it is **not going away** — it is the only place carrying
  `content_id`, `content_type`, `prompt`, per-artifact `success`/`error_message` and
  `generation_time_ms`. `getContentPerformanceMetrics` still reads it and is untouched.
  `cost_usd` is now a denormalised copy of the canonical figure, not a rival bill.
- `getMonthlyAICosts` **repointed to `ai_tool_usage`**:
  - scope `.eq("brokerage_id", actor.brokerageId).eq("agent_id", actor.agentId)`.
    The explicit brokerage predicate matters: RLS is
    `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())` (verified live),
    so the policy alone would also admit every UNTENANTED row on the platform.
    Agent scoping is what the function already had.
  - `.in("feature", CONTENT_GENERATION_FEATURES)` — spans BOTH lanes.
  - UTC-naive `>= startOfMonth` / `< startOfNextMonth` bounds (see §4).
  - `error` destructured and returned; a refused read is not a $0 bill.
  - sums in integer **cents**, divides **once** (`totalCents/100`) so 300 one-cent rows
    total exactly $3.00 instead of accumulating float dust. Same for the per-model breakdown.
  - rounding stated in the docblock as required.
- Call sites `generateListingDescription` and `generateBlogPost` now pass
  `costUsd: response.costCents / 100`.
- The CONSOLIDATION note's "two places" summary updated: `content_generation_logs` is the
  per-artifact telemetry lane; cost lives in `ai_tool_usage`.

### `app/api/ai/generate-content/route.ts`
- Passes `costUsd: response.costCents / 100` to `logGenerationCost`.
- **Bug found and fixed:** `generateAIResponse`'s `metadata` here was missing `agentId`.
  `logAIUsage` stamps `ai_tool_usage.agent_id` from that metadata, and `getMonthlyAICosts`
  scopes its read by agent — so every generation through this route was booked to the
  brokerage but **invisible on the agent's own spend panel**. `agentId` is already resolved
  from session on line 25; now passed through.

### `app/dashboard/content/panels/performance-costs-panel.tsx`
- `MODELS` repointed from the dead namespace (`openai/gpt-4o`, `anthropic/claude-sonnet-4.5`,
  `gemini-2.0-flash`) to the canonical `AIModel` ids. **This was load-bearing**: with the rival
  table deleted, those strings would now price at $0, because `calculateCost` refuses to guess.
- Card title `AI spend this month` → `Content AI spend this month` (it is feature-filtered,
  it is not all AI spend).
- `Avg each` → `Avg each (max)` + a caption stating the source is the platform usage ledger
  across every content generator and that costs are rounded up per generation.
- The manual entry form relabelled `Log a generation cost` → **`Record a generation in the
  content log`**, with a caption saying it does not change the spend figures. It writes
  `content_generation_logs`, which no longer feeds that card — leaving the old label next to
  a total it cannot move would have been a lie about what the button does. Button
  `Log cost` → `Record generation`; toast `Logged $X` → `Recorded — priced at $X`.

## 6. Found and NOT fixed (outside this lane's ownership)

1. **`lib/ai/models.ts` sends empty strings for uuid columns.** `generateAIResponse` calls
   `logAIUsage({ brokerageId: …?? "", teamId: …?? "", agentId: …?? "" })`. `ai_tool_usage`'s
   `agent_id`/`team_id`/`brokerage_id` are `uuid`; `""` is not a valid uuid, so the INSERT
   fails 22P02 and `logAIUsage` swallows it into a `console.error`. Live evidence: 3 of the
   23 rows have `agent_id IS NULL`. Any call without a full identity triple is at risk of
   vanishing from the ledger entirely. Should be `?? null`. **Not mine to edit** —
   `lib/ai/*` is on the forbidden list. Mitigated for my one owned route by passing `agentId`.
2. **Rows with `agent_id IS NULL` are invisible to `getMonthlyAICosts`.** Direct consequence
   of (1). I kept agent scoping because that is what the function and its sibling
   `getContentPerformanceMetrics` have always done and the panel is an agent surface;
   loosening it to brokerage-only would silently change what the panel means. Fix (1) first.
3. **`logAIUsage` never passes `execution_time_ms` / `success` from `generateAIResponse`.**
   The params exist on `logAIUsage` and the columns exist, but the call site omits both, so
   `success` always defaults `true` and latency is always NULL. Per-manager SLO in
   `lib/platform/manager-ops.ts` reads these. `lib/ai/*`, not mine.
4. **`getContentPerformanceMetrics` still uses `.lte` on its `dateRange` end bound** and
   still filters `generated_at` with local-derived ISO strings. `content_generation_logs.generated_at`
   is `timestamptz` (not naive), so the tz half is fine there, but the `lte` end-bound shape is
   the same class of bug that was already fixed in `getMonthlyAICosts`. It takes an explicit
   caller-supplied range rather than deriving a month, and the panel calls it with no range at
   all, so nothing is currently wrong on screen. Left alone: out of task scope and it would
   change a public parameter's meaning.
5. **`scripts/orphan-export-baseline.json` still lists `calculateAICost`.** Baselines are on
   the forbidden list; the orchestrator/baseline refresh should drop that entry.
6. **`docs/content-generation-audit.md` lines 96 and 274 still describe `calculateAICost` as
   live** ("called internally by `logGenerationCost`", and counted in an unchanged-at-5 orphan
   tally). Stale prose only, no behaviour. Not one of the three files this lane owns, so left
   for the orchestrator; the tally there is now 4.

Cross-check against the parallel lane: `scripts/content-lane-ledger-simulator.ts` §5 asserts
(a) `calculateAICost` is gone and (b) no `{prompt, completion}` rate pair survives in this file
**after comments are stripped**. Both hold — the ONE PRICE TABLE record is `//` comments at
column 0, which its stripper removes, and it contains no rate pair in that shape.

## 7. Status

- [x] Task 1 kill rival price table (deleted, no external callers, nothing ported because nothing unique)
- [x] Task 2 `getMonthlyAICosts` repointed at `ai_tool_usage`
- [x] Task 3 panel honesty
- [x] numeric proof
- [ ] tsc (see §8)
