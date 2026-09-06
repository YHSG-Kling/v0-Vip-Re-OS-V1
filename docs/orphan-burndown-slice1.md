# Orphan burndown — slice 1 (`"use server"` action modules)

Working notes. Appended as each export is finished. Method: (a) duplicate? →
merge-then-delete naming the survivor; (b) not a duplicate? → wire it, or record
exactly what finishing needs, and leave the code. Never delete to move a number.

**Scope constraint on this slice:** I may only WRITE the files listed in my slice
(the orphan-bearing action modules themselves) plus this notes file. Consumer
surfaces (pages, components, route handlers) belong to nobody's slice and were
NOT edited. So "wire it" verdicts below are recorded as a precise wiring
instruction naming the consumer file and the call site, not as a code change.
In-file fixes (adding auth, closing fail-open gates, un-exporting internal
helpers) were made where warranted, since those are inside my files.

---

## SECURITY FINDINGS (read this section first)

_(populated as found — see per-export entries below for detail)_

---

## Per-export ledger

### `app/actions/auth.ts:loginUser` — **WIRE IT (unwired safety gate; instruction recorded)**

Not a duplicate in the sense that matters. The nominal survivor is
`app/login/page.tsx` → `supabase.auth.signInWithPassword` called **client-side**.
`loginUser` does the same sign-in **plus** `rejectIfSuspended()` — a service-role
read of `users.status` that signs a `'suspended'` user back out.

`rejectIfSuspended` appears in exactly two places in the repo, both in this file:
`loginUser` (orphaned) and `handleAuthCallback` (wired, via
`app/auth/callback/route.ts`). There is **no `middleware.ts` in this repo** — I
checked; it does not exist — and no other `users.status === 'suspended'` read on
any request path. `app/settings/users/users-management-client.tsx` only *writes*
the flag.

**Therefore: deactivating a user does not stop them logging in with a password.**
SSO and magic-link go through `/auth/callback` and ARE gated. Password login is
not. This is the single highest-value item in my slice, and it is a *missing
wire*, not dead code — deleting `loginUser` would delete the only enforcement of
the offboarding rail on the password path.

Wiring instruction (consumer file, outside my slice — NOT edited):
in `app/login/page.tsx`, `handlePasswordLogin` should call
`loginUser(email, password)` instead of the browser client, then
`router.refresh()` + `router.push('/dashboard')`.
Verified safe: `@supabase/ssr@0.8.0` `createServerClient` hard-forces
`persistSession: true` and cookie storage
(`node_modules/@supabase/ssr/dist/main/createServerClient.js:34`) regardless of
the `persistSession: false` passed in `lib/supabase/server.ts`, so the server
action writes the same cookies `lib/supabase/client.ts`'s `createBrowserClient`
reads. The already-wired `signOut()` proves the cookie round trip works.

### `app/actions/auth.ts:registerUser` — **LEFT, flagged (see security findings)**

Survivor for real signup: `app/actions/auth/signup-brokerage.ts:signupBrokerageAction`
(tenant provisioning — brokerage, tier, coupon, starter assistant). `registerUser`
is a bare `supabase.auth.signUp` with first/last name and **no brokerage, no tier,
no tenant**. It has no callers and creates an auth user that belongs to no tenant.

Not merged-and-deleted, because I could not establish it is dead: it is the
generic self-serve register primitive and Supabase's own signup settings (email
confirmation, allow-signups) govern it. But it is a **publicly reachable
account-creation endpoint on the tenant product** with no invite check and no
rate limit of its own. Owner decision: if self-serve registration outside
`/get-started` is not a product, delete it; if it is, it needs to route through
`signupBrokerageAction`'s provisioning.

### `app/actions/auth.ts:getCurrentUser` — **LEFT (thin, harmless, but redundant)**

Duplicate of `supabase.auth.getUser()` with the shape narrowed to `{id, email}`.
Survivor: any caller's own `createClient()` + `auth.getUser()`, and for the
domain-aware version `lib/kernel/identity.ts:resolveWriteContext`. It has no
extra capability to merge. It is authenticated by construction and returns only
the caller's own id/email, so it is not a security finding. Left because it is a
2-line convenience with zero risk and no owner signal either way; if the census
wants it gone, it is a clean delete with nothing to merge — survivor is
`lib/kernel/identity.ts:resolveWriteContext`.

