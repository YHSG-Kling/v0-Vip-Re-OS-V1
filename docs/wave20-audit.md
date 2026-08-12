# Wave 20 — the tenant escape hatch is open to the public internet

The database came back. The first thing it did was answer a question that had
been open since wave 16, and the second thing it did was replace that question
with a worse one.

## The wave-16 question: CLOSED, verified, negative

Under the exact m392/m393 predicate — permissive, `polcmd = '*'`, qual `'true'`,
granted to PUBLIC / `anon` / `authenticated` — the live database returns **zero
rows**. The 19 rows a broader query returns are all granted explicitly to
`service_role`, which holds `BYPASSRLS`; `to_public` is false on every one.

Positively confirmed on the nine `scripts/330` tables: **no "Service role full
access" policy exists on any of them.** They carry per-command tenant-scoped
policies instead. `client_portal_activity_select` reads
`is_platform_admin() OR (is_lead_visible_role() AND has_brokerage_access(…))` —
**wave 15's analysis stands.**

So the legacy `scripts/*.sql` RLS block never ran here. m392 dropped nothing,
m393 passes silently, `test:rls-public-grant` is regression insurance.
`docs/wave16-audit.md` has been updated to record this rather than left saying
"still open".

## W20-1 — 1,025 policies across 320 tables let `anon` read, write and delete untenanted rows

Migrations 029 and 030 added `brokerage_id` to a large slice of the schema and
installed the tenant policy in this shape:

```sql
CREATE POLICY "<table>_tenant" ON public.<table> FOR ALL
  USING      (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());
```

029's own header explains the `IS NULL` branch, and the explanation is honest:

> All target tables were **empty or near-empty at apply time**, so the column is
> added as NULLABLE (no default backfill needed)…

It was written as a grandfather clause for rows that were believed not to exist.
It is not a grandfather clause. It is a **standing rule that any row without a
tenant belongs to everyone** — and there is no `TO` clause, so "everyone" is
Postgres `PUBLIC`, which includes **`anon`**: the key that ships in the browser
bundle.

### Measured, live, on the production database

| | |
|---|---|
| policies containing the escape | **1,029** |
| of those, granted to `PUBLIC` (⊇ `anon`) | **1,025**, across **320 tables** |
| SELECT / UPDATE / DELETE / INSERT / ALL | 262 / 237 / 231 / 234 / 61 |
| tables carrying rows with `brokerage_id IS NULL` today | **11** |
| such rows | **317** |

