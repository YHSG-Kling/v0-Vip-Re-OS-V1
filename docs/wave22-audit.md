# Wave 22 — the external-portal routes ask "does this partner have access", never "is the caller this partner"

Found while closing the last two open questions in W21-5. One of them settled in
a sentence; the other one opened this.

## W22-1 — `partnerId` arrives in the query string and is never checked against a session

`app/api/external-portal/documents/download/route.ts`:

```ts
const { searchParams } = new URL(request.url)
const docId       = searchParams.get("docId")
const partnerId   = searchParams.get("partnerId")     // ← caller-supplied
const partnerType = searchParams.get("partnerType")
…
const supabase = await createClient()                  // session client
```

The route then does a genuine-looking access check — for `title` it reads
`title_company_users` where `user_id = partnerId AND transaction_id =
document.transaction_id`; for `lender` it resolves the lender vendor and checks
`vendor_assignments`. If that comes back empty it 404s.

**That check validates that the partner named in the URL has access. It never
validates that the caller IS that partner.** Measured: the file contains **zero**
calls to `auth.getUser()` or `getSession()` — and so does its sibling,
`app/api/external-portal/actions/complete/route.ts`, which takes `partnerId`
from input across five sites and *performs an action* rather than a read.

| route | session checks | `partnerId` from caller input |
|---|---|---|
| `external-portal/documents/download` | **0** | 7 |
| `external-portal/actions/complete` | **0** | 5 |

Those are the only two routes under `app/api/external-portal/`.

### What RLS does and does not cover

The route runs on the **session** client, so RLS is the only backstop, and it is
a partial one. Live policies:

| table | policy | shape |
|---|---|---|
| `documents` | `documents_tenant_select` | `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())` |
| `title_company_users` | `…_self_or_brokerage_select` | `(user_id = auth.uid()) OR (brokerage_id = current_user_brokerage_id())` |
| `vendor_assignments` | `…_tenant_select` | `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())` |
| `document_downloads` | `dd_insert` | **`true`, to PUBLIC** |

So, precisely:

- **Anonymous callers get nothing useful today** — and only because of m394.
  Before wave 20 these policies were granted to `PUBLIC`, so an unauthenticated
  request to this URL would have run the whole check as `anon`. It now runs as a
  role that RLS filters to empty, and the route 404s.
- **Any authenticated user is a different story.** The membership read is
  admitted by `brokerage_id = current_user_brokerage_id()`, so an ordinary agent
  can name *their own brokerage's* title user and pull any document on that
  transaction — the route never asks whether they are that person, and their own
  role is never consulted.
- **Across brokerages, the escape is the hole**: `documents_tenant_select`
  carries `brokerage_id IS NULL`, so **any untenanted document is readable by
  every authenticated tenant** through this route. That is task #156's
  cross-tenant half, reached through a surface that hands back `storage_url`.
- **The audit trail is forgeable and probably unreadable.** `dd_insert` is
  `WITH CHECK (true)` to PUBLIC, and `dd_select` gates on `user_id = auth.uid()`
  while the route writes `partner_id` — so the row recording the download may be
  invisible to everyone.

### The shape of the fix — and what needs deciding first

The mechanical part is clear: **derive the partner identity from the session,
never from the request.** Call `getUser()`, resolve the caller's partner record,
and use *that* id in the membership check — reducing `partnerId` to at most a
cross-check that must agree, or removing it entirely.

What is **not** mine to decide is how external partners authenticate. `/portal`
proper is Supabase-authenticated (`app/portal/[contactId]/layout.tsx:58` calls
`getUser()`, `:156` redirects to `/portal/login`), and `title_company_users` keys
on `user_id`, which strongly suggests partners are real auth users. If that is
true this is a straightforward repair. If external partners are instead meant to
arrive by signed link with no Supabase session, the fix is a token, not a
`getUser()` — a different build. **Owner call.**

Until it is answered, do not "fix" this by adding a `getUser()` that locks out a
partner cohort that was never meant to have accounts.

## W22-2 — W21-5 is now fully scoped: 37 narrow, 1 carve-out

Both questions wave 21 left open are answered, and both by reading rather than
inferring:

