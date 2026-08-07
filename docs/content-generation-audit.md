# Content-Generation Lane Audit

**Branch:** `claude/settings-consolidation-ui-0cd7lo`
**Date:** 2026-08-07
**Charter:** "content generation lane needs investigation to see which one holds the most advanced —
keep that one and merge any functions that the other one has and delete the loser."

Order of operations followed: **AUDIT → establish survivor → PORT → verify → THEN delete.**
Nothing was deleted on a no-caller rationale.

---

## 0. HEADLINE — the brief's premise does not survive contact with the code

The brief assumes `app/actions/content-generation-engine.ts` and
`app/actions/ai-content-generation.tsx` are two implementations of the same thing.
**They are not.** They are two different systems that happen to share the word "content":

| | `content-generation-engine.ts` (System 4.1) | `ai-content-generation.tsx` (Content OS) |
|---|---|---|
| Purpose | **Draft-only generator.** Produces a `ContentGenerationOutput` object, returns it to the caller, and persists **nothing but a signal row**. `content_id` is an in-memory `uuidv4()` explicitly commented "Runtime-only UUID (not persisted)". | **Content lifecycle system.** Persists the artifact, then manages it: templates, calendar, scheduling, approval status, A/B tests, SEO keywords, hashtag performance, cost ledger, performance tracking. |
| Modalities | text / audio script / video script / image *prompt* / omnipresent / variations | listing description / social / email / blog / hashtags / content plan / repurpose |
| Writes | `activities` (one row, no `raw_content`) | `ai_generated_content`, `content_generation_logs`, `content_templates`, `content_calendar`, `content_ab_tests`, `content_performance_tracking`, `hashtag_performance` |
| Exports | 9 | 45 |
| Compliance gate | **YES** on the video lane (`lib/video/script-compliance.ts`) | brand-voice / ThemFirst / `evaluateOutbound` on several paths, **no video-script gate** (has no video lane) |

There is **no capability in one that the other implements differently for the same job**, with
**three exceptions**, all documented in §3. So this is not a file-vs-file merge. It is a
**three-symbol collision** inside an otherwise-complementary pair.

Two guards in the repo already encode this conclusion and would break if the pair were merged:

- `scripts/ai-content-wiring-simulator.ts` (`test:ai-content-wiring`) asserts, in its header and
  its checks, that `ai-content-generation.tsx` is the **SOLE reader and SOLE writer** of its seven
  tables, and that "there was no rival module to merge into and nothing to delete."
- `scripts/video-script-compliance-guard.ts` (`test:video-script-compliance`) hard-codes
  `app/actions/content-generation-engine.ts` as one of the **five** `generateVideoScript` paths that
  must call `buildComplianceSystemBlocks` / `precheckBriefForFairHousing` / `postcheckScript`.
  `lib/kernel/manager-registry.ts::video_script_compliance` records the same. Deleting the engine
  deletes a *named, guarded* compliance path.

---

## 1. EXPORT CENSUS — Lane A: `app/actions/content-generation-engine.ts`

9 exports. Reached from surfaces via **direct import**; the underlying generator is reached through
the **`@/lib/content-generation` barrel** (`lib/content-generation/index.ts`), which is why a naive
import-path resolution misses it — see the guard header.

| Export | What it does | Real consumers | Notes |
|---|---|---|---|
| `generateText` | text draft (email/newsletter/sms/blog/social/ad/listing) → `generateTextContent` | `app/components/features/education/EducationEditor.tsx` | wired |
| `generateVideo` | video script draft | `app/components/features/education/EducationEditor.tsx` | **wired + THE COMPLIANCE PATH** |
| `generateOmnipresent` | one idea → N formats | `app/dashboard/marketing/blog/[id]/blog-editor-client.tsx` | wired |
| `generateVariations` | N A/B variants of one brief | `app/dashboard/marketing/blog/[id]/blog-editor-client.tsx` | wired |
| `generateAudio` | podcast/audio script draft | **none** | declared orphan in `scripts/wired-surface-baseline.json` |
| `generateFromURL` | repurpose from a source URL | **none** | declared orphan in baseline |
| `getGenerationHistory` | reads `activities` | **none** | declared orphan in baseline |
| `getGenerationStats` | aggregates `activities` | **none** | declared orphan in baseline |
| `generateImage` | produces an image **prompt string**, not an image | **none** | see §3.3 — a strictly-better `generateImage` exists at `lib/ai/image-generation.ts` with 8+ consumers |

