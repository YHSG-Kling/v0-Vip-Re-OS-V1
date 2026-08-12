# Wave 19 — the fail-closed branch I shipped yesterday cannot fire

## W19-1 — `resolveScopedConnection` reads a REFUSAL as an ABSENCE, and that is the whole credential cascade

This is the handoff the wave-18 agent wrote down rather than guessed at, and
checking it turned out worse than it recorded.

`lib/connections/resolve-scoped.ts:24 readOwnerCredential`:

```ts
const { data, error } = await svc.from("platform_credentials")…maybeSingle()
if (error || !data) return null          // ← :41  refused and absent are ONE answer
…
} catch {
  return null                            // ← :63  a THROW is swallowed too
}
```

And `resolveScopedConnection` itself has **no throw path at all** — the cascade
loop swallows per-tier, the legacy fallback ends `.catch(() => null)`, and the
function's own docstring says *"Never throws — returns null when nothing is
connected at any scope."*

### Consequence 1 — a gate I shipped yesterday is dead code

`lib/property/rentcast-eligibility.ts` returns `idx_check_unreadable` /
ineligible when the IDX lookup cannot be read, and I described that branch as the
thing standing between an unprovable answer and spending against the owner's
ruling. **It can never execute.** The resolver it calls cannot throw, so an
unreadable credential row arrives as `not_connected`, and RentCast is spent for a
tenant who may well own an IDX feed.

The module's own header flagged the risk honestly — *"`idx_check_unreadable`
therefore only fires when the resolver THROWS"* — and recorded fixing it as out
of scope. It was right to record it. What neither of us wrote down is that
"only fires when the resolver throws" plus "the resolver never throws" equals
**never fires**. A fail-closed branch that cannot run is a comment.

### Consequence 2 — the broader one: the cascade serves the WRONG TENANT'S credential

This is not confined to RentCast. The cascade is **agent → team → brokerage →
platform, most-specific owner wins**. If the agent-tier read is REFUSED rather
than empty, the loop does not stop — it falls through and returns the **team's,
the brokerage's, or the PLATFORM'S** credential instead.

That is not a failure. It is a *successful call made with somebody else's
account*, and every caller treats it as a normal hit. Twelve files rely on this
resolver:

| provider | what a wrong-tier credential means |
|---|---|
| `idxbroker` (`idxbroker-client`, `rentcast-eligibility`) | the tenant's board data silently replaced by the platform feed |
| `twilio`/SMS (`resolve-sms-provider`) | an agent's text sent from another number |
| `quickbooks` (`accounting-egress`) | a financial write landing in the wrong ledger |
| e-sign (`resolve-esign-provider`) | a signature request from the wrong account |
| transaction forms (`resolve-transaction-provider`) | forms filed under the wrong subscription |
| `ghl` (`crm/sync` ×2) | a sync-out to another brokerage's CRM |
| `showingtime` (×3), `transistor` (×2) | bookings and podcast episodes on the wrong account |

Pre-rollout the tables are EMPTY, so today every read returns "absent" honestly
and nothing misbehaves. That is exactly why this is worth fixing **now**: the
defect is invisible until there is data, and then it is invisible again because
it looks like success.

### The shape of the fix

`resolveScopedConnection` returns `ScopedConnection | null` and has twelve
callers. **Do not break them.** Add a discriminated sibling that separates
`connected` / `not_connected` / `unreadable`, keep the existing export as a thin
wrapper over it for callers that genuinely only need "is there one", and make
the cascade **stop on a refusal instead of descending** — falling through is how
one tier's outage becomes another tier's credential.

Then repoint the one caller whose correctness already depends on the
distinction: `rentcast-eligibility.ts`, whose `idx_check_unreadable` branch
becomes reachable for the first time.

## W19-2 — the budget gate's tier read drops its error, one line above a read that does not

`lib/vendor-governance/budget-gate.ts:50`:

```ts
const { data: brokerage } = await supabase.from("brokerages").select("plan_tier")…
const planTier = brokerage?.plan_tier ?? "solo_agent"
```

A refused read silently becomes **`solo_agent`** — the most restrictive tier —
so an enterprise brokerage can be told it is over a budget that is not its
budget. And the very next read in the same function does it correctly:
destructures `error`, and returns `degraded: true` so callers know the verdict
was fail-open rather than measured.

So the contract already exists in this file; one read simply does not honour it.
That makes this a **merge onto an established local pattern**, not a new policy —
which is the only reason it is in scope this wave rather than recorded again.

Note the asymmetry is deliberate on the other side and must be preserved: the
budget gate FAILS OPEN by design (*"a ledger read error must never take a
customer flow down"*). Wave 18 leaned on that contract when it built the RentCast
gate. This wave does not invert it — it makes the tier read report degradation
the same way the spend read already does.

## Recorded, NOT to be built — still genuinely blocked

- **Leads / raw-leads.** Owner-sequenced for after the loops and orphans.
- **`transcribeAudio`'s unvalidated `audioUrl`** (`ai-voice-transcription.ts:359`)
  — an authenticated caller still gets an arbitrary server-side fetch, and the
  Whisper call is uncapped. There is no SSRF/allowlist helper in this repo and
  every other `asset-download` call site passes a provider-returned URL. Wants a
  host allowlist or a signed-URL requirement — **an owner decision**, and it has
  been recorded as one since wave 2.
- **`calculateHomeValue` has no rate limit** (`calculators.ts:659`), same for
  `submitHomeValueRequest`. Public surfaces, real provider spend. Also recorded
  as needing an owner call rather than a guess.
- **The live RLS question.** Unanswerable: the owner hit the same
  `Connection terminated due to connection timeout`, and `get_project` reports
  ACTIVE_HEALTHY. Query and interpretation are in `docs/wave16-audit.md`.

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason.**
- supabase-js RESOLVES a refused query — destructure `error`; a bare `try/catch`
  around a supabase call catches NOTHING. Gates fail CLOSED.
- Pre-rollout the tables are EMPTY: "nothing came back" is never health — and a
  defect that only appears once there is data is not a defect that can wait.
- `agents.id` / `users.id` / `contacts.id` / `leads.id` are DISJOINT.
- Assert CONSTRUCTS in proofs, never spellings; negative-control every assertion
  and CONFIRM the control applied before believing it. **And check that the
  branch you are protecting can actually be reached** — that is this wave.
