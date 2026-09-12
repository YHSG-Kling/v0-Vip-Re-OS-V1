# Orphan burn-down — Wave 2, Slice 3 (`"use server"` action modules)

All 44 assigned files carry `"use server"`, so **every export is a publicly reachable
HTTP endpoint**. Verified: `head -3` of every file in the slice contains the directive.

Method (owner's, followed exactly):
1. Duplicate? → establish the survivor by READING both. Merge every capability the loser
   has and the survivor lacks, THEN delete. If the loser's extra is implemented badly,
   fix the class at the survivor — never port a defect.
2. Not a duplicate? → wire it to the surface it was written for, or finish it, or record
   precisely what finishing needs and leave it.
3. "No caller" is never a deletion rationale. Hardening without wiring is a good outcome.

**Typecheck: NOT RUN.** Per instructions (`tsc` / `npm run type-check` / `npm run guard`
are forbidden in this slice — three concurrent typechecks OOM'd the box last wave). The
orchestrator runs one typecheck centrally.

---

## Triage pass (done first, whole slice)

Auth-primitive grep across all 44 files
(`getAgentContext|auth.getUser|requireAuth|resolveWriteContext|requirePlatformCapability|
requireWriteContext|getSession|isAuthenticated`) isolated the files with **zero** auth
primitives anywhere in the module:

| file | orphaned exports | verdict of triage |
|---|---|---|
| `app/actions/lead-signal-ingest.ts` | `ingestPredictiveSellerSignalAction` | **HOLE — all 3 exports unauthenticated, cross-tenant** |
| `app/actions/analytics.ts` | `aggregateValueDelivered`, `trackLeadValueJourney` | see ledger |
| `app/actions/listing-video.ts` | `trackVideoView` | **HOLE — unauthenticated counter write** |
| `app/actions/vendor-portal.ts` | `uploadVendorJobDocument` | see ledger |
| `app/actions/superadmin/deal-room-demo.ts` | `getDealRoomDemoStatusAction` | false positive — gated by `requirePlatformCapability("tenants")` |
| `lib/blog/seo-optimizer.ts` | `getSeoScoreHistory` | see ledger |
| `lib/kernel/db.ts` | `expectSingle`, `maybeSingleRow` | see ledger |
| `lib/listings/tier-assigner.ts` | 4 exports | see ledger |

---

## Per-export ledger

### `app/actions/lead-signal-ingest.ts` — `ingestPredictiveSellerSignalAction` → **hardened in place (whole module)**

**SECURITY FINDING (high) — unauthenticated cross-tenant write of lead intelligence.**
Not a duplicate; a real feature. All **three** exports of this module (the orphan plus its
two already-wired siblings) had **no authentication and no tenant scope whatsoever**. They
pass a caller-supplied `contactId` straight into
`lib/lead-intelligence/signal-extensions.ts:applySignalDelta`, which runs on the **service
client** and filters on `contact_id` alone — RLS never applies. Any unauthenticated caller
could POST a contact id belonging to any brokerage and:
- push that tenant's `contacts.engagement_score` / `intent_score` up, and
- insert an attributed `lead_score_history` row so the platform looked like it had
  genuinely observed a seller/offer/open-house signal.

This is the `batchEvaluateLeadReadiness` class from Wave 1 (service-client read filtered on
entity id alone), reached through an endpoint with no auth at all.

**Fixed:** added `authorizeContactInTenant()`, run before any delta is built on all three
exports. It calls `resolveWriteContext()`, then proves the contact is in the caller's
brokerage via the **cookie** client (so RLS covers the check itself), and **fails closed** —
`error` is destructured and a refused read is rejected with a distinguishable reason rather
than read as "no rows". Returns a reason instead of throwing so the two fire-and-forget call
sites (`.catch(() => {})` in `seller-offers.ts` / `seller-open-house.ts`) keep their shape and
a rejected signal never blocks the business action. Both call sites already run inside an
authenticated request with a tenant-resolved `contactId`, so they are unaffected.

Also fixed input-trust defects that the builders propagate rather than reject:
- `confidence` — the builder clamps with `Math.min/Math.max`, which **propagates NaN**;
  `Math.round(15 * NaN) + 3` would land NaN/null in `lead_score_history`'s numeric score
  columns. Now rejected before the builder.
- `interestLevel` — multiplied into the boost; an out-of-range/non-integer value from the
  wire scaled the score arbitrarily. Now validated to integer 1–5 or dropped.
- `offerAmount` / `losingMargin` — non-finite values rendered as `"$NaN"` in the audit
  reason string.
- `signalKey` / `signalLabel` — required and length-capped.

**Wiring: not done, and why.** The lane it was written for is
`app/api/cron/lead-scraping/route.ts`, which runs with **no user session** and therefore
cannot call a session-gated action. Finishing it means having the pipeline call the library
entry point `applySignalDelta()` directly (it is `import "server-only"`, service-client, and
already idempotent per (contact, source, evidence, day)) with a contact it has already
tenant-resolved. That call site is outside this slice's file set. Recorded in the code.

### `app/actions/analytics.ts` — `aggregateValueDelivered`, `trackLeadValueJourney` → **hardened in place**

**SECURITY FINDING (high) — two unauthenticated writers keyed on caller-supplied ids.**
Neither is a duplicate. Nothing in the module authenticated. Both take the subject id from
the caller and **upsert** on it:
- `aggregateValueDelivered(agentId, date)` → upsert into `value_delivered_daily` under any
  `agent_id` the caller names.
- `trackLeadValueJourney(contactId)` → upsert into `lead_value_journey` under any
  `contact_id` the caller can guess.

**Also a genuine cross-tenant aggregation bug.** The `tool_usage_sessions` and
`document_downloads` reads had **no tenant filter at all** — every brokerage's tool sessions
and document downloads were counted into *this* agent's value metric and written to the
daily record. (Only the `messages` read had been anchored, in an earlier pass; the two
siblings were missed.) Both tables do carry `brokerage_id` — verified live on
`hrvaqgvukzxfskkcrwbt`.

**Fixed:**
- Added `authorizeAgent()` — authenticates, then proves the named agent is in the caller's
  brokerage. Resolves against `agents` rather than substituting `users.id` (disjoint id
  spaces). Fails closed on a refused read.
- Tenant-anchored both unfiltered reads on `brokerage_id`.
- `trackLeadValueJourney` now authenticates and scopes its authorising read to the caller's
  brokerage; swapped `.single()` → `.maybeSingle()` (`.single()` returns PGRST116 for the
  zero-row case, which the un-destructured `{ data }` flattened into the same `null` as a
  real failure) and destructured `error`.
- **Silent-write fix:** all three source reads had un-destructured `error`. A refused read
  resolves with `data: null`, every count fell to `0`, and the function then upserted those
  zeros **as the authoritative daily record for that agent**. It now aborts instead of
  writing a partial day as a complete one.
- Stamped the `brokerage_id` tenant column on both upserts — the columns existed and were
  never being set.
- `onConflict: "date,agent_id"` → `"agent_id,date"` to match the live constraint
  `UNIQUE (agent_id, date)`.
- Unified the day window. The three reads previously used **different windows**: two used a
  date-only string upper bound and the third used the passed date's actual time-of-day, so a
  call at 14:00 counted messages over a 24h window ending 14:00 the next day while counting
  tool sessions over the calendar day.
- **Live-schema bug uncovered:** `tool_usage_sessions.session_id` **does not exist**. The old
  `select("*")` plus `t.visitor_id || t.session_id` fallback read `undefined` forever and
  nobody noticed. Narrowed the select to real columns.

**Left, noted:** `getLeadValueJourneys` (not an orphan, same file) reads `lead_value_journey`
with **no tenant filter**, pulls `limit * 2` rows globally, then filters in JS by joining
`contacts`. It leaks other tenants' journey rows into process memory and returns a wrong
top-N whenever another tenant's rows dominate by value. It now *can* be scoped — this pass
started stamping `brokerage_id` on writes — but existing rows predate the stamp, so scoping
it needs a backfill. Left for the owner.

### `app/actions/listing-video.ts` — `trackVideoView` → **hardened in place**

**SECURITY FINDING (medium) — unauthenticated write against a SECURITY DEFINER RPC.**
Not a duplicate. `trackVideoView(projectId)` was unauthenticated and called
`public.increment(table_name, row_id, column_name)`. Verified live: that function is
`SECURITY DEFINER`, so it **bypasses RLS entirely**. It does carry a hard (table, column)
allow-list — so the dynamic-SQL surface is closed — but `row_id` was entirely
caller-controlled, meaning anyone could increment `view_count` on **any**
`ai_video_projects` row in **any** brokerage, including unrendered drafts. The call was also
pure fire-and-forget with no `error` destructure, so a broken counter was indistinguishable
from a working one, and the timing/behaviour made it an existence oracle over the uuid space.

**Fixed:** the row must exist and be genuinely watchable (`video_url` set) before the
increment; identical response for "absent" and "not yet rendered" so it is not an existence
oracle; rpc `error` destructured; returns a typed result instead of `void`.

**Deliberately left, recorded in the code:** this endpoint stays unauthenticated *by design*
— listing videos are watched by prospects on public/portal surfaces with no agent session.
The remaining gap is that there is no per-viewer dedupe, so a loop can still inflate the
counter on a real published video. Closing it needs a
`video_views(project_id, viewer_fingerprint, viewed_at)` ledger with a unique index on
(project_id, viewer_fingerprint, day) and the counter derived from it — a migration plus a
fingerprint source, neither of which exists. Not half-built.

### `app/actions/superadmin/deal-room-demo.ts` — `getDealRoomDemoStatusAction` → **left (triage false positive)**

Not unauthenticated: gated by `requirePlatformCapability("tenants")`. It is a thin duplicate
of `lib/platform/deal-room-demo.ts:getDealRoomDemoStatus`, which
`app/dashboard/superadmin/demo-room/page.tsx` already calls directly at render (the client
does `router.refresh()` after seed/teardown, which re-reads it).

**Survivor: `lib/platform/deal-room-demo.ts:getDealRoomDemoStatus`.** The loser's one extra
capability is the `requirePlatformCapability("tenants")` gate, which the *page* does not
apply — the page relies solely on the superadmin layout gate, so a platform-staff user
without the `tenants` capability can read demo status even though they cannot seed or tear
down. The correct merge is therefore to **wire the action into the page** rather than delete
it, which tightens the read to match the mutations. That edit is in
`app/dashboard/superadmin/demo-room/page.tsx`, **outside this slice's file set** — left for
the orchestrator. Not deleted: deleting would drop the stricter gate.

### `app/actions/phone-provisioning.ts` — `autoProvisionAgentPhone`, `manuallyAddAgentPhone` → **hardened in place**

Neither is a duplicate. The module's *auth* was already good (a prior wave added the
agent tenant-checks). Two real defects remained, both on money/telephony.

**SECURITY FINDING (high) — `manuallyAddAgentPhone`: cross-tenant phone-line takeover.**
The BYO/ported path takes the phone number as a **free string from the caller** and wrote it
straight into `tenant_phone_numbers` with (a) no proof the brokerage owned it and (b) no
check that anyone else already held it.

Verified live on `hrvaqgvukzxfskkcrwbt`: `tenant_phone_numbers` has **no unique constraint on
`phone_number` or `phone_digits`** — only `pkey`, the brokerage FK, and two CHECKs. Both
inbound routing paths resolve the tenant from the dialled number with
`.eq("phone_digits", digits).eq("is_active", true).maybeSingle()`
(`lib/voice/twilio-voice.ts:resolveInboundContext`, `lib/voice/sms-inbound.ts`) and both use
`const { data: num }` with **no `error` destructure**. `.maybeSingle()` **errors** on more
than one match, so `num` comes back undefined and the resolver returns `null`.

Consequence: any authenticated agent — the action deliberately permits a plain agent to add
their *own* number, the lowest-privilege role — could insert a row claiming a number already
active for a **different brokerage** and blackhole that brokerage's inbound calls and SMS.
If the victim's row was later deactivated, the attacker's row became the sole match and
inherited the routing.

**Fixed:**
- **Guard 1 — global active-number collision check**, deliberately *not* scoped to the
  caller's tenant (the cross-tenant case is exactly the one to refuse). Fails **closed** on a
  read error; does not disclose which other tenant holds the number.
- **Guard 2 — real ownership proof.** New `verifyNumberOwnedByTenant()` looks the number up
  in the Twilio account this brokerage resolves to (BYO → tenant subaccount → platform
  master, via the canonical `resolveTenantTwilioCreds`) through the existing connector
  gateway, and takes **Twilio's own SID** rather than trusting the caller-supplied
  `twilioSid`. Honest about a not-configured carrier: it **refuses**, because "we can't
  check" must not mean "it's yours".
- Normalised to digits/E.164 once; `phone_digits` (the column the resolvers key on) is what
  the uniqueness check uses.
- **Bind fix:** the insert now `.select("id")`s and calls `bindNumberToTwilioLane`. Before,
  the row was created and the UI reported the agent had a number, while its Twilio
  VoiceUrl/SmsUrl still pointed wherever they used to — the number could not answer.

**MONEY BUG — `autoProvisionAgentPhone` bought numbers that could never ring.**
It was the only tenant purchase lane that did not pass `bindToVoiceLane: true` to the shared
`provisionNumber` core (the sibling `purchaseBrokerageNumberAction` always has). So every
auto-provisioned agent number was a **real Twilio purchase, really billed, with no webhooks
pointed at the AI lane** — it rang into nothing. Fixed, and `bound` / `bindNote` are now
returned rather than swallowed (a bind failure never undoes a real purchase, so it is
reported).

**FEATURE PROMISED IN UI, NEVER WIRED (report to owner).** `brokerages.auto_provision_phone_numbers`
is written by `updateBrokeragePhoneSettings` and read by `getBrokeragePhoneSettings` — and
**by nothing else in the codebase**. `autoProvisionAgentPhone`, the function the toggle
exists to trigger, has no callers. The phone-settings UI tells the broker
*"Auto-provisioning is ON — each new agent automatically gets a number"* and nothing ever
happens. The same card says agents *"manually add a number from their settings using the
'Add Number' button"* — `manuallyAddAgentPhone` also has no callers and no such button
exists. Wiring the auto path means calling it from the agent-invite/creation action, which
is **outside this slice's file set**. Both endpoints are hardened and left correct so the
wiring is a one-line call when the owner takes it.

### `app/actions/twin-studio.ts` — `attachVoiceToTwin` → **merged-then-deleted**

**Survivor: `app/api/elevenlabs/voice-clone/route.ts` (the `twin_id` branch).** That is the
path the Twin Studio wizard actually calls. It writes the *same three columns*
(`voice_id`, `voice_sample_url`, `updated_at`) on the same row, and it already carries the
ownership guard **merged onto it from this very function** in Wave 1 — the route's own
comment names `attachVoiceToTwin` as the source of the guard. Nothing the loser had is
missing from the survivor; the survivor is strictly richer (creates the real ElevenLabs
clone, enforces the usage cap, honest 503 when the key is unset, meters via
`logMediaUsage('voice_clones_created')`).

**Deleted rather than left, because it was a live metering bypass.** As a `"use server"`
export it let a caller write an **arbitrary `voiceId` string** onto their twin without going
through the clone route at all — binding a voice id nobody in the brokerage paid to create,
with no cap check and no `voice_clones_created` meter line. A second door that skips the
spend accounting is not a harmless duplicate. Only the comment reference in the route
mentioned it; no importers.

### `app/actions/twin-studio.ts` — `updateTwinDetails` → **hardened in place**

Not a duplicate of `finalizeTwin` (that one writes greeting/sentiment/default and cannot set
`label`; this one writes `label`/`personality` and is the later-edit path).

**Fixed:** it was the **unbounded back door** to two columns its siblings guard —
`createTwinDraft` caps `label` at 64 chars, `finalizeTwin` refuses an over-long greeting, but
`updateTwinDetails` accepted unlimited input for both. `personality` is a free-text
**system-prompt addendum injected into every conversation the twin fronts**, so an unbounded
value is both a prompt-injection surface and an unbounded per-turn token cost on every AI
call that loads it. Now: label trimmed/required/capped at 64, personality capped at 2000 with
a refusal (not a truncation), `error` destructured on both the ownership read and the update.

**Not wired.** `TwinCard` already carries a `canEdit` prop but renders only Set-default and
Delete — there is no rename / edit-personality affordance. Wiring is a UI change in
`app/dashboard/settings/twin-studio/components/twin-card.tsx`, outside this slice's files.

### `app/actions/vendor-portal.ts` — `uploadVendorJobDocument` → **finished (feature completed) + hardened**

Not a duplicate. Triage false positive on auth: the module gates through
`requireVendorActor` / `gateVendor`, and this function's scope chain was already correct
(vendor actor → job in the vendor's scope → the job's assignment links to *this* transaction
→ the transaction is in the same brokerage).

**The defect was that it did not do the thing it is named for.** `fileData` was accepted as a
parameter and then **never referenced**. The function inserted a `transaction_documents` row
with `status: "uploaded"` and left `storage_url` NULL — a record asserting a file exists when
no file was ever stored. Not cosmetic: `lib/transactions/coordination-status.ts` reads
`transaction_documents.status`, so a vendor "uploading" a document flipped the transaction
checklist to received and advanced coordination status **on a document nobody can open**.

**Finished it:**
- The bytes are now written to the **private** `transaction-documents` bucket (verified live:
  `storage.buckets.public = false`) — deliberately *not* the public `documents` bucket, since
  vendor job documents are deal files (inspection reports, invoices).
- `storage_url` is minted via the existing `signedDocUrl` helper; `uploaded_at`,
  `uploaded_by_type: "vendor"`, and a `metadata.storage_path` are stamped.
- **Order fixed:** the object is stored *before* the row is inserted, and if the insert then
  fails the orphaned object is swept — otherwise every retry left another unreferenced copy
  of a confidential file in the bucket.
- **Path traversal:** `fileName` is caller-supplied and becomes part of a storage key.
  `sanitizeStoredFileName()` strips separators and traversal segments, so an upload cannot be
  aimed outside its `vendor-jobs/<brokerage>/<transaction>/` prefix.
- **Size cap:** 25 MB. It was an unbounded upload endpoint.
- `fileData` now accepts base64 / `data:` URL (what a browser server-action call can actually
  carry — a `Buffer` is not serializable across that boundary) as well as raw bytes.
- Null-checked `document` before reading `document.id` (it was `.maybeSingle()`, so a null
  row would have thrown a TypeError instead of a real error).
- The three new helpers are module-private, **not exported** — a `"use server"` file may only
  export async functions, and these must not become endpoints.

**Not wired:** `app/components/vendor/job-detail.tsx` imports the other four vendor actions
and renders an `Upload` icon, but has no upload control. Adding it is a UI change outside
this slice's files.

### `lib/kernel/db.ts` — `expectSingle`, `maybeSingleRow` → **de-endpointed (2 endpoints removed)**

Not duplicates — nothing equivalent exists in the tree — and they encode exactly the
discipline this codebase keeps re-learning: supabase-js **resolves** a failed query, so
`const { data } = await q` reads "refused" as "empty". Both destructure `error` and return a
discriminated result so a caller cannot make that mistake.

**Removed the `"use server"` directive.** It made both exports publicly reachable HTTP
endpoints — and nonsensical ones: each takes a `Promise<QueryResult<T>>` as its argument,
which is **not serializable across the Server Action boundary**, so no browser caller could
ever have invoked them correctly. They are pure in-process utilities that happen to be
`async`. The module had **zero importers anywhere in the tree**, so there is no call site to
migrate and nothing else changes. Net effect: two public endpoints gone, two useful helpers
kept and now actually importable.

### `lib/listings/tier-assigner.ts` — `getTierForListing`, `getTierBudgets`, `getRequiredDistributions`, `getTiersForBrokerage` → **hardened in place (whole module)**

**SECURITY FINDING (high) — authorization gated on a caller-asserted identity.**
Found while auditing the four orphaned reads. **Every** gate in this module was
`canAccessFeature(actorUserId, "listing_marketing_tiers")` where **`actorUserId` is a
parameter supplied by the caller**. The caller gets to name whose entitlement is checked.
Since the file is `"use server"`, each is a public endpoint, so anyone could pass the user id
of somebody whose brokerage *has* the feature and walk through the gate.

RLS on the three tier tables (`brokerage_id = current_user_brokerage_id()` — verified live,
one policy each) is what kept this from being a cross-tenant *write*. It does **not** stop
the entitlement bypass: a user whose brokerage lacks the paid feature could borrow an
entitled id and then create/update/delete tiers freely inside their own brokerage — exactly
what the gate exists to prevent.

**Fixed, without changing a single signature** (so `marketing-tier-client.tsx` and
`app/actions/listings.ts` are untouched):
- `resolveTierActor(claimedUserId)` — refuses unless the asserted id **is** the session user,
  then returns the actor's real brokerage. Fails closed on no session, mismatch, or a refused
  profile read. Applied at all 7 write/assign gates.
- Caller-supplied `brokerageId` on `assignTierToListing` and `createTier` is now **pinned** to
  the actor's real tenant instead of being used as the filter/insert value the caller chose.
- **Silent-no-op deletes fixed.** `deleteTierBudget` / `deleteTierDistribution` deleted on
  `id` alone and relied on RLS. An RLS-filtered delete removes **zero rows without raising**,
  so a delete aimed at another brokerage's row returned `success: true` to the caller. Both
  now carry an explicit `brokerage_id` filter and `.select("id")`, and report
  "Not found in your brokerage" when nothing was removed.
- The four orphaned **reads** now authenticate via `resolveTierReader()` and carry explicit
  tenant filters. `getTiersForBrokerage` no longer lets the caller name the tenant whose tier
  configuration (price bands, budgets) is returned. `getTierForListing` moved
  `.single()` → `.maybeSingle()` so a read failure is no longer reported as "Listing not
  found".

**On the duplication (recorded, not acted on).** All four reads are duplicated *inline* by
`app/dashboard/listings/[id]/marketing-tier/page.tsx`, which loads the listing+tier, the
`tier_budgets` and the `tier_distributions` itself. The page is the code that actually runs
today, but the four exports are the reusable, now-gated library API, and the losers carry
small extras the page lacks (`getTierBudgets` sums `totalBudget`; `getRequiredDistributions`
filters `is_required`; `getTiersForBrokerage` orders by `min_price` nulls-first).
**Deleting them would leave the un-gated inline copies as the only implementation and invite
a fifth copy at the next surface.** The correct consolidation is to have the page call these
four — a change to `page.tsx`, which is outside this slice's file set. Left for the
orchestrator with the endpoints hardened.

### `app/actions/voice-avatar-settings.ts` — `updateMyAssistantAvatar` → **hardened in place**

Not a duplicate. Auth and self-scoping were already right (`resolveWriteContext` +
`.eq("user_id", ctx.userId)`).

**Fixed — an identity gap, not an auth gap.** `assistantAvatarId` was a **free string**
written with the SERVICE client and never validated. It is read back verbatim by
`lib/voice/voice-resolver.ts:resolveSelfAvatar`, which returns it as the D-ID avatar to
render. So an agent could point it at **another agent's `did_avatar_id`** and have that
person's face render as their assistant — and spend D-ID budget doing it. That contradicts
this platform's own standing "nobody else's face, ever" rule. (Contact-facing surfaces are
unaffected — `resolveContactFacing` always uses the agent's own clone — but the twin named
still belongs to someone.)

