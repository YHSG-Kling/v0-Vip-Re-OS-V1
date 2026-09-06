# Wave 44 — the application catches up with the database, and the orphan baseline burns

Two workstreams, four parallel agents, one rule.

## The rule this wave was run under

> "i don't want to just delete. i want to compare the 2 if duplicated and merge any
> function off of the one that will be deleted to the survivor. if not a duplicate
> we need to see if it belongs to something or if it is an advanced feature that
> would benefit adding."

Every agent's brief opened with that verbatim, and with the decision tree it
implies: **duplicate → merge forward, then delete naming the survivor; not a
duplicate → wire it or leave it; "no caller" is NEVER on its own a reason to
delete.** Agents were told explicitly that a truthful partial beats a
confident-sounding complete, and that deleting a real capability is the one
outcome this workstream will not accept.

That instruction did most of the work. The two burn-down agents together left
~90% of their slice alone, with reasons — see "what was deliberately not deleted".

---

## Part 1 — a role LABEL is not a FACT

m440–m449 fixed this in RLS. The application still disagreed with the database
about who a team lead is, and about who the superadmin is.

Measured live, and **inverted on both accounts that exist**:

| account | `user_type` | what is actually true |
|---|---|---|
| `teamlead@vip.demo` | **agent** | **runs 1 team** |
| `buyer@yourbrokerage.com` | team_lead | **runs 0 teams** |
| `superadmin@vip.demo` | **admin** | `platform_role = 'superadmin'` |

There are **zero** rows with `user_type='superadmin'` and zero with
`user_type='support'`.

### The superadmin half — 34 sole-gate sites

A sole gate is one where superadmin is the *only* route to a platform-scoped
capability, so the real owner silently got the brokerage slice or a refusal. The
sharpest:

- **`/dashboard/admin/command-center`** — the owner passed the `admin` entry gate
  and then got the tenant view: header read *"Your brokerage"*, and Trust Meter,
  Deal-Play Lift, Earned Autonomy, AI Teammates, QBR and the autonomy-halt banner
  all rendered as brokerage panels. Platform scope was **never once granted.**
- **`/dashboard/admin/ai-usage`** — every dollar figure (per-model, per-feature,
  per-agent cost, ROI badge) hidden from the only account gated to see it.
- **`/dashboard/admin/feature-governance`** — the page's entire write half was
  dead: every toggle `disabled`, and the client showed *"flags are managed by the
  platform team"* **to the platform team**.
- **`app/actions/support.ts`** — the support console **silently narrowed to one
  brokerage while reading as the whole queue.** A scope lie, not a refusal.
- **`admin/billing.ts:loadRevenueSummaryAction`** — the only real gate on the
  cross-tenant revenue aggregate (the kernel command has none) refused the one
  account meant to pass it.
- **`listings/[id]/lifecycle`** — worse than hidden: `canLaunch` still required
  `marketingReady`, so listings were **blocked by a control nobody could see.**

The fix everywhere is the shape already documented in `vendor-budget.ts:136-147`
and mirrored from `public.is_platform_admin()`: read **both** identity columns,
never `user_type` alone. Nothing was widened to the four-role staff roster.

**A correction to my own brief, from the agent doing the work:**
`orchestrator.ts:141` fails **closed**, not open. Its dead literals sit inside a
*denial* condition, and always-true disjuncts ANDed into a denial make it
*stricter* — collapsing to the plain tenant check. Nothing was ever let through;
the platform owner was simply locked out of the exemption written for them.

### The team-lead half, and the regression it nearly shipped

`lib/kernel/financial.ts` set `accessLevel` from `ctx.userType === "team_lead"`,
so the real team lead got `"personal"` scope. Now resolved from
`resolveLedTeamId()` — the app-side twin of m444's `current_user_led_team_id()`,
reading `teams.team_lead_id`.