- **`calculator_history` — settled, no anonymous writer.** Its callers are
  `app/portal/[contactId]/resources/page.tsx` and `portal-financial-tools.tsx`,
  and `/portal` requires a Supabase session. `saveCalculatorResult` runs as
  `authenticated`. My earlier suspicion — that it sat in the public-tools lane
  alongside `tool_usage_sessions` — was a positional guess and it was wrong.
- **`document_downloads` — settled for this question.** The route's caller is
  meant to be an authenticated partner, and an anonymous caller cannot reach the
  insert anyway (the membership read returns empty first, so it 404s). The
  `WITH CHECK (true)` grant serves nobody and is W22-1's problem, not a
  legitimate anonymous writer.

So the count is **38 tables: 37 to narrow, 1 named carve-out
(`listing_inquiries`)** — the same shape as m394's `tool_usage_sessions`, and
now dispatchable.

## Recorded, NOT to be built — still owner rulings

- **#156 — the `brokerage_id IS NULL` escape's cross-tenant half.** W22-1 gives
  it a concrete consequence to weigh: an untenanted document is readable by every
  authenticated tenant through a route that returns `storage_url`. Still three
  correct resolutions depending on the table.
- **`offer_strategy_templates`** — `FOR SELECT USING (is_active = true)` to
  PUBLIC. Zero rows; the first active template publishes a negotiation playbook.
- **How external partners authenticate** — W22-1 above.
- **Leads / raw-leads**, owner-sequenced.
- **`transcribeAudio`'s unvalidated `audioUrl`** (`ai-voice-transcription.ts:359`).
- **`calculateHomeValue` / `submitHomeValueRequest` rate limiting**
  (`calculators.ts:659`).

## Carried from wave 21

- **`connector-health/route.ts`** — a refused credential read produces a skipped
  probe with no signal, on the surface whose job is reporting broken connectors.
  Consuming the discriminated form changes what lands in `connector_health_log`.
- **`ai_predictions.entity_id` is `uuid NOT NULL` and `predictWinningOffer`
  writes an MLS string** — that write has never landed. The refusal is surfaced
  now; choosing a uuid identity for an MLS listing is a schema decision.
- **`ai_autopilot_plans.agent_id` / `conversation_intelligence.agent_id` FK
  `agents(id)` while both writers pass a `users.id`** — FK violations, consistent
  with both tables holding zero rows.

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason.**
- supabase-js RESOLVES a refused query — destructure `error`. Gates fail CLOSED.
- `agents.id` / `users.id` / `contacts.id` / `leads.id` are DISJOINT. RESOLVE.
- Assert CONSTRUCTS in proofs; negative-control every assertion and confirm the
  control applied before believing green.
- A comment that asserts a gate is not evidence the gate exists.
- Census the callers before trusting that a signal reaches them.
- **New this wave:** an authorization check that reads its subject from the
  request is not an authorization check. `partnerId` looked like a parameter and
  was actually the answer to the question being asked.

## OWNER RULINGS (given during wave 22)

Both were raised with the measurements above rather than guessed at, and both
came back decided.

### 1. External partners are REAL SUPABASE AUTH USERS

So W22-1 is a **session-identity repair**, not a token scheme. The partner
identity comes from `getUser()`; `partnerId` in the request stops being the
authorization subject. The alternative the audit recorded — signed links with no
session, where adding `getUser()` would have locked out an entire partner cohort
— is **not** what this product does, and is now closed as a possibility rather
than left hanging.

This also fixes the shape of the refusal: no session is a **401**, and it must
stay distinguishable from "this partner has no access to that document", which
is a **404**. Collapsing them is how an outage reads as a permission decision.

### 2. Task #156 — the NULL escape resolves PER TABLE

The ruling is the third option, and it is the one that is correct everywhere
rather than simplest:

| class | resolution |
|---|---|
| genuine platform catalogues — `onboarding_steps`, `training_videos`, `help_topics_kb`, `content_topic_sources`, `service_status`, `buyer_stage_coaching`, `thank_you_note_templates` | a **read-only** global grant. NULL keeps meaning "every tenant reads this" — it stops meaning "every tenant may update and delete this". |
| `api_response_logs` | a **platform-admin** policy. It writes `brokerage_id: null` deliberately (`connector-gateway.ts:132` — "gateway calls are provider-scoped; tenant attribution lives in vendor_usage metering"), so it is platform telemetry that was never tenant data and should not sit behind a tenant policy at all. |
| everything else (the large majority of the 320) | the escape is **removed**. |