Supporting library (all reached through the barrel):
`lib/content-generation/content-generator.ts` (`generateTextContent`, `generateAudioScript`,
`generateVideoScript`, `generateImagePrompt`, `generateOmnipresentContent`,
`generateContentVariations`), `lib/content-generation/context-enricher.ts` (`gatherContext`,
`enrichPromptWithContext`), `lib/content-generation/generation-logger.ts`
(`logContentGeneration`, `logBatchContentGeneration`, `logOmnipresentGeneration`,
`getContentGenerationHistory`, `getContentGenerationStats`).

## 2. EXPORT CENSUS — Lane B: `app/actions/ai-content-generation.tsx`

45 exports. 40 have a live surface; 5 are declared orphans in `scripts/orphan-export-baseline.json`.

| Export | Consumers |
|---|---|
| `getBrandVoiceProfile` | 11 surfaces (inline-ai-reply-coach, smart-note-composer, relationship-ai-chat-panel, coming-soon-content, settings/brand-voice, referral-ai-drafting-panel, gratitude-gifting-panel, ai-tools-client, office-chat-client, ad-os-actions, creative-variations-panel) |
| `updateBrandVoiceProfile` | `app/settings/brand-voice/page.tsx` |
| `getContentTemplates`, `saveContentTemplate`, `getGeneratedContent`, `createGeneratedContent`, `updateContentStatus`, `learnFromEdits`, `trackContentUsage`, `generateAllListingDescriptions`, `enhancedGenerateListingDescription` | `app/dashboard/content/content-os-client.tsx` |
| `getSEOKeywords`, `addSEOKeyword`, `getHashtagPerformance`, `trackHashtagUsage`, `generateHashtags`, `calculateSEOScore` | `app/dashboard/content/panels/seo-hashtags-panel.tsx` |
| `trackContentPerformance`, `getContentPerformanceStats`, `logGenerationCost`, `getMonthlyAICosts`, `getContentPerformanceMetrics`, `getContentInsights` | `app/dashboard/content/panels/performance-costs-panel.tsx` |
| `createABTest`, `analyzeABTest`, `updateABTestResults` | `app/dashboard/content/panels/ab-testing-panel.tsx` |
| `generateContentPlan` | `app/dashboard/content/panels/content-plan-panel.tsx` |
| `getContentCalendar`, `scheduleContent` | `app/actions/content-studio.ts` → `app/content-studio/content-studio-client.tsx` |
| `generateListingDescription` | `app/actions/listings-kernel.ts`, `lib/kernel/listings.ts`, `listing-description-composer.tsx` |
| `saveDescriptionToListing` | `listing-description-composer.tsx` |
| `generateSocialPost` | `app/actions/ai-tools-hub.ts` |
| `generateEmail` | `app/actions/email-campaigns.ts`, `app/api/generate/email/route.ts` |
| `generateBlogPost` | `app/actions/blog.ts`, `app/api/cron/blog-cadence-tick/route.ts`, `blog-dashboard-client.tsx`, `lib/repurpose/actions.ts` |
| `repurposeContent` | `repurpose-engine-panel.tsx`, `ad-os-actions.ts` |
| `checkCompliance` | `app/components/video/VideoGenerationButtons.tsx`, `app/actions/link-to-video.ts` |
| `validateThemFirstContent` | `app/actions/listing-video.ts`, `app/api/validate-them-first/route.ts`, `lib/marketing/content-publish-gate.ts` |
| `getNeighborhoodData` | `app/actions/listing-landing.ts`, `app/listing/[slug]/page.tsx` |
| `bulkGenerateContent` | re-exported via `lib/services/index.ts` |
| **`logContentGeneration`** | `app/api/ai/generate-content/route.ts` — **NAME COLLISION, see §3.1** |
| **`getContentGenerationStats`** | **none** — **NAME COLLISION + defective, see §3.2** |
| `generateSEOKeywords`, `detectTargetBuyer`, `getComparableProperties`, `calculateAICost` | none (declared orphans; `calculateAICost` is called internally by `logGenerationCost`) |

