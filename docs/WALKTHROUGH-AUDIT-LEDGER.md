# Live Walkthrough — Itemized Audit Ledger

Source: the owner's live-check document, *"Required documents — documents you need for file before
submitting to compliance"*. 134 findings, numbered here by their line in that document so every row
is traceable back to the original text.

Three states are used, and they mean different things:

- **CLOSED** — fixed, with the commit that did it. Verified beyond "it compiles".
- **CLOSED (class)** — fixed as part of a root-cause cluster rather than individually.
- **OPEN** — investigated and confirmed still outstanding. Each carries what it actually needs.

An item is never marked closed because the code merely runs. The owner's standing rule applies:
*"just because it works, doesn't mean that it is a closed item."*

---

## The single largest finding

Roughly a sixth of the document is **one root cause wearing different names**:

> [51] "Agent portal deny no access staff access required" · [53] "Open house — agent identity
> required" · [56] "Documentation unauthorized" · [82] "Transaction — is not authorized" ·
> [93] "Pipeline — same" · [98] "Inbox, AI Outreach, Comm Intelligence, Handoff cockpit — all
> bounced back" · [104] "Stale Queue — bounce back" · [105] "Financials — kicks me to login page" ·
> [110] "AI Command center — Bump" · [111] "Monthly Intelligence Report — Bump" · [116] "Daily
> Briefing failed to load agent context not available" · [120] "My goals — agent profile not
> found" · [121] "Voice intelligence — bounces" · [123] "Some boxes and buttons bounce" ·
> [124] "Challenges — bounce" · [130] "Home value tool — no agent record found for your account" ·
> [133] "ISA calling — Brokerage required" · [134] "Some bumps"

Every one is a signed-in agent whose account is missing a `brokerage_id` and/or an `agents` row,
landing on a work page that redirects them away instead of repairing the account.

**Fixed in `24e7e55`**, two parts:

1. Fourteen work pages resolved identity through the raw `getAgentContext` and redirected on an
   incomplete result. They now resolve through `ensureAgentContextInPlace`, which provisions the
   missing records and re-resolves, so the page renders. The redirect survives only as the
   genuinely-unprovisionable fallback (a pending brokerage invite, or a staff user whose brokerage
   comes from their org).
2. The deeper bug, found while verifying the first: `ensureAgentBrokerage` returned early on **any**
   user carrying a `brokerage_id` as "nothing to heal". Anchored is not complete — a user can hold a
   `brokerage_id` and still be missing their `agents` row, and that account stayed broken forever
   because the one function that could fix it declined to look. It now runs the canonical
   `createOrRepairUserDomainRecords` for that state, using the brokerage's real `plan_tier`.

**Correction (later in the same session):** the first pass fixed only 14 pages — the ones resolving
through `getAgentContext`. A shape-based sweep found the MAJORITY of pages read `users.brokerage_id`
directly and redirect on it, a second spelling of the identical bounce. **95 pages** now self-heal.
Several items below were marked CLOSED (class) before that was true — including [98] Inbox,
[121] Voice intelligence and [133] ISA calling. They are genuinely closed now. The guard was
rewritten to scan every page by shape rather than by a fixed list, so neither spelling can regress.

Verified against the live schema, not asserted: the broken state was confirmed to **exist on real
accounts** (6 users with no brokerage; 4 agent-type users with no `agents` row — real accounts, left
untouched). A disposable probe reproduced the state, the repair resolved both `brokerage_id` and
`agents.id` through `get-agent-context`'s own resolution path, and the probe was removed to zero
residue. Locked by `test:identity-self-heal` (21 checks), owned by `data_steward`.

---

## Ledger

