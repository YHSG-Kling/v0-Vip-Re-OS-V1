# Wave 16 — the notes the agents left open

Every item here was named in a previous ledger by the agent that declined to do
it, with a reason. Each reason was re-read today and checked against the tree as
it stands now — because two of them were conditional ("once X lands"), and X has
since landed. Two items are **closed on inspection** and are recorded as such
rather than dispatched.

## W16-1 — `portalNaturalSearchAction` is ungated, and it is the fifth sibling

`app/actions/portal-nl-search.ts:28`. Wave 15 gated four buyer-facing portal
actions in `buyer-offer-tools.ts` against `requireContactAccess`. The agent that
did that work found this one and declined it in writing: *"it is outside W15-2's
named four and gating it changes who can search."* Correct call at the time —
the slice's file scope did not include it.

Re-read today, the defect is the same class, verbatim:

```ts
export async function portalNaturalSearchAction(input: { contactId: string; query: string }) {
  ...
  const svc = createServiceClient()
  const { data: contact, error: contactError } = await svc.from("contacts")
    .select("id, brokerage_id, agent_id, has_login").eq("id", input.contactId).maybeSingle()
```

A bare `contactId` on a `"use server"` export, straight onto the service client.
Any authenticated user who holds a contact uuid can run a paid RentCast/IDX
search **billed to that contact's brokerage**, and stamp a
`client_portal_activity` row on someone else's client that their agent will read
as their buyer's search intent. The read destructures `error` and the activity
row is tenant-stamped — wave 15 fixed both of those here — but neither is a
gate.

The agent's stated hesitation ("gating it changes who can search") is the right
question and it has an answer: `requireContactAccess` admits the contact
themselves (linked user id, matching email, or an accepted+unexpired portal
invite) **and** staff in the contact's own brokerage. That is exactly the set the
portal page at `app/portal/[contactId]/` already admits. The gate is not
narrower than the surface, so no real user loses the button.

## W16-2 — the batch entry point the offer lane named and could not build

`app/actions/buyer-offer/handle-multi-offer.ts:65-99` carries a KNOWN LIMIT the
author wrote out in full rather than hiding:

> *this is still one activities read per offer, issued concurrently. A true
> single-query batch needs a batch entry point on the canonical module itself
> (`deriveOfferStatesFromActivities`), and `lib/buyer-offer/offer-lifecycle.ts`
> is outside this slice — folding the rows here instead would mint the second
> derivation the offer lane spent a wave deleting.*

That reasoning is correct and it is why this is a loop and not a defect: the fix
belongs on the canonical module, and the canonical module was not in that slice's
write scope. It is in this one.

Three readers pay the cost — `checkPendingOfferLimit` (:241),
`getBuyerActiveOffers` (:390), and the sweep at :485 — and the buyer's
multi-offer banner calls two of them at once, so a buyer carrying five offers
issues eleven reads to render one card.

The shape is fixed by the constraint that created the limit: **one derivation, one
key.** `deriveOfferStateFromActivities` must not grow a rival — it must become
the single-offer face of the batch. One `activities` read filtered
`.in("entity_id", offerIds)`, folded per offer by the same reducer, so a state
derived one at a time and a state derived in a batch cannot ever disagree.

The probe read in `deriveStatesForOffers` also stops being necessary: the batch
read destructures its own `error`, so "unreadable" and "no events" separate at
the source rather than being separated by a preceding probe.

## W16-3 — the dashboard-data lane's delete precondition has been met

`hooks/use-dashboard-data.ts` (276 lines, 19 hooks) and
`app/api/dashboard/data/route.ts` (334 lines, 18 branches) were judged a
DUPLICATE in wave 13, with this lane losing. They were **not** deleted, for the
right reason, written into both files:

> *the method is MERGE FIRST, THEN DELETE, and the merge is not done. Three
> things the losing lane does that its survivors do not are listed under MERGE
> DEBT below. Each lives in a file outside this slice's write scope … Deleting
> now would throw away scoping that no survivor currently has — which is
> precisely the failure this rule exists to prevent.*

All three debts have since landed, and I checked each one in the tree today
rather than trusting the ledger:

| debt | survivor | state today |
|---|---|---|
| 1. `getAgents(brokerageId?)` — caller-supplied tenant, no role gate | `app/actions/agents.ts:getAgents` | **merged** — session-derived tenant + `BROKER_ADMIN_ROLES` gate + discriminated result |
| 2. `getAgentCommissions` / `getAgentExpenses` — caller-supplied agent id, no ownership check | `app/actions/agents.ts` | **merged** — `requireAgentLedgerAccess` + tenant filter |
| 3. `getTours(agentId)` — no brokerage filter | `app/actions/ai-showing-management.ts:getTours` | **merged** — `.eq("brokerage_id", ctx.brokerageId)` and a session gate |
| adjacent (a writer bug, not a merge) | `app/actions/ai-auto-response.ts` | **fixed** — stamps `brokerage_id`, reads the insert's `error` |