---

## 3. THE ACTUAL DUPLICATES — three symbols, not two files

### 3.1 `logContentGeneration` — SAME NAME, TWO TABLES, BOTH LIVE

- `lib/content-generation/generation-logger.ts::logContentGeneration` →
  **`activities`** (`activity_type = 'content_generated'`), stores a 200-char preview, never
  `raw_content`. Destructures `error`. Called by every Lane-A action.
- `app/actions/ai-content-generation.tsx::logContentGeneration` →
  **`ai_generated_content`** with `metadata.is_log = true`. Called by
  `generateListingDescription` and by `app/api/ai/generate-content/route.ts`.

**This is the "half the truth" problem in the brief, and it is real.** Ask "what has this agent
generated?" and you get `activities` rows or `ai_generated_content` rows depending on which lane
you ask, and neither reader looks at the other table.

**LIVE DATA:** `activities` carries **2** `content_generated` rows.
`ai_generated_content`, `content_generation_logs`, `content_templates`, `content_ab_tests`,
`content_calendar`, `content_performance_tracking`, `hashtag_performance` are **all 0 rows**
(the Content OS wiring landed recently, so nothing has exercised it yet).

### 3.2 `getContentGenerationStats` — SAME NAME, AND THE LANE-B COPY IS BROKEN

- `lib/content-generation/generation-logger.ts::getContentGenerationStats` — aggregates
  `activities`. Correct against what its own writer writes.
- `app/actions/ai-content-generation.tsx::getContentGenerationStats` — **three separate defects**:
  1. **Reads columns that do not exist.** It selects from `ai_generated_content` and then reads
     `l.success`, `l.generation_time_ms`, `l.tokens_used`. Verified against the live schema: those
     three columns **are not on the table**. Its own writer (`logContentGeneration`, §3.1) puts
     them *inside* `metadata`. So `successRate`, `avgGenerationTime` and `totalTokensUsed` are
     **always 0**. Same defect class as the already-documented `analyzeABTest` /
     `engagement_metrics` bug.
  2. **Returns hard-coded demo data** when `agentId` is not a UUID:
     `{ totalGenerations: 156, successRate: 98.5, avgGenerationTime: 2.3, totalTokensUsed: 45230 }`.
     That is mock data on a `"use server"` entry point.
  3. **Takes `agentId` FROM THE CALLER** on a `"use server"` export — the exact defect the rest of
     this file was already remediated for (`requireContentActor`).
  4. It has **zero consumers** — a writerless-adjacent read that nothing calls.

  The `activities`-backed copy is the only one that returns true numbers, but Lane B's cost/perf
  surface (`performance-costs-panel.tsx`) is served by `getMonthlyAICosts` +
  `getContentPerformanceMetrics`, which read `content_generation_logs` correctly.

### 3.3 `generateImage` — Lane A's is a prompt, not an image

`content-generation-engine.ts::generateImage` returns a **text prompt** for an external image
generator, has **no consumers**, and no way to reach an image. `lib/ai/image-generation.ts::generateImage`
actually produces and stores an image and has 8+ live consumers (blog, marketing-image cron,
social-media-pairing, workflow adapters, assistant-starter, video assistant-faces).
This is a duplicate *name* over non-duplicate *capability*; the engine's copy is a dead prompt-builder.

---

## 4. THE COMPLIANCE PATH — decisive, and it points at Lane A

`lib/kernel/manager-registry.ts::video_script_compliance` and
`scripts/video-script-compliance-guard.ts` both name **five** reachable `generateVideoScript`
functions. `content-generation-engine.ts` is one of them:

```
lib/content-generation/content-generator.ts   ← EducationEditor, via
  app/actions/content-generation-engine.ts    ← THE FIFTH PATH, reached through the barrel
```