Now the id must match a `did_avatar_id` on one of the **caller's own** `agent_avatar_assets`
rows that is `status = ready` **and** `approval_status = approved` (so a pending or rejected
likeness cannot be promoted either). Null clears. Fails **closed** — a refused ownership read
is not "you own it".

**Not wired:** `app/dashboard/settings/assistant/listening-preferences-panel.tsx` wires the
two voice actions but has no avatar control, so the avatar half of this module has no
surface. UI change, outside this slice.

### `app/actions/settings/global-settings-actions.ts` — `updateSettings` → **merged-then-deleted**

**Survivor: `app/actions/settings/update-global-settings.ts:updateGlobalSettings`** — the
action the settings UI actually calls (`BrandingForm`, `GeneralSettingsForm`,
`NotificationChannelsCard`). Nothing needed merging: it writes the same twelve fields, goes
through the same kernel function, returns `{ error }` instead of throwing, and translates the
kernel's "Forbidden" into a real sentence.

**SECURITY FINDING (medium-high) — mass assignment.** Deleted rather than left because
`updateSettings`'s *only* restriction on writable columns was its TypeScript signature
(`Partial<Pick<GlobalSettingsRow, …>>`) — and **types are erased at runtime**. A `"use server"`
export receives whatever the caller POSTs, and this one passed that object straight into
`updateGlobalSettings({ updates })`, which spreads it as `.update({ ...params.updates })`.
Every column on `global_settings` was therefore writable, including the secrets the kernel's
own comment says must never be written through it — verified live: `smtp_host`,
`smtp_username`, `smtp_password`, `airtable_api_key`, `ghl_api_key`, `zapier_api_key`.
Repointing a brokerage's SMTP credentials is a mail-interception primitive.

