# Wave 18 — leads are not buyers yet, and RentCast is not a fallback when the tenant owns a feed

## The rulings

> leads not for idx or rentcast, only contacts
>
> rentcast is platform owned and should not be used if the tenant adds their idx
> broker credentials

Both are refinements of wave 17, and the first one **corrects work wave 17
shipped hours ago**: W17-2 handed an IDX client to three functions whose
identity parameter resolves against `leads`. That is named first below rather
than buried.

## This does NOT reverse "enrichment must happen with raw leads" (wave 5)

Checked before anything else, because it looks like a conflict and is not.
`lib/enrichment/` contains no reference to IDX or RentCast — grep returns
nothing. Enrichment is the PeopleData/OSINT lane; property search is the
IDX/RentCast lane. Two disjoint provider sets, so "raw leads still get enriched"
and "leads never reach IDX or RentCast" both hold at once.

## W18-1 — four live paths carry a LEAD to an external property provider

| # | path | provider | why it is reachable |
|---|---|---|---|
| 1 | `app/leads/page.tsx:320` → `ai-predictions.ts:aiPropertyMatchGenius` (:1226) → IDX at :1385 | **IDX** | Reads `.from("leads")` FIRST (:1231), contacts only as fallback. The IDX call at :1385 sits **outside every branch** — nothing between the read and the call gates on which table answered. |
| 2 | any caller → `ai-predictions.ts:predictWinningOffer` (:1670) → IDX at :1683 | **IDX** | `data.leadId` appears **exactly once in the whole function — its own declaration.** It is never read against any table. The parameter is provably inert, so any id, of any class, reaches IDX. |
| 3 | any caller → `ai-predictions.ts:optimizeShowingRoute` (:2400) → IDX at :2428 | **IDX** | `data.leadId` is written straight through as `lead_id` into `smart_showing_recommendations` (:2484). Explicitly leads-classed by column, never checked. |
| 4 | `ai-predictions.ts:massGenerateCMAs` (:1533) → `generateAICMA({ contactId: lead.id })` (:1605) → `ai-cma.ts:193` | **RentCast** | Reads `.from("leads")` (:1565), then passes **`lead.id` into a parameter named `contactId`**. Reached for every leads row holding a `lead_property_ownership` record; the address handed to RentCast is lead-owned data. |

**In all three IDX cases the client is constructed BEFORE the leads-vs-contacts
determination** — :1228, :1676, :2422 — so the decision to spend is made with the
resource already in hand. That ordering is the shape of the defect, not an
incidental detail.

**One path is already correct and is the model to copy.**
`lead-intelligence.ts:enrichLeadData` (:727) resolves against **contacts only** —
`.from("contacts")…single()` at :734 with a throw at :736 — and builds the IDX
client at :1029, *after* the id is proven to be a contact. A `leads.id` cannot
survive line 734. This is the only entry point ordered correctly, and W18-1
should make the other four look like it.

### What is holding path 1 up today is an accident, not a guard

`aiPropertyMatchGenius` embeds `saved_properties` and
`lead_idx_property_interactions` off one `.from("leads")` query (:1236-1237).
Per `scripts/schema-snapshot.ts`, **those two tables sit on opposite id spaces**:

| table | key | keyed to |
|---|---|---|
| `saved_properties` (:575) | `contact_id`, **no `lead_id`** | contacts |
| `lead_idx_property_interactions` (:350) | `lead_id`, **no `contact_id`** | leads |
| `client_detailed_personas` (:181) | `contact_id` | contacts |

So the leads embed mixes a leads-FK table with two contacts-FK tables and will
likely raise PGRST200 — pushing execution into the contacts fallback, which then
finds nothing for a real lead id. **A PostgREST error is the only thing standing
between a lead and IDX.** `scripts/schema-drift-guard.ts` validates embed
*columns*, not embed *FK existence*, and the embed baseline is `[]`, so nothing
catches it either way.

Also found in that fallback: it fetches `contact`, null-checks it, and **never
assigns it to `lead`** (:1247-1257). Execution continues on `lead?.saved_properties`
regardless, so the fallback does not actually fall back.

### The id-class confusion runs BOTH directions