`anon` privileges are Supabase's default `GRANT ALL` — `SELECT, INSERT, UPDATE,
DELETE, TRUNCATE, REFERENCES, TRIGGER` on every one of these tables. RLS is the
only thing in the way, and RLS says yes.

### Not inferred — executed

```sql
begin; set local role anon;
select (select count(*) from public.content_ideas), … ;
rollback;
```

→ `content_ideas` **125**, `onboarding_steps` **66**, `ai_insights` **64**,
`training_videos` **12**, `api_response_logs` **3**. Then, in a transaction that
was rolled back and verified rolled back (`probe_leftovers = 0`):

| as `anon` | result |
|---|---|
| `UPDATE content_ideas WHERE brokerage_id IS NULL` | **125 rows** |
| `DELETE FROM api_response_logs WHERE brokerage_id IS NULL` | **3 rows** |
| `INSERT INTO content_ideas (title) VALUES (…)` | **1 row** |

The INSERT is the one that compounds: 234 of these policies carry the escape in
`WITH CHECK`, so an anonymous caller can *manufacture* untenanted rows in 234
tables, and each new row is then readable, updatable and deletable by everyone
under the same policy.

### The fix, and why it is a strict narrowing rather than a rewrite

**Add `TO authenticated` to every escape policy granted to `PUBLIC`.** The
expression is untouched; the only thing removed is `anon`.

Checked before proposing it, because a blanket narrowing is exactly the kind of
change that quietly breaks a public page:

- **Roles.** `anon` and `authenticated` are the only non-`BYPASSRLS`
  application roles. `postgres`, `service_role`, `supabase_admin` bypass RLS, so
  cron and server work are unaffected. `authenticator` never queries as itself —
  PostgREST `SET ROLE`s to one of the two.
- **Other policies still stand.** Policies OR together, so a table with a
  deliberate public policy keeps it. 53 of the 320 have one.
- **Logged-out surfaces.** Only two browser-client reads run outside a session.
  `listing_inquiries` (the inquiry form) is **not** in the escape set and already
  has the correct shape — `FOR INSERT WITH CHECK (true)` to PUBLIC, with
  SELECT/UPDATE/DELETE gated by `has_brokerage_access`. That is the pattern to
  point at. The other is `NeighborhoodWidget`, below.

### The one apparent exception, which turns out to prove the point

`neighborhood_reports` **is** in the escape set, and `NeighborhoodWidget.tsx:92`
reads it from the browser on the public listing landing page. That looks like the
one place where narrowing would break something.

It would not, and the reason is worth stating: the widget's fetch is guarded by
`if (initialData || !listingId) return`, and its only renderer —
`app/listing/[slug]/page.tsx:352` — passes `data={neighborhoodData}` and **no
`listingId`**. The client fetch has never run.

And had it run, it would have returned nothing: its only route through RLS is the
escape, so it can only ever see reports with **no tenant**. A correctly-stamped
report is invisible to it. The escape is not what makes that widget work — it is
what would have made it look like it worked, on other tenants' data.

*(The fetch branch stays. It is a prop-driven fallback with a live parameter; "no
caller" is not a deletion reason.)*

### Deliverables

- `supabase/migrations/m394-…` — DO block, `ALTER POLICY … TO authenticated` for
  every policy in schema `public` whose USING **or** WITH CHECK contains the
  escape and whose `polroles` contains oid 0. Select on the **construct**, never
  on a policy-name spelling.
- `supabase/migrations/m395-…` — the assertion half, separate for the m392/m393
  reason: **a `raise` rolls back its own transaction**, so asserting inside m394
  would undo the narrowings it just made. Names every survivor.
- `scripts/rls-anon-tenant-escape-guard.ts` (`test:rls-anon-escape`) — the source
  side, **zero baseline**: no new migration may install a tenant policy that
  omits `TO authenticated`. Statement-level, not line-oriented. Negative-control
  every assertion and confirm the patch applied before believing green.
- `package.json` guard entry **and** a `MAINTENANCE_DOMAINS` entry in
  `lib/kernel/manager-registry.ts` — a proof needs both.

## W20-3 — sixteen `FOR INSERT WITH CHECK (true)` policies granted to `PUBLIC`, and narrowing the escape does not touch them

Found while checking the 53 tables that keep a second public policy — the check
that was meant to prove W20-1 was safe, which instead turned up an independent
hole. Narrowing the escape closes nothing here, so it has to ride in the same
migration or it gets missed.

| table | policy | | table | policy |
|---|---|---|---|---|
| `ai_predictions` | `ai_predictions_insert` | | `orchestrator_tasks` | `ot_insert` |
| `ai_suggestions` | `ai_suggestions_insert` | | `presentation_sections` | `presentation_sections_tenant_insert` |
| `ai_usage_log` | `ai_usage_log_insert` | | `prospect_context` | `prospect_context_insert` |
| `chat_sessions` | `widget_insert_chat_sessions` | | `prospects` | `prospects_insert` |
| `conversation_insights` | `System can insert insights` | | `saved_calculations` | `saved_calculations_insert` |
| `document_folders` | `df_insert` | | `tool_usage_sessions` | `tool_usage_sessions_insert` |
| `email_tracking` | `email_tracking_insert` | | `vendor_communications` | `vc_insert` |
| `generated_content` | `generated_content_insert` | | `vendor_usage_tracking` | `Service role can insert vendor usage` |

Two of the policy **names declare the intent they fail to implement** — "System
can insert", "Service role can insert". `service_role` holds `BYPASSRLS`, so
neither policy was ever needed for its stated purpose. What each one actually
does is grant `anon` an unconditional insert.

It is not uniformly cosmetic. `ai_usage_log` and `vendor_usage_tracking` are the
metering ledgers the vendor budget gate reads — forged rows there poison spend
accounting on the platform's own bill. `orchestrator_tasks` is a work queue.
`generated_content` is a content-injection surface.

**Fifteen of the sixteen have no anonymous writer at all.** Measured, not
assumed: zero browser-client files touch any of them. `chat_sessions` — whose
policy is named for a widget — is written by `lib/education/agent-guide.ts:106`
and `client-tutor.ts:139`, both through the **service client**, which bypasses
RLS entirely. `email_tracking` is written by the SendGrid webhook, same. And
`saved_calculations`, `prospects` and `prospect_context` have **no insert call
site anywhere in the codebase**.

**One is genuine and must survive.** `tool_usage_sessions`:
`app/actions/calculators.ts:607 trackToolUsage`, under a header reading
`// PUBLIC TOOLS (Zero Friction, No Email Required)`, uses the session server
client — so for a logged-out visitor it runs as `anon` and needs this policy.
That one is a deliberate carve-out, named in the migration rather than silently
excluded.