The role gate does hold (`updateGlobalSettings` → `requireBrokerAdmin` internally, so this is
escalation *within* broker/admin, not any-user), which is why this is medium-high rather than
critical. The survivor is immune to the same input because it copies field-by-field out of a
runtime `ALLOWED_FIELDS` const — that allow-list is the actual control; the type never was.

### `app/actions/settings/global-settings-actions.ts` — `getPlatformVideoProvider` → **deleted (with its no-op setter)**

A public HTTP endpoint whose entire body was `return "did"` — a network round-trip to learn a
compile-time constant. Its sibling `setPlatformVideoProvider` (not on the orphan list, same
file, also callerless) was a public **no-op that accepted a provider argument and silently
discarded it** — exactly the "reports success, changes nothing" class this audit exists to
remove. Deleted both.

The business rule is unchanged and was never carried by these functions: the platform video
engine is permanently D-ID + ElevenLabs, enforced structurally. The only mentions of
`getPlatformVideoProvider` anywhere in the tree are **prose comments** in
`lib/kernel/video.ts` and `lib/video/intro-video-reactor.ts` restating that rule — no
imports, no calls. Removed the now-unused `updateGlobalSettings` import from the module.

### `app/actions/ai-newsletter.ts` — `aiPersonalizeNewsletter`, `manageSubscribers`, `manageSubscriberBatch` → **hardened in place**