**The consequence to plan for, stated up front:** removing the escape means every
writer that omits `brokerage_id` starts failing its insert. That is arguably the
correct behaviour — this session has fixed a dozen such writers precisely because
an untenanted row is a public row — but it is a real runtime change and the
writers must be found first. Waves 20 and 21 already fixed `ai_insights` (11
sites), `compliance_flags`, `ai_predictions` (2), `ai_autopilot_plans`,
`conversation_intelligence` and `ai-prediction-outcomes`. The remaining ones are
what the census for this work has to enumerate **before** the migration lands,
not after.

Sequencing note: this work writes migrations, and so does the W21-5 narrowing
(m396/m397) already in flight. It waits until that lands rather than racing it.

## W22-3 — the #156 blocker, ENUMERATED: 146 writers would start failing

Ruling 2 says the escape is removed everywhere except the catalogues and
`api_response_logs`. Its stated precondition was *"the remaining writers must be
found first"*. Found:

| | |
|---|---|
| tables carrying the escape **and** a `brokerage_id` column | **323** |
| of those, protected by a `*_set_brokerage` back-fill trigger | **14** (62 such triggers exist, but only 14 land on escape tables) |
| unstamped `.insert()` / `.upsert()` sites into escape tables | **211**, across **87** tables |
| …covered by a back-fill trigger | 55 |
| …carrying a spread that *may* stamp (needs reading) | 10 |
| **…HARD — no trigger, no spread, would fail immediately** | **146**, across **77** tables |

Scanned string-aware with balanced-delimiter matching and `brokerage_id`
required at **depth 1**, because the same three letters nested inside a jsonb
payload stamp nothing — the same trap wave 20's guard was built around.

Heaviest first:

| table | hard sites | |
|---|---|---|
| `automation_errors` | **17** | |
| `notifications` | **16** | |
| `sequence_step_executions`, `open_house_attendees`, `cron_execution_logs` | 4 each | |
| `social_posts`, `smart_assistant_suggestions`, `open_house_rsvp_tracking`, `open_house_invitations`, `listing_page_analytics` | 3 each | |
| 20 more tables | 2 each | |
| the remaining ~47 tables | 1 each | |

### The triage this needs before anyone writes SQL

The 146 are **not** all defects. `api_response_logs` proved that a table can
write `brokerage_id: null` deliberately and correctly — it is platform telemetry,
and the ruling exempts it with a platform-admin policy rather than a stamp. At
least two of the heaviest tables here look like the same class:
**`automation_errors`** (17) and **`cron_execution_logs`** (4) are infrastructure
ledgers, and `health_metrics` / `system_health_checks` appear in the long tail.

So the work splits three ways, and guessing which bucket a table is in is
exactly how a correct migration breaks a working lane:

1. **Platform-class** — exempt, and given a platform-admin policy like
   `api_response_logs`. Identify by reading the writer, not by the name.
2. **Tenant-class** — stamp the tenant, resolved through the record, the way
   waves 20 and 21 did for `ai_insights`, `compliance_flags`, `ai_predictions`,
   `ai_autopilot_plans` and `conversation_intelligence`.
3. **Trigger-covered (55)** — verify the trigger actually covers the shape being
   written. Wave 21 found `ai_predictions_set_brokerage` had **no `property`
   branch**, and that every one of these triggers is **SECURITY INVOKER**, so it
   yields NULL whenever the inserting caller cannot read the anchor. A trigger is
   a net with holes in it, not a guarantee.

`notifications` (16) is the one to look at first among the tenant-class
candidates: it is high-volume, user-facing, and an untenanted notification is
readable by every tenant under the escape that is about to be removed.

**Sequence:** triage → fix the tenant-class writers → *then* the migration. Not
the other way round. Removing the escape first would turn 146 silent
mis-tenanted writes into 146 loud failures, which is better but not good.