| # | Finding (abridged) | State | Evidence |
|---|---|---|---|
| 2 | Required-docs seed defaults: no upload / no add to transaction checklist | CLOSED | `m282` + template-form attach on the checklist |
| 4 | Feature governance — can't change enrollment, not really functional | CLOSED | Accurate: the page admits admin/broker but every flag control is `disabled={!isSuperadmin}`, so a broker met a wall of dead switches with no explanation. Flag definitions ARE correctly platform-level; the page now says so and points to Access Overrides, which a broker genuinely can change. **Two real defects found in that override path:** `created_by` recorded the TARGET as the grantor (falsifying the audit trail on a governance surface), and the email lookup had no brokerage filter — a foreign user resolved and bound to this tenant. Proven live: a real other-brokerage email resolves 1 under the old lookup, 0 under the scoped one |
| 6 | Video analytics looks old / plain | CLOSED | `afade62` — distribution vs hook vs missing-ask diagnosis |
| 8 | SLA monitor — plain dashboard | CLOSED | `ccfe9b1` — leads with silent (un-notified) breaches |
| 10 | Visitor tracking — snippet with no directions | CLOSED | The snippet also **could not work**: it used a relative `/api/track/pixel`, which resolves against the *installer's* origin, so every hit 404'd on their own domain. Now absolute via `NEXT_PUBLIC_APP_URL`, and it forwards UTM params the route already read but the snippet never sent. Real per-platform install steps replace copy that described placeholders the snippet doesn't contain, plus a live "is it receiving traffic?" line. `website_visitors` has 0 rows, consistent with a pixel that never fired |
| 12 | Billing navigation knocked me to login | CLOSED (class) | `24e7e55` — identity bounce |
| 14 | Usage meter — monitor AI/storage/voice consumption | CLOSED | The reading was right: it *is* a broker surface, sitting in the AGENT nav. `loadUsageOverview` admits broker/admin/superadmin/team_lead, so a plain agent got a silent `redirect("/dashboard")` — a click that appeared to do nothing. The entry is NOT wrong (team leads share that nav and legitimately see it), so it now explains rather than bounces. Verified on the real tenant: 3 of 12 users see the meter, 9 now get the reason. **Not a duplicate of `/dashboard/admin/usage`** — investigated: this is the plan-quota meter (am I near my limit), that is the consumption analytics (where is it going, per agent/team/tool, 6-month trend). Complementary, kept both |
| 16 | System intelligence says all providers up with none configured | CLOSED | `2cdf615` — the panel invented `enabled ?? true` with no override on file. Now reads the canonical credential-backed `getBrokerageProviderReadiness` (a duplicate-status merge, keeping the advanced). Measured on the walkthrough tenant: old claimed 7/7 active; truth is 4/63 usable, 36 waiting on the broker, 23 on platform staff |
| 18 | Audit trail — basic reporting | CLOSED | `87f8698` — honest capped-window limitation stated |
| 20 | AI audit trail — plain | CLOSED | `c7e5a10` — unreviewed AI output + age of oldest |
| 22 | Error handler — plain dashboard | CLOSED | `5a0ae11` — "one broken thing repeating" triage |
| 24 | What's new — too much detail pre-launch | OPEN (by owner's choice) | Owner asked to hold this until launch |
| 26–29 | Settings tree duplicates (General / Integrations / Email-calendar) | CLOSED | `5b29659` — Integrations redirects to the advanced `/settings/connections`; the other 14 settings surfaces investigated and confirmed distinct, not duplicates |
| 27 | General settings names the *app*, not the tenant | CLOSED | Worse than a label nit: `global_settings.app_name` defaults to the PRODUCT name, and the open-house kiosk renders it as the brokerage — including inside the TCPA consent text a lead agrees to. The kernel seeder now seeds it from `brokerages.name`, so a fresh tenant is correct on first load. Verified live: old seeder produced the product name, new one produces "VIP Premier Realty". Also relabelled the orphaned `/settings/global` copy. **Noted, not done:** `/settings/global` (388 lines) is an unreachable superset of `/settings/general` (125) — a real duplicate needing its own consolidation pass |
| 30 | Facebook OAuth connect button failed → bounced to profile | OPEN | Needs a live OAuth round trip; cannot close headless |
| 31–34 | CRM sync / phone-SMS / brand voice / brand settings | CLOSED | Advanced connections surface retained per the keep-the-advanced rule |
| 28b | **Found while re-auditing [28]:** the agent nav's "Integrations" pointed at the brokerage's provider CREDENTIAL surface, and `app/actions/settings/integrations.ts` had **no authorization on any of its 5 exports** — including `upsertPlatformCredential`, which writes provider API keys | CLOSED | Every export now gates to admin/broker/broker_admin/superadmin (fail-closed, same shape as the sibling actions). Verified on the 12 real users of the test brokerage: 3 admitted, 9 denied — previously all 12 could read *and write*. Agent nav repointed to the Connection Center; the page now states the permission boundary instead of "failed to load… refresh" |
| 35 | Email templates — no place to view them | CLOSED | A name list is not viewing a template. Selecting one now renders the actual email — subject and body with merge tokens resolved — and flags tokens that would reach a client as literal text. Also added the missing empty and loading states (the list was hidden entirely at zero templates). Verified live: the shipped helper caught `{{property_address}}` as unresolved on a real seeded template; probe removed, 0 residue |
| 36–37 | Notifications, commission calculation | CLOSED | Present and wired |
| 38 | Agent downline? | CLOSED | Referral downline in Agent 360, tenant-gated on the recruiting program |
| 43 | User Management + Invite can only change Roles | CLOSED | `d46dc92`/`6eff902` Agent 360 · `770838f` Staff 360 — full user view, not just role edit |
| 44–45 | Profile goes to settings / Settings goes to settings | CLOSED | Two causes: My Profile was filed *inside* the Settings nav group, and the page itself was a settings page whose only identity card was read-only ("edit via admin"). My Profile is now a top-level nav item, and the page leads with an editable identity card — name, phone, license #/state/expiry, years, bio — all on existing columns. Round-trip verified live on a real agent, then restored to its exact original state |
| 46 | Inbox has no window to type in | CLOSED | Unified inbox compose + outbound social DM (`7e2f551`) |
| 47 | Can't bring up an agent's account and apply/remove onboarding | CLOSED | `6eff902` — `OnboardingControl` on the Agent 360 panel |
| 49 | Property type should be a selection | CLOSED (vocabulary) · OPEN (target-area scoping) | `m285` constrained the column and unified the intake. Going after the *selection* found **seven** lists, two of which stored Title Case DISPLAY strings while listings store canonical values. The property-alert matcher compares with `.toLowerCase()` on both sides — which looks defensive but only fixes case, not the separator — so **Single Family and Multi-Family silently scored zero on every listing** while Condo/Townhouse/Land/Commercial matched. A filter that works for some values is worse than one that works for none. One `PROPERTY_TYPE_OPTIONS` + `canonicalPropertyType()` now drive every selector and both sides of the match; already-saved rows work with no data migration. Proven: all 6 types match after, 2 missed before. **Still open:** scoping the list to the subscriber's target area — see note below |
| 50 | Upload errors with no bucket | CLOSED | `m278` — 11 buckets provisioned, verified live |
| 51–56 | Agent portal / open house / showing prep / documentation authz | CLOSED (class) | `24e7e55` |
| 57–77 | Brokerage plan onboarding chain (license, E&O, phone, connects, twins) | PARTIAL | Twin Studio surfaced (task 39); the connect legs need live OAuth to close |
| 82–86 | Transaction authz, closing concierge, contract page, overdue, weekly insights | CLOSED (class) + OPEN [84] | `24e7e55`; [84] contract review page still needs its load path traced |
| 87–88 | Forms library, office pipeline basic | CLOSED | Forms library work (tasks 11–15, 19) |
| 90–94 | Video credits / twin studio / my videos spinner / pipeline | PARTIAL | Twin Studio + video surfaces consolidated (tasks 37–39, 49); the credit-gate UX remains |
| 95–96 | Market same as admin; campaign only repurpose | CLOSED | Tasks 26, 38, 44 — Ops Center and Market Studio merged |
| 98 | Inbox / AI Outreach / Comm Intelligence / Handoff all bounced | CLOSED (class) | `24e7e55` |
| 99–103 | Market insights setup, behavioral/agent/campaign patterns | CLOSED | Two causes. The page never read `searchParams` — every `?filter=` rendered the same unfiltered list. And the Agent/Campaign buttons promised a lens the schema forbids: `pattern_detections.entity_type` is CHECK'd to contact\|listing and `behavioral_patterns.entity_type` to buyer\|seller\|negotiation, so no filter value could ever populate them. The page now honours a validated filter, and the two buttons point at the surfaces that genuinely answer those questions (Coaching, Campaign ROI). All five supported filters verified discriminating on live seeded patterns; agent/campaign proven structurally 0 |
| 104–105 | Stale queue bounce, financials kicks to login | CLOSED (class) | `24e7e55` |
| 106 | My fees separate from commissions — should be one umbrella | CLOSED | Nav already grouped the two screens; the substantive half was that an agent had to open both and subtract in their head. A net-position card now sits on the earnings page reading the SAME `agent_fee_charges` source as the fee detail. Live-verified the math on seeded charges across all five statuses: owed counts only open+overdue ($500), not the naive all-status sum ($1,900) — waived, disputed and paid are correctly excluded. Test rows removed, 0 residue |
| 107 | Credit pipeline — unclear budget figures | OPEN | Needs a real read of what the numbers mean |
| 109 | Academy — My Template and My Path buttons go nowhere | CLOSED | Tasks 19, 50 — education/academy split and content generation |
| 110–111 | AI Command center, Monthly Intelligence Report — bump | CLOSED (class) | `24e7e55` |
| 113 | AI Toolkit — page can't load | CLOSED | Not the identity class — a real render crash. `getAIToolUsageStats` returns an OBJECT of totals, but the client assigned it whole (behind an `as any`) to array state and called `.sort()` on it at render, outside the try/catch: `TypeError: usageStats.sort is not a function`, reproduced verbatim. The action now returns per-tool counts on `.by_tool` keyed on the real `tool_name` column. Also fixed a dead `groupByCategory` reading a nonexistent `tool_category` (every row fell to one "other" bucket) and a `.sort()` mutating state during render |
| 114 | AI Chat — no unified box | CLOSED | Task 54 — three floating assistants merged into one |
| 115 | Voice assistant speaks as admin to an agent | OPEN | Persona must follow the viewer's role |
| 116 | Daily briefing — agent context not available | CLOSED (class) | `24e7e55` |
| 117 | Pipeline analytics plain | CLOSED | `3c4a8e2` — verified, not assumed: `/dashboard/reporting` carries `composePipelineBriefing()` and the read card. The doc's "each box takes you to other crews" was a description, not a complaint |
| 118 | Trains & Coaching — analyze-goals button goes nowhere | CLOSED | The button was genuinely dead: `loadGoalCoaching` early-returned on `goalCoachingLoaded`, which the tab click had already set, so the retry could never fire. It also offered the wrong action — re-analysis cannot help an agent with no goals. Now `force` bypasses the guard for an explicit retry, and the empty state distinguishes "no goals set" (→ Set your goals) from a real failure (→ Try again, showing the error). Both branches verified against live data |
| 119 | Objection practice hard-coded cards | CLOSED | Task 56 — scenarios generated from real mishandled-objection calls |
| 120–121 | My goals / voice intelligence bounce | CLOSED (class) | `24e7e55` |
| 122 | Motivations — well built | — | Owner marked this good |
| 123–124 | Boxes bounce; challenges bounce | CLOSED (class) | `24e7e55` |
| 125 | Business diagnosis — good | — | Owner marked this good |
| 126 | Reports basic; commission shouldn't show | CLOSED | Task 57 — commission removed, Summary made a real snapshot |
| 128 | Business cards — file won't add | CLOSED | `m278` — `business-cards` bucket provisioned |
| 129 | QR codes 404 | CLOSED | Route resolves; all 224 nav hrefs audited against real pages |
| 130 | Home value tool — no agent record found | CLOSED (class) | `24e7e55` |
| 131 | Calculators — good | — | Owner marked this good |
| 133–134 | ISA calling brokerage required; some bumps | CLOSED (class) | `24e7e55` |
| 135 | Token not working / settings page sends to another settings page | PARTIAL | The settings-tree redirects are resolved; the token path still needs a live check |