So the stated precondition is met and the delete is now the honest move — with
one condition that is the whole substance of the slice. **The MERGE DEBT list was
written by an agent enumerating what it happened to notice; it is not proof that
nothing else in the route is stronger than its survivor.** Before a line is
deleted, all eighteen branches get read against the function
`DASHBOARD_DATA_SURVIVOR` names, on the four properties this route actually
carries:

1. tenant filter (`.eq("brokerage_id", …)`, session-derived);
2. identity resolved with `resolveAgentIdInBrokerage` — the *brokerage-scoped*
   resolve, which exists because the unscoped one hands back a mismatched
   `(agentId, brokerageId)` pair for a user holding agents rows in two
   brokerages;
3. a refused read reported as a failure, never as `[]`;
4. an unprivileged caller REFUSED rather than handed an empty list (the `agents`
   branch's 403).

Anything the route has and its survivor lacks is a **merge, and it lands before
the delete**. Nothing gets ported the other way just because it is there: the
route is the loser, and its consumers number zero.

Deleting the lane also retires `scripts/dashboard-data-layer-simulator.ts`,
whose entire subject is these two files. A proof cannot outlive what it proves,
and a retired proof must leave through both doors it entered — the `guard` chain
in `package.json` **and** `MAINTENANCE_DOMAINS` in
`lib/kernel/manager-registry.ts` — or the chain breaks on a script that no longer
has a target.

## Closed on inspection — recorded, not dispatched

- **`transaction_milestone_templates` / `milestone_template_items` still have no
  reader.** Unchanged from wave 15 and still not a loop: wave 14 removed the only
  reader *correctly* (it could never produce a completable milestone). A
  brokerage-configurable template system needs a writer, an admin surface, and a
  seeder stamping canonical `milestone_type`. That is a feature and it needs an
  owner decision. Still recorded, still not invented.

## Carried into this wave as my own work, not an agent's

- **The legacy portal SQL is worse than "stale", and it is nine tables, not one.**

  Wave 15 recorded `scripts/330-*` and `scripts/360-*` as *misleading*, on the
  grounds that their `client_portal_messages` column list
  (`message_type/title/content/is_read`) contradicts the live table
  (`agent_id, body, brokerage_id, channel, contact_id, direction, metadata,
  read, read_at, transaction_id` — confirmed against
  `scripts/schema-snapshot.ts:187`). The column drift is real. It is also the
  least interesting thing in the file.

  `scripts/330-create-client-portal-collaborative-features.sql:217-226` declares
  **nine** policies under the comment *"Simplified RLS policies - service role
  has full access, authenticated users can read"*:

  ```sql
  CREATE POLICY "Service role full access <t>" ON <t> FOR ALL USING (true);
  ```

  on `collaborative_searches`, `collaborative_search_members`,
  `collaborative_search_properties`, `property_family_ratings`,
  `property_consensus`, `property_smart_insights`, `showing_requests`,
  `client_portal_activity`, and `client_portal_messages`.

  The policy NAME says service role. The policy does not: there is no `TO`
  clause, so it applies to **PUBLIC** — `anon` and `authenticated` — and `FOR
  ALL USING (true)` is read *and* write. And RLS policies are PERMISSIVE by
  default, which means **they OR together**. A single live `USING (true)` policy
  does not sit beside a correct policy; it makes the correct one decorative.

  That is what makes this urgent rather than tidy. Wave 15 read
  `047-client-portal-activity.sql` and concluded, from the file, that an
  unstamped `client_portal_activity` row is invisible to the agent it exists to
  inform. If 330's policy is ALSO live on that table, the true answer is the
  opposite and worse: every row is visible to every authenticated session in
  every brokerage. Both conclusions cannot hold, and the file cannot settle it.

  **Then I measured it, and the measurement changed the shape of the fix.** 330
  is not special: the same construct appears **173 times across 42 legacy
  `scripts/*.sql` files.** It was a house convention.

  The relief, and it is the important half: **`supabase/migrations/` contains
  ZERO of them.** The corpus that actually reaches this project is clean, and
  the legacy corpus has no runner in `package.json` and is invoked by nothing.
  So the likely state is that none of it is live.

  *(Correction to my own first count: a line-oriented `grep` said 158 across 31
  files. The statement-level scanner says 173 across 42 — SQL wraps freely and
  the grep missed every wrapped declaration. 173/42 is the number; the earlier
  one is not quoted anywhere that survived.)*

  "Likely" is not a security control, and the files cannot settle it: `CREATE
  TABLE IF NOT EXISTS` is a no-op against an existing table while the `CREATE
  POLICY` lines after it are **not** conditional, so a partial hand-run of any
  of those 42 files leaves exactly the state this is written for. The live check
  could not be made — the Supabase connection timed out on every query
  **including `select 1`**, and there is no `DATABASE_URL`/`POSTGRES_*` in this
  session's environment to fall back to.

  **It does not need to be, because the answer does not change the action, and
  the action is a no-op if the answer is "clean". So this asks the database at
  apply time instead of asking me:**

  - **`m392-drop-every-policy-that-grants-all-to-public.sql`** — selects on the
    CONSTRUCT (`polpermissive AND polcmd='*' AND qual='true' AND granted to
    PUBLIC/anon/authenticated`) across the whole `public` schema, not on a table
    list I enumerated and not on a policy name. Keying on the name would *be*
    the original mistake. It DROPS only where the table has another policy left
    to stand on, and REFUSES where the bad policy is the table's only one —
    dropping that denies every non-service caller, which is the opposite failure
    and just as real.
  - **`m393-assert-no-policy-grants-all-to-public.sql`** — the gate: fails and
    names every survivor. Separate from m392 **deliberately**: a `raise` rolls
    back its transaction, so raising inside m392 would undo the safe drops and
    one table needing a hand-written replacement would block every table that
    did not.
  - **`scripts/rls-public-grant-guard.ts`** (`test:rls-public-grant`) — the
    source side. Applied corpus: **zero baseline**, no acceptable first one.
    Legacy corpus: a **ratchet** that may fall and never rise, so a 174th cannot
    arrive by copying a neighbour — which is how the other 173 got there.
    Detection is statement-level, because a line scan misses whichever ones
    somebody happened to format across three lines. Five negative controls, each
    watched go red.

  **Still open, and deliberately left open:** whether any of the 173 is live.
  That is one query, and it should be run the moment the connection recovers.
  The migrations make the answer safe either way; they do not make it known.
- `docs/wave14-audit.md` still describes C1/C2/C4 as open.

## Outcome

**The container restarted mid-wave and killed all three agents** — the same
failure mode as wave 12. W16-1 and W16-2 had already passed their proofs; W16-3
had landed its survivor merges but never reached its deletion step. Everything
below was verified by hand afterwards rather than taken on report, and the
unfinished third slice was finished directly.

**W16-3 found three live cross-tenant reads the MERGE DEBT list never named** —
which is the whole argument for reading all eighteen branches instead of
trusting an enumeration somebody made in passing:

- `getListings()` applied **no tenant filter at all** and returned every listing
  on the platform; `getListings({agentId})` returned any agent's book.
- `getTransactions()` did the same for every deal.
- `app/offers/page.tsx` put every filter behind an `if`, so a session with
  `user_type: "agent"`, no resolvable agents row and no `brokerage_id` fell
  through all of them and issued a **bare select over every offer in the
  platform**, leaving RLS as the only thing between one brokerage and another's
  deal book.

Plus an adjacent writer bug: `createListing` never stamped `brokerage_id`, so
every row created through it carried a NULL tenant — the same class as the
`ai-auto-response` stamp.

All eighteen survivors were then read against the four properties. Five needed
nothing (`reviews`, `open_houses`, `notifications`, `documents`,
`communications` — the last one *stronger* than the branch it replaces). The
lane was deleted only after every owed merge had landed.

**The rewritten proof caught one more.** Rescoping L5 from files to survivor
FUNCTION BODIES surfaced `getShowings`, whose tenant check leaned on `!owner` to
cover a refused lookup. It failed CLOSED, which is the floor — but it answered
an **outage** with the word "Forbidden", which reads as a decision somebody made
and which a caller will never retry. Same conflation wave 15 removed from
`require-contact-access.ts`. Fixed rather than exempted.

**Two assertions in `test:offer-gate-enforcement` were asserting a superseded
shape** and had to be updated, not silenced: they pinned on the singular
`deriveOfferStateFromActivities` and on the readability PROBE that W16-2
correctly removed. Removing the probe was a **strengthening** — the probe proved
only that one read of the set succeeded, after which each of the N per-offer
reads could still be refused individually and be skipped as "no events". With
one batched read a refusal never reaches the level where skipping happens. The
assertions now key on `deriveOfferStates?FromActivities` and on the real
guarantee: the set-level refusal is RETURNED, before the loop that skips. Both
controls watched go red.

**Verification:** typecheck EXIT=0, zero errors. Guard chain 214/214 — 213 steps
plus `test:sweep` (457 simulators, 0 failed). *(The chain runner initially
reported 213/214 with no named failure: `while read` skips a final line with no
trailing newline, so `test:sweep` had silently not run. Worth recording, because
"213 passed and nothing failed" is exactly the shape of a green result that is
not one.)*

**Orphan-export re-baseline, taken deliberately:** 1423 → 1404. The removed set
is exactly the 20 exports of the deleted lane — the route's `GET` and the 19
hooks — and every one has a named survivor in
`lib/dashboard/data-survivors.ts:DASHBOARD_DATA_SURVIVOR`, enforced by
`test:dashboard-data-layer` rather than asserted in prose.

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason** — and it is never a safety argument either: an
  HTTP route is reachable by anyone with a URL bar.
- supabase-js RESOLVES a refused query — destructure `error`; a bare `try/catch`
  around a supabase call catches NOTHING. Gates fail CLOSED.
- Pre-rollout the tables are EMPTY: "nothing came back" is never health.
- `agents.id` / `users.id` / `contacts.id` are DISJOINT — resolve, never `??`.
- A gate must never be WIDER than the surface it protects, and never NARROWER
  than the surface that already admits the user.
- Assert CONSTRUCTS in proofs, never spellings; negative-control every assertion
  and CONFIRM the control applied before believing it.