**That fix alone would have been a regression.** It makes the Team Financials nav
appear for the real lead — and `financials/team/page.tsx` still gated on the label
and would have **bounced them to /financials/agent**. The agent that made the
kernel change flagged the pairing rather than shipping it blind. Fixed here, along
with two more defects on that page: `teamId` was read from `users.team_id` (NULL
for all 23 live users, so the team's own QuickBooks/Zoom panels rendered "not
connected" *for the person who runs the team*), and the connect button was gated
on the label too.

Three billing API routes were also hard-coding `userType: "superadmin"` — a label
typed in to satisfy a union, which reduced the kernel's own gate to a rubber
stamp. They now pass the caller's real identity.

---

## Part 2 — the orphaned baseline

The guard splits 1408 unreferenced exports into three strata, and only one is a
burn-down list:

| stratum | count | verdict |
|---|---|---|
| A — proof-only (a simulator names it) | 936 | **not dead**, off-limits |
| B — internal helper of a reached module | 208 | **live code**, off-limits |
| **C — referenced NOWHERE** | **264** | the real list |

Three of the four orphan baselines (`actions`, `routes`, `writes`) were already at
**zero** before this wave.

### The one wire that was worth the whole pass

`app/login/page.tsx` was calling `supabase.auth.signInWithPassword` **from the
browser**, which skipped `rejectIfSuspended` — the gate that reads the same
`users.status` flag the admin edit form and the superadmin suspend action write.
Magic-link and SSO both land on `/auth/callback`, which runs the gate. **Password
sign-in was the one door left open, so deactivating a user removed nothing:** they
could sign straight back in. Wiring the orphaned `loginUser` closed it.

### The deletions, each with a named survivor

`registerUser` is the one worth stating in full, because it was worse than dead:
as a `"use server"` export it was a **public unauthenticated POST** that produced a
`users` row with **no `brokerage_id`** — untenanted, invisible to every
`.eq("brokerage_id", …)` read, and skipping the trial funnel and provisioning
entirely. Account creation is reached by `/get-started` →
`signupBrokerageAction` → `provisionTenantOwner`, which is a strict superset.
Verified independently: `/signup` is a `permanentRedirect`, and no caller remained.

The rest were shims over a named survivor (`approveTourPlan`/`sendTourReport` →
`finalizeTour`), same-file duplicates (`getDemoUsersByRole` → `getDemoUsers` —
and the orphan returned raw `DEMO_USERS` entries, **`password` included**, over a
server action), or a never-rendered component whose three AI features are all
already wired in the live wizard.

### What was deliberately NOT deleted — the point of the rule

The dominant finding in `app/actions/**` was not dead code. A previous security
wave had walked those files and **gated them in place**, writing into each what it
used to expose. They are finished, hardened capabilities with no surface — exactly
what the rule protects. ~82 exports were left alone on that basis, with three
singled out as carrying their own written handoff and being the best next *wire*
targets:

- `calculators.ts` — the blocker (a per-browser visitor id) is already solved in
  `lib/tools/visitor-id.ts`; "the missing piece is now purely UI".
- `lead-signal-ingest.ts` — names the library entry point the session-less cron
  should call instead.
- `ai-content-generation.tsx:saveDescriptionToListing` — says outright which
  button should call it.

Two more were left alone specifically because deleting them would have **lost a
capability**: `LeaderboardClient` still holds an off-board rank callout
("Your current rank: #N") that the surviving `/dashboard/motivation` lacks, and
`AgentBrandingClient` holds a compliance-logo view that exists nowhere else.
Both need a merge, not a delete.

---

## The finding that outranks the burn-down

While triaging orphans in `lib/`, one agent found that
`lib/seed-compliance-rules.ts` — named by migration 051's own header as the
seeder for `prohibited_phrases` — **is called by nothing**.

Verified live: **`prohibited_phrases` has 0 rows.** `compliance_rules`, its
sibling catalogue, has 10.

`lib/application/compliance-monitoring.ts:481` iterates `prohibitedPhrases || []`.
With zero rows the loop body never runs, so **the Fair Housing phrase scan passes
everything** — "perfect for families", "no children", "adults only" all go
unflagged.

This is the rule earning its keep. That export presented as an orphan; deleting it
on "no caller" would have removed a Fair Housing control **that was already not
running**, and the deletion would have looked clean. An orphan is a question.

Tracked as its own item, with the shape of the fix specified (a migration, not a
button — federal phrases are a platform catalogue and must not depend on someone
clicking something), including the check that its RLS does not carry the
`IS NULL OR =` shape m442 showed publishes an unstamped row to every tenant.

## Two more live defects found by triage, reported not fixed

- **The portal's "Your Agent" card is null for every contact.**
  `layout.tsx:215` passes `contact.agent_id` (an **agents.id**) into a resolver
  that queries `agents.user_id = <that value>` — false for every row that will
  ever exist. Same two-id-classes trap as m390 and m441 claim 6. Fails closed, so
  nobody noticed. Three screens involved.
- **The blog category filter can never match** — the client filters on
  `post.category`, the page's select omits the column.

## What the guard itself gets wrong

The category-C list is matched by export **name, not path**, so two files defining
the same symbol mask each other: `hooks/use-mobile.ts:useIsMobile` and
`lib/hooks/use-media-query.ts:useMediaQuery` were both wholly unreferenced yet
absent from the list, and `lib/contact-utils.ts` has **zero importers** while only
4 of its 11 exports appear. **The true dead surface is larger than 264.** Recorded
rather than "fixed", because changing the census mid-burn-down would make the
before/after numbers incomparable.

## Verification

Typecheck **EXIT=0 cold, zero errors** across all four agents' work. Both guard
halves green. Every deletion re-checked by symbol grep across `app/`, `lib/`,
`hooks/`, `services/`, `scripts/`, `contexts/`, `types/` and `e2e/` — no dangling
import anywhere. The one deletion flagged for a second pair of eyes
(`registerUser`) was independently verified by the orchestrator: `/signup` is a
`permanentRedirect`, `provisionTenantOwner` is a strict superset, no caller
remained.

---

# The orphan that was a Fair Housing hole (#205)

This is the case the governing rule exists for, so it is written out in full.

`lib/seed-compliance-rules.ts` presented as a clean orphan: `seedComplianceRules()`
had **no caller anywhere in the repository**. Under a "no caller → delete" sweep it
would have been removed in a single line of a batch, and the diff would have looked
tidy. It is instead the seeder for the platform's **Fair Housing phrase catalogue**.

## What was actually true, measured before writing anything

```
prohibited_phrases   0 rows          ← the phrase scan's entire input
compliance_rules    10 rows          ← the sibling catalogue WAS seeded
```

`lib/application/compliance-monitoring.ts` iterated `prohibitedPhrases || []`. With
zero rows the loop body never executed, the scan produced no issues, and

```ts
passed: issues.filter((i) => i.severity === "blocking").length === 0
```

came back **true for every piece of content ever scanned**. `submitContentForApproval`
turns that boolean into `status: "pending"` — i.e. queued as clean — instead of
`"needs_revision"`. "Perfect for families", "no children", "adults only", "no Section
8": every one of them approved, on every listing description and marketing asset that
went through the lane. `app/actions/ai-chat.ts` reads the same empty table for
outbound messages.

**An empty compliance catalogue is not a neutral state. It is a gate that says yes to
everything, and at the call site it is indistinguishable from a clean scan.**

## And it could never have worked, which is the sharper half

The seeder was not merely unwired. Its 17 Fair Housing rows carry
`severity: "blocking"`, and the live constraint is

```sql
prohibited_phrases_severity_check CHECK (severity = ANY (ARRAY['info','warning','critical']))
```

so anyone who had called `seedComplianceRules()` by hand would have taken a **23514 on
exactly those 17 rows** and seeded only the 8 harmless ones — a catalogue that looked
populated and had lost precisely the phrases with statutory teeth. "Never called" was
hiding a second defect underneath it.

## Three vocabularies, one of them authoritative

| source | vocabulary |
|---|---|
| the column's CHECK | `{info, warning, critical}` |
| `scripts/check-vocabularies.ts:1190` (declared, in the chain, green) | `["critical","info","warning"]` |
| the seeder | `{info, warning, blocking}` |
| `compliance-monitoring.ts` issue grades | `{info, warning, blocking}` |

The declared contract wins; the seeder's spelling is the outlier. But the reader's
vocabulary is **also** `blocking`, and it intersects the column's on `info` and
`warning` and **not on the value that stops content**. So seeding alone would have
fixed nothing: the scan would have found the phrase, pushed it into `issues` as
`critical`, and the `=== "blocking"` filter would have skipped straight past it —
`passed: true` with a Fair Housing violation sitting in the list.

Both halves therefore ship together:
- **m450** seeds 25 phrases, verbatim from the authored file, mapping
  blocking→critical (the CHECK's severest value). Nothing is downgraded.
- **compliance-monitoring.ts** normalises `critical → blocking` at the boundary where
  the two vocabularies meet.
- **m451** asserts the pairing, so neither half can drift back alone.

## Why a migration and not a button

Checked before choosing a scope, because the m442 lesson is that guessing a tenant is
how an unstamped row gets published to everyone:

- `prohibited_phrases` has **no `brokerage_id` column at all** — nothing to stamp;
- SELECT is `true` TO `authenticated` — every tenant reads the same list, which is
  correct, because the Fair Housing Act is federal, not per-brokerage;
- INSERT/UPDATE/DELETE are gated on `is_platform_admin()`.

It is a platform catalogue **by construction**, and
`scripts/child-tenant-scope-simulator.ts:67` already recorded the intent in words:
*"Fair-Housing phrase list — must be readable by every tenant."* A federal compliance
control must not depend on somebody remembering to click something, and must be
present in every environment from first boot. The fix for "nothing runs it" is to
stop needing anything to run it.

## The scan now fails CLOSED

`scanContentComplianceService` read the catalogue as `const { data } = …` — the
recurring defect. supabase-js **resolves** a failed query, so a permission denial
arrived as `data: null` and read as "nothing prohibited found". Both that and a
genuinely empty table now throw rather than clear the content. m450/m451 guarantee the
rows exist, so neither branch fires in normal operation — but if one ever does, the
scan says so instead of quietly approving.

## New guard: `npm run test:fair-housing-phrase-gate`

39 checks, and it covers the half a migration cannot — that the seeded patterns work
when the JavaScript scanner runs them. The phrase-scanning loop was extracted to
`compliance-monitoring.ts:scanForProhibitedPhrases` so the guard exercises the **real**
function, not a copy. Phrases are read from the m450 migration on disk, which m451
asserts the database still matches. No fixture data.

It asserts, among others:
- every seeded pattern **compiles** as a JS RegExp — one that does not throws out of
  `new RegExp` and takes the *whole* scan down, not just its own phrase;
- every seeded pattern **matches its own phrase** — a pattern that cannot is
  decorative, sitting in the catalogue looking like coverage and flagging nothing;
- real violating listing copy produces a **blocking** issue and would route to
  `needs_revision`, while clean copy produces **zero** issues;
- the service destructures `error`, throws on a failed read, throws on an empty
  catalogue, and calls the shared scanner rather than a second copy of the loop.

Negative-controlled: removing the `critical → blocking` mapping turns exactly 3 checks
red (`20 passed, 3 failed`); restoring it returns 23/23.

## The lesson, stated plainly

That export presented as an orphan. Deleting it on "no caller" would have removed a
Fair Housing control **that was already not running**, and the deletion would have
looked clean — no dangling import, no failing guard, no screen changed. Nobody would
have found this for a long time, and the thing that would have found it is a discrimination
complaint.

**An orphan is a question, not a verdict.** This one's answer was that the capability
was real, unrunnable, and load-bearing.

## The second lane, found by asking who else reads the table

`app/actions/ai-chat.ts:468` — `checkMessageCompliance` — read the same catalogue
and carried **both** defects verbatim: its own inline copy of the RegExp loop, the
same `severity === "blocking"` filter against a column storing `critical`, and the
same swallowed read error. `sendMessage` turns its verdict into
`compliance_flagged: !complianceCheck.passed`, so a Fair Housing violation in an AI
chat message was **stored unflagged**. Fixing only `compliance-monitoring.ts` would
have closed one half of one gate and left the outbound conversational lane open.

Both lanes now call the same `scanForProhibitedPhrases`. The failure postures
differ, correctly: `scanContentComplianceService` **blocks** — content that cannot be
scanned must not be reported compliant, so it throws. `checkMessageCompliance`
**flags** — it never blocked a send, so failing closed here means raising a
`compliance_scan_unavailable` issue that makes `passed` false and puts the message in
front of a human. Failing closed means the strictest thing the lane already does, not
a new behaviour bolted on.

Also checked and found clean: `submitContentForApprovalService`'s `submitterRow` read
is unchecked, but a missing `brokerage_id` cannot produce an untenanted approval row —
`activities_tenant_insert` WITH CHECK is `brokerage_id = current_user_brokerage_id()`
and `activities_insert_own` requires an `agent_id` this writer never sets, so a NULL
tenant is refused by RLS and `if (error) throw error` surfaces it. It fails closed and
loudly. Left alone rather than changed.

## Then the deletion audit found what the seed had left behind

Only after m450/m451 did `lib/seed-compliance-rules.ts` become a candidate for
deletion — and auditing it *for* deletion is what turned up two more things it
carried that the survivor did not. This is precisely why the rule is merge-first.

**(a) `suggested_alternative` is a column that does not exist.** Both readers emit
it — `compliance-monitoring.ts` as `suggestedAlternative`, `ai-chat.ts` as
`alternative` — and the live table's columns are `id, phrase, phrase_pattern,
category, severity, is_active, notes, created_at, updated_at`. The field has been
`undefined` on every issue the scanner has ever produced: the agent is told what is
wrong and never what to write instead. It is also a **third** independent reason
`seedComplianceRules()` could never have run — PostgREST rejects an unknown column
outright (PGRST204). Zero rows, a severity the CHECK forbids, and a column that does
not exist, in one unwired function. "No caller" was the least of it.

**(b) `required_disclosures` was the *other* empty catalogue.** Measured: **0 rows**,
and `scanContentComplianceService` iterates it as `requiredDisclosures || []` — the
identical shape as the phrase list. The missing-disclosure warning had never once
been raised. One empty catalogue is a coincidence; two is the pattern.

**m452** adds the column and backfills 20 alternatives verbatim, and seeds 3
disclosures. **m453** asserts both — and carries a correction to m452's own prose,
which said "19" and "six" where the measured figures are **20** and **five**. The SQL
was right; the sentence was not. Corrections belong in the next migration, not in a
silent edit of one already applied.

### Why three disclosures and not the authored five

The reader's test is a literal substring match —
`!content.contentBody.includes(disclosure.disclosure_text)` — so the text must be a
string compliant copy actually contains. Two of the authored five are not:

| row | authored text | why it cannot ship |
|---|---|---|
| `brokerage_name` | "Brokerage Name Required" | a **label**, not a disclosure. No real asset contains that string, so it would warn on 100% of email/print/social content forever. |
| `license_number` | "Licensed Real Estate Agent" | the requirement is the agent's licence **number**, a per-agent fact. An agent writing "License #12345" satisfies the law and would still be warned. |

Both are per-tenant/per-agent facts wearing placeholder text, and the table has no
tenant column to hold them. They need a resolver substituting `brokerages.name` and
the agent's licence number per asset, which does not exist. **Reported for a ruling,
not guessed at** — because a check that always fires is worth exactly as much as one
that never does, and m453 claim 3 asserts that constraint as a construct so no future
edit can reintroduce a placeholder.

### `lib/seed-compliance-rules.ts` — DELETED, survivors named

Only once everything it carried was merged forward:

- `seedComplianceRules()` → **m450** (25 phrases) + **m452** (20 alternatives, 3
  disclosures). The 2 unshippable disclosures are preserved verbatim in m452's header
  rather than lost with the file.
- `getProhibitedPhrases()` → duplicate. Survivor:
  `lib/application/compliance-monitoring.ts:scanContentComplianceService` and
  `app/actions/ai-chat.ts:checkMessageCompliance`, which both read the table directly.
- `getRequiredDisclosures(channel, state)` → duplicate. Survivor: the channel/state
  filtering already done inline in `scanContentComplianceService`.

Verified before deleting: zero importers of the module path, zero references to any
of the three symbols anywhere in `app/`, `lib/`, `hooks/`, `services/`, `scripts/`,
`contexts/`, `types/` or `e2e/`.

### The screen effect of the merged column

`suggested_alternative` is not a field with no home. Two screens already render it
and both were guaranteed blank:

- `app/components/shared/compliance/submit-content-form.tsx:265` — *"Try instead:
  …"*
- `app/components/shared/compliance/pending-approvals-list.tsx:182` — *"Suggestion:
  …"*

Every prohibited-phrase issue ever shown on either screen carried the violation and
no remedy, because the column the value came from did not exist. After m452, an agent
who writes "perfect for families" is shown *"This home offers generous space and a
welcoming layout"*. `app/actions/ai-chat.ts` surfaces the same value as `alternative`
on flagged messages.

### Negative controls

- **Guard** — removing the `critical → blocking` mapping turns exactly 3 of the 39
  checks red; restoring it returns 39/39.
- **m453 claim 3, live** — inserting the real `brokerage_name => "Brokerage Name
  Required"` row inside a DO block that always raises: the claim caught it by name.
  The `raise` rolled the fixture back by construction, and `required_disclosures` was
  re-counted afterwards at exactly 3 rows — `advertising_disclosure, equal_housing,
  mls_disclaimer`. Zero leftovers.

## The deletion's own consequence, caught by the guard chain

Half B went red on `test:writerless-reads` — and it was right:

```
✗ NEW required_disclosures ← lib/application/compliance-monitoring.ts, lib/compliance/vendor-respa.ts
```

Deleting the seeder removed the only runtime writer that table had, leaving two
readers over a table nothing writes. The guard's framing — *"build the writer,
repoint the read, or delete the dead surface"* — has a fourth answer it already
supports, and it is the correct one here.

`compliance_rules` and `prohibited_phrases` were **already** in that file's
`SEEDED_REFERENCE` set. `required_disclosures` is the third sibling of that exact
pair and escaped classification only because the seeder was its runtime writer — a
writer that, as m450 establishes, could never actually run. Two independent facts
confirm the class:

1. **By construction** — no `brokerage_id`, `SELECT true` to `authenticated`, writes
   gated on `is_platform_admin()`. It is a platform catalogue, now seeded by m452 and
   asserted by m453.
2. **By its other reader** — `lib/compliance/vendor-respa.ts:294` reads it purely as
   an *override* store for three `respa_*` disclosure types, with hardcoded fallbacks
   that "guarantee real language even before a brokerage customizes it." It expects
   rows to be absent and degrades correctly.

A runtime writer is not expected there and never was. Added to `SEEDED_REFERENCE`
next to its two siblings with the reasoning inline — an auditable exemption, not a
baseline entry that hides the question.

## Baseline burn

`test:orphan-exports` named **exactly** the three deleted exports and nothing else,
which is what makes the deletion safe to accept. Re-baselined deliberately:

| | before | after |
|---|---|---|
| files with orphaned exports | 668 | **667** |
| C. referenced NOWHERE (the real burn-down list) | 239 | **236** |

−3, matching the three deleted symbols precisely. No unrelated export was swept up.

## And the chain caught the guard itself having no owner

`test:proof-ownership` then flagged exactly one new unowned proof —
`test:fair-housing-phrase-gate`, mine. That is #92's rule doing its job on the work
that was closing #205: *a feature nobody owns is a feature nobody fixes*.

Registered as `fair_housing_phrase_catalogue` under `compliance_officer`, which
already owns `video_script_compliance` and `fair_housing_dispatch_backstop`.

**Recorded deliberately in that entry: this is NOT the same control as
`fair_housing_dispatch_backstop`.** That one carries its own hardcoded
`FAIR_HOUSING_PATTERNS` / `detectFairHousingViolations` and runs at the physical
dispatch chokepoint, on the final assembled message. This one is the
platform-admin-editable catalogue scanned at COMPOSE time. Two independent layers by
design — a later reader looking at "two Fair Housing detectors" should not collapse
them, and the registry entry says so in as many words. Noting it here because that is
exactly the shape of a "duplicate" that is not one.

Verification of the registry edit: `test:proof-ownership` 377 owned (was 376),
unowned 309 against baseline 309 — the proof moved into ownership and nothing else
drifted. `test:manager-ownership` 73/73. All nine other guards that read
`MAINTENANCE_DOMAINS` re-run individually — doc-kernel, session-rails,
egress-coverage, render-cache, living-video, partners-meeting-reel, crm-pull,
platform-ops-wiring, outcome-ledger — zero failure markers each.