None is a duplicate. **Auth and tenancy were already correct** and are worth recording as
*good*: all three derive the tenant from `getAgentContext()`, explicitly ignore the
caller-supplied `agentId`/`brokerageId` (the params survive only for signature
compatibility and are documented as ignored), verify the newsletter/contact belongs to the
session brokerage before touching it, and honour the id-class rule — `newsletter_subscribers.agent_id`
is agents-class, and a user with no agents row is **refused** rather than having a users id
substituted.

**Checked and cleared:** re-subscribing a suppressed address is **not** a compliance hole
here — the send path (`sendNewsletter`) runs the De-Conflict + compliance + suppression gates
per recipient and counts `suppressed` separately, so a suppressed subscriber is never mailed
regardless of list membership.

**Fixed:**
- **Duplicate-mailing bug (`manageSubscribers`).** The live constraint is
  `UNIQUE (brokerage_id, email)` on the **raw** email column. Emails were inserted
  un-normalised, so `Bob@Example.com` and `bob@example.com` were two accepted rows for one
  person — and that person received every newsletter twice. Now trimmed + lowercased before
  the constraint sees it, and validated with `isValidEmail`. The unsubscribe/remove branch
  matches on the same normalised value (previously it matched the raw input, so unsubscribing
  could miss the row it was meant to hit).
