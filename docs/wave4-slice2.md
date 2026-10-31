# Orphan burn-down — Wave 4, Slice 2 (`"use server"` action modules)

38 files, 55 category-C orphaned exports. Every file carries `"use server"`, so every
export is a publicly reachable HTTP endpoint.

Method (owner's):
(a) Duplicate? Read BOTH, establish the survivor, MERGE the loser's extra capabilities onto
    the survivor first, then delete. Bad implementation of an extra → fix the class at the
    survivor, don't port the defect.
(b) Not a duplicate? Either it BELONGS to a surface (WIRE it) or it is an advanced feature
    worth having (finish it, or record exactly what finishing needs).
"No caller" is never a deletion rationale. Every deletion names its survivor as
`file.ts:functionName`.

**Typecheck: NOT RUN** (forbidden in this slice — orchestrator runs one central typecheck).
Parse-only verification via `esbuild.transformSync`.

---

## Triage pass (whole slice, done first)

Auth-primitive grep
(`getAgentContext|auth.getUser|requireAuth|resolveWriteContext|requirePlatformCapability|
requireWriteContext|getSession|isAuthenticated|resolveActorContext|requireAdmin|getServerUser`)
across all 38 files. Files with **ZERO** auth primitives anywhere in the module:

| file | orphaned export | why it is dangerous |
|---|---|---|
| `lib/blog/seo-optimizer.ts` | `getSeoScoreHistory` | flagged by earlier wave as last of the zero-auth bucket |
| `app/actions/vendor-w9.ts` | `getMyVendorW9Action` | **W-9 = tax ID / SSN-class PII** |
| `app/actions/direct-mail.ts` | `trackDelivery` | outbound spend + delivery ledger |

Those three go first, then money/deletion (`financials.deleteExpense`,
`data-health.purgeInvalidContacts`), then credentials (`voice-tenancy`), then spend
(`phone-provisioning`), then AI spend.

---

## Per-export ledger

### `lib/blog/seo-optimizer.ts` — `getSeoScoreHistory` → **WIRED + module hardened**

Not a duplicate. `app/dashboard/marketing/blog/[id]/page.tsx` ships only the **latest**
`seo_optimization_log` row to the editor, so the editor could never show whether an edit
moved the score. `getSeoScoreHistory` is exactly the missing panel.

**Wired** into `app/dashboard/marketing/blog/[id]/blog-editor-client.tsx`:
`refreshSeoHistory()` on mount and after every successful `handleAnalyzeSEO`, rendering a
"Score history" list (last 10 analyses, with per-step deltas) inside the existing SEO Score
card.

**SECURITY / correctness findings fixed in the same module (all 3 are in `analyzeSEO`,
which IS live — called from the blog editor):**

1. **Client-supplied tenant id.** `analyzeSEO(postId, brokerageId)` took `brokerageId`
   straight from the browser. Live RLS on `blog_posts` and `seo_optimization_log` is
   `brokerage_id = current_user_brokerage_id()` (verified against project
   `hrvaqgvukzxfskkcrwbt`, `pg_policies`), and both exports use the **cookie** client, so
   RLS was the only boundary. Added module-private `resolveBlogTenant()` (NOT exported —
   this file carries `"use server"`) which resolves the caller's real brokerage via
   `getAgentContext()` and **fails closed** on unauthenticated / no-brokerage. A
   caller-supplied brokerageId that disagrees with the session is now **refused**, not
   silently re-scoped.
2. **A control that reported success without doing the thing.** Both writes
   (`seo_optimization_log` insert, `blog_posts.seo_score` update) only `console.error`'d
   their error and then returned `success: true`. The editor showed a fresh score that was
   never persisted, and the new history panel would have silently disagreed with it. Both
   now return the failure. The `blog_posts` update also gained `.eq("brokerage_id", …)`.
3. **Swallowed `error` on the keyword reads** (lesson 4 — supabase-js RESOLVES a refused
   query). A refused `blog_post_keywords` / `seo_keywords` read read as "this post has no
   keywords", which silently costs the post 50 of its 100 points — a wrong score reported
   as a real one. Both now destructure `error` and fail.

`getSeoScoreHistory` itself: added the same session gate plus an explicit
`.eq("brokerage_id", …)` so a future service-client refactor of this read cannot quietly
become cross-tenant.

Call sites changed: `blog-editor-client.tsx` (import, state, mount effect, post-analyze
refresh, trend UI). `analyzeSEO`'s failure convention did NOT change (still
`{success,error}`); its single caller already renders `result.error`.

---

### `app/actions/vendor-w9.ts` — `getMyVendorW9Action` → **WIRED**

**Triage false positive corrected:** my auth grep did not include `requireVendorActor`;
this export IS gated (`requireVendorActor(vendorId)` → `user_role_assignments`). Both
server consumers of W-9 posture (`app/vendor/documents/page.tsx`,
`app/vendor/invoices/page.tsx`) resolve `vendorId` from the caller's own role assignment
and then call `lib/vendors/w9.ts:readVendorW9` directly — correct, and the reason the
action had no caller.

Not deleted. It is the only **client-callable** door to a vendor's own W-9 posture, and it
carries the gate the lib function cannot. Wired into `app/vendor/documents/w9-card.tsx`:
the card now holds `w9` in state (seeded from the server render) and, after a successful
upload, re-reads its own posture through `getMyVendorW9Action`, so the badge reflects the
**derived** status (`deriveW9Status` recomputes `expired` from the vendor's current legal
name) instead of the just-written literal `on_file`. A refused/failed re-read leaves the
previous posture in place — no optimistic "on file" badge — and `router.refresh()` still
runs as the backstop for the sibling document list.

