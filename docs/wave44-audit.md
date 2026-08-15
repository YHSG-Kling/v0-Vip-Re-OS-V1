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
