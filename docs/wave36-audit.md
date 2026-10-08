# Wave 36 — five rulings, and the lane the owner warned about was the broken one

Owner rulings, verbatim:

> "make sure that the recordings is wired to the actual call and the clsoed
> commission needs to stay on the office that closed the deal. agent's commission
> earned is located in their accounts, agent authored scripts should save to
> scripts and if it the video goes viral using that script, it should be shared
> to the whole brokerage. chat/stream is tricky since there are public and
> private options. 1. admin, superadmin, support can read tenant financilas of
> platform. 2. a brokerage can only have access to their own commission."

Three of the five turned out to be **partly built already**, which changed what
was dispatched. Researching first is what found that.

## The recordings were wired to a player nobody reached

Wave 32 built the lane. Only **two of five** surfaces used it. The authenticated
same-origin proxy exists because `recording_url` holds the raw `api.twilio.com`
media URL, which needs Twilio Basic auth — a browser hitting it directly gets a
guaranteed 401. Three surfaces still did exactly that.

**The binding itself was already correct**, and this was checked rather than
assumed: the callback matches `vendor_call_id = CallSid`, fenced by a tenant
resolved from `tenant_phone_numbers` — a number the tenant *owns*, never a
poster-supplied claim — with the signature then validated against that tenant's
own token. Proven with a decoy row in another tenant carrying the **same
CallSid**: untouched.

**The proxy, however, was strictly looser than the page it claimed to mirror.**
The page refuses on `voiceCall.agent_id !== agentId`, which is TRUE when
`agent_id` is NULL. The proxy short-circuited with `row.agent_id && …`, so a NULL
`agent_id` skipped the check entirely — and the inbound path stores NULL whenever
the dialled number is a brokerage main line. So **any plain agent could stream
the brokerage's general inbound recordings** through a route whose own page would
have redirected them away. Proven over the full cross-product: 12 cases, 1
divergence before, 0 after.

Two helpers were duplicates; survivor is
`lib/voice/recording-playback-path.ts:recordingPlaybackPath`. The direction was
not arbitrary — the dedicated module exists to be client-safe, yet **both**
importers were pulling the copy out of the server-side module.

## The office stamp, and two access rulings that were inverted

`commission_splits` had no `location_id`, so wave 32's office report derived from
the agent's *current* office and documented the cost: an agent who transfers
takes their whole history with them. The owner reversed that. m427 stamps the
office at write time from `lib/kernel/resolve-user-office.ts` — the one
precedence rule — with **no DEFAULT and no GENERATED expression**, because a
DB-side derivation would be a second precedence rule and would drift.

Measured live in a rolled-back fixture, against the **unmodified** policies:

| principal | agent_commissions visible | can UPDATE a colleague's row |
|---|---|---|
| ordinary agent | 2 of 3 (own + colleague) | **YES** |
| client-portal `contact` user | 2 of 3 | **YES** |
| superadmin | own tenant only | no |
| platform support | own tenant only | no |

So ruling 1 was not merely unimplemented — it was **inverted**: platform staff
could read *nothing* cross-tenant. And an ordinary agent could rewrite a
colleague's commission.

`can_read_tenant_financials()` is `is_platform_staff()` **minus marketing**: the
standing staff roster is four roles, but the financial ruling named three.
Deliberately absent from every write clause — the ruling says "read", and nothing
in that sentence authorises a support operator to alter a commission. m428 claim 5
asserts that schema-wide, because the next financial table to adopt the helper is
where the mistake gets made.

Also found: **m419's documented agent-own clause on `commission_splits` was dead
code**, because an ordinary agent already matched every row in their brokerage
through the unconditional `has_brokerage_access` sitting next to it.

## Scripts: the writer had been refused since the policy was written

`generateScriptContent` already wrote to `scripts`. Its INSERT policy was
`is_platform_admin()` only, so **every agent's save had been refused** — which is
why the table held zero rows. The code already reported that honestly and its
comment explicitly deferred the decision. The owner made it; the comment is now
the decision.

The load-bearing piece is a CHECK, not a policy:
`(visibility = 'platform') = (brokerage_id IS NULL)`. The SELECT policy **must**
admit `brokerage_id IS NULL` (that is the platform catalogue, per m406/m421) — and
that disjunct does not mention the caller, so it is true for every tenant. Without
the CHECK, the owner's feature becomes the mechanism that publishes one agent's
private prospecting script to every brokerage. The CHECK makes untenanted mean
platform *by definition*, so there is no third "unstamped" state for the disjunct
to catch.