---

### `app/actions/phone-provisioning.ts:autoProvisionAgentPhone` — **FIXED IN PLACE (cross-tenant write)**
### `app/actions/phone-provisioning.ts:manuallyAddAgentPhone` — **FIXED IN PLACE (cross-tenant write)**

Neither is a duplicate. `lib/kernel/manager-registry.ts:491` names
`autoProvisionAgentPhone` as *the* tenant purchase path that turns
`enforceTenantAllowance` on. `manuallyAddAgentPhone` is the only BYO / port-in
insert in the repo. The nearest sibling, `purchaseBrokerageNumberAction`
(wired), takes an explicit `phoneNumber` from a search — different lane.

**Defect found and fixed.** Both took `params.agentId` from the caller and
resolved it with `svc.from("agents").select("user_id").eq("id", params.agentId)`
— service client, RLS bypassed, **no brokerage check** — then wrote rows stamped
with the *caller's* `ctx.brokerageId`. The survivor in the same file,
`purchaseBrokerageNumberAction`, already does the right thing
(`if (agent.brokerage_id !== ctx.brokerageId) return ...`). So this is the
worked-example shape: the capability is real, the implementation was defective,
and the fix is the class fix already proven next door.

Impact before the fix (both callers are authenticated broker/admin, so this is
cross-tenant, not anonymous):
- `autoProvisionAgentPhone` — buy a Twilio number on tenant A's bill and bind
  it to an agent of tenant B, taking over that agent's inbound call routing.
- `manuallyAddAgentPhone` — worse: the statement right after the resolve
  deactivates the target agent's existing active number, so tenant A can cut
  another tenant's agent line dead and re-point it at a number A controls.

Ported onto both: `select("user_id, brokerage_id")`, an explicit `agentErr`
destructure that refuses rather than falling through on a refused read, and the
`brokerage_id !== ctx.brokerageId` refusal. Still unwired — see below.

Remaining wiring (consumer outside my slice): `app/dashboard/admin/phone-settings/page.tsx`
already imports `getBrokeragePhoneSettings` and `getPhoneAllowanceStatusAction`
from this file, so the surface exists; it needs the auto-provision toggle to call
`autoProvisionAgentPhone` on agent-add, and an "Add existing number" control
bound to `manuallyAddAgentPhone`.

---

### `app/actions/vendor-payments.ts:completeStripeConnectOnboarding` — **WIRE IT (broken round trip)**

Not a duplicate — it is the *return half* of a flow whose first half is wired.
`initiateStripeConnectOnboarding` (wired, from `app/vendor/earnings/stripe-connect.tsx`)
sets `return_url: ${appUrl}/vendor/settings?stripe=complete`. `app/vendor/settings/page.tsx`
exists but **nothing anywhere in `app/` reads a `stripe=` search param** (grepped).
So a vendor completes Stripe onboarding, is redirected back, and
`setVendorStripeOnboarding` is never called — `onboarding_complete` stays false
and payouts stay blocked forever.

Properly authenticated: `requireVendorActor(vendorId)` before anything, then
`stripe.accounts.retrieve` to confirm `details_submitted && charges_enabled`
before flipping the flag. No fix needed in-file.

Wiring instruction: `app/vendor/settings/page.tsx` should, when
`searchParams.stripe === 'complete'`, call
`completeStripeConnectOnboarding(vendorId)` and render the result.

### `app/actions/vendor-payments.ts:markInvoicePaid` — **LEFT, unwired-by-design gap recorded**

Not a duplicate. `lib/vendors/premium-placement.ts:159-169` documents it by name
as the writer that mints the `vendor_earnings` payout claim, and encodes a real
invariant against it (`billed_to: 'vendor'` must NOT mint earnings — the orphan
honours this at the top of its earnings block). Nothing else in the repo marks a
`vendor_invoices` row paid; `app/api/billing/webhook/route.ts:120` is the
*subscription* invoice lane, a different table.

Authentication and tenant scope are already correct and heavily commented
(`resolveWriteContext` → `verifyInvoiceInCallerBrokerage`); a prior pass clearly
hardened this file. Left as-is.