---

## Cross-tenant sweep (found by re-auditing my own claims, not from the document)

Three surfaces resolved a user from an attacker-supplied **email typed into a form field**
and then wrote a row carrying the *caller's* `brokerage_id` with that foreign `user_id`.
The row looks correctly scoped in isolation — the **binding** is what crosses the line.

| Surface | Fixed in |
|---|---|
| Academy assign-to-agent · assign-to-staff | `2647700` (VADE-reported) |
| Feature-governance trial grant | `447d7cd` |
| **`inviteTenantMember` — a full tenant CAPTURE, not just a binding** | this commit |

The invite path was the worst of the three. `resolveEmailHolder` searches `users.email`
globally — it must, the column is unique platform-wide. But when it found an existing
auth-linked user, the upsert below rewrote **that user's `brokerage_id` to the inviter's**.
A broker who typed the email of an agent at another brokerage did not invite them, they
*moved* them — silently, along with agents/onboarding/RBAC provisioning. Reachable by any
broker, admin or team_lead with invite rights, knowing only an email.

Now refused unless the caller is a superadmin (who legitimately moves users between tenants
via the superadmin path). Verified on real accounts: the test broker is REFUSED, the
platform superadmin is still allowed.

Locked by a new TENANT-BINDING check inside `test:tenant-scope`, written by shape with six
documented global exemptions — each naming *why* global is correct there, so a future reader
can challenge it rather than assume it was rubber-stamped. That check found the invite
capture itself: my own hand-run sweep had only walked `app/`, missing `lib/`.

