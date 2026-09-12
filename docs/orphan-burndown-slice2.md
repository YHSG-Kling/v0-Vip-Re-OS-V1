# Orphan burndown — slice 2 (`"use server"` action modules)

Method (per owner's correction): for each callerless export —
(a) duplicate? find the survivor by reading; **merge the loser's unique capability onto the survivor first**, then delete. Never delete to move a number.
(b) not a duplicate? wire it to the surface it was written for, or record precisely what finishing needs and leave the code.

Every file here is `"use server"`, so **every export is a public HTTP endpoint**. Each entry records auth posture.

Status: IN PROGRESS — appended as each file is finished.

---
## `app/actions/copilot.ts` — 4 orphans (3 unwired event handlers + 1 duplicate)

### Context established first (this governs all four)
`app/actions/copilot.ts` opens with `// EVENT HANDLERS - Called by orchestrator`. The orchestrator is
`lib/orchestrator/internal.ts`. Two facts from reading it:

1. Its `EVENT_HANDLERS` map (line 58) is documented **"⚠️ NOT CURRENTLY DISPATCHED"** — `orchestrateEvent()`
   routes through a type-safe `switch`, and the map exists only to keep built-but-unwired modules referenced.
2. The map lists exactly one copilot function — `generate7DayPlan` on `lead.created`. It does **not** list
   `handleSuggestionAccepted`, `handleCoachingSessionBooked`, or `handleMorningKickoff`.

Cross-checked the emitters: **no event of any of these three shapes is ever emitted.**
`lib/events/types.ts` has `AI_SUGGESTION_CREATED` / `AI_SUGGESTION_ACTIONED` but nothing emits an
"accepted" event; there is no coaching-booked or morning-kickoff event type at all. The only repo-wide hit
for `morning_kickoff` is the string this handler itself writes.

So these three are **unwired event handlers**, not dead code — case (b). Verdict per function below.

### Security posture — read this even if nothing changes
`createServerClient` in `lib/supabase/server.ts:48` is an alias for the **anon-key, cookie-bound** client, so
these writes are RLS-gated, not service-role. That bounds the blast radius but does **not** make them safe:
all three take the acting identity **from `payload: any`**, never from the session. For an authenticated
caller that is a straight **IDOR** — the endpoint acts as whatever `user_id` the caller types:

- `handleMorningKickoff` inserts into `notifications` with `user_id: payload.user_id` → notification injection
  into another user's feed, to the extent notifications RLS permits insert-by-any-authenticated-user.
- `handleCoachingSessionBooked` resolves `agents.brokerage_id` from `payload.user_id`, then inserts
  `calendar_events` + `tasks` against that agent — cross-agent write wherever RLS is brokerage-wide.
- `handleSuggestionAccepted` stamps `acted_by: payload.user_id` into the suggestion's metadata, so the
  **audit field is caller-controlled and forgeable**.

None of the three has a caller, so none is exploited today. Wiring them up in this state is how it ships.

### `handleSuggestionAccepted` — NOT a duplicate to delete; it carries a fix the survivor lacks
Survivor search: the nearest thing is `app/actions/assistant.ts:completeSuggestion`, which delegates to the
file-local `setSuggestionStatus(id, "actioned")` on the same `smart_assistant_suggestions` table.
(`app/actions/ai-chat.ts:acceptAiSuggestion` is **not** the survivor — it writes a different table,
`ai_suggestions`, in the chat lane.)

Comparing the two, `handleSuggestionAccepted` has two capabilities `setSuggestionStatus` does not:

1. **It merges outcome metadata** (`outcome`, `action_taken`, `acted_by`) into the existing `metadata`
   rather than dropping it — the record of *what* was accepted. (Its own comment records that an earlier
   version REPLACED metadata wholesale and destroyed it; that class is already fixed here.)
2. **It verifies the row actually moved** — `.select("id")` then `if (!updated?.length) return "Suggestion
   not found"`. `setSuggestionStatus` destructures only `error` and returns `{ success: true }` whenever
   postgrest didn't error — so a nonexistent id, or one RLS hides, **reports success having changed nothing**.
   This is the fail-open class from the worked example, at the survivor.

Per the method this is "the loser's extra is a real capability, and the survivor has a defect of the same
class" → **fix the class at the survivor**, then reconcile. I did **not** make that edit:
`app/actions/assistant.ts` is **slice 3's file** (`assistant.ts: handleAssistantQuery, ...`).

**→ HANDOFF TO SLICE 3 / ORCHESTRATOR:** add row-count verification to
`app/actions/assistant.ts:setSuggestionStatus` (`.select("id")` + refuse on zero rows), so
`dismissSuggestion` / `completeSuggestion` stop reporting success on a no-op. Left `handleSuggestionAccepted`
in place meanwhile — deleting it before that fix lands would lose the only correct implementation.

## `app/actions/blog.ts` — 3 orphans, all cross-tenant reads. FIXED.

Survivors found by reading the surfaces, not by guessing:

| orphan | survivor | relationship |
|---|---|---|
| `getBlogPosts` | `app/dashboard/marketing/blog/page.tsx` (inline read in `BlogDashboardPage`) | partial duplicate — survivor loads the unfiltered list; orphan adds filters the survivor lacks |
| `getBlogPostById` | `app/dashboard/marketing/blog/[id]/page.tsx` (inline read in `BlogEditorPage`) | duplicate — survivor was already correct |
| `getSeoKeywords` | *none* — `app/actions/ai-content-generation.tsx:getSEOKeywords` is a **documented deliberate non-duplicate** | distinct capability, kept |

### Why they were not deleted
`getBlogPosts` carries filters (publish status, agent, date range) the page has no equivalent for — the
refresh path the dashboard client still needs. `getSeoKeywords` is the brokerage-wide axis;
`ai-content-generation.tsx:getSEOKeywords`'s own comment says the split is intentional ("Deliberately NOT
merged into blog.ts:getSeoKeywords — that one is brokerage-wide … The two read the same table on different
axes"). Deleting either would lose real capability.

### SECURITY — all three were unauthenticated cross-tenant reads (fixed)
Every export in a `"use server"` file is a public HTTP endpoint. All three took the tenant **from the caller**
and had **no auth gate whatsoever**:

- **`getBlogPostById` was the worst: it had no tenant predicate at all** — `.eq("id", postId)` and nothing
  else — while returning the post's full body, its keyword strategy and its SEO audit log. Any post uuid read
  any brokerage's unpublished content. The page it duplicates always did
  `.eq("id", postId).eq("brokerage_id", userData.brokerage_id)`; the survivor was right and the copy dropped
  the predicate.
- `getBlogPosts(brokerageId)` / `getSeoKeywords(brokerageId)` fed a caller-supplied uuid straight into
  `.eq("brokerage_id", …)` — any brokerage's draft inventory and paid SEO target list.

**Fix (case b — finish the work, don't delete it):** all three now open with
`getAgentContext()` + `isAuthenticated`/`brokerageId` refusal and scope on `ctx.brokerageId`, matching the
file's own house pattern at `saveBlogPost`. The caller-supplied `brokerageId` parameters are **removed**
(no callers to break), so the tenant can no longer be asserted from outside.

### Left alone, but flagged
`blog.ts:addSeoKeyword(userId, { brokerageId, … })` is **not** an orphan (called by
`app/dashboard/marketing/seo/seo-keywords-client.tsx`), so it is out of this burndown's scope — but it takes
**both `userId` and `brokerageId` from the caller and INSERTS on them**, writing `created_by: userId`. Same
class as the three above, on a write path, with a forgeable authorship field. Fixing it means changing the
signature, which would edit a client file this slice does not own. **Recommend a follow-up.**

## `app/actions/twin-studio.ts` — 2 orphans. Both KEPT. One exposed a live hole at its survivor.

Both are correctly gated (`resolveWriteContext()` + `isAuthenticated` + `agentId`, then an ownership check
`twin.agent_id !== ctx.agentId`). Neither is a security finding. My first-pass auth scan missed
`resolveWriteContext` — corrected on reading.

### `attachVoiceToTwin` — survivor is `app/api/elevenlabs/voice-clone/route.ts` (the `twin_id` branch)
The file's own flow comment documents a 4-step wizard: `createTwinDraft` → D-ID avatar → `attachVoiceToTwin`
→ `finalizeTwin`. `app/dashboard/settings/twin-studio/components/twin-wizard.tsx` imports steps 1 and 4 only;
for step 3 its `VoiceStep` POSTs to `/api/elevenlabs/voice-clone` with `twin_id`. That route clones the voice
**and** writes `voice_id` + `voice_sample_url` onto the same `agent_avatar_assets` row — so the route is the
survivor and `attachVoiceToTwin` is the orphaned twin of its write half.

**🚨 The survivor is missing the one check the orphan has.** Route lines 168–184:

```ts
const { data: twin } = await supabase
  .from("agent_avatar_assets")
  .select("id, agent_id")      // ← selects agent_id …
  .eq("id", twin_id)
  .maybeSingle()
if (!twin) {
  return NextResponse.json({ error: "Twin not found" }, { status: 404 })
}                              // ← … and never compares it to auth.agentId
await supabase.from("agent_avatar_assets").update({ voice_id, voice_sample_url, … }).eq("id", twin_id)
```

It fetches `agent_id` — plainly intending to check ownership — then drops it. **Any authenticated agent can
bind a voice clone to any other agent's twin, in any brokerage, by passing that twin's uuid.** That is not
cosmetic: a twin's `voice_id` is what the platform *speaks with* — ISA outbound calls, video generation, and
the portal widget all read it (`syncAgentVoiceId` promotes it to `agents.voice_id`). The attack overwrites
whose voice another agent's avatar uses. It also spends the victim's brokerage ElevenLabs quota — the
`checkUsageCap` / `logMediaUsage` calls bill `auth.brokerageId`, i.e. the *caller's* brokerage, while the
asset lands on the *victim's* twin.

`attachVoiceToTwin` has the correct guard: `if (!twin || twin.agent_id !== ctx.agentId) return "Twin not found"`.

**Verdict: KEPT, not deleted.** Deleting the only correct implementation while the survivor carries the hole
is exactly the worked-example mistake. `app/api/elevenlabs/voice-clone/route.ts` is **not in this slice's file
list**, so I did not edit it.

**→ HANDOFF / SECURITY:** add `if (twin.agent_id !== auth.agentId) return 403` to the `twin_id` branch of
`app/api/elevenlabs/voice-clone/route.ts`. One line, and the data to make the comparison is already fetched.

### `updateTwinDetails` — NOT a duplicate; unwired edit path
Compared against `finalizeTwin`, the only other writer of these fields: `finalizeTwin` sets `personality`,
`greeting`, `greeting_sentiment`, `is_default` — it **cannot rename a twin**. `updateTwinDetails` is the only
writer of `label`. So it is not a duplicate; it is the "edit an existing twin" path.

**Wiring gap (case b):** `app/dashboard/settings/twin-studio/components/twin-card.tsx` imports only
`setDefaultTwin` and `deleteTwin` — the card has no rename/edit affordance, so nothing calls it. Finishing it
needs a rename control on the twin card wired to `updateTwinDetails({ twinId, label })`. That is a UI file
this slice does not own. **Left in place**; the capability is real and the endpoint is safe.

## `app/actions/campaign-sequences.ts` — 3 orphans. 1 deleted, 1 fixed, 1 kept. Plus 2 fixes at survivors.

This file **documents its own tenant-gate pattern** on its service-client mutations:

```ts
// Tenant gate: service client bypasses RLS, so we must verify the sequence
// belongs to the caller's brokerage before mutating.
const ctx = await getAgentContext()
```

`deleteCampaignSequence` and `updateCampaignSequence` carry it. Three functions here did not — and two of
those are not orphans, they are the survivors with live callers.

Live schema verified before editing: `sequence_enrollments.brokerage_id` and `campaign_sequences.brokerage_id`
are both **NOT NULL**, so scoping on them is always valid.

### `resumeCampaignSequence` — MERGED-THEN-DELETED
Survivor: **`app/actions/campaign-sequences.ts:launchCampaignSequence`**. Whole body was
`return launchCampaignSequence(sequenceId)` — resuming a paused sequence and launching one are the same write.
**Nothing to merge** (the `createStripeTransfer` case from the worked example). Deleted; confirmed zero
remaining references. This removed a second public endpoint onto the same mutation.

### `cancelEnrollment` — FIXED (was an unauthenticated service-client write)
Not a duplicate — it is the only writer of `sequence_enrollments.status = 'cancelled'`. But it had **no gate
at all** on the RLS-bypassing client, so an enrollment uuid was enough to pull any brokerage's contact out of
a nurture sequence. It also accepted `sequenceId` purely for `revalidatePath` and never checked the
enrollment was in that sequence. Now: `getAgentContext()` → read the row → refuse on `readError` (a refused
read is not "no rows") → brokerage compare → update scoped by `brokerage_id` with `.select("id")` so a no-op
reports failure instead of success. Revalidates on the row's *own* `sequence_id`.

### `getSequenceSteps` — KEPT, already correct
Properly gated (`getAgentContext` + ownership verify) and it validates every step's channel against
`VALID_STEP_TYPES` rather than rendering an unknown one. Not wired: the builder page loads steps via
`getCampaignSequence` instead (see below). Left in place — it is the stricter read of the two.

### 🚨 Fixes made at the SURVIVORS (not orphans, but the same class)

**`getCampaignSequence` — unauthenticated read returning contact PII.** This is what
`app/dashboard/campaigns/sequences/[id]/builder/page.tsx` actually calls. It ran on the service client with
**no auth gate and no brokerage predicate**, returning the sequence, every step *including subject and body
message copy*, and up to 200 enrollments joined to **`contacts(first_name, last_name, email)`**. One sequence
uuid returned another brokerage's campaign copy plus its contacts' names and email addresses. Fixed: session
gate, `.eq("brokerage_id", ctx.brokerageId)` on both the sequence and the enrollment read, **and an explicit
refusal when the sequence row comes back null** — the three reads run in `Promise.all`, so without that
refusal a wrong-brokerage id returned `sequence: null` alongside fully populated steps and enrollments, i.e.
the leak would have survived the predicate. Signature unchanged; callers are server components passing an id.

**`launchCampaignSequence` — unauthenticated activation.** It flips `is_active: true`, which starts sending
real messages to real contacts, and a bare sequence uuid was enough to start any brokerage's. Same gate added,
update scoped by `brokerage_id`.

### Left alone, flagged
`listCampaignSequences(brokerageId, category?)` takes the tenant **from the caller** on the service client with
no auth gate — same cross-tenant read class. It has live callers, so fixing it means a signature change
touching files this slice does not own. **Recommend a follow-up.**

## `app/actions/property-buyer-matching.ts` — 2 orphans. Both KEPT + FIXED. Plus a dead engine repaired.

Neither orphan is a duplicate. `matchBuyersForListing` (ranked list, has a caller),
`scoreSingleBuyerForListing` (one pair, on demand) and `getListingMatchHistory` (replay past signals) are
three distinct operations over `lib/property-matching`. Nothing to merge; the two orphans are unwired
capabilities of a wired engine.

### 🚨 The whole file was unauthenticated and cross-tenant
Its header claims `Internal use only (agent/broker/team leader)` — **documented but never enforced**. All
three exports ran on the RLS-bypassing service client with **no auth gate and no brokerage predicate**:

- `matchBuyersForListing` selected from `contacts` with **no tenant filter at all** — `contact_type` and
  `status` only, `.limit(500)` — i.e. up to 500 buyer records **across every brokerage in the system**,
  returning their names. A cross-tenant PII harvest reachable with one listing uuid.
- `scoreSingleBuyerForListing` read any listing and any contact by uuid, returning the contact's name and
  freeform `notes`, and could write an `activities` row (`logSignal`).
- `getListingMatchHistory` replayed any listing's match signals (contact ids + match reasoning).

**Fixed:** all three now resolve `getAgentContext()` and refuse unauthenticated, and every read is scoped —
`listings`/`contacts` by `.eq('brokerage_id', ctx.brokerageId)`, `activities` likewise
(`activities.brokerage_id` is NOT NULL, verified live). Signatures unchanged, so the one live caller
(`app/components/dashboard/listings/lifecycle/matching-buyers-panel.tsx`) is unaffected.

### 🐛 And the match engine had never returned a single buyer
The buyer query filtered soft-deletes with:

```ts
.not('deleted_at', 'is', null)   // → deleted_at IS NOT NULL
```

That is **inverted**: it selects *only* soft-deleted contacts. Verified against the live DB — 4 contacts,
**0 of them soft-deleted** — so this read matched zero rows and `matchBuyersForListing` answered
`"No eligible buyers found"` on every call, for every listing, since it was written. The panel that calls it
has therefore always rendered empty. Corrected to `.is('deleted_at', null)`.

This one is worth flagging beyond the security story: the feature was not "unwired", it was wired to a
filter that could never match, and nothing surfaced that because an empty result is indistinguishable from a
genuine no-match.

## `app/actions/ai-voice-transcription.ts:transcribeAudio` — KEPT + GATED. 🚨 SSRF + unmetered AI spend.

**Not a duplicate.** Searched every `experimental_transcribe` / whisper call site and every writer of
`call_transcriptions`: this is the **only** one. It is an unwired capability (case b), not a redundant copy —
`analyzeCallTranscript` in the same file consumes a transcript, it does not produce one.

### What was wrong
The export had **no auth gate whatsoever**, and two things happen *before* any database write, both driven
entirely by caller-supplied input:

1. **SSRF** — `callConnector({ connector: "asset-download", url: params.audioUrl, method: "GET",
   auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000 })`. An arbitrary caller-chosen
   URL, fetched server-side with no auth and no validation.
2. **Unmetered AI spend** — whatever comes back is handed to `openai.transcription("whisper-1")` on the
   platform's key. No usage cap, no metering, no attribution.

The only thing between an anonymous HTTP request and both of those was the incidental RLS on the
`voice_calls` lookup. That is a side effect, not a gate.

### Fixed
Explicit `getAgentContext()` gate, and the `voice_calls` lookup is now scoped
`.eq("brokerage_id", ctx.brokerageId)` so the id cannot be borrowed from another tenant either. Anonymous
reach is closed, which is the precondition for both the SSRF and the spend.

### 🚩 STILL OPEN — needs an owner decision, deliberately not guessed
- **`audioUrl` is still unvalidated**, so an *authenticated* caller still gets an arbitrary server-side fetch
  (cloud metadata endpoints, internal services). There is **no SSRF/allowlist helper anywhere in this repo**,
  and I checked every other `asset-download` call site — `lib/ai/image-generation.ts`, `lib/social/publisher.ts`,
  `lib/offers/offer-extractor.ts`, `lib/did/index.ts`, `lib/repurpose/transcribe.ts`, etc. — **every one of
  them passes a provider-returned URL. This is the only call site that takes the URL from the caller.**
  It wants a host allowlist (storage bucket + telephony provider) or a signed-URL requirement. Writing that
  helper means a new `lib/` module, which is outside this slice's file list.
- **No usage cap or metering on the Whisper call.** Compare `app/api/elevenlabs/voice-clone/route.ts`, which
  wraps its provider spend in `checkUsageCap()` + `logMediaUsage()`. This path caps nothing and bills nobody.

Both are recorded in the code as a `STILL OPEN` comment block above the function so they are not lost.

## `app/actions/crm.ts:updateContactStage` — KEPT + FIXED. Its one unique capability had never worked.

**Partial duplicate.** The stage write itself is shared with `app/actions/crm.ts:updateContact` — both are
`updateContactService` passthroughs (`lib/services/contact-management.service.ts:updateContact`). So on the
write, `updateContact` is the survivor.

**What is NOT duplicated** — and the reason this does not fold into `updateContact` — is the **stage-change
audit row**. A stage move is the one contact edit that matters later (pipeline reporting, conversion timing),
so it writes an `activities` entry carrying the agent's note. `updateContact` has no equivalent.

### 🐛 …except the audit row had never once been written
The insert omitted `brokerage_id`. On `activities` that column is **NOT NULL with no default**. Proven
against the live database — the exact former payload, run in a transaction:

```
ERROR: 23502: null value in column "brokerage_id" of relation "activities"
       violates not-null constraint
```

And the insert's result was **never destructured**, so the error was discarded and the function returned the
successful stage update regardless. Every stage change ever made reported a note recorded that does not exist.

This is the worked-example shape exactly: the loser's extra capability is real, but the implementation is
defective — so **port the intent, not the implementation**. Fixed in place rather than deleted:
`brokerage_id` and a real `entity_type`/`entity_id` added, `agent_id` populated, and the error now
destructured and surfaced as a `warning` (the stage *has* moved by then, so it must not report total
failure — but it must not claim the note landed either).

Id spaces confirmed against live FKs before writing: `activities.agent_id → agents.id`,
`activities.agent_user_id → users.id`, `contacts.agent_id → agents.id`. `ctx.agentId` is `agents.id`, which
is the correct space for both. Resolved, not `??`-substituted.

### 🚨 Security: `agentId` came from the caller and the ownership check was therefore vacuous
`updateContactService` verifies ownership with `.eq("agent_id", params.agentId)` — i.e. it compares the
contact against **whatever agent id the caller supplied**, which checks nothing. As a `"use server"` export
this is a public endpoint, so a contactId plus its agent_id was enough to move any brokerage's contact
through the pipeline. `agentId` is now derived from `getAgentContext()`; the parameter is kept as optional
and ignored (house pattern in this repo) so existing callers still typecheck.

**Same class, not fixed (not orphans, would need signature changes in files this slice does not own):**
`crm.ts:updateContact(contactId, agentId, updates)` and `crm.ts:createContact({ …, agent_id })` both take the
agent id from the caller in the same way. **Recommend a follow-up.**

## `app/actions/ai-client-gifting.ts` — 2 orphans, both KEPT + GATED. Whole file was ungated.

Neither is a duplicate: `aiPlanBulkGifting` (plan a round across the sphere) and `getGiftAnalytics` (spend +
ROI for the year) are distinct from `aiRecommendGift` (one contact) and `createGiftOrder` (place one).
Unwired capabilities of a wired feature — case (b).

Both took `agentId` **from the caller** with no auth gate, on a `"use server"` export:

- `aiPlanBulkGifting` read that agent's whole sphere joined to
  `transactions(purchase_price, close_date)` — client names and **what they paid for their homes** — and then
  spent real gpt-4o tokens planning against a caller-chosen `totalBudget`. Unauthenticated PII read **and**
  unauthenticated AI spend in one call.
- `getGiftAnalytics` returned gift costs joined to `contacts(first_name, last_name)` — who an agent gifted and
  what they spent.

**Fixed:** both derive `agentId` from `getAgentContext()`; the parameter is kept optional and ignored (house
pattern). `ctx.agentId` is `agents.id`, the space `contacts.agent_id` and `client_gifts.agent_id` both
reference (confirmed against live FKs).

### 🚨 Not orphans, NOT fixed — the rest of this file is ungated too
`aiRecommendGift`, `createGiftOrder`, `aiGenerateThankYouNote`, `getVendors`, `createVendor` all take
`agentId` from the caller with **no auth gate**. `createGiftOrder` is the sharp one: it writes a gift order
with a caller-supplied `cost` against a caller-supplied `agentId` — an unauthenticated money-shaped write.
They have live callers, so fixing them means signature changes in files this slice does not own.
**Recommend a follow-up covering the whole file.**

## `app/actions/ai-direct-mail.ts` — 3 orphans. Analysed; deliberately NOT auth-gated. Left as-is.

Recorded because the obvious move here is the **wrong** one.

`trackCampaignResponse({ trackingId, responseType: "qr_scan" | "call" | "website_visit" | "form_submission" })`
is an **inbound** endpoint. The caller is a mail *recipient* — someone scanning a QR code off a postcard or
hitting a landing page. They are not, and cannot be, logged in. It resolves the tenant correctly: it looks the
campaign up **by `tracking_id`**, which is a capability token printed on the mail piece, and takes
`brokerage_id` from the campaign row it found — never from the caller. **Being unauthenticated is the design,
not a defect.** Adding a session gate would break the feature. Left alone.

What it *does* want, and does not have, is rate limiting / replay protection on `tracking_id` — response
counts drive attribution, so an unbounded endpoint lets anyone inflate a campaign's numbers. Noted, not
changed; that is a product decision about tracking, not an orphan question.

`getDirectMailAnalytics` and `aiAnalyzeCampaignPerformance` are the opposite case — agent-facing reads taking
`agentId`/`brokerageId` from the caller with no gate, and `aiAnalyzeCampaignPerformance` spends gpt-4o tokens
on top. **These two should be session-scoped** exactly like the gifting pair above. I ran out of slice before
doing them; they are unchanged and are the top of the remaining queue.

---

# WHERE I STOPPED

## Handled properly (16 of 70 exports across 8 files)

| file | exports | verdict |
|---|---|---|
| `copilot.ts` | `handleSuggestionAccepted`, `handleCoachingSessionBooked`, `handleMorningKickoff`, `createTransactionMilestone` | analysed; unwired orchestrator handlers, left with IDOR finding + slice-3 handoff |
| `blog.ts` | `getBlogPosts`, `getBlogPostById`, `getSeoKeywords` | **fixed** — session-scoped; were cross-tenant reads |
| `twin-studio.ts` | `attachVoiceToTwin`, `updateTwinDetails` | kept; exposed a live hole at the survivor |
| `campaign-sequences.ts` | `resumeCampaignSequence`, `cancelEnrollment`, `getSequenceSteps` | 1 **deleted** (true duplicate), 1 **fixed**, 1 kept |
| `property-buyer-matching.ts` | `scoreSingleBuyerForListing`, `getListingMatchHistory` | **fixed** — plus repaired a dead match engine |
| `ai-voice-transcription.ts` | `transcribeAudio` | **gated**; SSRF + unmetered spend flagged |
| `crm.ts` | `updateContactStage` | **fixed** — audit row that never worked, now works |
| `ai-client-gifting.ts` | `aiPlanBulkGifting`, `getGiftAnalytics` | **fixed** — session-scoped |

Plus **4 fixes at survivors** that were not orphans but carried the same defect class:
`campaign-sequences.ts:getCampaignSequence`, `campaign-sequences.ts:launchCampaignSequence`,
`property-buyer-matching.ts:matchBuyersForListing` (auth + the inverted soft-delete filter), and the
`crm.ts:updateContactStage` activity insert.

## Deliberately left (54 exports)

**Left because they need owner input, not because they are fine:**
- `ai-direct-mail.ts:getDirectMailAnalytics` / `aiAnalyzeCampaignPerformance` — analysed, ungated,
  AI spend. Top of the queue. `trackCampaignResponse` analysed and correctly left public.
- `ai-review-automation.ts` (`aiCreateRecoveryPlan`, `aiSetupReviewMonitoring`) — same shape: caller-supplied
  `agentId`, no gate, gpt-4o spend, writes. Partially read; not fixed.
- `ai-newsletter.ts` (3), `ai-cma.ts`, `content-prediction.ts`, `podcast-generation.ts` (2),
  `seller-coaching.ts`, `financials.ts:deleteExpense`, `lead-management.ts:getLead`,
  `user-profile.ts:getAgentEmailSignature`, `superadmin/parked-retention.ts`, `vendor-w9.ts`,
  `buyer-move.ts`, `transaction-stage-machine.ts`, `link-to-video.ts` (2), `video-generation.ts` (2),
  `voice-tenancy.ts`, `admin/locations.ts`, `learning-modules.ts`, `newsletter/approve-template.ts` (2),
  `inbox.ts:markInboxRead`, `contact-details.ts`, `academy.ts:addTemplateFeedback` — **all verified
  authenticated** on a first pass. They are orphan-wiring questions, not security ones, so they were lower
  priority than the ungated set.
- `lib/kernel/db.ts` (`expectSingle`, `maybeSingleRow`) — generic query wrappers, not endpoints in the same
  sense. `maybeSingleRow` correctly destructures `error` and fails closed. Untouched.
- Remaining ungated reads not yet reached: `academy.ts:getTemplateFeedback`,
  `ai-isa/initiate-engagement.ts:getAIISAEngagementStatus` (service client),
  `ai-predictions.ts:getLeadPredictions`, `inbox.ts:getInboxMessages`,
  `neighbor-notifications.ts:listNeighborCampaignsForListing`, `photo-management.ts:getPhotoOrderingRules`,
  `brand-template-registry.ts` (2), `contact-enrichment.ts` (2), `tour-planner.ts` (2),
  `social/generate-social-post.ts:stampPostBrandCompliance`,
  `settings/global-settings-actions.ts:getPlatformVideoProvider`, `ce-provider.ts:connectCeProvider`,
  `marketing-cadence-policy.ts`, `onboarding/training.ts:recordVideoProgress`.

**Nothing was deleted except `resumeCampaignSequence`**, and that one is declared above with its survivor
named and the comparison recorded.

---

# SECURITY FINDINGS — consolidated

Ordered by severity. Items marked **[NOT FIXED]** are in files this slice does not own, or need an owner
decision.

1. **[NOT FIXED — one line, needs an owner] `app/api/elevenlabs/voice-clone/route.ts`, `twin_id` branch:
   missing ownership check.** It selects `agent_id` off the twin and never compares it to `auth.agentId`. Any
   authenticated agent can bind a voice clone to any other agent's twin in any brokerage — changing whose
   voice that agent's avatar speaks with on ISA calls, video generation and the portal widget — while the
   ElevenLabs spend is billed to the *caller's* brokerage.

2. **[PARTIALLY FIXED] `app/actions/ai-voice-transcription.ts:transcribeAudio`: SSRF + unmetered AI spend.**
   Auth gate added (closes anonymous reach). Still open: `audioUrl` is unvalidated, so an authenticated caller
   gets an arbitrary server-side GET — this is the **only** `asset-download` call site in the repo that takes
   its URL from the caller rather than from a provider response. And the Whisper call has no `checkUsageCap` /
   `logMediaUsage`, unlike the comparable ElevenLabs path.

3. **[FIXED] `app/actions/campaign-sequences.ts:getCampaignSequence`: unauthenticated read returning contact
   PII.** Service client, no gate, no tenant predicate — returned campaign message copy plus up to 200
   enrollments joined to `contacts(first_name, last_name, email)` for any sequence uuid.

4. **[FIXED] `app/actions/property-buyer-matching.ts`: unauthenticated cross-tenant PII harvest.**
   `matchBuyersForListing` selected up to 500 `contacts` rows with **no tenant filter at all**, across every
   brokerage, and returned their names.

5. **[FIXED] `app/actions/blog.ts:getBlogPostById`: no tenant predicate whatsoever.** Returned any
   brokerage's unpublished post body, keyword strategy and SEO audit log from a bare post uuid.

6. **[FIXED] `app/actions/crm.ts:updateContactStage`: vacuous ownership check.** The service compared the
   contact against a caller-supplied `agent_id`, so supplying the pair moved any brokerage's contact.

7. **[FIXED] `app/actions/campaign-sequences.ts:launchCampaignSequence` / `cancelEnrollment`:
   unauthenticated writes on the service client.** Launch starts real message sends to real contacts.

8. **[FIXED] `app/actions/ai-client-gifting.ts:aiPlanBulkGifting` / `getGiftAnalytics`:** unauthenticated read
   of a sphere joined to `transactions(purchase_price, close_date)` — client names and home purchase prices —
   plus unauthenticated gpt-4o spend.

9. **[NOT FIXED] `app/actions/ai-client-gifting.ts:createGiftOrder`:** unauthenticated money-shaped write —
   caller-supplied `cost` against a caller-supplied `agentId`. Has live callers.

10. **[NOT FIXED — IDOR] `app/actions/copilot.ts` event handlers:** take the acting identity from
    `payload: any`. `handleMorningKickoff` injects notifications into an arbitrary `user_id`;
    `handleSuggestionAccepted` stamps a **caller-controlled, forgeable `acted_by`** audit field. No callers
    today, so unexploited — but wiring them up as-is is how it ships.

11. **[NOT FIXED] Caller-supplied tenant, same class, non-orphans:**
    `campaign-sequences.ts:listCampaignSequences`, `blog.ts:addSeoKeyword` (also forgeable `created_by`),
    `crm.ts:updateContact` / `createContact`.

# NON-SECURITY BUGS FOUND (both proven against the live DB)

- **`property-buyer-matching.ts`: the match engine had never returned a buyer.** `.not('deleted_at','is',null)`
  compiles to `deleted_at IS NOT NULL` — it selected only soft-deleted contacts. Live: 4 contacts, 0
  soft-deleted, so the read matched zero rows every time and the panel always rendered empty. **Fixed.**
- **`crm.ts:updateContactStage`: the stage-change audit row had never been written.** The insert omitted
  `brokerage_id` (NOT NULL, no default); reproduced live as `23502`. The error was discarded, so every stage
  change reported a note recorded that does not exist. **Fixed.**