Call sites changed: `app/vendor/documents/w9-card.tsx`.


---

### `app/actions/direct-mail.ts` — `trackDelivery` → **WIRED (real user-visible gap closed)**

Not a duplicate. An earlier wave hardened this endpoint (shared-secret gate + tenant
resolved from the campaign row) and recorded, in its own doc comment, that it was still
NOT WIRED. Confirmed live: **nothing in the tree wrote `mail_tracking`.**
`app/dashboard/campaigns/mail/mail-dashboard.tsx:148` calls `getTrackingRecords(campaignId)`
→ `mail_tracking`, so the campaign **Tracking tab rendered empty for every campaign,
forever**, no matter what Lob reported — on the most expensive touch the platform makes.

**Fixed a blocker the earlier wave's plan would have hit.** `mail_tracking`'s live RLS
policy is `brokerage_id = current_user_brokerage_id()` for **ALL** commands (verified,
`pg_policies`). `trackDelivery` used the **cookie** client. Its only possible caller is an
unattended one — the gate refuses anything without `LOB_WEBHOOK_SECRET`, and Lob's receiver
has no session. So calling it as written would have inserted nothing and left the tab empty
anyway. Switched to `createServiceClient()` (lesson 1: the unattended caller gets its own
door — the secret is the gate, and the tenant is still **resolved from the campaign row**,
never accepted from the caller). `getTrackingRecords` keeps the cookie client so reads stay
RLS-scoped.