Wiring instruction: `app/dashboard/vendors/vendor-charges-panel.tsx` (or
`app/vendor/invoices/page.tsx`) needs a "Mark paid" control. Until then the
brokerage side of vendor billing has no way to settle an invoice, so
`vendor_earnings` never reaches `available` and `initiateVendorPayout` has
nothing to pay out — the whole vendor payout rail is inert.

---

### `app/actions/superadmin/platform-providers.ts:getPlatformProvidersAction` — **LEFT (client-refresh half of a server-rendered page)**
### `app/actions/superadmin/deal-room-demo.ts:getDealRoomDemoStatusAction` — **LEFT (same shape)**
### `app/actions/superadmin/connector-healing.ts:listPendingProposalsAction` — **LEFT (same shape)**
### `app/actions/superadmin/connector-healing.ts:listRecentProposalsAction` — **LEFT (same shape)**

All four are read-only and all four ARE gated — my first-pass regex missed them
because each file defines its own local gate helper:
`requireSuperadmin()` (platform-providers), `requirePlatformCapability("tenants")`
(deal-room-demo), `assertPlatformStaff()` → `isPlatformStaff` (connector-healing).
**No security finding here.**

They are orphaned because in each case the *page* is a server component that
calls the underlying library function directly and skips the action wrapper:
`app/dashboard/superadmin/platform/page.tsx` → `getPlatformProviderConfig`,
`app/dashboard/superadmin/demo-room/page.tsx` → `getDealRoomDemoStatus`,
and the connector-healing page queries its table directly. The sibling *mutations*
in each file (`setPlatformProviderAction`, `seedDealRoomDemoAction`,
`approveProposalAction`) ARE imported by the client panels.

So the pattern is consistent and deliberate: initial paint server-side, mutation
via action. What is missing is the *re-read after mutation* — each client panel
currently has no way to refresh without a full navigation. These are the refresh
path. Left in place; finishing them is a one-line `await getXAction()` in the
respective client panel after a successful mutation. Not worth owner time now.

---

### `app/actions/calculators.ts:emailCalculationResults` — **FIXED IN PLACE (open email relay + PII exfiltration)**

**This was the worst thing I found.** Not a duplicate — nothing else emails a
saved calculation. It is a `"use server"` export, therefore a reachable HTTP
endpoint, and it had **no authentication of any kind**:

```
emailCalculationResults({ calculationId, recipientEmail })
  → select * from saved_calculations where id = <caller-supplied>
  → sendCalculatorResults({ email: <caller-supplied>, ...row })
```

Two live consequences:

1. **Open email relay.** Any anonymous caller sends mail from the platform's
   sending domain to any address they name, carrying content they influence.
   Sender-reputation / deliverability incident, and a phishing vector wearing
   the brokerage's From:.
2. **PII exfiltration.** `saved_calculations` carries `user_email` and
   `user_name`.

**RLS does not save it — I checked the live database rather than assuming.**
The SELECT policy on `public.saved_calculations` is
`is_platform_admin() OR (brokerage_id IS NULL) OR has_brokerage_access(brokerage_id)`,
and `saveCalculation()` in this same file **never sets `brokerage_id`**. So the
middle clause is true for every row in the table and the whole table is
anon-readable. Column list and policy verified against project
`hrvaqgvukzxfskkcrwbt`.

Fix (keeps the lane public — requiring login would defeat a lead-magnet
calculator — but removes both primitives):
- the row is now fetched scoped by `visitorId`, the same opaque per-visitor
  secret `getSavedCalculations` already treats as the retrieval key, and
  `visitorId` is a required parameter;
- the destination is the `user_email` **recorded on the row**, never the
  caller's. A supplied `recipientEmail` is accepted only if it matches, so it
  can no longer redirect the send;
- a row saved with no email cannot be mailed and says so;
- the read now destructures `error` and refuses on a refused read, instead of
  letting a refusal masquerade as "not found".

Signature changed (added required `visitorId`, `recipientEmail` now optional) —
safe precisely because it has no callers.

**Separate DB-level finding for the owner, not fixed here:** the
`brokerage_id IS NULL` clause in `saved_calculations_select` makes that table
anon-readable in full. That is a migration and a policy decision, deliberately
not taken on my own authority.

### `app/actions/calculators.ts:getSavedCalculations` — **LEFT (IDOR by design of the public lane)**