`scripts_select` was `USING (true)` — every script readable by every tenant. It
survived m417 by being granted to `authenticated` rather than PUBLIC, i.e. scored
as "not an ANONYMOUS leak" rather than as "not a leak".

**The video→script link did not exist.** The `script_id` in the video lane points
at `video_scripts_library`, a different table; the only FK into `scripts` was from
`long_form_videos`, documented dead schema. Creating the link was part of the job.
The viral threshold keys on `video_performance_tracking.total_views`, which is
really written — `share_rate` round-trips through a percentage and loses the count,
and `ai_video_projects.view_count` has **no producer at all**.

**Partial, and named as such:** `source_script_id` has a wired server-side producer
but no UI passes a `scripts` id yet, so in production the column stays NULL and the
promoter's honest no-op path runs. No page was invented to close it.

## chat/stream had no caller; the public lane did

The route the owner flagged is an **orphan** — nothing in the tree POSTs it. It was
a third, unauthenticated copy of the private agent lane, and it carried two holes:
identity from the request body, and a `contactId` service-client read of *any*
contact whose name and status were injected into the prompt and echoed back by the
model. The second needs no session id at all.

**The lane with real public callers was the broken one.**
`/api/widget/session` took `brokerage_id` and `agent_id` from an unauthenticated
body onto a service client. Proven by inserting the exact row the old route would
write: a session for VIP Premier stamped with an agent of *Your Brokerage*. The
database accepted it — both FKs are satisfied; nothing but the route stood in the
way.

And three siblings were worse than a session mint: `/api/widget/intake`,
`/api/widget/capture` and `/api/widget/live-agent-request` each let a public POST
create a **consented contact** — with a TCPA consent-event row, an enrichment queue
row, an activity and a notification — in **any** brokerage, attributed to **any**
agent. All now derive identity from the opaque server-issued token.

`/widget/[brokerageSlug]` was also simply **dead**: it pre-generated a token and
commented that the client would create the DB row; the client never called. Every
send from that lane answered `403 Invalid or closed session`.

Origin enforcement is **half done, deliberately**. The `Origin` header check is
real (both entry points are same-origin iframes, and a third-party page cannot
forge it). An `allowed_domains` list was **not** invented: the chat widget has no
such config, `embed_widgets.allowed_domains` belongs to the avatar embed, and a new
column would be client-supplied, default-empty and unreachable without a settings
editor — a migration for a control that adds nothing over the header check.

## Two things I did not fix, on purpose

- **Client-portal users can read the commission book.** m427 kills their write;
  the read survives via the `(not is_agent_role())` branch. Portal accounts almost
  certainly reach far beyond these two tables, and closing it only here would look
  like the class was handled. → #185.
- **There is no `streamTextRouted`.** All eight streaming routes miss the routing
  caps and the cost ledger. Token counts only exist after the stream ends, and the
  ledger's client captures cookies at construction — a naive inline copy produces
  silently unbilled spend. The two pre-stream rails (Data Guard, fair-use) were
  closed inline; the helper is its own wave.

## A ratchet raised, with its reason

`test:error-message-honesty` went 76 → 79. All three are on the public chat widget,
where the visitor is not the operator and vagueness is the correct register; one
(`!cancelled`) is the React effect-cleanup flag and not a condition at all. Named
individually in the guard header, because a ratchet raised without a reason is just
a disabled guard. Negative-controlled: 78 goes red.

## Verification

Typecheck EXIT=0 cold. Guard chain both halves — 28/28 and 457/457 with
`test:sweep` last and actually run. m427–m430 applied via `apply_migration` and
confirmed in `supabase_migrations.schema_migrations`, each assertion body run as a
**negative control before** its change (m428 named all three pre-conditions false;
m430 named `USING(true)` and the 3 PUBLIC write policies). `test:schema-drift`
caught `commission_splits.location_id` exactly as it caught `users.location_id` in
wave 32; snapshot regenerated from the live schema. Every live proof ran inside a
transaction ended by a `raise`, so fixtures roll back by construction — zero
leftovers re-verified on every table touched.

**Not verified:** no Twilio credentials, so no real recorded call; no `.env`, so no
HTTP round-trip against the widget lane; `scripts`, `commission_splits` and the
video tables all hold 0 rows, so the promoter's TypeScript control flow is not
exercised. Authorization predicates are proven at the SQL level throughout.

m431 and m432 remain unused.