## Duplicate sweep

Per the owner's rule — *"we either merge them or keep one and let the others removed but only after
a full investigation of dependencies and business process"*:

| Duplicate pair | Decision | Basis |
|---|---|---|
| `commissions` vs `agent_commissions` | **Merged onto `agent_commissions`** (`m283` superset, `m284` drop) | 25 consumers vs 7; keeper has the dispute/approval lifecycle and QuickBooks export. All 7 exclusive columns ported, all consumers repointed, three drop-blockers investigated individually rather than CASCADE'd |
| `/settings/*` vs `/dashboard/settings/*` | **No duplication to remove** | `branding`, `general`, `notification-rules`, `teams` are already redirects to `/settings/*`; the other 14 are distinct surfaces. Investigated before touching |
| `/settings/integrations` vs `/settings/connections` | **Kept connections** (advanced) | `5b29659` — matches the owner's "take the advanced" rule; the manual provider list became a documented redirect and its orphaned action was removed |
| Market Studio vs Ops Center | **Merged** | Tasks 26, 38 |
| Three floating AI assistants | **Merged into one** | Task 54 |
| Two KB embedding pipelines | **Merged into one** | Task 18 |
| Provider status: System Intelligence's own vs `getBrokerageProviderReadiness` | **Kept the readiness evaluator** (credential-backed) | `2cdf615` — the panel's private notion defaulted unconfigured providers to "on"; the evaluator reads four credential stores plus env presence |

## The `services/` blind spot (found by a PR review comment, then by widening the guards)

A review comment flagged that two live service methods still queried the `commissions` table
dropped in `m284`. It was right, and chasing *why no guard caught it* was worth more than the fix.

**Both guards that should have caught it were built the way I was told never to build one.**

| Guard | How its coverage was defined | Consequence |
|---|---|---|
| `legacy-tables-retired-simulator.ts` | `RETIRED` was a **hand-written list of 5 tables** | `commissions` was dropped and nobody typed it in, so the guard was not looking for the broken thing |
| `legacy-tables-retired-simulator.ts` | walked `["lib","app"]` | `services/` was invisible |
| `schema-drift-guard.ts` | walked `["app","lib"]` (twice) | same blind spot, independently |

Ten top-level directories ship TypeScript. Two were being checked.