**Wired** in `app/api/webhooks/lob-events/route.ts`: the campaign lookup by `lob_order_id`
is now done once (with `error` destructured — a refused read must not read as "no such
campaign") and feeds both the existing terminal-status mirror and a new per-piece ledger
write via `trackDelivery`. In-flight events (`in_transit`, `re_routed`) are recorded too,
not just terminal ones. Timestamps are stamped **only from the event that proves them** —
`delivered_at` is set only for `TRUTH_SOURCES.direct_mail.confirms`, `returned_at` only for
`contradicts`, `mailed_at` only for `inFlight` — so the ledger can never claim a delivery
Lob did not report. The route still always ACKs 200 (no retry storms); a `trackDelivery`
refusal is logged, not thrown.

Live schema verified before writing: `mail_tracking` columns
(`brokerage_id, campaign_id, batch_id, provider_delivery_status, mailed_at, delivered_at,
returned_at, tracking_payload`) all exist; **no CHECK constraints** on the table, so no
value can be rejected into unreachability.

Call sites changed: `app/api/webhooks/lob-events/route.ts` (campaign lookup hoisted, status
mirror now `.in("id", …)`, new step 4, `trackingRecorded` added to the ACK body);
`app/actions/direct-mail.ts` (service client + `createServiceClient` import + doc comment).

---

### `app/actions/financials.ts` — `deleteExpense` → **WIRED (MONEY)**

Not a duplicate; no other delete path for `business_expenses` exists. Already correctly
scoped by an earlier wave (resolves `agents.id` from the session — `business_expenses.agent_id`
FKs `agents(id)`, not `auth.users.id` — and requires the row to match BOTH the expense id
and that agent, then checks `deleted.length` so a no-op delete is reported as a failure).
Left the action's logic untouched.

**The gap it left:** `app/dashboard/financials/expenses/page.tsx` has an Add dialog, a CSV
export and a receipt attach, and **no way to remove a row**. Those rows are not cosmetic —
they feed the YTD deduction total, the category breakdown and the P&L report, so a wrong
amount or a double-logged receipt silently **overstates a tax deduction** until a human
notices, with no lever to fix it.

**Wired:** new `app/dashboard/financials/expenses/components/delete-expense-button.tsx`
(confirm-gated `AlertDialog`, since this is a hard delete of a financial record; the dialog
names the description and amount, and stays OPEN showing the refusal if the action returns
`success: false` — it never closes on a delete that did not happen), added as a trailing
column on the expense table.

Call sites changed: `app/dashboard/financials/expenses/page.tsx` (import, header cell, body
cell). New file: `delete-expense-button.tsx`.

---

### `app/actions/data-health.ts` — `purgeInvalidContacts` → **WIRED (BULK DELETION) + count made honest**

Not a duplicate. Gates were already right (broker/admin only via `PURGE_ALLOWED_ROLES` on
`ctx.userType` — correctly **not** `users.role`, lesson 5; brokerage-scoped; refuses a
read-only act-as grant; a refused `data_health_logs` read is a refusal, not "nothing to
purge"). Left all of that as-is.

**Correctness fix (the "reports success without doing the thing" class):** the soft-delete
`update` had no `.select()`, and the function returned `deletedCount: contactIds.length` —
the number it *intended* to purge, taken from `data_health_logs`. A log row can outlive its
contact, so the caller could be told "purged 40" when 12 rows moved. Now `.select("id")`
and `deletedCount` is the proven count, with an honest partial-purge message when the two
disagree. The follow-up `data_health_logs` delete was also fire-and-forget and is now
scoped to the **proven-purged** ids (clearing the log for a contact that survived would
hide it from the next scan) with its error surfaced instead of swallowed.

**Wired** into `app/dashboard/admin/data-health/page.tsx`: the page rendered an "Invalid"
count with no lever at all. A confirm-gated "Purge invalid" action now sits on that stat
card (only when `stats.invalid > 0`), states plainly that this is a brokerage-wide soft
delete, and surfaces the action's refusals (`Forbidden…`, `Read-only session…`) verbatim
via `toast.error` rather than reporting a clean run. Reloads stats/logs on success.

Live schema verified: `contacts.deleted_at` and `contacts.brokerage_id` both exist.

Call sites changed: `app/dashboard/admin/data-health/page.tsx`; `app/actions/data-health.ts`
(return shape gained an optional `message`; **no existing caller** to re-check — it had
none, which is why it was in this slice).

---

### `app/actions/voice-tenancy.ts` — `setTwilioByoCredsAction` → **WIRED (CREDENTIALS)**

Not a duplicate. This is a finished, tier-gated, format-validated credential writer with
**no UI anywhere in the tree** — the one commercially-promised way off platform-managed
telephony (`lib/kernel/manager-registry.ts:phone_system_tenancy` describes it as the
product's BYO escape hatch) could not be reached by the customer it was written for. The
sibling `getVoiceUsageAction` IS wired, on `app/dashboard/admin/phone-settings/page.tsx`;
that is where this belongs.

Live schema verified BEFORE writing the card (lesson 3): `platform_credentials` carries
`account_id / access_token / owner_type / owner_id / is_active`, and its CHECK constraints
accept `platform = 'twilio_byo'` and `owner_type = 'brokerage'` — so the action's existing
insert cannot be rejected into unreachability. `brokerages.plan_tier` exists (the column
with writers; `subscription_tier` is the one that drifts).

**Added** `getTwilioByoStatusAction` to the same module — the card needs to say "connected"
without the token ever leaving the server. It returns only the Account SID (a public
identifier) plus a boolean; `access_token` is **never** selected into the response. Its read
destructures `error`, because a refused read rendering as "not connected" would invite an
admin to re-enter credentials that are already in place.

**Extended** `getVoiceUsageAction` to also report `planTier` so the page can decide whether
to render the card. The tier rule stays **enforced inside `setTwilioByoCredsAction`** — the
page's check is presentation only, and the card renders the action's refusal text verbatim
if the two ever disagree. Its single existing call site (the phone-settings page) is the one
I changed; the added field is additive, so nothing else re-checks.

**Wired:** new `app/dashboard/admin/phone-settings/twilio-byo-card.tsx`. Rendered when the
tenant is `multi_location` **or already has BYO creds configured** — a plan downgrade must
never strand a configured Twilio account with no way to view or replace it.

Call sites changed: `app/dashboard/admin/phone-settings/page.tsx`;
`app/actions/voice-tenancy.ts`. New file: `twilio-byo-card.tsx`.

---

### `app/actions/phone-provisioning.ts` — `autoProvisionAgentPhone`, `manuallyAddAgentPhone` → **BOTH WIRED (SPEND)**

Neither is a duplicate; both were already hardened by earlier waves (caller-supplied
`agents.id` resolved AND tenant-checked; global active-number collision check; real
ownership proof against the brokerage's resolved Twilio account; plan-allowance
enforcement; honest `bound` / `bindNote` reporting). Their logic is untouched.

**SECURITY / INTEGRITY FINDING — a control that reported success without doing the thing.**
`brokerages.auto_provision_phone_numbers` is a live toggle on
`app/dashboard/admin/phone-settings/`, and the UI tells the broker auto-provisioning is
"ON". A grep for every reader of that column across the whole tree returns **only its own
getter, its own setter, and the UI label** — *nothing anywhere provisioned anything*. The
brokerage could switch it on, be told new agents get numbers automatically, and no agent
ever got one. This is precisely the defect class the audit exists to remove.

**AUTO lane wired** in `app/actions/agents.ts:createAgent` (the tenant-facing, broker-gated
agent creation path, and the exact trigger the module header describes: "When an agent is
added…"):
- runs **only** when the flag reads back `true` — it buys a real Twilio number and bills
  the tenant, so a refused settings read skips provisioning and *says so* rather than
  guessing in either direction;
- **best effort** — the `agents` row is already committed and is the point of the action, so
  a provisioning failure is reported, never allowed to reverse or fail the creation;
- `autoProvisionAgentPhone` re-derives the caller's own context and role, so **no identity
  is forged** and the target agent's tenancy is re-checked;
- imported with the dynamic `await import(...)` form at the call site (lesson 2).

`createAgent`'s return gained an additive optional `phoneProvisioning`. Its **single** caller,
`app/dashboard/admin/users/create-agent-record-button.tsx`, was re-checked and updated: a
provisioning error keeps the dialog open with an amber note instead of reporting a clean
success. The existing `people-vendor-education-wiring-simulator` invariants on `createAgent`
(no caller-supplied tenant, tenant stamped at the insert, service client, role gate,
target-tenancy check) are all untouched — the new block sits after the insert and never
reads `agentData.brokerage_id`.

**MANUAL lane wired**: new `app/dashboard/admin/phone-settings/agent-port-in-card.tsx` —
the "bring your own / port-in, bind it to an agent" surface the module header describes and
that did not exist anywhere. The page supplies the agent roster via `getAgents()` on the
**cookie** client, so RLS (`agents_read_brokerage`, verified live) scopes it to the caller's
brokerage; the page never names a tenant, and the action re-checks tenancy regardless. Agent
names come from `user.name / user.email` — `agents` has no `first_name/last_name/email`
(lesson 3). The card renders the action's collision and ownership refusals verbatim and
surfaces `bindNote` when the number saved but the AI-lane bind did not.

Call sites changed: `app/actions/agents.ts`,
`app/dashboard/admin/users/create-agent-record-button.tsx`,
`app/dashboard/admin/phone-settings/page.tsx`. New file: `agent-port-in-card.tsx`.

---

### `app/actions/content-generation-engine.ts` — `generateAudio`, `generateFromURL`, `getGenerationHistory`, `getGenerationStats` → **ALL FOUR WIRED (AI SPEND)**

Not duplicates. `docs/content-generation-audit.md` and
`lib/kernel/manager-registry.ts:content_lane_ledger` already establish there is no
file-level loser between this module and `ai-content-generation.tsx`. All four orphans are
gated identically to their four already-wired siblings (`resolveAuthorizedAgentId`, which
resolves `agents.id` from session and keeps `agent_id` / `agent_user_id` in their separate
id spaces — lesson 8).

The module's live consumers are `app/components/features/education/EducationEditor.tsx`
(`generateText`, `generateVideo`) and the blog editor (`generateOmnipresent`,
`generateVariations`). The education editor is where all four belong, and all four went
there:

- **`generateAudio`** → a new "Podcast Script" format. `learning_modules.channels` already
  carries a `podcast` value (the learning-modules console offers it), so
  `lib/kernel/education.ts:createEducationalResource` gained `"podcast"` in its
  `contentType` union and its channel switch — **additive**: no existing caller passes it,
  and the switch already had a default. A podcast script is therefore saved on the podcast
  channel rather than mislabelled as an article. Live check: `learning_modules` has **no
  CHECK constraint** on channels (only `status`), so the value cannot be rejected.
- **`generateFromURL`** → a "Repurpose from a URL" format with a source-URL field.
- **`getGenerationHistory` + `getGenerationStats`** → an "Your AI generations" ledger under
  the generate button (totals, per-content-type counts, last 10 generations), refreshed
  after every generation. Every button on that tab spends AI budget and there was no way to
  see what it had been spent on.

**Correctness finding fixed in `lib/content-generation/generation-logger.ts`** (the module
behind both reads): `getContentGenerationHistory` returned `[]` and
`getContentGenerationStats` returned all-zeros on a **refused** query — the stats function's
own comment said "A REFUSED read is not 'no rows'. Say so instead of returning silent
zeros" and the very next line returned silent zeros. Harmless while nothing rendered them;
the moment I rendered them it becomes "your AI spend was zero", a claim. Both now throw.
**Failure-convention change re-checked (lesson 7):** grepped the whole tree — the *only*
caller of either is `content-generation-engine.ts`, whose two wrappers already sit inside
`try/catch → handleError`, so the throw surfaces as `{ success: false, error }`, which the
new panel renders instead of showing zeros.

The history rows are `activities` rows (`title / activity_type / completed_at`), **not**
`content_type / created_at` — the panel reads the real shape.

Call sites changed: `app/components/features/education/EducationEditor.tsx`,
`lib/kernel/education.ts`, `app/actions/education-kernel.ts`,
`lib/content-generation/generation-logger.ts`.

---

### `app/actions/seller-showing-sentiment.ts` — `getShowingSentimentSummaryAction` → **WIRED**

Not a duplicate — it is the gated, session-scoped twin of the ungated
`buildShowingSentimentSummary` that `app/api/cron/seller-updates/route.ts` calls. That
split is exactly right (lesson 1: the unattended caller has its OWN door onto the library
function; it is not made to fake a session). The module's own header says the summary is
"triggered by the seller-updates cron (Mondays 8am) **and on-demand from the listing detail
page**" — only the cron half existed.

**Wired:** new `app/dashboard/listings/[id]/showings/seller-sentiment-panel.tsx`, rendered
on `app/dashboard/listings/[id]/showings/page.tsx`. Deliberately **button-triggered, not
loaded with the page** — the summary runs an LLM theme extraction, and firing it on every
render would spend AI budget on an agent who only wanted the showings list. The action's
`unauthorized` / `forbidden` / `not_found` refusals are rendered as words; an empty summary
is never shown in their place, and a genuine zero-feedback window says so explicitly rather
than letting empty ratings read as bad ones.

Call sites changed: `app/dashboard/listings/[id]/showings/page.tsx`. New file:
`seller-sentiment-panel.tsx`.

---

### `app/actions/showings.ts` — `updateShowingStatus` → **DELETED (duplicate), capabilities merged first**

**This is a duplicate**, established by reading all four candidates. Survivors — all
session-gated (`requireCaller`), all listing-tenancy-checked, all already wired to
`app/components/dashboard/listings/showings/showing-requests-panel.tsx`:

| status | survivor |
|---|---|
| `approved` | `app/actions/seller-showings.ts:approveShowingRequest` |
| `denied` | `app/actions/seller-showings.ts:denyShowingRequest` |
| `needs_reschedule` | `app/actions/seller-showings.ts:suggestAlternativeTime` |
| `cancelled` | `app/actions/showings.ts:cancelShowing` |

Its doc block claimed two unique capabilities. Both checked, both rejected:
- *"the `seller_approved` / `seller_approved_at` stamping … nothing else writes those
  columns"* — **false**. `approveShowingRequest` has always written both. A comment is not
  evidence (the mirror of lesson 6).
- the `pending` status, which no survivor offers. **Not ported** — reverting an approved
  request to pending would leave the `showings` row, `converted_showing_id`, the
  `lifecycle_events` row and the fired `SHOWING_SCHEDULED` event untouched. A badly
  implemented extra, so the class was fixed at the survivor rather than the implementation
  copied.

The loser was in fact the weakest of the four: **no authentication check at all**, no
listing-tenancy check, no `revalidatePath`, and none of the approve-path side effects. (Live
RLS on `showing_requests` is `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`;
the `IS NULL` escape hatch is unreachable because `showing_requests.brokerage_id` is
**NOT NULL** — verified — so an anonymous hit matched nothing. Intra-tenant, though, RLS was
the only thing standing between any signed-in user and any showing verdict.)

**MERGED ONTO THE SURVIVORS BEFORE DELETING** — the one thing the loser genuinely had was
the `.select()` + zero-row refusal:
1. `approveShowingRequest`'s status update was a bare `await` with **no `error` destructure
   and no `.select()`**, and the code then went on to INSERT a real `showings` row, stamp
   `converted_showing_id`, write a `lifecycle_events` row and fire `SHOWING_SCHEDULED` — for
   an approval that may never have been recorded. It now refuses before any of that.
2. `denyShowingRequest` had the same silent-write shape (a refused update returned
   `{ success: true }`). Fixed.
3. `suggestAlternativeTime` gained the loser's `status: "needs_reschedule"` write. It used to
   write only `alternative_times` and leave `status = 'pending'`, so a request whose times
   the agent had already re-proposed stayed in the "awaiting your decision" queue that
   `getShowingRequests` builds (`.eq("status","pending")`) and was put in front of them again
   on every visit. Live-verified against `showing_requests_status_check`
   (`pending|approved|needs_reschedule|denied|cancelled`).

**Call sites re-checked (lesson 7).** All three survivors have exactly one caller,
`showing-requests-panel.tsx`, and every handler there was `if (res.success) { … }` with **no
`else`** — a refusal left the modal open with no explanation. All three now surface the
error, and the suggest handler drops the request from the pending list to match its new
status.

Files changed: `app/actions/showings.ts` (deletion + a tombstone recording the above),
`app/actions/seller-showings.ts`, `app/components/dashboard/listings/showings/showing-requests-panel.tsx`.

---

### `app/actions/compliance-bridge-actions.ts` — `emitCompliancePassedAction`, `loadComplianceBridgeStatusAction` → **GUARD FALSE POSITIVES — already live. No change.**

Both are called, from a rendered surface, today:
`app/dashboard/listings/[id]/offers/components/compliance-bridge-panel.tsx` →
`runEmitCompliancePassed` / `reloadBridgeStatus` → `handleMarkCompliance()` → the "Mark
compliance passed" button, and the panel is mounted by
`app/dashboard/listings/[id]/offers/offers-manager-client.tsx:601`.

**Why the guard missed them:** the panel imports them via **`await import(...)`** (a
deliberate choice — it keeps the server-only kernel/compliance chains out of the client
bundle), and the guard's static resolver does not follow dynamic imports. The sibling
`acceptOfferConditionallyAction` is imported exactly the same way and is *not* flagged, only
because its name also appears statically in `lib/voice/deal-decision.ts` and
`scripts/voice-command-coverage-simulator.ts`.

This is lesson 6 in its literal form — I confirmed with a second, differently-shaped search
(filename-based grep for the module path, then reading the panel and its mount point) before
touching anything. **Nothing changed.** Both are correctly gated (`resolveCaller`,
staff-role check on the manual override, and offer-brokerage equality on both). Worth
recording for the guard's baseline: `--list` category C is not proof of deadness for any
export reached only through `await import(...)`.

---

### `app/actions/onboarding-decisions.ts` — `getOnboardingDecisionsAction` → **MERGED then WIRED**

Not a file-level duplicate, but it WAS a thinner copy of what
`app/components/onboarding/setup-readiness-card.tsx` does inline: that server card runs
`loadOnboardingDecisionFacts → composeOnboardingDecisions → **attachLessons**`, while the
action stopped at `composeOnboardingDecisions`. **Merged first**: the action now runs
`attachLessons(…, facts.moduleIdByTopic ?? new Map())` too, so its output is shape-identical
to what the page renders. Without that merge, wiring it would have silently dropped every
`/academy/module/…` lesson link from the rendered list.

**Wired** into `app/components/onboarding/decision-room.tsx`. After a successful
`adoptAssistantIdentityAction`, the component used to hand-write a `state: "done"` card with
a **locally authored evidence string** — a claim about server state that nothing verified,
and one that only ever patched a single decision even though adopting the assistant identity
can settle more than one. It now re-reads the real list; the optimistic patch survives only
as the fallback for a refused re-read (where it is at least truthful about the one act just
performed).

Call sites changed: `app/components/onboarding/decision-room.tsx`,
`app/actions/onboarding-decisions.ts`.

---

### `app/actions/superadmin/platform-providers.ts` — `getPlatformProvidersAction` → **WIRED**

Not a duplicate: `app/dashboard/superadmin/platform/page.tsx` imports
`getPlatformProviderConfig` / `PLATFORM_PROVIDER_SPEC` from the lib directly (correct for a
server component that is already superadmin-gated); the action is the **client-callable**,
superadmin-gated door with no client caller.

**Wired** into `app/dashboard/superadmin/platform/platform-providers-panel.tsx`. Those
switches decide whether the platform-funded channels (Lob direct mail, D-ID video) run for
**every tenant**, and the panel was purely optimistic — flip the switch, keep the local
value. A superadmin could walk away believing direct mail was off platform-wide when the
override had not landed as expected. The toggle now re-reads the real state after a
successful write; a refused re-read keeps the optimistic value and *says* it could not be
confirmed rather than silently reverting to a value we cannot verify either.

**Noted, not changed:** the page's own gate is `user_type === "superadmin"` while the
action's is `user_type === 'superadmin' || platform_role === 'superadmin'`. The page is the
*stricter* of the two, so this is a UX inconsistency (a `platform_role` superadmin can write
but cannot reach the page), not a hole. Left alone — widening a page gate is not this
slice's call.

Call sites changed: `app/dashboard/superadmin/platform/platform-providers-panel.tsx`.

---

### `app/actions/admin/invitations.ts` — `markBrokerageSetupCompleteAction` → **WIRED (unreachable state made reachable)**

Not a duplicate. **This was the only writer of
`brokerages.onboarding_status = 'completed'` in the tree**, and it had no caller — so the
brokerage onboarding state machine could move `pending → in_progress` (automatically, on the
first invited user's first login, via `acceptUserInvitationOnFirstLogin`) and **never any
further**. Every real tenant sat at `in_progress` permanently, including in the superadmin
brokerage console that renders that column
(`app/actions/superadmin/brokerage-management.ts:143`) and in the
`v_brokerage_onboarding_progress` view. Confirmed by grepping every writer of
`advanceBrokerageOnboarding` (two: this action, and the automatic `in_progress` bump).

**Wired:** new `app/dashboard/admin/users/invitations/setup-complete-card.tsx` on the
invitations page — the admin's onboarding hub, already showing who was invited and who
landed. The card takes the status the state machine **returns**, not a hard-coded
"completed" (the RPC decides which transition is legal), surfaces the action's role refusal
verbatim, and never flips the badge on a write that did not happen. Its status vocabulary is
live-verified against the `brokerages` CHECK
(`pending | in_progress | completed | abandoned`).

Call sites changed: `app/dashboard/admin/users/invitations/page.tsx`. New file:
`setup-complete-card.tsx`.

---

### `app/actions/blog-cadence-policy.ts` — `getMyBlogCadencePolicy` → **WIRED**

Not deleted. `app/settings/blog-cadence/page.tsx` reads `blog_cadence_policy` inline on the
service client across all three scopes (agent/team/brokerage) plus the newsletter and social
mirrors — a strictly richer read, but a **server-component** one. `getMyBlogCadencePolicy` is
the agent-scoped, session-gated, **client-callable** door, and had no client caller.

**Wired** into `app/dashboard/marketing/blog/blog-dashboard-client.tsx` as a cadence line
under the page title: what (if anything) is scheduled to auto-publish, and a link to change
it. Before this, the only place a cadence appeared was a settings page you had to already
know existed, so an agent on the blog dashboard could not tell whether the cadence cron was
going to publish for them at all. **A refused read renders nothing** rather than "no cadence
set" — a failure to check is not evidence that nothing is scheduled.

Call sites changed: `app/dashboard/marketing/blog/blog-dashboard-client.tsx`.

---

### `app/actions/superadmin/deal-room-demo.ts` — `getDealRoomDemoStatusAction` → **WIRED (read gate tightened)**

Earlier-wave note **verified and acted on as recorded**: this is a thin wrapper over
`lib/platform/deal-room-demo.ts:getDealRoomDemoStatus`, and the wrapper's `requirePlatformCapability("tenants")`
gate is real and is the thing the page did not apply.

Confirmed by reading both: `app/dashboard/superadmin/demo-room/page.tsx` called the **raw
library read**, which applies no capability check at all — so the superadmin layout's
"platform staff" gate was the entire boundary on the read, while **both mutations on the same
page** require `requirePlatformCapability("tenants")`. A staff member without the `tenants`
capability could see the demo tenant's brokerage id and name, the lead id and the contact id,
and was shown Seed / Tear down buttons that would then refuse.

**Not deleted — wired**, exactly as the earlier wave recorded. The page now reads through the
action, so read and write agree on the same capability. A refusal renders an explicit "Deal
Room demo unavailable — needs the platform `tenants` capability" message; it does **not** fall
through to an empty runbook, which would have read as "the demo is not seeded".

Call sites changed: `app/dashboard/superadmin/demo-room/page.tsx`.

---

### `app/actions/income-engine.ts` — `completeRecommendedActionAction`, `dismissRecommendedActionAction` → **WIRED + silent writes fixed**

Not duplicates — they are the **only writers** of
`income_gap_recommended_actions.status` other than the generator's `open`. With no caller,
the ranked action queue on `/dashboard/income-truth` was purely advisory: an agent who had
actually done the work had no way to say so, the same recommendation returned every week,
and `completed_outcome` — which the module's own header describes as "records outcome for
future tuning" — was never written by anyone, so the tuning loop had no input at all.

**Silent-write fixed in both:** each `.update()` had no `.select()`, so an `actionId`
belonging to a **different agent** matched zero rows, returned `error === null`, and was
reported as `{ ok: true }`. Both now `.select("id")` and refuse a zero-row update.

**Wired:** new `app/dashboard/income-truth/action-disposition.tsx` (Done / dismiss on each
row). Status vocabulary live-verified against
`income_gap_recommended_actions_status_check` (`open | in_progress | completed | dismissed | expired`).

Call sites changed: `app/dashboard/income-truth/page.tsx`, `app/actions/income-engine.ts`.
New file: `action-disposition.tsx`.

---

### `app/actions/portal-stream.ts` — `triggerPortalProjectionAction` → **SECURITY FINDING (high): privilege escalation. GATED.**

**The endpoint authenticated the caller and authorised nothing.** Its only check was
`auth.getUser()`, and it then made a server-side `fetch` carrying **`CRON_SECRET`** in an
`Authorization: Bearer` header to `/api/cron/portal-stream-projector`. Any signed-in user of
any tenant — an agent, an invited assistant, a portal contact with a login — could make the
platform run a projection pass over every tenant's `lifecycle_events`, on demand, as often
as they liked. The secret itself was never disclosed, but **the capability it guards was**,
which is the same thing. The cron route's own header already calls the on-demand path "admin
on-demand reprojection"; the action simply did not implement that.

**Fixed:** brokerage admin / broker / platform staff only, resolved from `users.user_type`
(**not** `users.role` — retired, 19 of 23 live rows NULL, so a role filter would have matched
nobody and turned the gate into a hard block; lesson 5). The gate **fails closed**: the
profile read destructures `error` and a refused read is a refusal, not a pass (lesson 4).
Live `user_type` values confirmed against the database (`agent`, `contact`, `admin`,
`vendor`, `system`, `lender`, `broker`, `tc`, `compliance_officer`, `team_lead` — all
lowercase, so the allow-list matches real data).

Left unwired deliberately: there is no admin surface that should re-run the projector today,
and inventing one is not what closes this hole. The gate is the fix.

---

### `app/actions/contact-details.ts` — `getContactCopilotSuggestions` → **WIRED + error swallow fixed**

Not a duplicate. It is the **only reader** of `smart_assistant_suggestions` filtered to a
contact, so every suggestion the OS wrote against a contact sat unseen.

**Wired** into `app/crm/page.tsx` — the contact detail surface, which already loads four
other exports of this same module in the same `Promise.all`. Rendered as a "Suggestions for
this contact" card above the AI Copilot Plan. Field names checked against the live table
(`title`, `description`, `suggestion_type` all exist).

**Fixed:** the brokerage pre-check was `const { data: contact }` with no `error`, so a
refused read produced the same empty result as "not your contact" (lesson 4). Now
destructured and returned. Left as-is (recorded, not changed): the `!agentId` branch returns
an empty list for a broker/admin with no `agents` row — correct for a service-client read
that scopes on `agent_id`, but it means the card never appears for those seats. Changing that
means deciding what a broker should see in an agent-scoped queue, which is a product call
outside this slice.

Call sites changed: `app/crm/page.tsx`, `app/actions/contact-details.ts`.

---

### `app/actions/open-house-automation.ts` — `handleRSVP`, `submitFeedback` → **SECURITY FINDING (high): untenanted writes on a world-open RLS policy. HARDENED. Not wired.**

Not duplicates. Both are **deliberately unauthenticated** — they are the endpoints behind an
RSVP link and a feedback form that a *logged-out invitee* clicks from an email. A session gate
here would break exactly the caller they exist for (lesson 1), so no gate was added.

**What was actually wrong (verified live, project `hrvaqgvukzxfskkcrwbt`):** all four open-house
tables — `open_house_invitations`, `open_house_attendees`, `open_house_feedback`,
`open_house_rsvp_tracking` — carry the RLS policy
`brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`, **and `brokerage_id` is
NULLABLE on every one of them** (`information_schema.columns`). Under that policy a row with a
NULL tenant is readable *and writable* by every user of every tenant, and by anonymous callers.

- `handleRSVP`'s `open_house_rsvp_tracking` insert **omitted `brokerage_id` entirely**, so every
  row it ever wrote was permanently world-open. It now stamps the tenant resolved from the
  invitation, and refuses when there is none rather than writing a world-open row.
- `submitFeedback` wrote `brokerage_id: attendee.brokerage_id ?? null` — the same defect
  whenever the attendee row had drifted untenanted. `open_house_feedback` holds a buyer's
  **price opinion, their stated concerns, and their contact link**, so a null-tenant row there
  is a real disclosure. It now falls back to the event's brokerage and **refuses** if neither
  resolves.
- `handleRSVP` also accepted any (`eventId`, `invitationId`) pair without checking they belong
  together; two ids from different brokerages could be combined into one tracking row. Now
  checked.

**Reported-success-without-doing-the-thing, fixed in both.** Every write in both functions was a
bare `await` with no `error` destructure, and both reads were `const { data }` with no `error`
(lesson 4) — so an RLS refusal produced the same result as a bad id, and the invitee was
returned *"Great! We look forward to seeing you. Calendar invite sent to your email."* for an
RSVP that was never recorded. All reads now destructure `error`, all writes are checked, and the
attendee update uses `.select("id")` with a zero-row refusal.

**Left, with reasoning:** the remaining exposure is that both endpoints authorise on a
*guessable* id alone. The correct fix is an unguessable per-invitation capability token minted
at send time and carried in the RSVP/feedback link, checked here — the same shape as the
`LOB_WEBHOOK_SECRET` door on `trackDelivery`. That needs a schema column
(`open_house_invitations.rsvp_token`) plus a change to every sender that builds those links, so
it is a migration-bearing change beyond this slice. Recorded here as the precise next step. Not
wired to a surface: there is no RSVP/feedback page in the tree today, so the endpoints stay
unreferenced until that page is built — hardened, not wired, is the honest outcome.

---

## NOT REACHED

Depth was chosen over coverage, per the brief. These 15 files (21 orphaned exports) were
**not analysed** in this slice beyond the triage pass. Every one of them has an auth
primitive somewhere in its module (the zero-auth bucket was cleared first), so none is in
the known-worst class — but that is triage, not a verdict:

| file | orphaned exports |
|---|---|
| `app/actions/ai-lead-nurturing.ts` | `aiCalculateLeadScore`, `aiGenerateDripCampaign`, `aiPredictConversion` |
| `app/actions/calculators.ts` | `calculateHomeValue`, `emailCalculationResults`, `getSavedCalculations` |
| `app/actions/activities.ts` | `getAgentActivities`, `getPendingFollowups` |
| `app/actions/ai-market-intelligence.ts` | `getMarketAlerts`, `predictPropertyPrice` |
| `app/actions/ai-vendor-management.ts` | `coordinateVendors`, `requestVendorReview` |
| `app/actions/lifetime-customer-touchpoints.ts` | `getLifetimeCustomerContacts`, `getTouchpointCalendar` |
| `app/actions/link-to-video.ts` | `generateSocialCaption`, `getVideoDetails` |
| `app/actions/ai-calendar-management.ts` | `createDeadlineEventsFromMilestones` |
| `app/actions/ai-content-generation.tsx` | `saveDescriptionToListing` |
| `app/actions/ai-predictions.ts` | `getLeadPredictions` |
| `app/actions/buyer-offer/handle-multi-offer.ts` | `checkDuplicateOffer` |
| `app/actions/creative-playbooks.ts` | `listCreativePlaybooks` |
| `app/actions/lead-management.ts` | `getLead` |
| `app/actions/marketing-intelligence.ts` | `getCompetitorPostInspiration` |
| `app/actions/transaction-stage-machine.ts` | `getTransactionStageInfo` |
| `app/actions/user-profile.ts` | `getAgentEmailSignature` |
| `app/actions/social/generate-social-post.ts` | `stampPostBrandCompliance` |
| `app/actions/portal-lifetime.ts` | `setLifetimeSegment` |
| `app/actions/portal-stream.ts` | `getAgentPortalStream` (its sibling `triggerPortalProjectionAction` WAS done) |

Partial reads made along the way, recorded so the next pass does not repeat them:

- **`app/actions/calculators.ts:emailCalculationResults`** — already hardened by an earlier
  wave (visitor-secret scoping, `error` destructured, the send destination pinned to the
  address on the record so the caller can never redirect it, and a previously-wrong column
  read that rendered "Your undefined Results" already fixed). Looks like a wiring job, not a
  hardening one.
- **`app/actions/portal-lifetime.ts:setLifetimeSegment`** — gated by `requireContactAccess`
  and explicitly refuses `isContactSelf`, so a client cannot reclassify their own segment.
  Its `.update()` has no `.select()`, so it is very likely the same zero-row silent-write
  class fixed five times in this slice. Wiring target: the staff-side lifetime portal
  controls.
- **`app/actions/activities.ts`** (`getAgentActivities`, `getPendingFollowups`) — both gated
  by `resolveOwnAgentId` and both destructure `error` correctly. Reads looking for a surface.
- **`app/actions/creative-playbooks.ts:listCreativePlaybooks`** — a pure projection of the
  static `CREATIVE_PLAYBOOKS` constant with no gate and no IO, and
  `app/settings/campaign-bundles/client.tsx` **already imports that constant directly**
  (it is client-safe and pure). This is the strongest deletion candidate left in the slice;
  survivor `lib/marketing/creative-playbooks.ts:CREATIVE_PLAYBOOKS` (a const, not a
  function). Not deleted here because I did not read every field it projects.
- **`app/actions/marketing-intelligence.ts:getCompetitorPostInspiration`** — gated
  (`getAgentContext` + `brokerage_id` predicate), builds a brand-safe "do not copy the
  original" prompt from `competitor_content`. Clear wiring target: the content studio's
  generate flow.
- **`app/actions/user-profile.ts:getAgentEmailSignature`** — already hardened by an earlier
  wave (the empty-string `userId` → `22P02` case is closed and `error` is destructured).
  Wiring target: any email composer that should append the agent's signature.

## GUARD NOTE

`scripts/orphan-export-guard.ts --list` category C means "no **static** reference". It does
**not** follow `await import(...)`. Two exports in this slice
(`compliance-bridge-actions.ts:emitCompliancePassedAction`,
`loadComplianceBridgeStatusAction`) are live, rendered, and reached only that way. Anything
in the C list that is imported dynamically needs a second, differently-shaped search before
it is touched.