*(Noted in passing, not fixed here: `trackToolUsage` wraps its insert in
`try/catch` with `// Silently fail`. A bare `try/catch` around a supabase call
catches nothing — the write is fire-and-forget telemetry and the swallow is
intentional, but the mechanism it uses is not the one it thinks it is.)*

### Completeness check — do W20-1 and W20-3 together actually close the door?

Asked explicitly rather than assumed, because "we narrowed the obvious one" is
how a hole survives a fix. Every remaining policy granted to `PUBLIC` on those
320 tables, excluding the escape and excluding anything whose predicate calls
`auth.uid()` / `current_user_brokerage_id()` / `has_brokerage_access()` /
`is_platform_admin()` / `is_brokerage_admin()` / `current_user_agent_id()` /
`is_lead_visible_role()` — i.e. everything an anonymous caller could still
satisfy — comes to **three**:

| table | policy | predicate | anon? |
|---|---|---|---|
| `isa_outreach_log` | `service_role_bypass_isa_outreach_log` | `auth.role() = 'service_role'` | no |
| `seller_stage_coaching` | `seller_stage_coaching_service_write` | `false` | no |
| `offer_strategy_templates` | `Read active templates` | `is_active = true` | **yes** |

So the two changes do close it, with exactly one residual — recorded below
rather than swept into a migration it does not belong in.

**`offer_strategy_templates`: `FOR SELECT USING (is_active = true)` to `PUBLIC`.**
Confirmed as `anon`: readable, **0 rows today** because the table is empty
pre-rollout. This is not the escape and not an accident of 029/030 — it is a
deliberately written policy with a deliberate name. But an offer strategy
template is a brokerage's negotiation playbook, and the moment anybody marks one
active it is readable by the public internet. Latent, not live. **Needs an owner
ruling**, because "active" may well have been meant as *published to this
tenant's agents* rather than *published to everyone*, and only the owner can say
which.

## W20-2 — `ai_insights`: eleven writers omit the tenant, and the reader's comment says otherwise

`app/dashboard/agent/page.tsx:287`:

```ts
// … writers (app/actions/ai-predictions.ts) insert insight_title/
// insight_description and usually leave agent_id null, so include
// unattributed rows; RLS scopes reads to the caller's brokerage.
```

**RLS does not scope that read to the caller's brokerage.** The policy is the
W20-1 escape, so an untenanted insight is visible to every tenant — and to
`anon`. The comment is the exact shape this session keeps finding: a claim about
a gate, written next to the code that depends on it, never checked against the
gate.

It is not a near miss. **All eleven `ai_insights` insert sites** in
`app/actions/ai-predictions.ts` — lines 871, 1059, 1444, 1701, 1959, 2090, 2274,
2308, 2440, 2688, 2781 — omit `brokerage_id`. Live count: **64 rows, 64
untenanted.** Every insight this system has ever produced is cross-tenant
readable, and the dashboard that renders them thinks RLS is handling it.

The read compounds it: `.or("agent_id.eq.<id>,agent_id.is.null")` deliberately
widens to unattributed rows, and there is no brokerage predicate at all — so the
only tenant boundary in the whole path is the one that isn't there.

