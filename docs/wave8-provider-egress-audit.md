# Wave 8 — the provider / egress resolution cluster

Pre-dispatch audit. Every count below was taken from the tree, and every
"orphaned" claim was checked against the census rather than a loose grep.

## The thesis: orphaned SIBLINGS of live functions

These are not a random slice of the backlog. Each one sits in a module whose
*other* exports are load-bearing — the m356 shape this repo keeps rediscovering,
where the sites a detector named got wired and the siblings beside them did not.

| function | file | real consumers | siblings in the same file |
|---|---|---|---|
| `dispatchPhone` | `lib/providers/dispatch.ts` | **0** | `dispatchEmail` **54**, `dispatchSms` **26** |
| `resolveSMSProviderForBrokerage` | `lib/providers/messaging/resolve-sms-provider.ts` | **0** | `resolveSMSProviderForActor` — live, imported by the messaging barrel |
| `resolveContactFacing` | `lib/voice/voice-resolver.ts` | **0** (only a prose mention in `voice-avatar-settings.ts:107`) | `resolveSelfVoice` **5**, `resolveSelfAvatar` |
| `pickCredTier` | `lib/voice/twilio-tenancy.ts` | **0** | `resolveTenantTwilioCreds` **12**, `ensureTenantSubaccount`, `loadVoiceUsage` |
| `providerTenancy` | `lib/providers/tenancy-matrix.ts` | **0** | `PROVIDER_TENANCY` (the data) |
| `hasPersonalCalendar` | `lib/providers/calendar/personal-calendar.ts` | **0** | — |

Method note: a plain grep reports 1 consumer for `resolveContactFacing` and
`pickCredTier`. Both are false. The single `resolveContactFacing` hit is a
sentence inside a comment; `pickCredTier`'s is its own definition. The census
ignores prose-only references (that measurement fix is task #119) and is the
authority here — **do not re-derive orphanhood with a bare grep.**

## What each one probably is (to be PROVEN, not assumed)

**`dispatchPhone` — almost certainly an unwired capability, not a duplicate.**
Its two siblings in the same dispatcher carry the entire platform's egress (80
call sites between them). The owner's standing ruling is that voice is
Twilio + ElevenLabs, and a voice lane was built in earlier waves. So the
question is not "should this exist" but "what calls the other two that should
also be able to place a call". Find the surface. If the voice lane already has
its own dispatch path, then this IS a duplicate and the merge rule applies —
read both, establish the survivor, merge, then delete naming it.

**`resolveSMSProviderForBrokerage` vs `resolveSMSProviderForActor` — the
likeliest true duplicate pair in the wave.** Two resolvers, one file, one live.
Read both in full. The actor-scoped one is presumably narrower (an agent's own
number) and the brokerage one broader (the tenant default). If the live one
already falls back to the brokerage tier, the orphan is redundant and merges
into it. If it does NOT, the orphan is the missing tenant fallback and the
platform silently has no SMS for anyone without a personal number — which would
be a real defect, not a cleanup.

**`pickCredTier` — a pure helper its own module should be using.**
`resolveTenantTwilioCreds` (12 consumers) picks a credential tier; `pickCredTier`
is a pure function that does exactly that decision from three booleans. Check
whether the live resolver duplicates that logic inline. If it does, this is a
merge *inward*: the impure resolver should call the pure helper, which is also
the only way the tier decision becomes testable.

**`resolveContactFacing` — the contact-facing half of a voice pair.**
`resolveSelfVoice` has 5 consumers. Per the owner's Twin Studio ruling, the
distinction between the agent's own cloned voice and the voice a *contact* hears
is real product policy, not an implementation detail. Determine which surfaces
speak to contacts and whether they are silently using the self voice.

**`providerTenancy` / `hasPersonalCalendar`** — read them against the surfaces
that ask the same question a different way before deciding anything.

## Rules for this wave (unchanged, restated because they are what matters)

- DUPLICATE → read BOTH, establish the survivor, MERGE first, then delete,
  naming the survivor as `file.ts:functionName` in an in-code record. If the
  loser's extra behaviour is implemented badly, fix the class at the survivor —
  never port the defect.
- NOT a duplicate → it either BELONGS to a surface (wire it) or is an advanced
  feature worth finishing. **"No caller" is never a deletion rationale.**
- Pre-rollout: tables are EMPTY. "The query returned nothing" is never evidence
  of health.
- supabase-js RESOLVES a refused query — destructure `error`; gates fail CLOSED.
- `"use server"` files may export ONLY async functions.
- `agents.id` / `users.id` are disjoint id spaces — resolve, never `??`.
- Owner domain law: voice is Twilio + ElevenLabs (no VAPI); video is
  Remotion + D-ID + ElevenLabs (no HeyGen); video is a payload, not a channel.

---

## SETTLED DURING THE AUDIT (do not re-litigate, do verify)

**`resolveSMSProviderForBrokerage` is a pure delegation wrapper.** Its entire
body is `return resolveSMSProviderForActor({ brokerageId: brokerageId ?? null })`,
under a comment reading "Backwards-compat wrapper — callers that don't yet have
userId context." There are no such callers. Nothing to merge; survivor is
`resolveSMSProviderForActor` in the same file.

**`dispatchPhone` vs `placeOutboundAiCall` is the find of this wave, and it is a
COMPLIANCE GAP, not a cleanup.** Both place an outbound call. The live one is
`lib/voice/twilio-outbound.ts:placeOutboundAiCall`. Their gates are
COMPLEMENTARY, not overlapping:

| gate | `dispatchPhone` (orphan) | `placeOutboundAiCall` (live) |
|---|---|---|
| autonomy boundary (`autonomyGate`) | ✅ | ❌ |
| suppression: contact FLAGS *and* `contact_suppression_list` (`checkSuppression`) | ✅ | ❌ |
| TCPA / consent (`enforceTCPACompliance`) | via `evaluateOutboundCompliance` | ✅ |
| over-touch de-conflict (`deconflictGate`) | ✅ | ❌ |
| vendor budget ceiling | ❌ | ✅ |
| caller-ID honesty (real tenant number) | ❌ | ✅ |

`enforceTCPACompliance` reads `contacts.dnc_status` — the contact FLAG — and does
NOT read `contact_suppression_list`. `dispatchPhone`'s own comment already names
the failure mode: *"comprehensive suppression check … AND contact_suppression_list
… The contact-flag-only gate below misses list-only entries."*

**So a contact suppressed via the LIST rather than the flag can still be dialled
by the AI outbound lane today.** That is the defect to close. The survivor is
`placeOutboundAiCall`; the merge direction is the orphan's three missing gates
onto it. Prove each gap before fixing it, and do not weaken any gate the
survivor already has.

**`hasPersonalCalendar` is a wiring target, not a duplicate.** Its siblings
`createEventViaPersonal` / `getAvailabilityViaPersonal` are both live via
`lib/providers/calendar/index.ts:78,87`. It is the readiness predicate for the
same connection — the natural home is the provider-readiness surface built in an
earlier round (live vs dark).