- **23505 handled.** A duplicate insert now returns "already on this brokerage's list"
  instead of an opaque database error — and deliberately does **not** flip an
  `unsubscribed` row back to `subscribed`. Re-subscribing an opt-out must be a deliberate act.
- **`source` CHECK respected.** `params.source` is caller-supplied free text and the column
  has a live 9-value CHECK; an out-of-vocabulary value was a 23514 surfaced as a raw DB
  error. Now validated against the vocabulary, falling back to `manual`.
- **Unbounded batch (`manageSubscriberBatch`).** `contactIds` is a caller-supplied array
  driving **one scope read plus one write per entry**, with no cap — one request became
  arbitrarily many sequential queries (the amplification half of the Wave 1
  `batchEvaluateLeadReadiness` class). Now capped at 500 with an honest refusal, and
  de-duplicated (the same id twice was two round trips for one row).

---

## Where I stopped

**Completed: 22 of the slice's 66 orphaned exports, across 12 of its 43 files.** Worked densest-and-most-dangerous first,
as instructed. Everything below was NOT reached — no file in it was read in depth, so nothing
should be inferred about it either way.

**Not reached (21 files, ~30 exports):**
`admin/locations.ts`, `ai-auto-response.ts`, `ai-cma.ts`, `ai-isa/initiate-engagement.ts`,
`ai-market-intelligence.ts`, `ai-predictions.ts`, `blog-cadence-policy.ts`, `blog.ts`,
`buyer-offer/handle-multi-offer.ts`, `ce-provider.ts`, `compliance-bridge-actions.ts`,
`contact-details.ts`, `content-prediction.ts`, `credit-copilot.ts`, `crm.ts`,
`error-handler.ts`, `lead-assignment/assign-lead.ts`, `lifetime-customer-touchpoints.ts`,
`marketing-studio.ts`, `negotiation-strategy.ts`, `onboarding/agent-onboarding-actions.ts`,
`partner-orders.ts`, `portal-messages.ts`, `portal-stream.ts`, `showings.ts`,
`social-publishing.ts`, `superadmin/platform-providers.ts`, `tour-planner.ts`,
`transactions.ts`, `video-generation.ts`, `lib/blog/seo-optimizer.ts`.

