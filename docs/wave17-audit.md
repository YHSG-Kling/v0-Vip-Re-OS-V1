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