- **leads.id → contacts param:** `ai-predictions.ts:1605` passes a `leads.id` as
  `contactId`, which reaches RentCast *and* is written to
  `cma_reports.contact_id` — a NOT NULL column whose own comment (`ai-cma.ts:127`)
  says it "must be tied to a contact".
- **contacts.id → leads FK:** `lead-intelligence.ts:1041` writes
  `lead_id: leadId` into `lead_idx_property_interactions`, whose FK is
  `REFERENCES leads(id)` (`scripts/320-*.sql:187`) — while :734 has already
  *proven* that id is a **contacts.id**. Every IDX interaction row this writer
  produces puts a contacts.id in a leads foreign key.

That second one is on the path wave 17 touched, and it is the one defect in this
audit that a passing guard chain did not catch — worth saying plainly.

## W18-2 — the IDX-over-RentCast precedence exists once, and it is the wrong rule

`lib/property/listing-source.ts:16-24` is the **only executable precedence** in
the tree:

```ts
if (opts.hasIdx && opts.idxResultCount > 0) return "idx"
if (opts.hasRentcast) return "rentcast"
```

Read the condition: IDX must be connected **and have already returned rows**. So
IDX is called first, and RentCast is skipped only when IDX *produced results*.
The ruling is stronger and simpler — **if the tenant has IDX credentials,
RentCast is not used** — and it does not depend on what IDX returned.

Everywhere else there is no precedence at all:

- **`lib/cma/comp-provider.ts:244-266` — RentCast runs FIRST and
  UNCONDITIONALLY**, and the IDX client is not constructed until :335, ninety
  lines later. `idxConnected` is computed at :339, *after* RentCast has already
  spent (`costCents += RENTCAST_COMPS_COST_CENTS`, :254). **A tenant with IDX
  connected pays for RentCast on every single CMA.** This is the sharpest
  instance of the ruling being violated.
- `app/actions/ai-cma.ts:189-196` — `getRentcastComps` with no IDX check in the file.
- `lib/avm/provider-chain.ts:126-128` — gated on `usePaidProviders` +
  `checkVendorBudget`, i.e. **budget** gating, not IDX-connection gating. No
  `resolveScopedConnection("idxbroker")` anywhere in the file.
- `negotiation-copilot.ts`, `appraisal-negotiation.ts`, `listings-kernel.ts`,
  `schedule-showing.ts`, `mcp/route.ts` — all call RentCast with no IDX check.

The rule is otherwise **purely documentary**: `tenancy-matrix.ts:94`,
`manager-registry.ts:925`, `resolve-app-capability.ts:23` all describe it in
prose. The only `resolveScopedConnection("idxbroker", …)` in the codebase is
inside `forBrokerage` — it selects *which IDX credential*, never *whether to skip
RentCast*.

## W18-3 — the carried item the ruling converts into a decision already made

Wave 17 recorded, and deliberately refused to guess at:

> RentCast has no budget gate on three of its four lanes. Only
> `provider-chain.ts` consults `checkVendorBudget`… "Platform-gated" implies
> metered *and* capped, and today it is metered everywhere but capped in one
> place. Changing that alters runtime behaviour at six call sites and is a
> decision, not a cleanup.

The ruling supplies the decision. "Should RentCast run at all for this tenant,
right now?" has three answers and they belong at **one** gate, not scattered
across seven call sites:

1. is there a platform key at all,
2. does this tenant have an IDX Broker credential connected → **no**,
3. is the vendor budget exhausted → **no**.

Consolidating these closes the carried item as a *consequence* of the ruling
rather than as an invented decision — which is the only reason it is in scope.

## Recorded, NOT to be built in this wave

- **Leads / raw-leads themselves.** The owner's sequencing is explicit: *"we will
  go over leads/rawleads after we clear up the loops and orphans."* This wave
  only stops leads REACHING those two providers. It does not redesign the leads
  lane, the promotion gate, or the `leads`↔`contacts` relationship.
- **`lib/vendor-governance/budget-gate.ts:50`** drops the `error` on its
  `brokerages` read, so a refused read silently becomes the `solo_agent` tier. It
  fails CLOSED, so it is not urgent — but it is the same conflation class and is
  recorded rather than swept in.

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason.**
- supabase-js RESOLVES a refused query — destructure `error`; a bare `try/catch`
  around a supabase call catches NOTHING. Gates fail CLOSED.
