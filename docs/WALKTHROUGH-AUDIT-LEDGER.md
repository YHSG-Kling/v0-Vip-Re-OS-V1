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

## Tier 3 — RLS-bound free-text lookups

| Surface | Defect | Fix |
|---|---|---|
| `sendPropertyToContact` (voice assistant) | matched `listings.address` with `ilike` and **no tenant filter — while already taking `brokerageId` as a parameter and never using it**. A spoken address could resolve to another tenant's listing, and the `activities` row then joined THEIR `listing_id` to this caller's brokerage and contact | scoped to `brokerageId`; `.single()` → `.maybeSingle()` so a miss is a miss, not a throw |
| `/portal` | resolved a contact by `email` with `.single()` and no tenant filter. A person who is a client of two brokerages got an arbitrary tenant's portal — and `.single()` **hard-errored on >1 row**, so the dual-tenant client saw a crash | takes the match only when unambiguous, then falls through to the `contact_user_id` / `user_id` lookups, which were always the reliable paths |
| `/api/sms/inbound-optout` | the fallback comment said the brokerage came from *"the `to` number's provider config"* — **the query never used `to`**. It took the first `twilio` row in `integration_credentials`, so an unknown number's STOP was suppressed under an arbitrary tenant | resolves the owning brokerage of the `to` number through `phone_number_events`; if the number can't be attributed, logs and does nothing rather than suppressing under a brokerage that never messaged them |

The cross-tenant phone suppression *above* that fallback (`.or(phone.eq…)` across all brokerages)
is intentional and documented — a STOP should suppress everywhere — and was left alone.

Live-verified with a third brokerage, one person known to both and one address listed by both:
the voice lookup narrowed 2 tenants → 1, and the portal now sees the ambiguity and falls through
instead of erroring. Probe rows deleted — zero residue.

**Still open from the sweep:** `neighborhood-report` matching `home_value_estimates.property_address`
(free text as a foreign-key substitute) and `collaborative_search_members.email` (scoped to a
tenant-owned search id, so bounded — flagged as shape, not a leak).

## `addContactNote` ×3 — investigated, needs the owner's call

Three exports share the name. Two are real; one is a delegate.

| Where | Writes to | Reached from |
|---|---|---|
| `app/actions/contacts.ts:300` | **`activities`** (`activity_type: "note"`) | `app/crm/page.tsx` — the note box a user actually types into |
| `app/actions/communications.ts:311` | **`contact_notes`** (+ syncs the note out to GHL) | `app/actions/crm.ts:434`, a thin `@deprecated` delegate |

**The duplication is not the two functions — it is the two tables.** A note lands in `activities`
or in `contact_notes` depending on which entry point was used.

What I checked before concluding anything: the contact timeline (`crm.ts`) reads **both**
`activities` and `contact_notes` and merges them, so **no note is invisible to the user today**.
This is drift, not an outage — worth stating plainly, because the same shape elsewhere in this
audit *was* an outage and it would be easy to overclaim here.

Why it still matters:
- `contact_notes` carries **`is_private`** and `author_user_id`. `activities` has no equivalent, so
  a private broker note is only expressible on one of the two paths.
- Editing or deleting a note has to know which table it came from.
- Only the `contact_notes` path syncs the note out to GHL.

**This is the owner's call, and I am not making it**, because the two candidates trade off against
each other rather than one being strictly better:
- Keep **`contact_notes`**: purpose-built, has the privacy flag, already syncs outward. Cost —
  `activities` is the ledger the AI managers read for context, so notes would need to be surfaced
  into that context deliberately.
- Keep **`activities`**: one ledger, already read by 173 files and by the AI managers. Cost —
  `is_private` and `author_user_id` must be added, and the GHL sync re-attached.

My recommendation, for what it is worth: keep **`contact_notes`** as the store and write a
lightweight `activities` row alongside it so the managers still see that a note happened. That
preserves the privacy flag and the outbound sync without blinding the AI context. But it is a
data-model decision with a customer-visible privacy feature attached, so it should be yours.

## A known weakness in the tenant-scope guard — measured, not shipped

Four of today's cross-tenant findings had the same signature: **the tenant id was already in scope
and simply not used in the query** (the scraping dedupe took `brokerageId` and never referenced it;
`sendPropertyToContact` took `brokerageId` and never referenced it; two comments described scoping
the code did not do). That is mechanically detectable, so I went looking for why
`tenant-scope-guard` had not caught them.

**The mechanism:** `SCOPE_EVIDENCE` lists parent ids — `contact_id`, `listing_id`, `agent_id`,
`transaction_id` — as **bare substrings**, and the guard passes a query if any appears within a
500-character window. So `contact_id: contactId` sitting in an INSERT payload *after* the query
counts as evidence that the query was scoped. That is precisely how `sendPropertyToContact`'s
unscoped `listings` lookup read as safe: the tenant evidence was in the next statement.

**Tightening it to require the filter form** (`.eq("contact_id"`, `.in("listing_id"`, …) is a
two-line change. I made it, measured it, and **reverted it**: it surfaces **74 additional sites**.

I am not shipping that, in either available form:
- Failing CI with 74 findings blocks the branch on work nobody has reviewed.
- Baselining 74 unreviewed entries (the tenant-scope guard tolerates debt — currently 5) would be
  the silent truncation this audit has spent the day removing. A number that large recorded as
  "known" is indistinguishable from a number that large ignored.

Recorded here instead, with the exact change and the exact count, so it is a decision someone makes
with the real number in front of them rather than a discovery someone repeats. The 74 are almost
certainly a mix of genuinely-scoped-another-way and genuinely-unscoped; separating them is the work,
and it is a session of its own.

## Three review findings on `4c49b15` — all self-inflicted, fixed in `3332c0a`

VADE reviewed the branch and raised three defects. All three verified against the code, and all
three were introduced by earlier commits **on this branch** — this is the audit auditing itself.

1. **The crm-pull guard was dead.** `d867a82` moved the pull UI to the superadmin tenant panel;
   the guard still read `app/dashboard/admin/import/crm-pull-card.tsx` and crashed `ENOENT`
   *before reaching half its checks*. The two assertions it did reach pinned the removed
   `processImportRows` call and `ctx.brokerageId`. Repointed at the migrated symbols, plus the
   checks the migration should have carried with it (the platform-staff gate on an explicit
   target tenant, and the pagination rule in 3).

2. **Recruit names rendered `undefined undefined`.** The embedded-column burndown (`c20032e`)
   correctly repointed the select at `agents.users(first_name, last_name)` — `agents` carries
   neither column — but left both consumers reading `agents.first_name`. The ROI table
   interpolated with no fallback, so the literal string reached the page; the acquisition page
   used `?? ""` and rendered blank instead.

3. **An all-invalid CRM page aborted the whole migration.** Worse than it reads: the `break`
   fired *before* `cursor = page.nextCursor`, so the returned cursor pointed back at the same bad
   page and every resume re-fetched it — permanently stuck. Those rows are already counted in
   `failed`, and the genuinely fatal cases (brokerage missing, no owner agent, dedupe scan
   failure) all sit *after* the `parsed.rows.length === 0` early return, so they can only arise
   once there were importable rows. Gated on exactly that.

**The structural finding underneath them.** `test:crm-pull` was **never in the `guard` chain** —
49 assertions about the white-glove import gate had been running nowhere, which is why a crashing
guard never surfaced. Wired in next to `test:crm-sync-credential`; it now runs in CI and passes.
This is the same failure mode as the `services/` blind spot above: a guard that exists is not a
guard that runs.

Two things found while verifying, that the review did not flag:

- **`agents` has no `status` column** and the select never requested one, so the ROI table's
  status badge had *always* read `Unknown`, on `main` too. `is_active` is the real signal.
- **One assertion was already failing on `main`** before this PR — it pinned `SUNSET LANE` in the
  tenancy matrix, wording the Vapi retirement replaced. Updated to the current text rather than
  left as a permanently-red check.

Verified on `3332c0a`: `type-check`, `crm-pull` (49/49, was crashing), `schema-drift`,
`tenant-scope`, `settings-authz`, `crm-sync-credential`. All five CI checks green.

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

---

## The guard chain covers 22% of the guards — measured, not wired

`test:crm-pull` turned out not to be a one-off. Auditing every `test:`/`check:`/`harness:`
script in `package.json` against what CI actually invokes:

| | count |
|---|---|
| `test:` / `check:` / `harness:` scripts declared | 548 |
| reachable from a CI entry point | **119** |
| never run by anything | **429** |

CI has exactly four entry points — `guard` and `guard:compliance` (`guards.yml`),
`test:e2e:flows` (`e2e.yml`), and `test:production-smoke` (`post-deploy-smoke.yml`). The other
429 simulators are invoked by nothing: not a workflow, not a chain, not another script.

**That headline number overstates the problem, and the split is the point.** 275 of the orphans
open a Supabase client and seed/assert/cleanup against the live database. Those cannot run in
GitHub Actions without a seeded tenant and service-role credentials, and leaving them out is a
defensible call rather than an oversight. The remaining **150 are pure in-memory simulators** —
no client, no network, no fixtures — and there is no cost argument for their absence.

So I ran all 150 rather than guessing:

- **147 pass.** Seconds each, no environment, no credentials.
- **3 fail** — `manager-governance` (24/25), `stripe-writethrough` (22/23), `cda-pdf-fill` (7/13).

**The three reds are pre-existing, not this branch.** Each fails identically on `origin/main`
(`f18bce1`) — same assertion, same counts — so they have been red for as long as they have been
unwired, which is the whole reason nobody noticed:

- `manager-governance` — one manager is not fully GOVERNED; the other 24 checks pass.
- `stripe-writethrough` — the entitlement engine does not read both spellings of an override
  value tolerantly. It *writes* the canonical one correctly, so this is a read-path gap.
- `cda-pdf-fill` — the worst of the three. Six failures: mapped values are not written onto the
  PDF, and agent commission and split do not round-trip. The guard's own honest cases (a value
  targeting a non-existent field is skipped, never invented) pass.

**Deliberately not wired in.** Adding 147 green scripts to `guard` is a real improvement, but it
is a CI-time and ownership decision, and the 3 reds each describe a live product gap that wants
triage rather than a `|| true`. The measurement is the deliverable; the wiring is the owner's
call. Same reasoning as the 74 tenant-scope sites above — measured and left visible rather than
baselined unreviewed.

Four scripts resolve to no simulator file, and none is a coverage gap:

- `test:e2e` / `test:e2e:ui` — Playwright against a running server; `e2e.yml` runs
  `test:e2e:flows` instead.
- `harness:integrity` — an alias for 11 guards that are **all already in `guard`**. Redundant,
  not missing.
- `check:kernel-client-leaks` — a bare `rg` with no pass/fail semantics. It exits 0 on 58
  matches, most of them legitimate server-side `processKernelEvent` imports in API routes. It
  cannot be wired as a guard until someone gives it an assertion; as written it would either
  always pass or always fail depending on how you read the exit code.

---

## Owner rulings applied — notes, matching keys, collaborative search

**`addContactNote` — owner ruled: keep `contact_notes`.** Applied, but *not* the way this
ledger previously recommended. The earlier note ("write a light `activities` row alongside") was
wrong, and checking before implementing is what caught it: `getContactTimeline` (`app/actions/crm.ts:152`)
already reads **both** tables and concatenates them. Writing both would have shown every note
twice. There is now exactly one writer and one row per note.

What the consolidation actually found — **a fourth note path, and a real bug**:

| path | wrote to | outcome |
|---|---|---|
| `contacts.ts` (CRM note box) | `activities` | no `is_private` / `author_user_id` |
| `crm.ts` → `communications.ts` | `contact_notes` + GHL | correct |
| `voice-assistant.ts` (local copy) | `contact_notes`, **no `brokerage_id`** | **invisible to everyone** |

`contact_notes_select` gates on `has_brokerage_access(brokerage_id)`, and that function is
`target_brokerage_id IS NOT NULL AND … ` — so it returns FALSE for NULL. Every voice-dictated
note was written successfully and then readable by nobody in the brokerage, including the agent
who dictated it. Not a leak; a disappearance. The local copy is gone and delegates to the
canonical writer.

Two smaller corrections came with it: the canonical writer no longer requires an `agents` row
(`contact_notes` attributes to `author_user_id`, so brokers/admins can leave notes), and the CRM
contact pane (`app/crm/page.tsx`) now reads `contact_notes` alongside `activities` — it read only
`activities`, so moving the write without this would have made saved notes vanish from that pane
on refresh.

**The neighborhood-report matching key — answered.** There is no FK to find:
`home_value_estimates` carries `brokerage_id`, `contact_id`, `valuation_request_id`,
`property_address` — and **no `listing_id`**. `valuation_requests` has no `listing_id` either, so
there is no join path from a listing at all. The honest key is `contact_id`: a listing hangs off
the seller contact, and the valuation was requested by that same contact. That is a real foreign
key, and it is now what the query matches on, scoped by `brokerage_id`. Matching bare
`property_address` missed `"123 Main St"` vs `"123 Main Street"` and could hit a different
property sharing an address string. Both tables are empty today, so this is preventive.