### The fix

1. **Stamp `brokerage_id` at all eleven inserts**, resolved from the caller the
   way the rest of `ai-predictions.ts` already resolves tenant context — do not
   invent a new resolver, and do not `??` between id spaces.
2. **Filter the reader** by the caller's brokerage. Keep the `agent_id IS NULL`
   widening — that is a real product decision about unattributed insights — but
   it must widen *within* a tenant.
3. **Correct the comment** to say what the code actually relies on.

**The 64 existing rows are not backfillable** — nothing records which tenant they
came from. They are dev-era rows on an unrolled-out system. They are left in
place (they are the owner's data, not mine to delete) and become invisible once
the reader filters. Recorded here rather than silently dropped.

## Recorded, NOT to be built this wave — needs an owner ruling

- **Removing the NULL escape itself** from `WITH CHECK`, `UPDATE USING` and
  `DELETE USING` across the 320 tables. W20-1 closes the *anonymous* half; the
  cross-*tenant* half stays open — any authenticated user of any brokerage can
  still read, update and delete untenanted rows. The evidence is measured above.
  It is not dispatchable unreviewed because it inverts a documented migration
  decision and **every writer that currently omits `brokerage_id` would begin
  failing its insert** — which is arguably correct and is certainly a runtime
  behaviour change nobody has approved. Some of the 317 rows are also genuine
  platform-global catalogue content (`onboarding_steps`, `training_videos`,
  `help_topics_kb`, `content_topic_sources`, `service_status`,
  `buyer_stage_coaching`, `thank_you_note_templates`), where NULL means "every
  tenant reads this" and the right answer is a **read-only** global grant, not a
  removal. Three different resolutions for one predicate — that is a ruling.
- **`api_response_logs` writes `brokerage_id: null` on purpose**
  (`connector-gateway.ts:132`: *"gateway calls are provider-scoped; tenant
  attribution lives in vendor_usage metering"*). That reasoning is sound, but it
  means the table is **platform telemetry sitting behind a tenant policy** — so
  the escape makes it world-readable and world-deletable. It wants a
  platform-admin-only policy, not a tenant one. Named, not guessed at.
- **`content_ideas` (125) and `vendors` (1) are not writer defects.**
  `content-studio.ts` stamps `brokerage_id: auth.brokerageId` and filters reads
  by it; `business-card-actions.ts:164` stamps it too. Those untenanted rows
  predate the stamping. Checked before accusing the code.
- **Leads / raw-leads.** Owner-sequenced for after loops and orphans.
- **`transcribeAudio`'s unvalidated `audioUrl`** (`ai-voice-transcription.ts:359`)
  — SSRF surface, uncapped Whisper call. Recorded since wave 2.
- **`calculateHomeValue` / `submitHomeValueRequest` have no rate limit**
  (`calculators.ts:659`). Public surfaces, real provider spend.
- **`resolveConnection`** (`lib/integrations/connection-manager.ts`) destructures
  only `data`, so a refused LEGACY read still reaches the cascade as an
  honest-looking null. Carried from wave 19.
- **`redactBudgetForActor`** (`lib/vendor-governance/budget-visibility.ts`) takes
  `VendorBudgetEval` and so cannot see `degradedTier`/`degradedSpend` — role
  scoped budget views render a degraded verdict as an ordinary one. Carried from
  wave 19.

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason.**
- supabase-js RESOLVES a refused query — destructure `error`; a bare `try/catch`
  around a supabase call catches NOTHING. Gates fail CLOSED.
- Pre-rollout the tables are near-empty: "nothing came back" is never health.
- `agents.id` / `users.id` / `contacts.id` / `leads.id` are DISJOINT. RESOLVE.
- Assert CONSTRUCTS in proofs, never spellings; strip comments before structural
  assertions; negative-control every assertion **and** confirm the control
  actually applied before believing a green result.
- **New this wave:** a comment that asserts a gate is not evidence the gate
  exists. `ai-predictions.ts` and `dashboard/agent/page.tsx` disagreed with the
  database for as long as both have existed, and only the database was asked.
