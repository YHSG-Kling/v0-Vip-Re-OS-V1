# Wave 17 — an owner ruling that the code contradicts in one direction and ignores in the other

## The ruling

> rentcast is a platform gated credential and tenants can setup and use their
> idxbroker account if they set it up

Two providers, two different tenancy models, and they are not symmetric:

- **RentCast — PLATFORM-GATED.** One platform credential, metered and budget-gated.
  A tenant does not bring their own and is never offered the option.
- **IDX Broker — TENANT-SETTABLE.** A tenant who sets up their own IDX Broker
  account uses **theirs**. Their board data is the point of connecting it.

## This is already settled law in exactly one place

`lib/connections/scope.ts:50-51` states it almost verbatim, and predates the ruling:

```ts
// IDX Broker is per-tier connectable (agent/team/brokerage/platform). RentCast is platform-only
// (env/platform config) and is intentionally NOT a user connection.
listing:     ["idxbroker"],
```

So this wave is not a new feature. It is **the rest of the tree catching up with a
rule one module already encodes** — which is why both defects below are drifts
rather than gaps, and why the arbiter is a file already in the repo rather than
my reading of the ruling.

## W17-1 — RentCast resolves a PER-TENANT key first, on a platform-only credential

`lib/property/rentcast.ts:114`:

```ts
async function getApiKey(brokerageId: string): Promise<string | null> {
  ... .from("integration_credentials").eq("brokerage_id", brokerageId) ...
  // Platform-level fallback (single shared key across all brokerages)
  return process.env.RENTCAST_API_KEY ?? null
}
```

The tenant row wins and the platform key is the *fallback* — the exact inverse of
"platform gated credential", and a direct contradiction of `scope.ts`'s
"intentionally NOT a user connection."

It is not confined to one file. Three more places encode the same wrong model:

| file | what it says |
|---|---|
| `lib/providers/tenancy-matrix.ts:86` | `models: ["platform_metered", "tenant_optional_key"]` — **`tenant_optional_key` is the wrong half** |
| `lib/avm/provider-chain.ts:11,47` | "RentCast (per-brokerage key or RENTCAST_API_KEY)"; `brokerageId` documented as "whose RentCast credential … is used" |
| `lib/kernel/anniversary-equity.ts:25,298` | "key resolved from integration_credentials or RENTCAST_API_KEY env" |

**Why this matters beyond tidiness.** A metered platform credential is how the
spend is governed — `usePaidProviders` plus the vendor budget gate. A tenant key
resolved ahead of it is spend the platform cannot see, meter, or cap, on a
provider the product treats as platform-owned. And because the tenant row wins,
a stray row silently reroutes that tenant's entire AVM/comps lane onto a
credential nobody is watching.

**This is a MERGE, not a deletion.** `getApiKey` is not a duplicate — it is one
resolver with one branch too many. The branch to remove is the tenant lookup;
everything else about that function (the destructured `credError`, the null
return that lets the provider chain fall through to the next provider) is
correct and stays. `integration_credentials` itself is shared with other
providers and is NOT to be touched.

## W17-2 — nine IDX Broker call sites bypass the tenant credential entirely

`lib/idxbroker-client.ts` has the correct resolver already:

```ts
static async forBrokerage(brokerageId, actor?) {
  const conn = await resolveScopedConnection("idxbroker", { agentUserId, teamId, brokerageId })
  const apiKey = conn?.apiKey || process.env.IDXBROKER_API_KEY || ""
  return new IDXBrokerClient(apiKey)
}
```

Agent → team → brokerage → platform, then the platform env. Exactly the ruling.

**Nine call sites never use it.** Every one constructs `new IDXBrokerClient()`
with no argument, and the constructor falls straight through to
`process.env.IDXBROKER_API_KEY`:

| file | sites |
|---|---|
| `app/actions/ai-predictions.ts` | 1166, 1615, 1844, 1974, 2354, 2628 |
| `app/actions/calculators.ts` | 243, 690 |
| `app/actions/lead-intelligence.ts` | 986 |

So **a brokerage that connects its own IDX Broker account gets the platform's
feed anyway** on all nine paths. They connected it to get their board's data;
they get someone else's. The capability is built, correct, and unreached — the
`forBrokerage` factory is doing nothing on these paths.

Every one of the nine sits in a function that already has a tenant in hand (a
`leadId`, a `contactId`, or a resolved session) — `calculators.ts:690` is
`calculateHomeValue`, which already RESOLVES the brokerage from the session or
the agent's `public_slug`. So this is repointing, not new plumbing.

## W17-3 — `idxbroker` has no entry in the provider tenancy matrix at all

`PROVIDER_TENANCY` in `lib/providers/tenancy-matrix.ts` is the file whose own
header says vendor ownership is "decided ONCE so it's never re-litigated per
feature." IDX Broker — the one provider in this pair that a tenant genuinely
owns — is absent from it, while RentCast's entry describes IDX's role only in
passing, inside RentCast's `why` string.

That absence is why W17-1 and W17-2 were able to drift in opposite directions
without anything catching it.

## Still open from wave 16, and now confirmed NOT session-specific

The live RLS check (whether any policy grants ALL to PUBLIC) is still
unanswered. **The owner ran it and hit the identical error** —
`Failed to run sql query: Connection terminated due to connection timeout` — so
this is not this session's connectivity. The question, the exact query, and what
each outcome means are already written into `docs/wave16-audit.md`; nothing is
re-litigated here. m392/m393 remain safe either way.

## Outcome

Both slices landed. Both agents survived this time (the previous two waves lost
theirs to container restarts), and both reports were checked against the tree
rather than taken on trust.