`content-generation-engine.ts::generateVideo` **does enforce the full gate**, verified in source:

- `precheckBriefForFairHousing(actor, brief, "buyer")` → hard block, returns an error string
- `buildComplianceSystemBlocks(auth.brokerageId)` → brand voice + ThemFirst + Fair Housing prompt
  blocks prepended to the brief
- `postcheckScript(actor, content.raw_content, "buyer")` → advisory `complianceWarnings` returned
  to the surface

and it resolves the two id spaces correctly: `agentId` (an `agents.id`) for the activity write,
`auth.userId` (a `users.id`) for `evaluateOutbound`'s actor context — with an in-source comment
saying they must not be substituted. `scripts/video-script-compliance-negative.ts` negative-tests
exactly this file for exactly these three symbols.

**Lane B has no video-script generator at all.** So there is nothing in Lane B that could inherit
this gate, and **Lane A cannot be deleted** — deleting it removes one of the five guarded
Fair Housing paths and fails `test:video-script-compliance` by construction.

## 5. TENANT SCOPING AND IDENTITY

| | Lane A | Lane B |
|---|---|---|
| Actor source | `resolveAuthorizedAgentId()` — session only, caller's `agent_id` param explicitly ignored ("ignored — derived from session") | `requireContentActor()` — session only, on the remediated paths |
| Brokerage verify | re-reads `agents` and rejects if `brokerage_id` mismatches | `getAgentContext().brokerageId`, stamped at insert |
| id-space handling | correct and commented: `agents.id` for the write, `users.id` for `evaluateOutbound` | documented per-column map in the file header (`seo_keywords.agent_user_id` → `users.id`, everything else → `agents.id`) |
| Exceptions | falls back to `ctx.userId` as `activities.agent_id` when there is no agent row — a **cross-space substitution**, see §5.1 | `getBrandVoiceProfile`, `getContentGenerationStats`, `generateListingDescription`, `generateSocialPost` still take `agentId` from the caller |

### 5.1 Lane A cross-space fallback (found, NOT introduced by this work)

`resolveAuthorizedAgentId()` returns `{ agentId: ctx.userId }` when the session has no agent row,
and that value is written to `activities.agent_id`. `activities.agent_id` FKs `agents(id)`.
Recorded here; addressed in §7.

### 5.2 A THIRD writer of `ai_generated_content` — contradicts the "SOLE writer" claim

`lib/services/content-generation.service.ts::generateContent` inserts into `ai_generated_content`
with **no `brokerage_id`**. Verified live:

```
agc_insert  WITH CHECK (is_platform_admin() OR has_brokerage_access(brokerage_id))
has_brokerage_access(NULL) => false
```

So that insert is **refused outright** for any non-platform-admin, and the function does destructure
`error` but its caller path (`ai-content-generation.tsx::generateSocialPost`, reachable from
`app/actions/ai-tools-hub.ts`) surfaces the generated text while the row is thrown away.
Recorded here; addressed in §7.

---

## 6. SURVIVOR / LOSER

**There is no file-level loser.** Naming one and deleting it would delete either a guarded
Fair Housing path (Lane A) or 40 surfaced capabilities across 20 surfaces (Lane B). The owner's own
standing rule is the controlling one: *"if the functionality is not lost"* — here it would be.

Per-symbol rulings, which is the granularity the code actually supports:

| Capability | Survivor | Loser | Rationale |
|---|---|---|---|
| video script generation + compliance | **Lane A** `content-generation-engine.ts::generateVideo` | — | Lane B has no video lane; Lane A is a registry-named, guard-enforced compliance path |
| draft text / audio / omnipresent / variations | **Lane A** | — | no Lane B equivalent (Lane B's generators all persist and are format-specific) |
| persisted content lifecycle (templates, calendar, A/B, SEO, hashtags, costs, perf, approval) | **Lane B** | — | no Lane A equivalent |
| `logContentGeneration` | **both, deliberately, with the split named in source** | — | different tables, different readers, both non-empty in intent; §7.1 |
| `getContentGenerationStats` | **`lib/content-generation/generation-logger.ts`** (activities) | **`ai-content-generation.tsx::getContentGenerationStats`** | Lane B's copy reads three non-existent columns, returns mock data, takes the tenant from the caller, and has zero consumers |
| `generateImage` | **`lib/ai/image-generation.ts`** | **`content-generation-engine.ts::generateImage`** | Lane A's returns a prompt string, produces no image, has zero consumers |

---

## 7. WORK PERFORMED

### 7.1 `logContentGeneration` (Lane B copy) — PORTED, THEN DELETED

Order: port first, delete second.

1. **Ported.** `content_generation_logs` gained a `prompt text` column
   (`supabase/migrations/m386-content-generation-log-prompt.sql`, applied live and verified —
   `information_schema` reports `prompt / text`). That was the ONE field the loser recorded and the
   survivor could not: the first ~500 characters of the prompt. `scripts/schema-snapshot.ts` was
   updated in the same change so schema-drift is not blind to it.
2. **Widened the survivor.** `logGenerationCost` now takes `model` as OPTIONAL, specifically so a
   `catch` block — which does not know which model was reached — can still record the failure. Every
   other field the loser carried (tokens, elapsed ms, success flag, error message) already had a
   typed column.
3. **Repointed every caller.** `generateListingDescription`, the blog-post success path and the
   blog-post error path in `app/actions/ai-content-generation.tsx`, plus
   `app/api/ai/generate-content/route.ts`.
4. **Deleted** `app/actions/ai-content-generation.tsx::logContentGeneration`.

`lib/content-generation/generation-logger.ts::logContentGeneration` — the SAME NAME writing
`activities` for Lane A — **survives untouched**. It is a different row for a different reader, and
the §6 table records that split deliberately.

### 7.2 `getContentGenerationStats` (Lane B copy) — DELETED, nothing to port

Deleted from `app/actions/ai-content-generation.tsx`. Nothing was ported because there was nothing
correct to port: it read three columns that are not on `ai_generated_content`, returned hard-coded
demo numbers on a non-UUID `agentId`, took the tenant from the caller, and had zero consumers. The
`activities`-backed copy in `lib/content-generation/generation-logger.ts` is the survivor and is
unchanged.

### 7.3 `generateImage` (Lane A copy) — RECORDED, NOT DELETED

Left in place. It is a dead prompt-builder with zero consumers, but the deletion rule in this repo
requires the survivor to do the SAME JOB more completely, and `lib/ai/image-generation.ts::generateImage`
does a different job (it produces and stores an image; it does not produce a prompt string). Removing
Lane A's copy is a separate, small piece of work and is listed as open below rather than done
quietly here.

### 7.4 Census effect

`app/actions/ai-content-generation.tsx` went from 45 exports to 43. Its unreferenced-export count is
**unchanged at 5** — the same five symbols before and after (`calculateAICost`, `detectTargetBuyer`,
`generateSEOKeywords`, `getComparableProperties`, `saveDescriptionToListing`), verified by recomputing
the orphan set in a clean worktree at the pre-change commit. Both deleted symbols were *referenced*
(so neither was an orphan), which is why the count did not drop. No new orphan was created.

---

## 8. STILL OPEN (found here, not fixed here)

| # | Finding | Where |
|---|---|---|
| 1 | `resolveAuthorizedAgentId()` falls back to `ctx.userId` for `activities.agent_id`, which FKs `agents(id)` — a cross-id-space substitution that FK-rejects the write | `app/actions/content-generation-engine.ts` §5.1 |
| 2 | A THIRD writer of `ai_generated_content` with no `brokerage_id`, so RLS refuses the insert outright while the caller still surfaces the generated text | `lib/services/content-generation.service.ts::generateContent` §5.2 |
| 3 | `getBrandVoiceProfile`, `generateListingDescription`, `generateSocialPost` still take `agentId` from the caller on `"use server"` exports | `app/actions/ai-content-generation.tsx` §5 |
| 4 | Lane A's dead `generateImage` prompt-builder | §7.3 |