**Both inputs are now derived from the repo instead of typed into it** (`scripts/runtime-roots.ts`):

- `RETIRED` = every table named in a `DROP TABLE` across the migrations, **minus** any table still
  in the live-schema snapshot. Drop-then-recreate is a non-event automatically; a future drop is
  covered the moment its migration lands.
- `ROOTS` = every top-level directory containing TypeScript, minus two documented non-shipping ones
  (`scripts`, `e2e`). A new directory is covered the moment it holds a `.ts` file.

Coverage went from 5 hand-listed tables to **40 derived**, and from ~2,900 files to **4,354**.
A derived list can silently become an *empty* list, so the guard now carries canaries that fail if
the derivation resolves to nothing.

### What the widened reach found — all in `services/`, none previously scanned

Every one was **dead by construction**, and every one was fixed rather than baselined:

| Defect | Table / column | Reachable from | Fix |
|---|---|---|---|
| `getCommissions` | `commissions` (dropped) | `/api/financial/commissions` — live | Repointed to `agent_commissions`; **scope now required** (was service-role and unbounded); errors propagate instead of returning `[]` |
| `getFinancials("commissions")` | `commissions` (dropped) | `dataAccessService` | **Removed.** It selected every row service-role and left tenant filtering to caller JS — for an admin/broker that filter was a no-op. Reviving it against a live table would have turned a dead path into a cross-brokerage read |
| `getInteractionHistory` | `interaction_history` — **never existed** | `/api/credit/status` — live | Repointed to `activities`. The route's `interaction_type` filter was doubly dead: verified live that column does not exist on `activities` either |
| `createInteraction` | `interaction_history` | nothing | Removed |
| `getTransactionMilestones` | `.order("milestone_date")` — not a column | nothing | Removed; `lib/application/transactions.ts` is the live one and orders by the real `target_date` |
| `getSphere` / `getBadges` / `getLeaderboard` | `sphere_of_influence`, `user_badges`, `agent_leaderboard` — **none ever existed** | unmounted hook | Removed with their wrappers. Live counterparts already carry this data (`sphere_engagement_scores`, `agent_badges`/`gamification_badges`, `leaderboard_rankings`) |
| `healthCheck` | `.select("count")` — not a column | health probe | The health check reported "not connected" on a perfectly healthy database. Now `head + count:exact` |
| `video_branding_presets` | dropped table | manager registry | Stale `TABLE_MANAGER` ownership row removed — caught by the widened guard, confirmed dropped live |

`getBusinessExpenses` got the same required-scope treatment as `getCommissions`: it is the
sibling method with the identical unbounded-service-role shape, and `dataAccessService`'s
marketing branch needed a brokerage scope that did not exist.

Live-verified on real data (probe rows inserted, then deleted to zero residue — `agent_commissions`
back to 0 rows): agent scope returns only that agent's row, brokerage scope returns both rows at
that brokerage, a foreign brokerage scope returns nothing.

Both guards now pass with **zero baselining** — no finding was tolerated as pre-existing.

### The `as any` cast that hid five more

`app/actions/communications.ts` opened with `const supabaseService = _supabaseService as any`.
That one cast turned off type checking for every call the file made against the service, and it was
hiding **five members that do not exist on it at all**: `logActivity`, `getContactActivities`,
`addContactNote`, `getUserById`, and a `.client` accessor. Each is a runtime `TypeError`, not a
silent empty — and `sendNotificationToAgent` is called twice by `lib/orchestrator/internal.ts`, so
those orchestrator events were throwing.

The cast is removed, so `tsc` checks this file now. It immediately found four more real errors that
had been invisible behind it. The five members are implemented against live column names:

| Member | Written to | What the old call would have done even if it existed |
|---|---|---|
| `logActivity` | `activities` | passed `user_id`; the column is `agent_user_id`. `brokerage_id` is NOT NULL and no call site knows it, so it is resolved from the contact or the user rather than pushed onto callers |
| `getContactActivities` | `activities` | this is the method the credit route also needed — one name, one implementation, two callers |
| `addContactNote` | `contact_notes` | passed `note`, `category`, `ghl_note_id`; **none is a column**. Text goes to `body`; the external note id has nowhere to persist and is still returned to the caller |
| `getUserById` | `users` | — (the guard caught my own first draft selecting `full_name`, which is not a column; it is `first_name`/`last_name`) |
| `createNotification` | `notifications` | replaces reaching for a raw service-role client, which is a wider door than the one write needs |

Verified against the live database with real rows for each write, then deleted to zero residue.
The PostgREST layer itself was not exercised — the sandbox has no Supabase credentials — so this
checks the column names and NOT NULL constraints, which are the failure modes that produced every
defect above.

### Still open from this thread

`addContactNote` now exists in **three** places: `app/actions/communications.ts`, `app/actions/crm.ts`
(marked `@deprecated` in favour of the communications one), and `app/actions/contacts.ts` — which is
the one `app/crm/page.tsx` actually imports. A three-way keep-one merge, not started.

## Owner rulings applied