- Pre-rollout the tables are EMPTY: "nothing came back" is never health.
- `agents.id` / `users.id` / `contacts.id` / **`leads.id`** are DISJOINT —
  RESOLVE, never `??`, and never pass one under a parameter named for another.
- Assert CONSTRUCTS in proofs, never spellings; negative-control every assertion
  and CONFIRM the control applied before believing it.

## Outcome

**Both agents were killed by a container restart** — the third of this session —
after their code landed but before either proof existed. Everything below was
verified by hand and the unfinished half was finished directly.

**W18-1 landed complete** (9 assertions, 18 controls watched go red). Beyond the
four paths, it found and fixed things the audit had not named: the contacts
fallback in `aiPropertyMatchGenius` **bound its row and never assigned it**, so
execution carried on reading the row that had just failed to load — the fallback
did not fall back; and the prompt printed `None specified` for a preference
record that cannot exist, which reads as a client who stated no requirements.

`predictWinningOffer`'s inert parameter was **removed rather than given a
ceremonial lookup** — the prediction is about the property, and its one caller
lost the argument with it. `optimizeShowingRoute` now files on `contact_id`, the
column its reader matches first, because the id it holds is now *proven*
contacts-class. `massGenerateCMAs` resolves each record's nullable promotion
pointer and **skips, counting and reporting**, every unconverted owner —
capability preserved for promoted records rather than withdrawn wholesale.

**W18-2's gate I verified, its proof I wrote.** The gate is sound on the point
that mattered most: a **platform-tier** IDX credential is explicitly *not* the
tenant's, so the ruling cannot become a total silent outage. It also refuses a
credential row with no `apiKey`, matching the client exactly.

## Five failures the guard chain caught after the agents were gone

Every one was a real consequence, not a flaky test:

1. **An inert control.** W18-1 left the Match Genius button *disabled with a
   tooltip*. Defensible intent — but a disabled button with no handler is INERT,
   and this repo holds a **zero-inert-controls** invariant. Removed; the banner
   above the table carries the explanation once instead of a dead icon per row.
2. **`test:living-video`** asserted `getApiKey(params.brokerageId)` inside the
   status reader. Wave 18 moved key resolution one level in, to `gateRentcast`.
   Assertion **updated, not deleted** — the property it protects is intact and
   now stronger.
3. **`test:persona-journey-wiring`**'s control patched `lead_id: data.leadId`,
   which no longer exists. The control followed the write to `contact_id`.
4. **A writer-less read.** Removing the wrong-class write left
   `lead_idx_property_interactions` with readers and no writer. I baselined it —
   and `test:doc-kernel` **rejected that**, because the writer-less burn-down is
   a deliberate **zero** ("the drift class that started this campaign is
   EXTINCT"). It was right and I was wrong: I reverted the baseline and removed
   the three dead readers instead. They were dead by construction — that table
   is keyed on `leads(id)`, has no contacts column, and property search is no
   longer a leads capability. Leaving them would have been worse than untidy:
   a prediction factor that **can never fire**, a **30-point** score component
   permanently zero, and `Property Views: 0` printed as a fact about a person.
   `calculateMotivationScore` lost its 20-point `propertyViews` term entirely;
   the remaining weights are deliberately **not** rescaled, because refilling the
   gap would invent motivation the evidence never showed.
5. **`test:lead-flow`** asserted *"IDX connected but empty → RentCast fallback"* —
   the old rule verbatim. Updated to the ruling: connection decides, so an empty
   IDX result is an honest empty **from the tenant's own board**.

Three of these five were assertions encoding a rule the owner has now changed.
That is the wave's own lesson: a proof that pins a *decision* rather than a
*property* has to be re-argued every time the decision moves — and re-arguing it
is the work, not a nuisance to route around.

**Verification:** typecheck EXIT=0, zero errors. Guard chain **218/218**
including `test:sweep` (457 simulators, 0 failed). Writer-less reads back to
**0 of 668** tables.