Triage result for these: every one of them has at least one auth primitive in the module, so
none is in the "zero auth anywhere" bucket that this pass prioritised. `lib/blog/seo-optimizer.ts`
(`getSeoScoreHistory`) IS in that bucket and was **not** reached — it should be the next file
picked up.

**Deliberately left, with reasoning recorded above (not skipped):**
- `getDealRoomDemoStatusAction` — correctly gated; the merge is a one-line change to
  `app/dashboard/superadmin/demo-room/page.tsx`, outside this slice's files.
- `ingestPredictiveSellerSignalAction` wiring — needs a system-context call from the
  lead-scraping cron, outside this slice's files.
- The four `tier-assigner` reads vs. the inline copies in
  `app/dashboard/listings/[id]/marketing-tier/page.tsx` — consolidation needs the page.
- `updateTwinDetails`, `updateMyAssistantAvatar`, `uploadVendorJobDocument`,
  `manuallyAddAgentPhone`, `autoProvisionAgentPhone` — hardened and correct, but their UI
  affordances / call sites live outside this slice.
- `analytics.ts:getLeadValueJourneys` — needs a `brokerage_id` backfill before it can be
  tenant-scoped.

**Typecheck: NOT RUN**, per instructions. As a substitute I ran `esbuild` **parse-only**
(`--outfile=/dev/null`) over every edited file plus `app/settings/providers/page.tsx` — all
parse clean. That is a syntax check, not a type check; the orchestrator's central `tsc` is
still the authority.