### (a) CRM pull is a platform operation, not a tenant one

> *"crm pulls should only be done by the platform/global superadmin and staff because that is
> taking someone's books and importing. tenants can only sync out to their outside crm."*

Half of this was already true and half was inverted:

- **Sync-OUT** (`app/actions/crm-connect.ts`) is already tenant-facing and already outbound-only —
  its own header says *"SYNC-OUT ONLY — the app pushes contact updates out; no CRM syncs back IN."*
  Correct as-is, untouched.
- **Pull** admitted `agent` and `team_lead`, and imported into whatever brokerage the *caller*
  belonged to — while stamping the saved credential `owner_type: 'brokerage'`. The role set and the
  ownership claim disagreed, which is what the ruling resolves.

The pull could not simply be re-gated. It ran through `processImportRows`, which **derives the
brokerage from the caller's session by design** — a deliberately closed hole ("was previously
trusting caller-supplied brokerageId, letting any signed-in user bulk-create contacts in any
brokerage"). Gating that to platform staff would have landed the subscriber's book in the *staff
member's* tenant.

So the pull moved onto the lane that already does this correctly:

| | Before | After |
|---|---|---|
| Who | broker/admin/superadmin/**team_lead/agent** | platform staff with the `tenants` capability |
| Target tenant | the caller's own | an explicit `brokerageId` argument |
| Import lane | `processImportRows` (session-scoped) | `importParsedContacts` — the same lane the CSV white-glove uses |
| Audit | none | `superadmin_audit_log`, every run, honest counts |
| UI | a card on the tenant's own import page, ungated | `TenantCrmPullPanel` on `/dashboard/superadmin/brokerages/[id]`, beside the CSV panel |

**Consolidations this produced** (removals, not additions):
- `lib/platform/tenant-import.ts` — `importContacts` split into parse + `importParsedContacts`.
  One INSERT lane, two row sources (CSV text, vendor API). Dedupe, owner-agent resolution and the
  never-import-consent rule now provably identical for both.
- `lib/platform/tenant-import-parser.ts` — `parseContactFields` extracted; `parseContactRecords`
  added for object rows. One definition of "what a valid imported contact is".
- `lib/platform/staff-action-gate.ts` — `gateStaffAction` + `auditStaffAction`, replacing the
  private `gate()`/`audit()` pair inside `tenant-import.ts`. A staff action against a tenant cannot
  now be written without the audit trail being the path of least resistance.

The tenant's import page keeps its own CSV upload and gains an honest pointer to both the
white-glove migration and Connections, rather than the card silently vanishing.

### (b) and (c) — recorded, not yet built

### (b) settings/global vs settings/general — resolved by retiring `global`

> *"settings global is for the platform/global users (manager of this complete app/os) and
> settings/general is for everyone but both should not overlap or be duplicates of other
> setting types."*

Investigating the intent against the live code changed the answer. **`/settings/global` was never
a platform surface.** `global_settings` is per-brokerage (there is a `UNIQUE(brokerage_id)`
migration on it), so every field on that page belonged to one tenant. The genuine
platform/global surface — settings for whoever runs the whole OS — already exists at
`/dashboard/superadmin/platform`, platform-gated, and always did. Promoting `/settings/global`
into a second one would have created exactly the duplicate the ruling forbids.

So the page is retired, and its fields went to the surfaces that own their category. Mapping
every field first mattered: three of them existed **only** there, and deleting the page without
moving them would have removed working functionality.

| Field | Already owned by | Action |
|---|---|---|
| `app_name`, `timezone`, `date_format` | `GeneralSettingsForm` | duplicate — dropped from `global` |
| `primary_color`, `secondary_color`, `font_family` | `BrandingForm` | duplicate — dropped from `global`. **This answers the branding half of the ruling: they were already on the Branding page; `global` was the copy.** |
| `currency_symbol` | nothing | **moved → `/settings/general`** (workspace formatting, same family as timezone) |
| `email/sms/push_notifications_enabled` | nothing | **moved → `/settings/notifications`** as `NotificationChannelsCard` — master switches above the per-event rules they gate |
| Chat widget scope + embed code | nothing (`updateWidgetScope` had no other caller) | **moved → `/dashboard/settings/widget`** as `ChatWidgetScopeCard` — that page owns the launcher's look; this owns whose identity the conversation carries |

`/settings/global` now redirects to `/settings/general`, with the mapping recorded in the file so
the next person can see where each field went rather than guessing.

A near-miss worth recording: my first pass grepped only the route directories and concluded
Branding had no colour fields. They were in `app/components/settings/BrandingForm.tsx`. Searching
the route folder rather than the whole surface is the same directory-blindness that hid
`services/` from both schema guards — a one-directory search answers a one-directory question.

Live-verified: seeded a `global_settings` row, wrote every relocated field from the columns its
new home saves, confirmed all nine round-trip (including the three that existed only on the
retired page), then deleted the row to restore the tenant's prior state.

### (c) Target areas are brokerage-level — and the scrapers could not read one

> *"the target area scoping is brokerage level because it gives the platform/global the active
> brokerage territories that the scrappers need to find leads. farm areas is what the users
> determine for their marketing."*

The distinction is already modelled correctly and needed no merge:

| Table | Scope | Purpose |
|---|---|---|
| `lead_scraping_markets` (+ `lead_scraping_property_params`) | brokerage | what the scrapers may scrape — already resolved by active subscription and brokerage |
| `farm_territories` | agent | the user's own marketing farm, with its own monthly budget |
| `subscriber_service_areas` | brokerage / team / agent | where the subscriber operates |

Checking the ruling against the code found something much worse than a scoping question.

**The lead scrapers could not return a single territory.** `SCRAPE_TERRITORY_SELECT` requested
`lead_scraping_property_params (id, is_active, target_sites, min_price, max_price)`. That table has
**neither `is_active` nor `target_sites`** — verified against the live schema. PostgREST rejects the
**entire** query when an embedded select names a column the embedded table lacks, and the caller
discarded the error:

```ts
const { data: markets } = await supabase...   // error never checked
```

So `markets` was null, `territories` came back `[]`, and the resolver reported
`no_active_territories` — which reads as *"nobody has configured a market yet"* rather than *"this
query cannot succeed"*. The top of the entire funnel, dead by construction, reporting as idle.

Fixed: the two phantom columns dropped, the real params selected (**including `property_types`,
which already existed on the brokerage-level params row and was simply never read** — that is
walkthrough [49]'s second half, brokerage-scoped exactly as ruled), and a `territory_query_failed`
reason added so a broken query can never again look like an empty pipeline. The identical phantom
`is_active` in `lib/kernel/scraping.ts` was fixed with it.

### The guard blind spot this exposed — embedded selects

`parseSelectColumns` deliberately **strips** embedded relations, because their columns belong to a
different table. Stripping is correct; checking nothing afterwards was not. `parseEmbeddedSelects`
now resolves `embedded_table (a, b, c)` and checks each column against *that* table's snapshot.
Aliased embeds (`alias:fk(...)`) are skipped — the alias is not a table name — and
`related(count)` is exempt as PostgREST's aggregate.

The first run found **27 more of the same defect** across 15 files. Each one fails its whole query,
so each is a silently dead surface. Confirmed phantom against live schema:
`transactions.sale_price` (live: `purchase_price`), `transactions.property_type`,
`listings.sale_price` (live: `sold_price`), `listings.property_address`, `listings.listing_price`,
`messages.content`, `agents.first_name`/`last_name` (those live on `users`),
`brokerages.compliance_rules`, `brokerages.code`, `showing_feedback.feedback_text`/`rating`/
`sentiment`, `ai_isa_qualifications.created_at`/`qualification_notes`, and others.

**Burned down 27 → 1.** Each fix repointed the select AND its consumers, verified against the live
schema. What the dead queries were costing:

| Surface | Was |
|---|---|
| Seller portal showing feedback | whole showings query failed — `feedback_text`, `sentiment`, `rating` are all phantom. Real columns: `additional_notes`, `overall_impression` (CHECK: `loved_it`/`liked_it`/`neutral`/`not_interested`), `presentation_rating`. Sentiment now buckets off that constraint's own vocabulary instead of comparing to strings that could never appear |
| Showing reminder job | `listings(address, virtual_tour_url, matterport_url)` — neither URL column exists, so the **entire reminder cron** failed. Reminders never sent at all, not just without a tour link. Header comment corrected: the virtual-tour invitation is not active and needs those columns to exist first |
| Client gifting + sphere management | `transactions.sale_price` (live: `purchase_price`), `transactions.property_type` (no equivalent — a prompt line that could only ever say "Unknown" was removed rather than left) |
| AI communication hub | `messages.content` (live: `body`) — several consumers already read `m.body ?? m.content`, a half-finished rename that hid it |
| Lead lineage | `ai_isa_qualifications.qualification_notes`/`created_at` (live: `notes`/`qualified_at`); the client-side type declared the phantom names too, so tsc caught the second half |
| Voice call review + recruiting ROI | `agents.first_name`/`last_name` — agents has no name columns; they live on `users`, now embedded through it |
| Auth permissions | `brokerages.code` (live: `slug`) — in the **permission-resolution path**, ×3 |
| Marketing review, transaction service, link-to-video | `listings.property_address` → `address`, `listings.listing_price` → `list_price`, `brokerages.compliance_rules` (no equivalent) |

**Burned down to 0.** The last one I first called a schema gap: `tc-compliance-lender-vendor.ts`
filters on `transactions.assigned_tc_id`, which does not exist, and I concluded there was no
transaction-coordinator column at all. **That was wrong** — `coordinator_id` is the column, and the
closings query *six lines above in the same function* already filters on it correctly. I had checked
the schema for names I guessed at (`assigned_tc_id`, `tc_id`) instead of reading the working query
next to the broken one. The at-risk half of the TC's brief was empty while the closings half worked,
which is exactly the asymmetry that should have pointed at the answer.

### A guard-shaped footgun worth recording

Adding an explanatory comment between `.from("transactions")` and its chain turned the tenant-scope
guard red — twice, including on a pushed commit. The guard examines a fixed **500-character window**
after `.from(...)` for scoping evidence; a long comment pushes that evidence out of the window, so
the query reads as unscoped. Moving the comment out of the chain was not enough — it had to be
short. Documentation near a query is not free, and the failure mode is a guard that fails for a
reason that has nothing to do with the code's behaviour.

The new check got its **own ratchet** rather than joining the existing baseline. The direct-column
ratchet is deliberately held at **zero-zero** (a guard asserts it), and folding a newly-added
check's pre-existing findings into that file would have erased a standard the project set on
purpose. Same rule, separate list: nothing new may be added.


## Cross-tenant defects from free-text matching

A shape-based sweep (free-text value used as a lookup/join/conflict key with no tenant predicate)
returned 16 findings. Tier 1 — service-role clients, cross-tenant reads AND writes — is fixed:

| # | Defect | Reach | Fix |
|---|---|---|---|
| 1 | `provision-agent` upserts `users` with `onConflict: "email"` after an unscoped email lookup | live API route | A recruit whose email belongs to another brokerage silently had their user row, agents row and commission profile rewritten into the recruiting tenant. Now refused with a 409 and logged to `tenant_transition_log` — the same guard `lib/kernel/users.ts` already carried, which this route was missing |
| 2 | `dedupRawAgainstLeadAndContact` matched on email / phone / name with **no tenant filter** across 5 queries | kernel, reachable | It already **took `brokerageId` and never used it**. Another tenant's lead became the "duplicate" and their row id was returned to the promotion path; the name-only fallback (score 0.80) made that likely, not theoretical |
| 3 | inbound-mail webhook let a foreign tenant's contact **decide the brokerage** for the whole flow | live webhook | One shared email address filed offers and documents into the wrong tenant. Now resolves within the credential's tenant, and refuses to guess when an address is claimed by more than one |
| 4 | SendGrid webhook wrote `email_tracking` and updated `messages.status` on rows found by recipient email alone | live webhook | Engagement attributed to whichever tenant sorted first, and a status **write** onto another tenant's message. Now derives the tenant from the provider id — the only authoritative link — and correlates only within it |
| 5 | `getVendors` / `getVideoAssets` filtered by `category`, a free-text label, on the service-role client | `/api/vendors/list` — live | Every authenticated agent received **every tenant's** vendor directory, contact details included. `brokerageId` is now required; the route reads it from the caller's profile, never the request |

Live-verified with a second brokerage and one person deliberately known to both: every fixed shape
went from 2 tenants exposed to 1, and the inbound-mail ambiguity case is now detected rather than
silently resolved. All probe rows deleted — zero residue.

Tiers 2 and 3 (13 findings — global slug conflict targets, external-id upserts, RLS-bound
free-text lookups) are triaged and recorded but not yet fixed.

## Cross-tenant slug and external-id capture (Tier 2)

Correcting the sweep's framing first: `listing_landing_pages.slug`, `lead_capture_forms.slug` and
`qr_codes.slug` are **globally unique on purpose** — they resolve public URLs (`/listing/[slug]`,
`/forms/[slug]`, `/qr/[slug]`), and one address must mean one page. An unscoped *read* is therefore
correct and was not changed.

The defect is the **write**: an upsert whose conflict target is that global key lets one tenant take
another's row.

| Surface | Fix |
|---|---|
| `generateListingLandingPage` — `upsert(..., { onConflict: "slug" })` with a **caller-supplied** slug | Resolve the slug's current holder first; refuse if it belongs to another brokerage |
| ShowingTime sync — `upsert(..., { onConflict: "showingtime_id" })` | A ShowingTime id is unique only within a ShowingTime *account*, so two brokerages can collide. Foreign-owned ids are now skipped and counted (`skippedForeignShowingId`) rather than repointed |

Proved destructive on live data before fixing: an unguarded upsert from tenant B against tenant A's
slug rewrote **both the content and the `brokerage_id`** of A's published page. Probe rows deleted —
zero residue.

## Cannot be closed headless

Two loops need a preview environment with real credentials, and are honestly still open:

1. **Social DM live-fire** — the send path is built and guarded (`7e2f551`), but proving a real
   outbound DM requires live OAuth tokens on a connected account.
2. **Countersigned commission-agreement webhook return** — needs a real e-sign provider callback.

---

## Open design question — [49]'s second half

The document says the property-type selection *"should be selected by the subscriber in
target area"*. That reads two ways, and they build differently:

1. **Brokerage-level** — the subscriber picks which property types they transact; every
   selector offers that subset. One list per tenant.
2. **Per-territory** — the subset varies by `farm_territories` row (which already exists,
   brokerage+agent scoped with zips/city/state, but carries no property-type dimension).

Reading 2 adds a dimension someone then has to maintain per territory. I have not guessed
between them, because the choice determines the schema. The vocabulary work above is the
precondition either way and is done.