**`collaborative_search_members` — closed, by design and correctly enforced.** Owner: this is a
family collaborative on a subscriber's customer's property search. The committed migrations look
alarming (`063-rpcs-and-rls-fixes.sql` has `css_select … USING (TRUE)`), but that is **not** the
live policy — it has been superseded. Live `member_read_cs_members` requires either portal
membership of that search or that the parent `collaborative_searches.brokerage_id` is one of
yours. The table has no `brokerage_id` of its own and does not need one: it inherits scope from
its parent. No action.

## What the 147 unwired simulators actually cover

Ran a reachability analysis rather than reading 147 files: built the import graph over
`app/ lib/ components/ services/ hooks/` (4,300 modules), took every Next.js-served file as a root
(993 of them), and computed what is reachable. Then, for each unwired simulator, resolved the
modules it imports or names and asked whether **the app can reach them**.

The framing question — "is this feature present in the OS?" — turned out to be the wrong one.
Every one of the 147 green simulators asserts against code that **already exists**: they import
real modules, so a missing subject would throw rather than pass. The question that discriminates
is whether a *user* can reach it.

| | count |
|---|---|
| all subject modules reachable from a route | **136** |
| partially reachable | 4 |
| **no subject module reachable — built, tested, dark** | **10** |

The 136 need nothing but a decision about CI time. The **10 dark capability engines** are the
finding, and they are not junk — each is a deliberate, documented, unit-tested engine:

- **Video/animation rail** — `lib/charts/explainer-diagram.ts` (393 lines, the in-stack answer to
  Manim), `lib/video/ken-burns-plan.ts` (flat MLS photos → moving tour),
  `lib/video/comps-animation-spec.ts`, `lib/charts/geometry.ts`.
- **Seller decision intelligence** — `seller-listing-timeline.ts` (*when* a homeowner will list,
  not just how motivated), `seller-decision-room.ts` (which offer is genuinely best for the
  seller), `listing-price-advisor.ts` (the recommended new price, not just "this is stale").
- **Deal + relationship intelligence** — `deal-confidence.ts` (weakest link + the one protective
  action), `outcome-autopsy.ts` (learn from wins/losses, not just replies).
- **Lead-source diagnostics** — `source-wording-diagnostic.ts` (is the source bad, or is our copy
  not landing? — the difference between discarding a good source and fixing an opener).

Two of these are sharper than "unreferenced":

1. **`ExplainerAnimReel` is registered but unselectable.** It is a live Remotion composition in
   `remotion/Root.tsx`, and `lib/charts/explainer-diagram.ts` is its concept engine — but
   `lib/video/video-director.ts` lists eleven selectable `compositionId`s and that is not one of
   them. No agent-facing path can ever choose it. `PhotoWalkthroughReel`, by contrast, *is* in the
   Director's list, so `ken-burns-plan.ts` is only one hop from live.
2. **Two comps→chart shapes exist and one is unused.** `lib/charts/cma-reel-data.ts` feeds
   `CMAReel`; `lib/video/comps-animation-spec.ts` is referenced by nothing but its own simulator.
   Not pure duplication — the unused one additionally produces the *fair-value read*
   (below/at/above market + confidence) that the agent's offer narrative wants, and
   `cma-reel-data` does not. Consolidation should keep the richer output, not delete it.

Also checked and dismissed: `app/manifest.ts` reported unreachable is analyzer noise — Next.js
serves it as a special file and my root pattern did not list it. Recorded so nobody re-finds it.

**Not wiring any of this yet.** Where each belongs is a product decision about which domain
surface owns it, and the whole point of the exercise was to avoid scattering wires.

---

## The governance scorecard was dark — surfaced, and one red guard was unsatisfiable

Acting on the evaluation above rather than banking it. `lib/compliance/manager-governance-scorecard.ts`
was the single highest-value dark module: it maps each of the 14 named managers' authority scope to
the supervisory dimensions it must satisfy (FINRA-2026 autonomous-agent, OWASP LLM-01, GDPR/CCPA/TCPA)
and, for each, names the concrete guard in this repo that enforces it. Nothing rendered it.

**It did not need a new page.** `app/dashboard/admin/compliance-eval` already surfaces
`runManagerEval` — the *behavioural* red-team harness. The scorecard is its *structural* companion:
the eval proves the managers behave, the scorecard proves their authority is bounded. They belong on
one page, and now they are. No new route, no new nav entry, no scattered wire.

**`test:manager-governance` was not reporting a governance gap — it could never pass.** The
assertion read `s.governed === 13 && s.gaps === 0` while the line directly above it asserted
`s.totalManagers === 14`. Since `governed + gaps === totalManagers` by construction, that pair is
arithmetically unsatisfiable: it went stale the moment a 14th manager was added. All 14 managers
are, and were, fully governed. Corrected to assert the invariant (`s.governed === s.totalManagers`)
rather than a headcount literal, so adding manager 15 cannot re-break it. 24/25 → **25/25**.

This corrects what the previous ledger entry implied — that one manager was ungoverned. It was a
stale test, not a product gap. Two of the three long-red guards remain: `stripe-writethrough` (22/23,
entitlement engine reads only one spelling of an override) and `cda-pdf-fill` (7/13, the real one).

Verified the surface renders real data, not empty shells: 14 cards, 0 malformed, genuine counts
(Deal Coordinator: 69 owned tables, 13 scheduled jobs, 4 catalogued signals, 48 burn domains).

`test:manager-governance` is now wired into the `guard` chain — a single deliberate entry for the
guard covering the surface just shipped, not the mass-wire that was refused. The other 146 remain
the owner's CI-time decision.

---

## ExplainerAnimReel is selectable — and the Director's own proof was under-covering

The animated explainer was the cheapest of the ten dark capabilities: a registered Remotion
composition (`remotion/Root.tsx`) with a 393-line tested concept engine
(`lib/charts/explainer-diagram.ts`), which `lib/video/video-director.ts` could never choose
because it was not among the eleven selectable `compositionId`s.