**W17-1 — nothing was owed as a merge, and that is a finding.** The tenant branch
produced *a bare API-key string and nothing else*: the header is fixed in
`rentcastGet`, the base URL is a module constant, metering is `meterCall({ brokerageId })`
at each call site and was already per-tenant and already independent of which key
resolved, and there is no rate limit anywhere on the path. No different header,
no different base URL, no per-tenant metering, no quota — a pure branch removal.
Stating that explicitly is the point; "nothing to port" verified is not the same
as "nothing to port" assumed.

The `null`-not-throw contract survives, so the AVM cascade still falls through to
BatchData. The destructured `credError` disappeared *with its query* — there is
no supabase call left in the resolver, so there is no error left to drop.

`getApiKey(brokerageId)` **kept its parameter deliberately.** It is no longer a
credential selector; it is the tenant attribution every call is metered against,
which is what makes RentCast platform-**gated** rather than merely
platform-owned. A missing platform key now names the darkened lane once per
tenant instead of returning null in silence.

**W17-2 — nine sites repointed, and the constructor's env fallback removed.**
That fallback is what made all nine defects silent; the key parameter is now
required, so the omission is a **compile error** rather than a quiet cross-tenant
read, and `IDXBROKER_API_KEY` is named exactly once in the module — inside
`forBrokerage`, after the owner cascade. Every site fails CLOSED: an unresolvable
tenant refuses rather than falling through to the platform key,
`compareNeighborhoods` reports `active_listings` as *unavailable* rather than a
measured zero, and `enrichLeadData` records `idx_broker` as a consulted source
only when the sync actually ran.

Id classes held throughout: `forBrokerage`'s `actor.agentUserId` is a **users.id**,
so `contacts.agent_id` (an **agents.id**) was never substituted for it — the
record-driven path resolves at brokerage tier instead of crossing id spaces.

## Found while verifying, and fixed here rather than reported

- **`lib/property/external-listings-search.ts` was live logic, not a comment.**
  It read a per-brokerage `integration_credentials` row and OR'd it with the
  platform key, so this lane could report RentCast AVAILABLE on a credential the
  platform cannot meter or cap — and the read dropped its `error`, so a refusal
  read as "no tenant credential" rather than "we could not tell". The query also
  listed `spark`, `rets` and `bridge` and then never inspected any of them:
  `creds` was consulted for exactly one thing, the rentcast row. With that gone
  the whole read was dead and is removed rather than left as an unread round trip.
- `lib/agentic-os/resolve-app-capability.ts` and `app-capability-registry.ts`
  described the old resolution in prose. The `requires: { platform: ["rentcast"] }`
  declaration was already right; only the comments were false.
- `scripts/living-video-simulator.ts:378`'s label read "resolving through the
  tenant key, else the PLATFORM key". The assertion still passes and still
  should — what changed is what `brokerageId` MEANS. Relabelled rather than
  deleted: it is now the proof that a RentCast lane cannot resolve a key with no
  tenant to meter it against.
- `manager-registry.ts`'s wave-16 entry said `analyzeAddressForBuyer` "spends the
  contact's brokerage's RentCast budget". Under the ruling it spends PLATFORM
  quota metered against that brokerage — an ungated caller does not spend the
  tenant's money, it spends the platform's and bills the wrong tenant, which is
  the same defect wearing a different hat.

## The team rung, closed across the tree

W17-2 reported that `getAgentContext` **selected `users.team_id` and discarded
it**, so every caller needing the TEAM rung of the cascade either re-read `users`
or skipped the rung — meaning a team that connected its own IDX Broker account
lost to the brokerage's feed. It fixed that inside its own scope with a targeted
read and handed the general case over.

`AgentContext` now exposes `teamId` once, and the three sites that were skipping
it pass it: `calculators.ts` ×2 and `listings-kernel.ts` (whose own local
`resolveCallerContext` was already reading `users` and now selects `team_id`
there rather than adding a second read). `comp-provider.ts` already passed it.
Impersonated contexts get `null` deliberately — the grant carries no team, and
the *staff actor's* team is not the impersonated tenant's; borrowing it would
resolve a credential from the wrong org.

## Verification

Typecheck EXIT=0, zero errors. Guard chain **216/216**, including `test:sweep`.
Two new proofs, both with every negative control watched go red:
`test:provider-tenancy-model` (13 controls) and `test:idx-tenant-credential`
(16 controls). Both watch `lib/connections/scope.ts` as the ARBITER, so if that
decision is ever edited the proofs fail loudly instead of quietly re-deriving a
new answer.

## Carried, not silently dropped

- **RentCast has no budget gate on three of its four lanes.** Only
  `provider-chain.ts` consults `checkVendorBudget`; `searchRentcastSaleListings`,
  `getRentcastMarketStats` and `getRentcastComps` do not. "Platform-gated" implies
  metered *and* capped, and today it is metered everywhere but capped in one
  place. Changing that alters runtime behaviour at six call sites and is a
  decision, not a cleanup.
- `calculateHomeValue` still has no rate limit (pre-existing, unrelated to
  credential ownership, already flagged in that file as awaiting an owner call).

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason.** W17-2 is the wire-it case: the capability exists
  and is correct, and nothing reaches it.
- supabase-js RESOLVES a refused query — destructure `error`; a bare `try/catch`
  around a supabase call catches NOTHING. Gates fail CLOSED.
- Pre-rollout the tables are EMPTY: "nothing came back" is never health.
- `agents.id` / `users.id` / `contacts.id` are DISJOINT — resolve, never `??`.
- Assert CONSTRUCTS in proofs, never spellings; negative-control every assertion
  and CONFIRM the control applied before believing it.