Unauthenticated, takes `visitorId` from the caller and returns that visitor's
saved calculations including `user_email` / `user_name`. Not a duplicate.

Left as-is because the visitor id **is** the lane's retrieval secret — this is
the documented public-calculator contract ("Use your visitor ID to retrieve it
later", `saveCalculation`'s own success message). It is at least scoped, unlike
`emailCalculationResults` was. Worth the owner knowing it exists: the security
of every public calculator row rests entirely on the unguessability of
`generateVisitorId()`, plus the RLS gap above.

### `app/actions/calculators.ts:calculateHomeValue` — **LEFT, flagged; merge target is outside my write scope**

Partial duplicate. Survivor: `app/actions/home-value.ts:submitHomeValueRequest`
— the explicitly-designed public sessionless home-value lane, which resolves the
brokerage from an **agent slug** rather than trusting the caller, captures the
contact, records TCPA consent, issues the portal invite, and then runs the same
`runAiCma` engine via its local `generateAIValuation`.

I did **not** delete it, because the loser carries two things the survivor does
not, and the method says merge first:
- `IDXBrokerClient.searchProperties(address)` and
  `BatchDataClient.searchByAddress(...)` — subject-property fact enrichment the
  survivor never pulls;
- `trackToolUsage({ tool: "home_value", visitorId })` — the anonymous
  tool-usage row every other calculator in this file writes.

The merge target `app/actions/home-value.ts` is not in my slice, so I cannot
perform the merge. Recorded rather than guessed.

**Security note (real, and the reason this one is flagged):** it is
unauthenticated and takes `brokerageId` **from the caller**, and
`home-value.ts:472` states in its own words that `brokerageId` "is what meters
the comp pull against the tenant". So an anonymous caller can name any
brokerage and bill that tenant for an IDX search, a BatchData address lookup and
a full `runAiCma` model run, once per request, with no rate limit. Every other
calculator in this file is public by design but spends nothing; this is the only
one that burns third-party money per call.

---

### `app/actions/content-generation-engine.ts` — all four LEFT, and correctly so

`generateAudio`, `generateFromURL`, `getGenerationHistory`, `getGenerationStats`.
**All four are properly authenticated** (`resolveAuthorizedAgentId()` first
statement; each declares `agent_id?` in its params and comments "ignored —
derived from session"). No security finding. My first-pass regex missed the
local helper name.

There is already an owner-facing audit for this exact file —
`docs/content-generation-audit.md` — which establishes there is no file-level
loser (`content-generation-engine.ts` is a registry-named, guard-enforced Fair
Housing video path; `ai-content-generation.tsx` is a different system) and lists
these four as declared orphans in `scripts/wired-surface-baseline.json` without
reaching a per-export verdict. Verdicts:

- **`getGenerationHistory` / `getGenerationStats` — not duplicates, keep.** Lane A
  persists nothing but a signal row in `activities`; these two are its *only*
  readers. The apparent survivors (`ai-content-generation.tsx:getGeneratedContent`,
  `getContentPerformanceStats`) read Lane B's seven tables — a different ledger.
  Deleting these leaves Lane A's ledger write-only.
- **`generateFromURL` — not a duplicate, keep.** The nearest survivor,
  `ai-content-generation.tsx:repurposeContent`, repurposes from an internal
  `sourceContentId`. This is the only path that ingests an **external URL**.
- **`generateAudio` — overlapping, keep, one real asymmetry recorded.** Survivor
  candidate `app/actions/podcast-generation.ts:generatePodcastScriptDraft` is
  wired and sits inside the full episode lifecycle, but it is topic/keyword
  driven; `generateAudio` is entity-context driven (`gatherContext` over
  listing / contact / transaction, plus duration and target audience). Different
  inputs, so neither subsumes the other.
  **Asymmetry worth the owner's attention:** `generatePodcastScriptDraft` runs
  `applyBrandVoice` on its output and `generateVideo` in this same engine file
  runs the `lib/video/script-compliance.ts` gate that
  `lib/kernel/manager-registry.ts::video_script_compliance` names by file. The
  **audio** path in this engine runs neither. It produces agent-facing marketing
  copy with no Fair Housing or brand-voice check. Not a live risk today because
  it is unwired — but it becomes one the moment it is wired, which is exactly the
  wrong time to notice. Finishing `generateAudio` means adding the gate, not just
  adding a button.

Wiring instruction for all four: `app/components/features/education/EducationEditor.tsx`
already imports `generateText`/`generateVideo` from this module and is the
natural host; the two read functions belong on whatever surface shows an agent
their generation history.

---

### `app/actions/ai-isa/engage-contact.ts:toggleContactAIISA` — **FIXED IN PLACE (unauthenticated service-role write to an outbound-automation switch)**

Not a duplicate — the only toggle for AI ISA automation on a contact. It is a
`"use server"` export with **no authentication of any kind**, opening a
`createServiceClient()` (RLS bypassed) and taking `contactId`, `brokerageId`
**and `actorId`** all from the caller. Three distinct problems:

1. **Re-arms outbound automation.** It sets `ai_outreach_paused = false` and
   `isa_reengage_allowed = true`. An anonymous caller with a contactId +
   brokerageId pair could un-pause automated email/SMS outreach that an agent
   had deliberately stopped. Wrong direction on a suppression-adjacent flag.
2. **Forgeable audit trail.** `isa_reengage_marked_by` is an accountability
   column, and `actorId` is also stamped on the emitted
   `AI_ISA_ENABLED_ON_CONTACT` / `..._PAUSED_...` lifecycle event. Both were
   whatever the caller claimed.
3. **RLS was no help.** The live `contacts` UPDATE policies are actually good
   (agent-owns-contact / broker-in-brokerage / platform-admin — I read them off
   the database), but `createServiceClient()` bypasses every one of them.

Fixed: `resolveWriteContext()` first; `brokerageId` and `actorId` now come from
the session and the caller's copies are ignored (params kept and documented as
ignored, matching the convention used elsewhere in the repo). Also added
`.select('id')` so a write that matched zero rows — e.g. a contact in another
brokerage — reports "not found in your brokerage" instead of `success: true`;
without it, supabase returns `error === null` for a zero-row update.

Wiring instruction: the doc comment says "agent toggle from contact detail
view", so the host is the contact detail surface; it now needs only
`{ contactId, enabled }`.

---

### `app/actions/services-config.ts:toggleAIAgentTemplateStatus` — **MERGED, THEN DELETED**
Survivor: **`app/actions/services-config.ts:toggleAIAgentTemplate`** (same file, wired from `app/settings/services/services-content.tsx:504`).

### `app/actions/services-config.ts:togglePlaybookStatus` — **MERGED, THEN DELETED**
Survivor: **`app/actions/services-config.ts:togglePlaybook`** (same file, wired from `app/settings/services/services-content.tsx:750`).

These are the only deletions I made, and both were merged first.

**What the losers carried that the survivors lacked, and where it went:**
- *"returns the updated row."* Real, if small. **Ported** onto both survivors as
  an additive `template` / `playbook` field (additive, so no existing caller's
  return shape breaks).
- `toggleAIAgentTemplateStatus` also wrote a column called **`enabled`**.
  That is not a capability, it is a defect — `ai_agent_templates` **has no
  `enabled` column**; the live flag is `is_active` (checked against the
  database, not inferred). PostgREST refuses that write and the `if (error)
  throw error` on the next line rethrows, so this function could never have
  succeeded even once. Per the worked example: do not port a broken
  implementation. Nothing to merge.

**What made them worth deleting rather than keeping:** neither authenticated and
neither scoped by tenant, while both were `"use server"` exports — two
anonymously reachable write endpoints onto another tenant's AI agent templates
and playbooks. The survivors authenticate.

**Class fix applied at the survivor** (the point of the merge, not a side
effect): `togglePlaybook` did not authenticate either. It leaned silently on
RLS, and the live `plan_tasks_tenant_update` policy is
`brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()` — that
first clause hands every NULL-tenant row to anon. It now requires a session.

**Root cause recorded, deliberately NOT fixed** (outside this orphan's blast
radius): `createPlaybook` in the same file never sets `brokerage_id`, so every
playbook the product creates lands NULL and therefore lands in the permissive
RLS branch. Scoping the toggle by brokerage *today* would make every existing
playbook untoggleable — the fix belongs at the writer plus a backfill, which is
a migration and an owner decision. `plan_tasks` is empty live (pre-rollout), so
a backfill is currently free. **This same `brokerage_id IS NULL OR ...` shape
appears on `saved_calculations`, `plan_tasks`, `transaction_milestones` and
`ai_video_projects` — it is a repo-wide RLS pattern worth one deliberate review.**

---

### `app/actions/showings.ts:updateShowingStatus` — **KEPT + silent-write fixed**

Not a duplicate, though `updateShowing(id, updates: any)` (wired via the
`app/actions/index.ts` barrel) looks like one. Two things only this function has:
- a status union that matches the live `showing_requests_status_check` exactly
  (`pending|approved|needs_reschedule|denied|cancelled` — read off the
  constraint), so a typo cannot reach Postgres, whereas `updateShowing` takes
  `any`;
- the `seller_approved` / `seller_approved_at` stamping — **nothing else in the
  repo writes those columns.** That is the record of the seller having said yes.

Deleting it would delete the seller-approval record. Kept.

**Silent write fixed:** the UPDATE ran with no `.select()`, so an id that did not
exist or a row RLS refused matched zero rows, returned `error === null`, and was
reported as `{ success: true }` — a seller told their approval was recorded when
nothing was written. It now requests the affected ids and refuses on zero.

Not a *cross-tenant* finding: `showing_requests.brokerage_id` is `NOT NULL`
(checked), so the `brokerage_id IS NULL` escape in its RLS policy can never fire
and anonymous callers fail closed. But note there is **no role check** — any
authenticated user in the brokerage can approve or deny any showing in it, and
that is equally true of the *wired* `updateShowing` / `cancelShowing` /
`confirmShowing`. Recorded, not changed.

**False alarm I chased down and am recording so nobody re-chases it:**
`app/components/dashboard/listings/showings/confirmed-showings-list.tsx` appears
to write statuses (`completed`, `confirmed`, `rescheduled`) that the CHECK
rejects. It does not — its `updateShowing` at line 95 is a *local* optimistic
state helper, not the server action.

---

### `app/actions/listing-video.ts:trackVideoView` — **LEFT (benign; and I verified the scary-looking part)**

An anonymous view counter: UUID-validates `projectId`, then calls
`supabase.rpc('increment', { table_name, row_id, column_name })`.

That RPC signature looks like an arbitrary-write primitive, and it is
`SECURITY DEFINER` and **executable by `anon`** — so I read its body rather than
assume. It is **allowlisted**: it raises unless `(table_name, column_name)` is
one of four literal pairs (`ai_video_projects.view_count`,
`knowledge_articles.view_count|helpful_count|not_helpful_count`). `trackVideoView`
hardcodes both anyway. **No finding.** Worth writing down because the next
person to read this line will have the same alarm.

Verdict: not a duplicate, correctly public (it is a view counter on a shared
video), leave it. Wiring: the public video-share page should call it on mount.

### `app/actions/lead-signal-ingest.ts:ingestPredictiveSellerSignalAction` — **LEFT, flagged; the defect is file-wide and its siblings are wired**

Not a duplicate — it is one of three signal builders, and the file's own header
names the intended caller ("the existing lead-scraping pipeline").

**Finding:** no export in this file authenticates, and `applySignalDelta`
(`lib/lead-intelligence/signal-extensions.ts:167`) opens a
`createServiceClient()` — RLS bypassed. So these are unauthenticated
service-role writes to `lead_score_history` and `contacts` scores, keyed on a
caller-supplied `contactId`, with a caller-supplied `confidence`. An anonymous
caller can poison a tenant's lead scoring and therefore its work prioritisation.

I did **not** fix it, and the reason is deliberate: the same defect sits on
`ingestOfferLostSignalAction` and `ingestOpenHouseAttendeeSignalAction`, which
ARE wired (`app/actions/seller-offers.ts:404`,
`app/actions/seller-open-house.ts:748`) — and both call sites are themselves
server-side flows, one of which (`seller-open-house`) is a *public* lane where a
session may legitimately not exist. Bolting `resolveWriteContext()` onto the
shared path could break a working public flow. The right fix is to give
`applySignalDelta` a trusted-internal entry point and have the three actions
authenticate, which is a file-level change needing the owner's read on the
open-house lane. Recorded, not guessed at.