Added as its own `SituationKind` (`concept_animation`) rather than a flag on `explainer`, matching
the precedent `lead_intro` already set — the treatment differs at every layer (no avatar, charts
on, no b-roll, per `finish-spec`'s `CHART_REEL, broll: "none"`).

**It was not one array entry.** `SituationKind` feeds seven switches, and wiring only the format
map would have left the rest returning `undefined`:

- `musicMoodForSituation` → `calm` (teaching cut; music must not fight narration)
- `qrKindForSituation` → `explainer`. The `default` here is `just_listed`, so falling through
  would have pointed a concept explainer's outro QR at a listing page.
- `qrCaptionForSituation` → "Scan to book a consult" (default was "Scan to see the listing")
- `defaultHookForSituation` → "Let Me Show You"
- `videoTypeForSituation` → `education`, reusing the existing `ai_video_projects.video_type`
  CHECK value; a new literal would be rejected by the constraint
- `compositionHintFor` (voice studio) → `ExplainerAnimReel`

**tsc caught exactly one of those six.** `tsconfig` has `noImplicitReturns` OFF, so a switch that
misses a kind returns `undefined` rather than failing to compile. Only `compositionHintFor` errored
(its return type excludes undefined). The type checker is not a safety net here — the switches were
found by reading each one.

**Two pre-existing defects surfaced while doing it:**

1. **The Director's guard was testing 12 of 14 kinds.** `ALL_KINDS` in
   `scripts/video-director-simulator.ts` is hand-maintained, and `photo_walkthrough` and
   `lead_intro` were added to the type and never added there — so every assertion in that layer
   silently skipped them. Now 15 kinds and 90 situation×channel combos (was 72). The guard now
   reads the `SituationKind` union back out of the source and asserts `ALL_KINDS` covers it, plus
   asserts no mapper returns `undefined` — the check tsc cannot perform.
2. **Two disagreeing evergreen lists.** `planStudioSession` had its own hardcoded
   `evergreenKinds` fallback that had drifted from the `defaultTopics` the voice studio passes in.
   Collapsed to one exported `DEFAULT_EVERGREEN_TOPICS`; the fallback now derives from it.

Verified end-to-end, not just compiled: a real 2-week voice-studio plan schedules an "animated
concept explainer" slot resolving to `ExplainerAnimReel`, with zero undefined composition hints,
on both the supplied-topics and fallback paths. All 15 kinds return defined values from all six
mappers.

---

## The seller decision room was a duplicate — merged, not wired

Second of the ten dark capabilities. The plan was to wire `lib/kernel/seller-decision-room.ts`
into the listing offers surface. Investigating first changed the answer.

**`app/dashboard/listings/[id]/offers` already ships the comparison.** `MultiOfferMatrixCard`
(via `lib/workflow/intelligence/multi-offer-matrix.ts`) renders "Highest price", "Best net to
seller", "Most likely to close" and a full matrix — exactly what the decision room was built to
produce. Adding it as a third card would have been the drift this ledger keeps refusing.

But deleting it would have thrown away the one thing it has that the shipped path does not:

| | shipped matrix | decision room |
|---|---|---|
| comparison table | yes | duplicate |
| three superlatives | yes | duplicate |
| **single recommendation** | **LLM `aiSummary`** | **deterministic rule** |
| **highest-net ≠ highest-price flag** | no | `netBeatsPrice` |

So the resolution is a MERGE. The deterministic recommendation and the `netBeatsPrice` insight
now render inside the existing matrix card; nothing else from the module is surfaced, because the
rest already exists.

**Why keep a rule-based recommendation next to an AI one.** "Which offer should I accept" is
advice with legal weight. The matrix's recommendation is an LLM-written three-paragraph summary;
this one is reproducible from the inputs and can be replayed in an audit. That is the same
argument the governance scorecard above makes — for the questions that carry liability, bounded
and deterministic beats fluent. Both now render, labelled, side by side.

**Three defects found by actually running it rather than trusting the guard's 11 green checks:**

1. **A duplicated `SellerCosts` interface.** The module declared its own five-field copy of the
   canonical type in `lib/offers/net-sheet-calc.ts`. It is now
   `Omit<NetSheetSellerCosts, "buyerClosingCredit">` — the exact shape `computeNetProceeds`
   accepts, so the two cannot drift.
2. **Ungrammatical seller-facing prose.** The outcome line interpolated `The ${tag}.`, and the
   neutral branch's tag is "in the mix" — so any offer that was neither top-net nor top-certainty
   told the seller "The in the mix." Tags are full sentences now.
3. **A raw enum leaked into prose** — `very_strong` rendered verbatim in "Buyer looks very_strong".

None of the three were caught by `test:seller-decision`, which passed 11/11 throughout: it
asserted the ranking maths, never the strings a seller reads.

Verified on a realistic two-offer case: a $612,000 cash offer with no closing credit nets $319,880
against a $620,000 financed offer asking $15,000 back, which nets $312,400 — lower sticker, more
money, `netBeatsPrice: true`. Empty input still returns empty (no fabrication).

`test:seller-decision` is wired into the `guard` chain, same principle as `manager-governance`:
the guard covering a live surface runs in CI.

**Dark capabilities: 10 → 7 closed or resolved** (governance scorecard surfaced, explainer-diagram
wired, decision room merged).

---

## Owner ruling: the agreed commission and fees belong in EVERY net sheet

Two net sheets existed and they disagreed about the seller's money.

| | commission source | flat fee | both sides |
|---|---|---|---|
| CMA tab (`cma/tabs/net-sheet-tab.tsx`) | `listing_agreements` rates | **ignored** | yes |
| Offers tab (`offers/page.tsx`) | `listings.commission_rate`, else **6%** | ignored | **no** |

The offers sheet was the worse of the two, and it is the screen where the seller actually picks
an offer. It applied a single listing-side rate. The seller normally pays **both** sides, so the
commission was understated and the net **overstated** — on a $600,000 sale, a 3% listing-side rate
against an agreed 5.5% total understates by **$15,000**. That number then fed the deterministic
recommendation added in `b27bde3`, so the recommendation was being computed on an inflated net.

**One resolver, not a third interpretation.** `resolveAgreedCommission` now lives in
`lib/offers/net-sheet-calc.ts` — the canonical net-sheet module — with this precedence:

1. flat fee (`commission_is_flat_fee` + `commission_flat_amount`) → the amount IS the commission
2. `total_commission_rate`
3. `listing_commission_rate + buyer_commission_rate` (both sides)
4. `listings.commission_rate` — listing side only, **flagged as an estimate**
5. house default 6% — **flagged as an estimate**

Rates are stored as PERCENT values (3 means 3%), matching `lib/revenue-protection/scorer.ts` and
`app/actions/seller-cma.ts`. Steps 4 and 5 carry `isEstimate: true` and a label, because
`scorer.ts` already treats a listing with no executed agreement as a **critical data-integrity
finding** — silently quoting 6% as if it were agreed is exactly what that guard exists to catch.
The offers page now renders an amber "Commission is an estimate" strip in those cases and a blue
"per listing agreement" strip otherwise.

**The CMA sheet had its own two gaps**, fixed here rather than left for later:

- **Flat fee was ignored entirely** — a flat-fee listing was charged a percentage of price. On a
  $600k sale with a $12,000 flat fee, the sheet showed $36,000 of commission. The flat amount is
  now charged as-is, the percentage inputs are replaced by the agreed amount (editing a percent
  under a flat fee moved nothing), and the row reads "Commission (flat fee per agreement)".
- **`total_commission_rate` was ignored** — an agreement recording only a total fell through to
  the 3/3 default and quoted 6%. The total now lands on the listing line with the buyer line at 0,
  so the two still sum to the agreed figure.

The pre-fill notice also fired only on an explicit listing-side rate, so flat-fee and total-only
agreements looked like un-agreed defaults. It now covers all three.

Verified across all seven precedence branches, including the degenerate flat-fee-with-zero-price
case (returns 0, no divide-by-zero). `test:offer-net-sheet`, `test:net-sheet-surprise`,
`test:cma-presentation`, `test:cma-data`, `test:seller-closing-costs`, `test:commission-disclosure`,
`test:seller-decision`, `test:tenant-scope`, `test:schema-drift` all pass; type-check clean.

**Third net sheet — the seller's own portal card.** `runOfferNetSheets`
(`lib/kernel/offer-net-sheet.ts`, the cron behind the portal card and the agent summary) carried
the identical `lst.commission_rate ?? 0.06` line. That is the most seller-visible of the three:
the number a seller reads in their portal without an agent present. Now resolved through the same
`resolveAgreedCommission`, and the runner's existing per-line provenance ledger records the
commission line as `confirmed` / `template` / `default` to match, so the sheet's own
disclose-first policy (`decideNetSheetPolicy`) sees an unbacked commission for what it is.

All three sheets — CMA tab, offers tab, portal cron — now price from one resolver. There is no
fourth: `net_sheet_calculations` is a persisted result, not a second calculator.

---

## Owner ruling: a flat transaction fee is a net-sheet line

`SellerCosts` had no line for a brokerage transaction fee charged to the seller at closing, so
every net sheet overstated the seller's proceeds by it.

**The trap this had to avoid.** `agent_commission_profiles.transaction_fee`, `agents.transaction_fee`
and `transaction_fee_type/value` already exist — and they are **agent-side**: what the agent pays
the brokerage out of their own split. Reusing them would have deducted the agent's desk cost from
the seller's proceeds. Different payer, different column. `listing_agreements.seller_transaction_fee`
(m286) is the seller-side term, flat dollars only; a percentage charge is commission and belongs in
the rate columns.

Added as a **required** field on `SellerCosts` rather than optional, which made the compiler
enumerate every consumer instead of letting some silently keep the old total: the interactive sheet,
the equity estimator, and three simulators. All updated; the pre-listing equity estimate passes 0
deliberately (no listing agreement exists yet to set one).

It flows through all three sheets, the provenance ledger (`transactionFee` is a `CostLineKey`,
defaulting to `template` — a brokerage fee is policy, and zero is a real answer), and the
deterministic seller recommendation, which shares the same cost lines.

**Persistence, because a vanishing edit is the bug I keep finding.** Every other editable line on
the CMA sheet persists; a transaction fee that reset on reload would have been the same class of
half-wire. m287 adds `net_sheet_calculations.transaction_fee`, the saved sheet wins over the
agreement default, and `saveNetSheet` carries it into the total.

Two smaller things fixed in passing: the CMA tab's `currentNetSheet` — the payload shared to the
**seller's portal** and fed to the AI explanation — omitted the fee while `netProceeds` included
it, so the seller's own numbers would not have reconciled; and `saveNetSheet`'s `totalCosts` had to
include it or the persisted net would disagree with the rendered one.

Verified: the fee is flat, reduces net by exactly its amount, and stays $495 at double the sale
price rather than scaling like a percentage. Both migrations applied live and recorded in the
snapshot; `schema-drift` green.

---

## Title fees and doc stamps were missing from the CMA net sheet only

Owner: "title fees and/or doc stamps have been left off net sheets — I thought I did that in
another pass." Both halves are right. The work was done; it was mounted on two of the three sheets.

`lib/offers/regional-closing-costs.ts` is a 50-state + DC convention table that already models the
seller's customary share as the exact complement of the buyer's (`sellerShareFactor`, so the two
sides can never double-claim or drop a cost), including the county-level realities in its notes —
FL doc stamps at $0.70/$100 with the Miami-Dade surtax, CA county documentary transfer tax, MD
county transfer + recordation, NV by county (Clark $2.55/$500), IL state + county with Chicago's
buyer-paid city portion. `deriveNetSheetClosingCostSection` turns it into itemized lines.

Mounted on the **offers** net sheet and the **seller portal** calculator. **Not** on the CMA net
sheet — the one an agent uses at the listing appointment, which fell back to `price * 0.02`.

**A blind 2% is wrong in both directions.** On a $600,000 sale it charges $12,000 against real
regional midpoints of:

| | midpoint | vs the flat 2% |
|---|---|---|
| CA | $3,985 | overstated by ~$8,000 |
| TX | $4,215 | overstated by ~$7,800 |
| NY | $5,000 | overstated by ~$7,000 |
| MD | $5,800 | overstated by ~$6,200 |
| NV | $6,165 | overstated by ~$5,800 |
| WA | $11,205 | roughly right |

Overstating closing costs **understates the seller's net** — so the sheet was quoting a listing
appointment a number that was thousands of dollars pessimistic in most states, and the seller was
never shown what the money was for.

The CMA sheet now mounts the same section: itemized Transfer/deed tax (seller share), Owner's title
insurance (seller share), Settlement/escrow (seller share), Recording — deed & payoff release, each
as a low–high band under the Closing Costs row, recomputed as the scenario price moves, with the
settlement statement named as the authority and the field still editable. Unknown state → the flat
2% stands, honestly unlabeled, exactly as the other sheets behave.

`listing.state` was already reaching the CMA client; only the tab's local `Listing` interface
failed to declare it. The module is pure and client-safe (its only import is a type), so no server
boundary was crossed.

All three sheets now price commission, the transaction fee, and regional closing costs from the
same models.

---

## Price advisor — NOT a duplicate, and the first consumer found a unit trap

Fourth dark module. Investigating first was again the right call, but this time the verdict flipped
the other way: `lib/kernel/listing-price-advisor.ts` is genuinely missing capability, not a copy.

Three things exist and only two of them were built:

| | question answered | exists |
|---|---|---|
| `pattern-detector` `price_reduction_likely` | *is* a reduction likely? (DOM/showings/offers) | yes |
| `price_predictions` → `/dashboard/listings/ai-pricing` | what is this worth? (an AVM) | yes |
| `listing-price-advisor` | **what price, and why — or is price not the problem?** | dark |

The third is the one an agent actually needs to open a seller conversation, and its honesty is the
point: it anchors to the comp median and never recommends below it, and it **declines** when the
listing is already priced at comps — "the issue is exposure or condition, not price" — which is
information, not a non-answer.

**Home: the listing health board** (`/dashboard/listings/health`), which already ranks listings by
how worried the agent should be and had `days_on_market` but no showings velocity and no comp
anchor. Both now come from real rows — `showings` bucketed last-14d vs prior-14d for the velocity
trend, and the newest `cma_reports.recommended_price` as the comp median — each tenant-scoped to
the agent's brokerage. No new route; the advice renders inside the existing card, and a decline
renders too so the agent learns price is not the lever.

**`dropPct` returned a fraction.** It was computed as `dropAmount / currentPrice`, so a 5% cut came
back as `0.05` under a field named `Pct` — and the very first consumer (this one) rendered
"0.05%". Nothing else consumed the module, so the name was made true rather than the trap
documented: it now returns 5.0, matching the repo convention where stored rates are percent values
(`listing_agreements` holds 3 for 3%). The simulator only compared `dropPct` values relatively, so
the change was safe; verified 8/8 still pass.

`test:price-advisor` wired into the `guard` chain — the guard for a live surface runs in CI.

**Dark capabilities: 10 found, 4 resolved.** Remaining: seller-listing-timeline, deal-confidence,
outcome-autopsy, source-wording-diagnostic, ken-burns-plan (one hop from live), comps-animation-spec.

---

## Sweeping for the closing-fees pattern found a worse one on the same screen

Owner asked whether other code files were half-mounted the way the regional closing-cost model was.
Ran a targeted sweep for **inline money math** — a surface computing a figure a shared model already
owns — across `app/` and `lib/`. 44 sites; most are noise (`limit ?? 3`, image padding, lead-rate
estimates). One is serious.

**`lib/workflow/intelligence/multi-offer-matrix.ts` priced net-to-seller at a flat 6%.**

```
const estimatedSellerCosts = offerPrice * 0.06   // "commission + closing"
```

That single constant stood in for the agreed commission, the regional closing lines, the
transaction fee — and **the mortgage payoff**, which is normally the largest deduction of all and
was simply absent.

Why it matters more than the CMA closing-cost gap: this is the **same card**. `MultiOfferMatrixCard`
renders "Best net to seller" from this number, the deterministic recommendation added in `b27bde3`
directly above it from the real cost lines, and `InteractiveNetSheet` sits immediately below using
the same real lines. Three figures on one screen, one of them computed differently — so the matrix
column could name a different winner than the recommendation two inches above it.

Now uses `computeNetProceeds` with the same `defaultSellerCosts` + `resolveAgreedCommission` +
`deriveNetSheetClosingCostSection` inputs as its neighbours. Mortgage payoff still defaults to 0 —
unknowable server-side — but that now matches the net sheet's own default and its provenance
ledger already flags an unconfirmed payoff rather than hiding it.

**Also surfaced, recorded not yet fixed:**

- `app/actions/seller-cma.ts` `saveNetSheet` recomputes `totalCosts` server-side with `?? 3`
  commission defaults and `salePrice * 0.02` closing costs. The agent now sees agreed commission +
  regional lines on screen, so a **saved** sheet's `total_costs`/`net_proceeds` can disagree with
  the sheet that was saved. The rendered figures are right; the persisted ones can be stale.
- `app/actions/ai-listing-presentation.ts:265` and `lib/kernel/transactions.ts:1323` carry their own
  `?? 3` commission fallbacks.
- Revenue proxies disagree with each other: `lib/kernel/reporting.ts` and `app/actions/source-analytics.ts`
  use `purchase_price * 0.03`, while `lib/financials/revenue-projection.ts`,
  `lib/income-engine/action-recommender.ts` and `lib/agent-action-queue/composer.ts` use `* 0.025`.
  Analytics proxies rather than seller-facing money, but two different house rates for the same
  concept is the same drift in a lower-stakes place.

The method generalises: grep for the magic constant a shared model was built to replace. Every one
of these is a surface that predates the model and never got repointed.

---

## Source wording-vs-quality diagnostic — the one that protects lead spend

Fifth dark module, onto `/dashboard/analytics/source`, which already computes the funnel rates it
needs (`lead_to_contact_rate`, `contact_to_appt_rate`, `close_rate`) and had nowhere to say what
they MEAN.

The question it answers is the one that costs real money: a source with poor outcomes looks
identical whether the leads are bad or the opener is bad — and downranking it in the second case
throws away good leads over a fixable copy problem.

The discriminator is ENGAGEMENT vs DOWNSTREAM CONVERSION. `messages` has no open tracking, so
reply rate carries it (the stronger signal regardless): outbound vs inbound messages to that
source's contacts, attributed through a `contact_id → source::family` map built inside the existing
contacts loop, so nothing is re-queried. Benchmarks are **brokerage medians**, not absolute
thresholds — "low" has to mean low *here*.

Verified against the cases that matter:

| scenario | verdict |
|---|---|
| low replies, healthy downstream | **wording_issue** — "the leads are good, the opener isn't landing. Test a different copy angle, don't downrank." |
| leads never qualify to contacts | targeting_issue — adjust cadence before judging the source |
| replies at/above benchmark | healthy — copy is landing |
| 4 touches sent | insufficient_data — refuses to judge below 25 |

The verdict renders under each source's close rate, with the full reasoning on hover, and only when
it is NOT healthy — a clean source stays visually quiet.

`test:source-wording` wired into the `guard` chain.

**Dark capabilities: 10 found, 5 resolved.** Remaining: seller-listing-timeline, deal-confidence,
outcome-autopsy, plus ken-burns-plan (reachable through the Director, flagged only because `app/`
does not import it directly) and comps-animation-spec (a consolidation call, not a wiring one).

---

## Deal confidence — and three fabricated percentages on the transaction page

Sixth dark module, onto `app/transactions/[transactionId]`, which already renders the health score
and the per-factor breakdown from `transaction_health_factors`.

**What was actually there.** Between the score and the factor list sat three hardcoded rows:

```
Timeline Adherence   92%
Document Completion  85%
Client Engagement    78%
```

Static literals, identical on every transaction in the system, rendered in the same visual language
as the real scored factors directly beneath them. Not a missing wire — fabricated data presented as
measurement. They are gone.

In their place, `distillDealConfidence` over the REAL factors: the verdict, the single weakest link,
and the one protective action. Weakest link is the largest **weighted** shortfall — `(100 − score) ×
weight` — so a 40/100 lender (impact 840) outranks a 70/100 documents (impact 240) rather than
whichever number simply looks lowest. With no scored factors it says so instead of inventing a
verdict.

**A client/server split had to come first.** `lib/deal-health/health-scorer.ts` owns
`CATEGORY_WEIGHTS` but imports `createServiceClient`, so a `"use client"` page cannot reach it — and
a second copy of the weights in the UI is precisely the drift this ledger keeps recording. Extracted
to `lib/deal-health/category-weights.ts`, client-safe, with the scorer importing from it: one
source, no copy. Same split `lib/offers/net-sheet-calc` made from `lib/kernel/offer-net-sheet`, for
the same reason.

`weightForFactorType` normalises the stored `lower_snake` `factor_type` to the UPPER weight keys, so
the UI never guesses. Verified: weights sum to 100, an unknown factor type scores 0 weight (and is
filtered out rather than silently weighted), and the empty case returns "nothing is dragging this
deal".

`test:deal-confidence` wired into the `guard` chain.

**Dark capabilities: 10 found, 6 resolved.** Remaining: seller-listing-timeline, outcome-autopsy,
plus ken-burns-plan (reachable via the Director — an analyzer artifact, not a real gap) and
comps-animation-spec (a consolidation call).

---

## Generalising the sweep past money — and a correction

The money sweep worked by grepping for the magic constant a shared model was built to replace.
Generalised it to three domain-agnostic signals across `app/` and `lib/`.

### Fabricated metrics rendered as measurement

Two, both real, both fixed:

- **`app/video-assistant/page.tsx`** — `AI Accuracy  98%`, a literal sitting between
  `{scripts.length}` and `{scripts.filter(s => s.video_url).length}`. Two real counts either side
  made it read as measured; nothing in this system measures script accuracy. Removed rather than
  replaced with a different guess, and the grid is 2-up now.
- **`app/components/shared/compliance/violations-dashboard.tsx`** — `100%` for
  `coldLeadChannelCompliance`. Not fabricated (a real boolean drives it) but a boolean rendered as
  a percentage implies a measured rate, on a compliance surface where that matters. Now reads
  "Compliant".

Combined with the three hardcoded percentages on the transaction page (`160b688`), that is the
whole of this class the sweep can see: literals adjacent to real metrics. It cannot see a
*plausible-looking but wrong* computed value — only a human reading the math catches those.

### CORRECTION: there IS a fourth net sheet

An earlier entry claimed "there is no fourth: `net_sheet_calculations` is a persisted result, not a
second calculator." That was wrong. **`app/actions/cma-presentation/net-sheet-calculator.ts`**
(457 lines, `generateNetSheet`) is a fourth calculator, with five caller files including the voice
assistant's command executors. The near-twin sweep found it; the money sweep missed it because it
does not hardcode a constant — it reads its numbers from config.

It is not simply behind, which is why this needs the owner rather than a quick merge:

| | canonical (`lib/offers/net-sheet-calc`) | `net-sheet-calculator.ts` |
|---|---|---|
| commission | agreed terms from `listing_agreements` (flat fee / total / both sides) | brokerage `getDefaultCommissionStructure` |
| closing costs | itemised 50-state regional bands | `financial_defaults.closing_cost_percent` |
| transaction fee | yes (m286/m287) | no |
| provenance + disclose-first policy | yes | no |
| brokerage-configured defaults | **no** | **yes** |
| multi-scenario | via callers | built in |

The canonical model is more accurate and more honest; the fourth has one capability it lacks — a
**brokerage-level configured closing-cost percent**. "Keep the advanced one" therefore means
folding `financial_defaults.closing_cost_percent` into the canonical resolver as a tier that
outranks the regional estimate but yields to a real agreement, then repointing all five callers.
That is a real piece of work with voice-command blast radius, not a rename.

### Duplicate exported names — 229 groups, mostly layering

Most are legitimate (`app/actions` → `lib/services` → `lib/kernel` for one concept). The ones that
look like genuine triplication rather than layering:

- `TrainingProgressPanel` — the same component in three directories (academy, admin onboarding,
  dashboard onboarding).
- `calculateLeadScore` × 3 (`ai-auto-response`, `multi-factor-scorer`, `lead-management.service`).
- `markCommissionPaid` × 4, `completeMilestone` × 4, `generateVideoScript` × 7.

And two near-twin pairs in the same domain: `lib/fatigue/fatigue-calculator.ts` vs
`lib/fatigue/fatigue-scorer.ts` (same directory), and `lib/alerts/alert-engine.ts` vs
`lib/property-alerts/alert-engine.ts`.

Recorded rather than resolved: each needs the same investigate-first treatment the seller decision
room got, where the "duplicate" turned out to be one shipped feature plus one unique capability.
`generateVideoScript` × 7 is the highest-value thread to pull.

---

## Seller time-to-list — the radar knew HOW motivated, never WHEN

Seventh dark module, into `lib/kernel/listing-inventory-radar.ts`, which already scores seller
intent from real scraped signals and ranks the bench.

The gap it fills: intent answers *how motivated*, not *when*. Different distress carries different
KNOWN clocks, and working the most motivated owner is not the same as working the right owner
today. Verified against realistic candidates:

| candidate | class | window | why |
|---|---|---|---|
| pre-foreclosure | forced | 30–90d | forced auction clock |
| FSBO | active | 0–45d | already selling |
| fresh expired (5d) | opportunity | 7–60d | imminent re-list |
| probate | opportunity | 120–365d | court-paced |
| long tenure + high equity | eventual | 90–365d | likely downsizer |
| no signal | unknown | — | refuses to guess |

**It annotates; it does not promote.** The module's own header is explicit that the canonical gate
(`listing-inventory-radar → raw_scraped_leads → processRawRecord`) still decides what becomes a
lead, and nothing here touches that path — `ScoredSellerLead` simply carries a `timeline` field now.

**Intent still leads the sort.** Timeline is a TIE-BREAKER, not a re-rank: a hot seller outranks a
merely imminent one, and among equally motivated owners the nearest clock comes first. Inverting
that would have quietly changed which sellers the ISA works — a behaviour change dressed as an
annotation.

The tags come from the same real signals the scorer credits (source, motivationType, quickLists,
intentSignals, plus the fsbo/absentee/vacant booleans), with expiry recency, tenure and equity
passed through. Nothing invented for the timeline's benefit.

`test:seller-timeline` wired into the `guard` chain.

**Dark capabilities: 10 found, 7 resolved.** Remaining: outcome-autopsy, plus ken-burns-plan (not a
real gap — reachable via the Director) and comps-animation-spec (a consolidation call).

**The full `guard` chain was run locally end to end for the first time this session: exit 0.** All
six newly added entries (manager-governance, seller-decision, price-advisor, source-wording,
deal-confidence, seller-timeline) pass inside the real chain, not just individually.

---

## Win/loss autopsy — the last dark module

Onto `lib/lead-pipeline/source-lifetime-health-runner.ts`, which already walks every converted
contact and reads its live relationship-health band. Same walk, different axis: that runner grades
**sources** by lifetime health; the autopsy grades **channels** by which one earned the last
engagement before the relationship forked.

Why it is not the reply-rate signal already in the codebase: reply rate says what gets *opened*.
This says what preceded the *outcome* — a channel can be replied to constantly and still be the
last thing said before a relationship goes dormant. Verified on exactly that shape: five contacts
where every one replied to email, but the wins all ended on a call —

```
  call    wins=2  losses=0  winRate=100%
  email   wins=0  losses=2  winRate=0%
```

Reply rate alone would have rated email fine.

**Only the decided ends count.** Thriving is a win, dormant is a loss; the middle bands are still
in play and would dilute the signal, so they are excluded rather than bucketed. A contact that
never replied credits no channel at all — verified — instead of silently crediting the last touch
we happened to send.

The touch mapping is honest about what the data supports: `messages.type` is the channel and an
INBOUND message *is* the reply, which is precisely what `replied_at` marks. No inference pairing
outbound sends to later inbounds.

`test:outcome-autopsy` wired into the `guard` chain.

**Dark capability burndown complete: 10 found, 8 resolved.** The remaining two are not gaps —
`ken-burns-plan` is reachable through the Video Director (the analyzer flagged it only because
`app/` does not import it directly, `remotion/` does), and `comps-animation-spec` is a
consolidation call against `cma-reel-data` where the unused module uniquely produces the fair-value
read: keep the richer one, do not delete.

### Still open, recorded, owner's call

- **The fourth net sheet** (`app/actions/cma-presentation/net-sheet-calculator.ts`) — fold
  `financial_defaults.closing_cost_percent` into the canonical resolver as a tier above the
  regional estimate and below a real agreement, then repoint five callers including voice commands.
- **`saveNetSheet` recomputes totals** with `?? 3` and `salePrice * 0.02`, so a saved sheet can
  disagree with the sheet that was saved.
- **`generateVideoScript` × 7**, `markCommissionPaid` × 4, `completeMilestone` × 4,
  `calculateLeadScore` × 3, `TrainingProgressPanel` × 3, `fatigue-calculator` vs `fatigue-scorer`,
  two `alert-engine`s — each needs the investigate-first treatment, not a bulk merge.
- **Tenant-scope guard burn-down** — the 74 sites, with the INSERT-payload caveat.
- **`stripe-writethrough` (22/23) and `cda-pdf-fill` (7/13)** — pre-existing on `main`.

---

## VADE on `f0442e7` — both findings correct, both mine, both worse than reported

Two findings, on code written in this session. Verified against live data before touching anything;
both confirmed, and the second was larger than the review stated.

**1. The neighborhood-report home-value fallback was dead code.** The commission-key work keyed on
`listings.contact_id`. Live: `contact_id` is populated on **0 of 3** listings, `seller_contact_id`
on 1. The column exists, so it type-checked and passed every guard — it simply is not the seller.
The reasoning in that ledger entry was right ("the listing hangs off the seller contact"); the
column name was wrong, which made the guard short-circuit and the whole fallback unreachable.
Repointed to `seller_contact_id`.

**2. The Deal Confidence panel could never render — and the table was wrong, not just the filter.**
VADE reported the `weight > 0` filter dropping every stored factor. True, but the cause is deeper:

- The page reads **`transaction_health_factors`**, which only ever stores
  `factor_type: 'comprehensive'` — one aggregate row, no per-category breakdown. There is no
  weakest link to find in it at all.
- The per-category rows live in a **different table**, `deal_health_factors`, written by
  `health-scorer.ts` — and under a **narrower vocabulary**: its `FACTOR_TYPE` map collapses the ten
  `HealthCategory` keys into four (`financing_status`, `deadline_proximity`, `timeline_adherence`,
  `document_completeness`).

So `weightForFactorType` was matching stored values against a vocabulary that is never persisted.
Every component scored weight 0, every one was filtered, and the panel showed its empty state on
every transaction — replacing three fabricated percentages with a permanently blank card.

Fixed properly rather than patched: `PERSISTED_FACTOR_WEIGHTS` sums the categories that collapsed
into each stored type (financing_status = EARNEST_MONEY + LENDER = 28, deadline_proximity =
INSPECTION + DEADLINES = 22, timeline_adherence = 10, document_completeness = TITLE + COMPLIANCE =
20). The page now reads `deal_health_factors` for the distillation and keeps
`transaction_health_factors` for its narrative/red-flag list, which is what that table is good for.
`PROTECTIVE_ACTION` gained entries for the four persisted types, each covering the categories that
collapsed into it, so the action is specific instead of generic filler. Verified: 4 of 4 components
now survive the filter (was 0), financing wins the weighted shortfall at impact 1540 vs timeline's
300, and `comprehensive` still resolves to weight 0 — correctly unusable.

**Honest limitation recorded in the code:** the four persisted types cover 80 of the 100 weight.
`COMMUNICATION` (6), `DOCUMENTS` (8) and `PARTICIPANTS` (6) have no `FACTOR_TYPE` mapping and are
never written, so the weakest-link ranking is correct over what was actually scored but cannot see
those three.

**The lesson, twice in one review.** Both bugs type-checked, passed every guard, and passed my own
verification — because I verified the *pure function* against synthetic inputs rather than against
the shape the database actually stores. A guard that never runs against real rows cannot catch a
wrong column or a wrong table.

---

## Two migrations named `m283`, two named `m284`

Chasing three older VADE findings that had never been confirmed resolved, the migrations directory
turned up a collision of my own making. Two threads of work on this branch each reached for the
next free number and both landed:

| number | one file | the other |
|---|---|---|
| `m283` | `agent-commissions-superset` (Jul 27 04:40) | `listing-agreement-seller-transaction-fee` (Jul 28 03:21) |
| `m284` | `drop-commissions-twin` (Jul 27 05:04) | `net-sheet-transaction-fee` (Jul 28 03:21) |

`m285` was already taken by the property-type vocabulary, so the transaction-fee pair was written
*after* `m285` and still reused two lower numbers.

**No outage, and that is the point.** The four touch disjoint tables and were applied by hand, so
nothing broke. What broke is that the code says things like "the `commissions` table dropped in
m284" — and there are now two m284s. A migration number is the only thing ordering the SQL we ship;
"which m284?" is not a question it should be able to raise, and the next collision may not land on
disjoint tables.

**Verified applied before renaming**, against the live database rather than the snapshot: the
`commissions` table is gone, `agent_commissions` exists, `listing_agreements.seller_transaction_fee`
and `net_sheet_calculations.transaction_fee` are both present and numeric. All four had run, so
renumbering is a file-naming change with no schema consequence.

The transaction-fee pair (authored last) became `m286`/`m287`. Their SQL headers and the six code
and doc comments that cited them by number moved with them; the comments citing `m283`/`m284` for
the *commission keep-one* work are still correct and were left alone.

**The durable half — Layer 4 of the schema-drift guard.** Nothing enforced uniqueness, which is why
this shipped. `duplicateMigrationNumbers` now fails the guard when a number names more than one
migration. Two details matter:

- **Both prefix eras share one number space.** The early files are bare `NNN-`, the later ones
  `mNNN-`. My first cut only parsed `mNNN-`, which silently skipped 42 older migrations — the same
  class of mistake as the bug being fixed. An `m` is decoration, not a namespace, so `063-x.sql`
  and `m63-y.sql` now collide. Leading zeros are insignificant.
- **Gaps are allowed.** A number can be abandoned; the invariant is uniqueness, not density.

All 234 migrations pass. **Negative-tested**: dropping a second `m287-` into the directory fails the
guard with both filenames named; probe removed and the directory re-verified clean.

**The three VADE findings that prompted the look were all already fixed** — checked in the tree
rather than assumed: `test:crm-pull` runs 49/0 (the simulator it pointed at exists), the
`commissions` reads were removed and repointed at `getCommissions`/`getBusinessExpenses` with the
scope in the query, and both recruit-name consumers read `agents.users.first_name` behind an
`|| "Unknown"` fallback. The inbox auto-select effect carries a comment naming VADE as its source.

---

## Tenant scope, part 2: the sweeps that were RPCs and the children nobody scoped

Continuing the tenant-scope burn-down, this time asking two questions the existing guard
could not answer: *what does the guard accept that it shouldn't*, and *what about the
child tables*.

### The guard accepted a selected column as a filter

`test:tenant-scope` passes a query chain if a 500-character window merely **contains** the
string `brokerage_id`. `.select("id, brokerage_id, agent_id")` contains it. So a query that
selects the column while filtering by nothing at all reads as scoped.

Measuring it took three passes, and the first two were wrong in opposite directions:

| probe | rule | count | why it was wrong |
|---|---|---|---|
| 1 | narrow 500-char window | 68 | the window truncates real filters that sit further down the chain |
| 2 | wide window, filters only | 356 | dropped `brokerage_id:` INSERT payloads, which **are** legitimate scoping |
| 3 | wide window, strip `.select(...)`, keep payloads | **57** | correct |

The owner's constraint — *an INSERT payload carrying `brokerage_id` IS legitimate scoping* —
is exactly what probe 2 violated, and it inflated the number six-fold.

Then the split that mattered: **which client**. All 19 tenant tables have RLS enabled with
policies (verified live), so a `createClient()` chain is backstopped by the database even
with no app filter. A `createServiceClient()` chain is not. Of the 57: 7 RLS, 31 service,
11 injected/unknown. Most of the 31 are cron routes that legitimately sweep every tenant and
fan out per-row.

### The real defect: a platform-wide sweep exposed as an RPC

Three of the service-client sweeps were not cron routes. They were exports of top-level
`"use server"` modules — which makes every one of them an RPC endpoint any authenticated
session can call:

- `generateAnnualHomeValueReportsCronTick` — reads **every** brokerage's closed transactions
  and **emails past clients**
- `generateQuarterlyHomeValueReportsCronTick` — same
- `gbpAutoPostsCronTick` — reads every brokerage's listings and posts publicly on their behalf

Each cron ROUTE gates on `verifyCronAuth`. That gate protects the route, not the function:
importing the action and calling it directly walked straight past it. Any logged-in user
could trigger a cross-tenant email run.

Both modules moved to `lib/`, which **removes** the endpoint instead of guarding it —
the shape `lib/showings/showing-brief.ts` already used for its own cron tick.
`annual-home-value-report.ts` moved wholesale: it had zero UI callers, so the `"use server"`
directive bought nothing and cost two ungated platform-wide endpoints.

`app/actions/cron-kernel.ts` was left alone — it already does a documented soft auth check
and only writes telemetry. A previous pass reasoned about it; that reasoning still holds.

**Guard:** `use-server-export-guard.ts` gained a second check — no `*CronTick*` may be
exported from a `"use server"` module. Negative-tested by re-adding one (guard failed naming
the file), then reverted.

### The children: what migration 063 left open

The app-layer guard lints ~20 named tables in TypeScript. It structurally cannot see a child
table that holds tenant rows, has no `brokerage_id` of its own, and is protected only by an
RLS policy. Only `pg_policies` knows.

Walking the live FK graph found **5 children of tenant tables with no `brokerage_id`**. One,
`collaborative_search_properties`, is scoped **correctly** — through an `EXISTS` on its
parent — and became the model for the rest.

The root cause is migration **063**, which fixed a genuine outage: ~44 tables had RLS enabled
with **zero** policies, which denies everything, so those features were silently dead. It
unblocked them with `USING (TRUE)`. Right for platform reference data; wrong wherever the
table carried tenant rows. Worst case: `open_house_analytics` had `SELECT USING(true)` **and**
`UPDATE USING(true)` on live per-event data (attendance, `avg_lead_score`,
`serious_buyers_count`) — any authenticated user could read and rewrite every brokerage's.

**m288** scoped ten tables: seven through their parent (`open_house_analytics`,
`cma_comparables`, `cma_price_adjustments`, `campaign_sequence_steps`,
`objection_training_turns`, `newsletter_seo_scores`, `tool_shares`) and three on their own
`brokerage_id` (`ai_suggestions`, `newsletter_scheduled_sends`, `newsletter_sections`).
All ten were empty at the time, so this tightened a boundary rather than revoking access.

**The step that nearly made it a no-op.** Five of the `DROP POLICY` statements named policies
that don't exist — the 063-era names differ from the convention used elsewhere
(`ai_suggestions_update`, not `ai_suggestions_upd`; `nlss_upd`/`nlsec_upd`/`nlseo_upd`;
`tool_shares_update`). Postgres OR's permissive policies together, so each new correctly-scoped
policy sat **beside** a surviving `USING (true)` and changed nothing. Re-querying `pg_policies`
after applying — rather than trusting `success: true` — is the only reason this was caught.
Five tables read as fixed while still being world-writable.

**Guard:** `test:child-tenant-scope` (new, live-DB, creds-gated). A table is *tenant-anchored*
if it has its own `brokerage_id` or an FK to a table that does; an anchored table may not carry
a permissive SELECT/UPDATE policy. The facts come from a SECURITY DEFINER
`tenant_scope_facts()` (same shape as m269's `assert_tenant_isolation()`), and the **judgement
stays in TypeScript** as a reasoned allowlist — 23 global-reference entries plus 4 marked
`NO ANCHOR` (`long_form_videos`, `marketing_stats`, `transparency_videos`,
`demo_persona_contacts`), which are tracked, not blessed. Verified live: 723 anchored tables,
27 permissive, 6 both — all 6 on the allowlist, so offenders **0**.

### What the orphan guard then caught

Moving the cron tick out left `app/actions/gbp-auto-posts.ts` with zero importers, and
`test:no-orphan-actions` failed. The two remaining actions had **always** been dead — masked
only because the cron route imported the file for a different export.

Investigated before removing, per keep-one: `lifecycle-promo-policy.ts` already auto-spawns
`just_listed` and `just_sold` with cooldowns, per-(listing,trigger) idempotency and a
compliance gate, and `/api/cron/listing-promo-social-publish` already publishes
`google_business` alongside seven other platforms. The orphans were a narrower duplicate of
the advanced path, so they went rather than being wired up a second time.

**Flagged, not silently done:** `gbpAutoPostsCronTick` overlaps that same lifecycle-promo
path. It is registered, gated and running, so collapsing it needs its own investigation
rather than a deletion buried in a scoping commit.

`tsc --noEmit`: 0. `npm run guard`: 97 simulators, exit 0.

---

## The seller net sheet's Save button had never worked

Item #2 on the open list was "saveNetSheet recomputes totals with `?? 3` and `salePrice * 0.02`,
so a SAVED sheet can disagree with the sheet that was saved." That was true, and it was the
smaller half.

### Three ways the saved sheet disagreed

Measured against a REAL live listing (FL, $485,000) with a REAL flat-fee agreement seeded on it
($4,995 commission, $395 seller transaction fee), running the ACTUAL helpers:

| line | saved (recomputed) | shown (as the seller saw it) |
|---|---|---|
| commission | $29,100 (3% + 3%) | **$4,995** (flat fee per agreement) |
| closing costs | $9,700 (flat 2%) | **$6,350** (FL county-customary itemization) |
| total costs | $355,795 | $328,340 |
| **net proceeds** | **$129,205** | **$156,660** |

A seller shown **$156,660** would reload the saved sheet and see **$129,205** — a **$27,455**
swing, against them, with no indication anything had changed.

1. **Flat fee erased.** `net_sheet_calculations` could only store two percentages. A flat-fee
   agreement had nowhere to land, and `?? 3` then reinstated 3% + 3%. **m289** adds
   `commission_is_flat_fee` + `commission_flat_amount`, named to match `listing_agreements` so
   the agreement and the sheet derived from it read identically.
2. **Regional closing costs discarded.** The tab defaults that line to
   `deriveNetSheetClosingCostSection` — itemized title fees and doc stamps for the listing's
   state. It sends `undefined` when the agent hasn't typed an override, and the flat 2% replaced
   the county-customary math. Now derived server-side with the same helper.
3. **Commission guessed.** When rates are absent it now resolves from the listing agreement
   through `resolveAgreedCommission` — the resolver the offers page and cron runner already use.

### And a scenario-math bug underneath

`netProceeds: salePrice * 0.95 - totalCosts * 0.95` scaled the **entire** cost stack, shrinking
the mortgage payoff, the tax bill, HOA dues and the flat transaction fee by 5% on a quick sale.
Only commission and percentage-based closing costs move with price. On the same real listing the
old formula reported a Quick Sale net of **$148,827** against a true **$132,675** — overstating
by **$16,152**, and making a quick sale look *better* than the recommended price.

### The bug the live test actually found

Seeding the round-trip, the INSERT was rejected:

```
23503: insert or update on table "net_sheet_calculations" violates foreign key constraint
Key (agent_id)=(a0000000-…-0001) is not present in table "agents".
```

`net_sheet_calculations.agent_id` FKs **agents(id)**. `saveNetSheet` was writing
`user.user.id` — a **users.id**. Live check: **0 of 5** agents have an id that is also a
users.id, so the FK could never be satisfied. `net_sheet_calculations` contained **0 rows**.

**The Save button on the seller net sheet has never once worked.** The `?? 3` / `* 0.02` drift
was real but downstream of an insert that always failed — which is also why nobody noticed the
drift: there was never a saved sheet to reload and compare.

`lib/kernel/agent-identity.ts` states the rule in its own header — *"NEVER do: agentId =
user.id"* — and the registry records an FK pass that fixed 60+ of these. This site was missed.
Now resolved through `resolveAgentId`, with an honest refusal when the user has no agent profile
rather than a silent failure.

**Verified end-to-end on the live database**, then cleaned to 0/0: flat fee survived the reload
(`commission_is_flat_fee` true, `4995`), closing costs persisted at the regional `6350` rather
than the `9700` flat 2%, and the stored Quick Sale scenario is now correctly *lower* than the
recommended net. Both seeded rows deleted; `net_sheet_calculations` and `listing_agreements` are
back to their original counts.

### Same class, still open

Sweeping the live FK map (193 columns referencing `agents(id)`) against every insert/update
payload found **15 more sites** writing a user-id expression into an agents-FK column — including
`activities.agent_id`, `tasks.assigned_to_agent_id`, `contacts.agent_id` and
`social_posts.agent_id`. Each needs its own check (some params are misleadingly named and do
carry an agents.id), so they are being worked separately rather than bulk-patched.

`tsc --noEmit`: 0. schema-drift, tenant-scope, use-server-exports, no-orphan-actions: all pass.

---

## The id-class burn-down, and the sweep that lied the first time

`saveNetSheet` writing a users.id into an agents(id) FK was not a one-off. Sweeping
the live FK map against every insert/update payload closed the class.

### The sweep was wrong before it was right

First pass reported **15** wrong-class writes. Six were false, and the reason matters:
the scan window was a fixed 900 characters from `.from(table)`, which spills past the
end of that query into the NEXT one and attributes its payload to the wrong table. It
flagged `newsletter_scheduled_sends.agent_id = user.id` as a bug — and that write is
**correct**, because that column FKs **users(id)**, not agents.

Cutting the window at the next `.from(` gives **9** real sites. Checking rather than
bulk-patching is what the owner asked for, and it was load-bearing: a bulk fix would
have broken a working newsletter write.

Each of the 9 was confirmed a users.id before being touched — `distribute-video.ts`
settles its own case by writing `params.userId` to **both** `user_id:` and `agent_id:`
in one payload.

| file | column | nullable |
|---|---|---|
| `buyer-financial.ts` | `activities.agent_id` | yes |
| `cma-presentation/net-sheet-calculator.ts` ×2 | `activities.agent_id` | yes |
| `video/distribute-video.ts` ×3 | `activities` / `client_portal_messages` / `social_posts` | mixed |
| `api/internal/ai-chat/route.ts` | `client_portal_messages.agent_id` | **NOT NULL** |
| `transactions/gift-order-trigger.ts` | `activities.agent_id` | yes |
| `transactions/stage-progression.ts` ×2 | `activities` / `contact_portal_modules` | yes |
| `api/internal/ai-note/route.ts` ×2 | `activities` / `tasks.assigned_to_agent_id` | **NOT NULL** |

Nullability decided the shape of each fix. Nullable columns resolve-or-null. The two
NOT NULL ones cannot: `tasks.assigned_to_agent_id` now **skips creating the task**
when the caller has no agent profile rather than writing an id the FK will reject, and
`ai-chat`'s `contact.agent_id ?? user.id` fallback — where the first branch was already
a correct agents.id — resolves instead of falling back to the wrong class.

### The guard

`test:agent-id-class` (new, pure, in the chain). `scripts/agent-fk-columns.ts` commits
the FK map — 185 tables — snapshotted from the live database so the guard runs offline
and the map is reviewable in a diff. The header says plainly why it exists: the column
NAME tells you nothing, since `newsletter_scheduled_sends.agent_id` is a users.id and
`net_sheet_calculations.agent_id` is an agents.id.

Six pure checks pin the detector's behaviour, including the two that cost the first
sweep its credibility: it must ignore a users-FK `agent_id`, and it must not spill into
the next query's payload. **Negative-tested** by restoring the original
`agent_id: user.user.id` in `saveNetSheet` — the guard failed and named the exact
file, table and column — then reverted.

`tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## The fourth net sheet priced nothing the seller had agreed to

`app/actions/cma-presentation/net-sheet-calculator.ts` — five callers including the voice
command executors — was the last net sheet outside the canonical resolvers. It charged the
brokerage's **default** commission rates, defaulted closing costs to a flat brokerage percent,
and had **no transaction-fee line at all**. A flat-fee listing and a $395 brokerage fee simply
did not appear on it.

It now shares the resolvers the other three already use: `resolveAgreedCommission` for the
commission (an executed agreement outranks brokerage defaults; a flat fee is charged as-is with
the buyer side folded in) and the new `resolveClosingCosts` for the closing line. The agreed
`seller_transaction_fee` is read from the listing agreement and carried as a fixed cost.

### The tier the owner asked for, and the trap in it

The ruling was to fold `financial_defaults.closing_cost_percent` in **above** the regional
estimate and **below** a real agreement. Implemented as: entered figure → brokerage percent →
county-customary band → 2% house default.

The trap: `get-brokerage-settings` hardcodes `closing_cost_percent: 0.02` as its fallback, so a
brokerage that never configured it reports **exactly the same 0.02** as one that deliberately
chose it. Ranking that above the regional band would let the house default masquerade as
brokerage policy *and* outrank real county title/doc-stamp math — the precise dishonesty this
provenance system exists to prevent.

So the brokerage tier applies only when its percent **differs** from the house fallback. At
exactly 2% it is indistinguishable from unset, and the regional band wins. Verified on a real
FL listing at $485,000:

| case | amount | source | labelled |
|---|---|---|---|
| entered figure | $7,250 | `confirmed` | **fact** |
| brokerage configured 2.5% | $12,125 | `template` | estimate |
| brokerage at exactly 2% | **$6,350** | `regional_estimate` | estimate — county-customary wins |
| no state, no brokerage figure | $9,700 | `default` | estimate, honestly labelled |

The FL county-customary midpoint is $6,350 against a flat 2% of $9,700 — a $3,350 difference on
one listing, previously invisible on this sheet.

### Two more corrections in the shared math

`computeNetSheetScenario` gained `transactionFee` (a fixed cost that does **not** scale with
price) and `flatCommissionAmount`. Closing costs are now resolved **per scenario** so the
regional band tracks the scenario price, rather than a single figure being scaled after the fact
— the same class of error as the `totalCosts * 0.95` bug fixed in `saveNetSheet`.

All four seller net sheets now resolve commission, closing costs and the transaction fee through
one set of functions. `tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## Duplicate consolidation, round 1: two of the three "duplicates" weren't

The open item listed seven duplicate families. Investigating the first three changed what
the list means.

### `generateVideoScript` ×9 — a name collision, not nine copies

Nine functions share the name. Comparing signatures and bodies, they are mostly **distinct
products**: library authoring (`video-content.ts`, writes `video_scripts_library`), listing
highlight reels (`ai-listing-presentation.ts`), URL→script repurposing (`link-to-video.ts`),
project-based generation (`lib/kernel/video.ts`, updates `ai_video_projects`), the generic
content pipeline (`content-generator.ts`, one `content_type` among many), and a private
hardcoded template string (`presentation-assembler.ts` — not even AI-generated).

Renaming seven live functions would be churn with real regression risk and no user benefit.

**One real defect did surface.** `video-generation.ts`'s version carried a second parameter
shape commented *"Identity / context shape used by /dashboard/videos/create caller"* —
`agentId`, `brokerageId`, `targetDurationSeconds`, `listingContext`, `saveToLibrary`. That page
imports the **other** `generateVideoScript` (`app/actions/video/generate-script.ts`), and none
of those five params is read anywhere in the body. Dead surface area that made two distinct
functions look like copies of each other. Removed; `videoType` and `description` stay because
both are genuinely read as fallbacks. Both live callers pass only the original prompt shape.

The two are now documented as what they are: **personalized one-to-one contact messages**
(welcome, thank-you, holiday, open-house invite) versus **marketing videos** driven by a video
type against the shared script-structure vocabulary, with word-count targeting and the
`evaluateOutbound` compliance gate.

### `markCommissionPaid` / `completeMilestone` — the premise was wrong

`app/actions/transactions.ts` and `lib/application/transactions.ts` define both with
**identical signatures**, which reads as a copy. It isn't. The action file imports the lib file
as `TransactionService` and delegates to it after validating UUIDs. That is correct two-layer
architecture — a thin validating server-action shell over an application service — and
collapsing it would have deleted the validation layer.

### What the investigation actually found: two commission ledgers, two UI surfaces

Chasing the remaining implementations surfaced something the "duplicate" framing was hiding:

| surface | path | table | guarded |
|---|---|---|---|
| `PayoutButton` | `financial-kernel` → `lib/kernel/financial.ts` | `agent_commissions` | role gate + `.eq(brokerage_id)` |
| transaction detail view | `app/actions/transactions.ts` → `lib/application/transactions.ts` | `transaction_commissions` | UUID validation only |
| reconciler | `reconcile-tracking` → `lib/commission/payment-tracker.ts` | `agent_commissions` | server-side, no user role exists |

**Marking a commission paid in the transaction detail view does not mark it paid in the
`agent_commissions` ledger, and vice versa.** Both write a `status='paid'` transition to
*different* tables.

Live check: both tables are currently **empty** (0 rows, 0 paid), so nothing has diverged yet —
the split is latent, not damaging. That is what makes it a design decision rather than a data
repair, and it is why it is NOT being resolved in a refactor commit: `manager-registry.ts`
already records this as a finance-owned consolidation target ("FOUR split formulas … across
THREE table families"), and picking one ledger is a schema and business-process call, not a
rename.

`tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## The lifecycle-promo path had never fired either — so the "duplicate" was the only one working

Item #69 was "collapse `gbpAutoPostsCronTick` into the canonical lifecycle-promo path." Under
the merge-then-remove rule the first job is to establish which one is actually the advanced
path. On paper it is not close. The canonical path has:

- a policy gate resolving agent → team → brokerage → platform default for `(event_type, scope)`
- a cooldown gate so three price edits in a day produce one promo
- an idempotency ledger with a unique constraint
- a tenant check
- the compliance gate (Brand voice + Fair Housing + Them-First)
- per-platform tailored captions across **eight** platforms, `google_business` among them

The GBP cron has none of that. It posts to one platform with its own copy, and `gbpEnabledFor`
returns `true` unconditionally — so it **ignores the agent's lifecycle-promo policy entirely**.
An agent who switched `just_sold` off still gets a Google Business post.

So: keep the reactor, port the GBP cron's one genuine capability (a 24h `updated_at` catch-up
sweep, which the event-driven reactor lacks), delete the rest.

### Then the live check inverted it

`ListingPromoInput.agentUserId` was documented as *"users.id of the listing agent. Resolved
from listings.agent_id (which on the live schema is already a users.id)."*

That is false. Live:

| check | result |
|---|---|
| `listings.agent_id` FK | → **agents(id)** |
| `listing_promo_videos.agent_id` FK | → **users(id)** |
| listings whose `agent_id` matches an `agents.id` | **3 of 3** |
| listings whose `agent_id` matches a `users.id` | **0** |
| rows in `listing_promo_videos` | **0** |

Most of the 13 call sites feed `listings.agent_id` straight through, so the ledger insert
FK-failed every time. **The canonical lifecycle-promo path had never once fired** — no policy
gate, no compliance gate, no eight-platform fan-out, ever. `social_posts` has zero
`google_business` rows, confirming the GBP cron never produced anything either.

Deleting the GBP cron on the strength of the doc comment would have removed a path in favour of
one that does not run. **This is the third instance of the same bug class this session** — after
the net-sheet Save button and the nine wrong-class writes — and the second time a confident code
comment was contradicted by the live foreign keys.

### The fix

Normalised inside `dispatchListingPromoVideo` rather than at each of the 13 call sites: one seam
covers them all and is safe for callers already passing a genuine users.id. Resolve-or-keep — if
the value matches an `agents` row, translate to that agent's `user_id`; otherwise keep it. The
same shape the registry records for `qr_codes`. All three downstream uses (`resolveUserIdToAgentRecord`,
the `actorContext.userId`, and the ledger insert) now consume the normalised value, and the
misleading doc comment has been replaced with what the schema actually says.

**Proven against the live database**, then cleaned to 0 rows: inserting `listings.agent_id`
into `listing_promo_videos.agent_id` raises `foreign_key_violation`; inserting the normalised
`agents.user_id` succeeds.

### Still open on #69

The consolidation itself is now *unblocked but not done*. With the canonical path able to run
for the first time, the remaining work is to port the 24h catch-up sweep into it and retire the
GBP-only poster. That deserves its own pass — and it should be verified by watching the reactor
actually produce ledger rows and social drafts, which was impossible until now.

**A guard is owed here.** `test:agent-id-class` catches user-id → agents-FK writes. This bug is
the REVERSE direction — an agents.id written into a users-FK column — which that guard does not
model. Extending it needs the users-FK column map alongside the agents one.

`tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## The id-class contract, both directions — and the regression I shipped

The previous entry said a guard was owed for the REVERSE direction: an agents.id written
into a users(id) FK. Building it found three more instances, **one of which I had introduced
myself two commits earlier.**

### The regression

Fixing the fourth net sheet, I replaced `agent_id: user.id` in
`cma-presentation/net-sheet-calculator.ts` — but that file has **two** such lines, and my
replacement hit both:

| site | column FKs | `user.id` was | my edit |
|---|---|---|---|
| `activities.agent_id` | **agents** | wrong | correct fix |
| `transparency_updates.agent_id` | **users** | **already correct** | **broke it** |

`transparency_updates.agent_id` is named like an agents reference and is not one. I made
exactly the mistake this guard exists to prevent, in the commit where I was fixing the same
class elsewhere, and no type-check or existing guard could see it. Reverted to `user.id` with
the FK documented inline.

### Two more, in a feature that had never persisted anything

`lib/listing-health/health-scorer.ts` wrote `listing.agent_id` — an agents.id — into
`listing_health_scores.agent_id` and `listing_health_interventions.agent_id`, both of which FK
**users**. Live: both tables hold **0 rows**. The listing-health scorer has never persisted a
score or an intervention.

That is the fourth flagship flow this session found dead from this one bug class, after the
seller net sheet's Save button, the nine wrong-class writes, and the entire lifecycle-promo
path. Fixed by resolving `listings.agent_id → agents.user_id` once, after the listing fetch.

### The guard now models the split-brain

`scripts/agent-fk-columns.ts` gained `USERS_FK_AGENTISH_COLUMNS` — 50 tables whose
users(id) FK column has an **agent-ish name**, snapshotted from the live database. Only
agent-ish names are listed: nobody confuses `created_by` for an agents.id, and listing every
users FK would bury the ones that actually mislead.

`test:agent-id-class` now runs both scanners, 12 checks:

- forward — a user-id expression into an agents(id) FK
- reverse — an agents.id expression (`resolveAgentId(...)`, `agentRecordId`,
  `listing.agent_id`) into a users(id) FK, while accepting a genuine `user.id` or an
  already-normalised `agentUserId`

Both directions are pure-checked against the two cases that actually shipped:
`listing_promo_videos.agent_id` and `listing_health_scores.agent_id`. Repo scan: 4,291 files,
185 agents-FK tables, 50 agent-ish users-FK tables, **0 offenders in either direction**.

### What this class has cost

Four features that type-checked, passed every guard, and had never executed once:

1. seller net sheet Save (`net_sheet_calculations` — 0 rows)
2. the lifecycle-promo path (`listing_promo_videos` — 0 rows)
3. the listing-health scorer (`listing_health_scores` / `_interventions` — 0 rows)
4. nine assorted activity/task/message writes

In three of the four, a confident code comment asserted the opposite of what the live foreign
key said. The schema is the authority; comments are hearsay.

`tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## A lead is not a contact — the third id-class family

Having closed agents↔users in both directions, the registry names one more split-brain:
*"leads are NOT contacts"*, with a pass recorded as fixing it. Sweeping the live FK map found
**three sites that survived that pass**, plus one false positive worth as much as the fixes.

### The three real ones

`activities.contact_id` FKs `contacts(id)`. A lead id there is FK-rejected and the row is
silently lost — these inserts sit behind best-effort wrappers, so nothing surfaced.

| file | what never got logged |
|---|---|
| `lib/ai-isa/inbound-intent-classifier.ts` | every ambiguous inbound reply — the "kept nurturing" touch |
| `lib/ai-isa/tools.ts` ×3 | ISA escalations, lead qualifications, appointment requests |
| `lib/lead-readiness/readiness-logger.ts` | every lead-readiness state transition |

The most telling detail: `inbound-intent-classifier.ts` uses the **correct** shape at its
conversion branch — `entity_type: "lead", entity_id: params.leadId` — and the wrong one forty
lines later. The right answer was already in the file. All four now use the repo's own shape:
`contact_id: null`, with the lead on `entity_type`/`entity_id`.

`lib/ai-isa/tools.ts` claims in a comment to "always log on the lead so the conversation
timeline shows it." It never did.

### The false positive, and why it matters

`app/actions/ai-chat.ts` writes `conversations.contact_id = data.leadId`. That reads like the
same bug. It is not: the field is gated by `requirePermission("view", "contact", …)` and
resolved with `.from("contacts").eq("id", …)`. **It is a contact id with a misleading
parameter name.**

That is the third time this session a misleading name produced a false positive — after
`newsletter_scheduled_sends.agent_id` (correctly a users.id) and the window-spill hits. Left
named `leadId` because it is a public server-action parameter, but now documented inline
specifically so a future sweep does not "fix" a working path into a broken one.

### The guard now covers all three families

`test:agent-id-class`, 16 checks, three scanners:

1. a user-id expression into an **agents(id)** FK
2. an agents-id expression into a **users(id)** FK
3. a lead id into a **contacts(id)** FK

`CONTACT_FK_TABLES` (57 tables) joins the two FK maps in `scripts/agent-fk-columns.ts`, all
snapshotted from live. The lead scanner is pure-checked against the exact shapes that matter:
it flags `contact_id: ctx.leadId`, accepts `contact_id: null` + `entity_type`/`entity_id`, and
accepts the `ai-chat.ts` false positive so the guard cannot manufacture the bug it prevents.

Repo scan: 185 agents-FK tables, 50 agent-ish users-FK tables, 57 contacts-FK tables —
**0 offenders across all three**.

`tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## Two "Brokerage P&L" screens — merge, then remove

The owner reported two UI surfaces doing the same thing. Rather than guess, the check was
mechanical: parse `navigation-config.ts` and find **labels that point at more than one href**.
481 nav entries, 14 duplicate labels.

Ten were false alarms — `Dashboard`, `Settings`, `Documents`, `Approvals`, `Connections` and
`More` legitimately exist once per persona (lender, title, vendor, portal, compliance each get
their own). Same word, different audience, not a duplicate.

### The settings trees were already consolidated

The PR body still calls `app/settings/*` vs `app/dashboard/settings/*` "the largest structural
drift". It is no longer true on this branch, and verifying that mattered before touching
anything:

- `/dashboard/settings/general` → a 6-line `redirect("/settings/general")`
- `/dashboard/settings/branding` → a redirect to `/settings/branding`
- `/settings/integrations` → a redirect to `/settings/connections`, carrying a KEEP-ONE note
  that `/dashboard/settings/integrations` (platform credentials, provider overrides, IDX
  Broker, lead sources) is a **different** surface and stays

Three redirects, one documented exception. Nothing to squash.

### The real one

| | `/dashboard/financials/brokerage` | `/dashboard/admin/brokerage-pnl` |
|---|---|---|
| size | 1,421 lines across 5 files | 134 lines |
| content | P&L line items, agent P&L table, 12-month trend, 6-month forecast, margin breakdown | YTD GCI, company dollar, production by agent |
| **recruiting ROI** | **absent** | present |
| **referral value** | **absent** | present |

Same nav label, same owner audience, same question — two screens. The larger one is obviously
the survivor, and deleting the smaller one on that basis alone would have **silently removed
the owner's entire recruiting-economics view**: a grep for `recruit|referral` across
`app/dashboard/financials/brokerage/` returned nothing at all.

So, merge first. `RecruitingAndReferralEconomics` now renders on the surviving page from the
**same** `generateBrokeragePnl` source, so the numbers agree with what the deleted page showed:
recruited agent count, total recruiting cost, lifetime brokerage net, blended ROI (green/red),
active partners, partner value generated.

Then remove: `app/dashboard/admin/brokerage-pnl/page.tsx` deleted, and both inbound links
repointed — the nav child entry and the admin dashboard tile. A grep confirms the only
surviving mention of the old path is the KEEP-ONE comment explaining where it went.

### Still on the list

Three same-persona duplicate labels remain unexamined and are NOT being touched blind:
`Knowledge Base` (`/dashboard/admin/knowledge` vs `/dashboard/settings/knowledge-base`),
`Lead Magnets` (admin vs agent — possibly a legitimate scope split), and
`System` / `System Health`, where **two different labels** point at the same pair
(`/dashboard/superadmin/observability` vs `/dashboard/system`) — the muddled one.

`tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## Two "Knowledge Base" screens — same merge, second instance

Same duplicate-label sweep, second real hit. Both admin-facing, both managing the same
`help_topics_kb` articles, both labelled **Knowledge Base** in the nav — three placements across
three personas pointing at two different screens.

| | `/dashboard/settings/knowledge-base` | `/dashboard/admin/knowledge` |
|---|---|---|
| size | 609 lines | 402 lines |
| nav placements | 2 personas | 1 |
| search / category / delete | ✅ | ✅ |
| **article editing + bulk** | ✅ | absent |
| **embedding-queue monitor** | **absent** | ✅ |

The settings surface is the survivor — larger, richer, already linked from two personas. But it
had **zero** references to the embedding queue, and that monitor is not cosmetic: an article is
only searchable by the AI once its embedding lands, so a stuck queue is the difference between
"I uploaded it" and "the assistant still doesn't know it". Deleting the admin page without it
would have removed the only place that failure is visible.

Ported as a sidebar card fed by the same `getEmbeddingQueueStatus`, and deliberately quiet: it
renders only when something is pending, processing or failed, with failures in red. A healthy
idle queue shows nothing rather than a row of zeros.

**Eight inbound references**, not one. The nav entry was the obvious one; the sweep also found
the command palette, a `Link` in the admin knowledge-ops panel, and **six `revalidatePath`
calls** inside `app/actions/knowledge/search.ts`. Those six are the ones worth noting — they are
invisible to a nav audit, and leaving them would have meant every create/update/delete
revalidated a route that no longer exists while the surviving page served stale content. All
repointed.

### The false alarms this sweep produced

Worth recording, because the sweep is only useful if its noise is understood:

- **`System` / `System Health`** — these labels sit on *both* `/dashboard/system` (tenant) and
  `/dashboard/superadmin/observability` (platform). Not duplicate screens: they are correctly
  separated tenant vs platform surfaces, and the nav already carries a comment about a
  "tenant-parity fix" for exactly this. The defect is **label collision**, not a duplicate UI.
- **44 routes carry more than one label** — `Team`/`My Team`/`View Team`, `Deals`/`Transactions`.
  Almost all are benign: a command-palette phrasing differing from a sidebar label is normal.
- **`Lead Magnets`** (`admin` vs `agent`) — left alone; an admin-scope and an agent-scope view of
  the same feature is a plausible legitimate split and needs its own check.

`tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## Three "Lead Magnets" screens — and the reason the feature had never worked

The last flagged duplicate label, left alone twice as "a plausible legitimate scope split".
It was not. It was three copies of one screen, and the split the admin copy's header
promised was never implemented.

| | `app/dashboard/agent/lead-magnets` | `app/dashboard/admin/lead-magnets` | `app/actions/lead-magnets.tsx` |
|---|---|---|---|
| lines | 228 | 219 | 221 |
| reachable | agent nav | broker + admin nav | **nothing imports it** |
| Google Business tab (`PublishGuideToGbp`) | ✅ | absent | absent |
| reads `magnet_type` | ✅ | absent | absent |
| list scope | own | **own** (despite the header) | own |

The third copy is the tell: a full page component parked in `app/actions/`, where the App
Router will never route it, carrying a role gate nobody could reach. Three files drifting
apart one feature at a time — only one of them ever gained the GBP tab.

Keep-the-advanced-one: the agent copy survives, with the brokerage-wide list the admin
copy was supposed to provide. It moved to `/dashboard/marketing/lead-magnets`, because all
three personas reach it from the same **Marketing & Content** nav group and a shared screen
should not live behind one persona's path prefix.

### The list was empty for every user in the product

`lead_capture_forms.agent_id` is a FK to **`agents(id)`**. All three pages built their
context as `agentId: user.id` — the **auth user id** — and passed it to
`listLeadMagnetsAction`, which forwarded it into `.eq("agent_id", …)`. The two id classes
never collide, so the filter matched nothing:

```
broker scope (no agent filter)          → 2 magnets
agent scope by agents.id                → 1 magnet  (the right one)
agent scope by the auth user id         → 0         ← what the UI actually did
```

Live-run against production with two seeded magnets under two different agents, then
cleaned to residue 0. This is the **sixth** feature killed by this one bug class, and the
first where the wrong id was laundered through a React prop rather than written inline —
which is why the `test:agent-id-class` scanners could not see it.

The fix removes the parameter, not just the value: `listLeadMagnetsAction` now takes
`{ scope?: "mine" | "brokerage" }` and resolves `agents.id` from `getAgentContext()`.
Broker/admin/superadmin get the brokerage; everyone else gets their own; a session with no
`agents` row gets an honest refusal rather than the unfiltered brokerage. A client can no
longer ask to see another agent's magnets, and cannot supply an id at all. The dead
`agentId` props on `MagnetBuilder` and `QRCodeGenerator` — both already resolving the right
id server-side, both never reading the prop — were deleted for the same reason.

### And the QR codes were written where nothing looks for them

Found on the way through: `generateQRCodeAction` inserted `purpose: "general"`, while every
reader of a lead-magnet QR filters `purpose = 'lead_magnet'` — the detail tab's existing-code
lookup and the scan-count join in `listLeadMagnets`. A generated QR was never found again:
the tab kept offering "Generate", and the library never showed a scan count. Now written as
`lead_magnet` with `agent_id` stamped from the session's `agents.id`; live-verified that the
join lands (`scanCount: 7` on the seeded row).

The detail tab's QR lookup deliberately does **not** filter by `agent_id` — brokerage plus
slug is already exact, and the agent copy's extra `.eq("agent_id", ctx.agentId)` was the same
wrong id class, hiding every QR that had been generated. Taking the admin copy's unfiltered
lookup into the survivor is the merge rule working in the less obvious direction.

Seven new checks on `test:lead-magnet-flow` hold all of it: exactly one Lead Magnets page
file, every persona's nav on the single route, no client-supplied `agentId` in the action or
the library, fail-closed scope, and the QR `purpose`/`agent_id` contract.

`tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## AI Identity: the persona an agent configures reached almost nothing

`ai-identity` was the last persona-prefixed twin left (`/dashboard/admin` vs
`/dashboard/agent`, plus `/dashboard/team`). **Not a duplicate** — three scopes of one
cascade, all three rendering the same `AIIdentityEditor` with a different `scope`,
`scopeId` and `parentProfile`. Correct composition; recorded as a false alarm.

The check that cleared it found something worse.

### An untyped column, and a twelve-way split

`ai_identity_profiles.scope_id` is a bare `uuid` with **no foreign key** — it is
polymorphic across `brokerage` / `team` / `agent` scopes. Nothing in the database
constrains it, so nothing rejected a wrong id, and the FK-driven scanners in
`test:agent-id-class` were structurally blind to it. At `scope_type = 'agent'` the
consumers split:

| reads `agents.id` | reads the auth `users.id` |
|---|---|
| public agent profile `/p/[agentSlug]` | `app/dashboard/agent/ai-identity` (**the writer**) |
| the embeddable widget (2 routes) | `app/api/internal/ai-chat` |
| Twilio voice greeting | `getUserAvatarConfig` (video) |
| video identity resolver | |
| portal AI chat | |
| ISA brand-voice prompt | |
| widget settings page | |
| `lib/ai/pipeline.ts` | |

Nine to three — and the majority is the right one on the merits, not just the count:
`saveAIIdentityProfile` authorises an agent-scope write by looking the `scopeId` up in
`agents`, and `lib/voice/vapi-numbers.ts` resolves a stored `scope_id` back through
`agents.user_id`. Both are only coherent if `scope_id` is an `agents.id`.

Which means the writer never wrote anything:

```
agents lookup for the id the page passed (auth user id)   → 0 rows → "Forbidden"
agents lookup for the id the page passes now (agents.id)  → 1 row  → authorised
```

An agent could open **My AI Identity**, fill in the assistant's name, tone, guardrails,
FAQ and objection library, press Save — and get an authorisation error. Had a row ever
landed, nine of the twelve consumers would not have found it. The AI's persona is the
product; it was configurable and inert.

Three sites moved onto `agents.id`: the page (resolved from `agents.user_id`, redirecting
when there is genuinely no agent seat), and the internal AI-chat route (through the
`resolveAgentId` helper it already imports). The third, `getUserAvatarConfig`, was
**deleted** — zero callers in a `"use server"` module, so a live RPC endpoint nobody
used, and wrong twice over: it looked up both `ai_identity_profiles.scope_id` *and*
`agent_voice_profiles.agent_id` (also an `agents(id)` FK) with the auth user id, so it
could only ever return `isConfigured: false`. `lib/video/video-identity.ts` is the
canonical resolver — right class, full agent → team → brokerage cascade, honest fallbacks.

Live-verified on production: both reader predicates resolve the agents.id row and never
the users.id row; the save-authorisation lookup returns 1 for the new shape and 0 for the
old. Zero agent-scope rows existed, so there is nothing to migrate — the whole feature
had never once been used successfully. Seeded rows cleaned to 0.

### The guard grew a fourth family

`test:agent-id-class` now scans **untyped polymorphic scope columns**, and scans **reads
as well as writes** — with no FK to reject a bad write, a mismatched read is exactly as
silent and exactly as fatal. Four new pure checks pin the detector: it flags the auth user
id at agent scope, accepts a resolved `agents.id`, leaves the team and brokerage scopes
alone (their ids are not agents ids), and catches the write side, not just the filter.
21 checks, 0 failures.

`tsc --noEmit`: 0. `npm run guard`: 98 simulators, exit 0.

---

## Onboarding Operations: a console that could not count, and could not act

`TrainingProgressPanel` appeared three times, which is what put this on the list. Two of
the three are legitimately different components that share a name — an Academy "My
Progress" card and a broker aggregate. The third belonged to
`app/dashboard/onboarding/components/os/`, an **eight-component directory with zero
importers**: not one file in the repo imports that barrel or any component in it. It had
been built as an "OS" layer for the agent onboarding dashboard and never mounted, while a
same-named set under `app/dashboard/admin/onboarding/components/os/` is what actually
ships.

Comparing them is what exposed the state of the shipping console.

### Nothing on it worked

| | shipped | actually |
|---|---|---|
| "Stalled" metric card | red count + intervention button | **always 0** |
| Actions tab | batch panel | selection nothing populates; both buttons permanently disabled |
| `onBatchAction` handler | — | empty body, comment: *"Batch actions handled by OnboardingBatchActionsPanel"* |
| Quick Actions | 3 buttons | **no `onClick` on any of them** |
| Command strip | 4 links | 2 are **404s**; a third points at the agent's own page |

The stalled count is the interesting one. `agent_onboarding.status` has a live CHECK
admitting exactly `in_progress`, `completed`, `paused`. The console filtered
`status === "stalled"` — a value the constraint forbids, so it could never be non-zero,
and the `stallCount > 0` branch guarding the "N Stalled Agents · Need intervention"
button was unreachable code. The whole intervention path was decoration on decoration.

Meanwhile `/dashboard/onboarding/admin/agents` — a second broker-facing onboarding
surface — had the honest rule all along: `in_progress` and no completed step in 7 days.

### One roster, one stall rule

`lib/onboarding/onboarding-roster.ts` is now the single loader for both surfaces, with
`isOnboardingStalled` exported pure so a guard can pin it without a database. The roster
page's local copy is gone.

That page's loader also carried an id-class bug of its own: it resolved agent names with
`users.id IN (agent_onboarding.agent_id …)`, but that column is an `agents(id)` FK. Live
against production, with three seeded onboardings under three real agents:

```
old lookup  users.id IN (agents ids)   → 0 hits on every row   ("Unknown", blank email)
new lookup  agents.user_id → users     → Jennifer Torres, Marcus Williams, Alex Rivera
stall rule  30d idle in_progress → stalled ✓   1d idle → not ✓   completed → not ✓
```

Every agent in the broker's roster table had been rendering as "Unknown".

### Actions that act

- **Batch panel** rebuilt over the real roster: checkboxes, select-all, per-agent progress,
  stall badges, idle days. `nudgeOnboardingAgentsAction` writes real `notifications` rows —
  admin/broker gated, targets re-read from the caller's own brokerage so a client-supplied
  id that is not in it simply does not appear. Live-verified the exact payload lands and
  satisfies both CHECK vocabularies (`channel = in_app`, `priority = medium`).
- **Agents with no linked user account** are badged and counted as skipped, not silently
  dropped — the toast says how many.
- **Quick Actions** now hands its selection to the Actions tab; the stalled button
  preselects exactly the stalled agents.
- **Command strip** rebuilt on three routes that exist. "View All Agents" points at the
  broker roster rather than the agent's own progress page.

Two things were deliberately **not** carried over. "Enroll in Training" had no enrolment
backend, and "Create Training Campaign" had no campaign backend — a button that pretends
to assign coursework is worse than no button, and the curriculum editor already on this
page is the real authoring surface. The orphan directory's `onResetProgress` prop was
likewise not ported: it was a signature with no implementation anywhere, and resetting
another agent's onboarding is not something to invent on the way past.

`scripts/onboarding-ops-simulator.ts` (25 checks) pins all of it, including that no
surface may filter on the impossible `'stalled'` literal again. Its source assertions
strip comments first — these files document the strings they assert absent, and without
that the guard would flag its own explanations.

Test data cleaned to baseline: 1 pre-existing onboarding, 0 completions, 0 notifications.

`tsc --noEmit`: 0. `npm run guard`: 99 simulators, exit 0.

---

## Two buyer-fatigue scorers, and only one of them could write

`lib/fatigue/` held `fatigue-calculator.ts` (323 lines) and `fatigue-scorer.ts` (192).
Not a naming coincidence: same inputs, same two tables (`buyer_fatigue_scores`,
`fatigue_alerts`), same five factors, same 0–100 scale. Both live, both wired, exported
side by side from the same barrel — with **different thresholds and different words**:

| | calculator | scorer |
|---|---|---|
| bands | 25 / 50 / 75 | 35 / 60 / 80 |
| vocabulary | fresh · moderate · high · critical | fresh · **watch** · **warning** · critical |
| engagement trend | stable · declining · increasing | stable · declining · **slowing** |
| alert type | `fatigue_threshold_crossed` | **`fatigue_warning`** / **`fatigue_critical`** |

Every bolded value is rejected by a live CHECK constraint. Proven against production by
attempting each literal:

```
risk_level        moderate/high/critical/fresh → ACCEPTED     watch/warning → REJECTED 23514
engagement_trend  stable/declining/increasing/stopped → OK    slowing       → REJECTED 23514
alert_type        fatigue_threshold_crossed → ACCEPTED        fatigue_warning/_critical → REJECTED
```

So the scorer could persist a score only when it landed below 35 or at 80+. Everything in
the **35–79 band vanished**, every `slowing` trend vanished, and every alert it raised
vanished. Not an error anyone would see — supabase-js resolves with `{ error }`, and none
of its callers checked.

It got worse downstream. Two UI surfaces were built on the scorer's vocabulary — the
brokerage fatigue dashboard's **Watch** and **Warning** columns and filter tabs, and the
contact fatigue widget's risk config — filtering for values the database cannot hold. Both
were permanently empty. `fatigue-display.ts`, the pure "is it safe to reach out?" helper,
mirrored the same thresholds, so the badge an agent sees described a row that could never
exist.

The calculator is the survivor: it speaks the vocabulary the database admits, and it is
also the more complete one (AI-authored alert copy, `smart_assistant_suggestions`, a
lifecycle sub-event, batch scoring). Retired with the scorer: **`app/actions/fatigue.ts`**,
a second action module duplicating four of `buyer-fatigue.ts`'s exports over the same
tables — one consumer against the survivor's eight.

Ported into the survivor before deletion, per keep-the-advanced-one:

- the **AI recovery plan** at high/critical (the scorer's genuinely-additional step),
  best-effort so a plan failure never fails the score
- **`getBuyerFatigueAlert`**, the singular-active-alert reader `ContactFatigueGuard` needs
- `recovery-generator.ts` retyped onto `FatigueResult`

Three further defects fell out of the sweep:

1. `lifecycle_events.actor_user_id` is a `users(id)` FK; the calculator stamped
   `contact.agent_id`, an `agents.id`. The alert beside it resolved the owning agent's user
   id correctly — the sub-event just never reused it, so it FK-threw while the alert landed.
2. The fatigue cron passed `contact.agent_id ?? contact.brokerage_id` as the actor — a
   **brokerage id as a user id** whenever the contact had no agent. `calculateFatigue`
   resolves the owner itself, so the argument is gone.
3. The contact widget titled its alert from `alert_type === "fatigue_critical"` — a value
   the CHECK forbids — so a critical alert always rendered as "Fatigue Warning". Severity
   now reads `risk_level`.

`test:fatigue` grew a vocabulary section (43 checks total) that walks all nine fatigue
source files and fails on any CHECK-rejected literal — comments stripped first, since these
files document the words they retired. It was **not on the guard chain**; it is now.

Test rows cleaned to 0 scores, 0 alerts.

`tsc --noEmit`: 0. `npm run guard`: 100 simulators, exit 0.

---

## Two property-alert engines, both on the cron dispatcher

`lib/alerts/` (496 lines, 5 files) and `lib/property-alerts/` (786 lines, 6 files). Same
table, same three writes (`property_alerts`, `property_alert_results`,
`property_alert_delivery_log`), same job: search IDX → score → dedup → deliver → log.

Both were **scheduled**. `CRON_REGISTRY` carried `/api/alerts/cron` at `6,21,36,51 * * * *`
*and* `/api/property-alerts/run` at four per-frequency schedules. Every active buyer alert
was being processed twice an hour by two independent code paths with different matchers.

The one thing that kept buyers from being mailed the same listing twice is that both
dedup against `property_alert_results.mls_number` — whichever engine got there first
inserted, the other skipped. That is a shared table doing the work a shared engine should
have been doing.

| | `lib/property-alerts` | `lib/alerts` |
|---|---|---|
| IDX search | dedicated module; logs `api_called`, `response_time_ms` | inline query builder |
| matcher | `{ qualifies, score, reasons }`, 200 lines | bare number, threshold 40 |
| dedup | mls + **re-send on a NEW price reduction** | mls only — a price drop never re-notifies |
| `max_results_per_alert` | honoured | ignored |
| delivery log | batch_id, channels, api timing | partial |
| extras | first-look consent, assistant suggestion | — |
| **buyer snooze** | **ignored** | honoured |

`lib/property-alerts` wins on every row but the last, and the last one matters: `snoozed_until`
is a column on `property_alerts`, set by the buyer, and the surviving engine **did not read it**.
A buyer who muted their search kept getting alerts from it. Ported across as
`lib/property-alerts/alert-cadence.ts` and applied in both entry points — `runAlert` refuses a
snoozed alert outright, so an agent's manual run cannot override a buyer's mute either.

Also ported: the retired engine's **batch cap** (50 per run). It is not a silent truncation —
anything over the cap is counted, returned as `deferred`, logged by name and picked up by the
next run of that frequency.

Deliberately **not** ported: `shouldRunNow(frequency, now)`, the retired engine's own cadence
clock. It was a second copy of a schedule `CRON_REGISTRY` already declares — instant `*/15`,
daily `0 8`, weekly `0 8 * * 1`, twice_daily `0 8,17` — and two clocks for one cadence is the
drift being removed. The registry is the clock; `/api/property-alerts/run` is called with the
frequency it is due for. All four frequencies are valid values of the live
`property_alerts.frequency` CHECK (`instant | twice_daily | daily | weekly | paused`).

`test:alert-cadence-snooze` was rewritten to assert cadence against the **registry** rather
than a second implementation of the rule, plus three checks that the surviving engine actually
applies the snooze it inherited and reports what it deferred. It had a package script but was
**not on the guard chain**; it is now. 24 checks.

Live-verified on production: a snoozed and an unsnoozed daily alert seeded under a real
contact and agent, the batch query returning both with `snoozed_now` true/false as expected —
the predicate the filter uses. Cleaned to 0.

`tsc --noEmit`: 0. `npm run guard`: 101 simulators, exit 0.
