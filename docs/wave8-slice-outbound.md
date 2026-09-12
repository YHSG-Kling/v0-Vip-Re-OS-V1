# Wave 8 — the outbound slice (phone dial + SMS provider resolution)

Ledger for the two duplicates in `docs/wave8-provider-egress-audit.md` that belong
to the outbound-egress lane. Both are now merged and deleted; one of them was a
live compliance gap, not a cleanup.

Files touched: `lib/voice/twilio-outbound.ts`, `lib/voice/outbound-call-gates.ts`
(new), `lib/providers/dispatch.ts`, `lib/providers/messaging/resolve-sms-provider.ts`,
`scripts/outbound-call-gates-simulator.ts` (new), `scripts/voice-lane-simulator.ts`,
`scripts/egress-send-guard-simulator.ts`, `scripts/orphan-export-baseline.json`,
`package.json`.

---

## 1. The defect, proven before it was fixed

`lib/communication/tcpa-gate.ts:enforceTCPACompliance` was read end to end. It
selects exactly this from `contacts`:

    dnc_status, tcpa_consent, tcpa_consent_date, sms_opt_out,
    phone_status, phone_validated_at, email_opt_out

and then checks quiet hours from the area code. **`contact_suppression_list`
appears nowhere in the file** — not in a query, not in an import, not in a
comment. The only DNC signal it consults is the contact FLAG `contacts.dnc_status`.

`lib/kernel/compliance/check-suppression.ts:checkSuppression` reads BOTH: the
contact flags (`dnc_status` / `call_stop_flag` on the phone channel) *and*
`contact_suppression_list`, brokerage-scoped, keyed by `contact_id` OR `email` OR
`phone`.

The list is not decorative: `addSuppression` — the writer behind the unsubscribe
page and the SMS STOP handler — inserts into `contact_suppression_list` and sets
`call_stop_flag` for the phone channel, but an admin/import/CSV path that writes
only a list row leaves `dnc_status` false. `checkSuppression` catches that;
`enforceTCPACompliance` cannot see it.

Until this change, the only caller of `checkSuppression` on the phone channel was
`dispatchPhone`, which had **zero callers**. The live dial —
`lib/voice/twilio-outbound.ts:placeOutboundAiCall`, reached from
`lib/voice-engine/call-executor.ts`, `lib/application/ai-isa.ts`,
`app/actions/ai-isa/engage-contact.ts`, `app/actions/ai-isa/initiate-engagement.ts`,
`app/actions/voice-call-bridge.ts` and `app/api/voice/initiate-call/route.ts` —
ran the flag-only gate.

**Confirmed: a contact suppressed on the list rather than on the flag could be
dialled by the AI outbound lane.** The audit was right.

### Corrections to the audit

The audit's table is accurate. Three things it did not say, found while reading:

1. **`dispatchPhone`'s suppression call was itself gated behind
   `if (params.contactId || params.leadId)`.** A number-only dial skipped the
   suppression list entirely — even on the orphan. That hole was NOT ported: the
   survivor's suppression gate always runs, because `toNumber` is always present
   and is itself a `contact_suppression_list` key.
2. **`enforceTCPACompliance` does not destructure `error` on its `contacts`
   read** (`const { data: contact } = await svc...`). A refused read yields
   `contact === null`, every flag check is skipped, and the gate falls through to
   quiet hours — i.e. the flag half of the TCPA gate fails OPEN. This is in
   `lib/communication/tcpa-gate.ts`, outside this slice's file scope, so it was
   not edited. It is materially de-fanged in practice now: the suppression gate
   runs FIRST, reads the same `contacts` row, destructures `error`, and refuses
   the dial when it cannot read it. The tcpa-gate read should still be fixed at
   source — flagged as the one follow-up defect out of scope here.
3. **There is a third dial path.** `lib/providers/messaging:placeCall` is still
   live via `app/actions/voice-call-bridge.ts:87` (the whisper/warm bridge). It
   dials the **agent's own line**, not a consumer, on an already-gated call, and
   is allowlisted as such in `scripts/egress-send-guard-simulator.ts`. It is
   deliberately not routed through the contact-suppression stack — suppressing an
   agent's own phone against their own contact list would be wrong.

---

## 2. The merge — gate by gate

SURVIVOR: `lib/voice/twilio-outbound.ts:placeOutboundAiCall`.

All five pre-dial gates now live in one ordered, exported list,
`lib/voice/outbound-call-gates.ts:OUTBOUND_CALL_GATES`, run by
`runOutboundCallGates` as step 1 of `placeOutboundAiCall`.

| # | gate | origin | landed as | refusal shape |
|---|---|---|---|---|
| 1 | `autonomy` | **merged** from `dispatch.ts:autonomyGate` | `runAutonomyGate` | `{ ok:false, error:"Outbound held: <reason>", blocked:true, blockReason:"autonomy_held" }` |
| 2 | `suppression` | **merged** from `dispatch.ts` → `checkSuppression` | `runSuppressionGate` | `{ ok:false, error:"Outbound blocked: <reason>", blocked:true, blockReason:"suppressed" }` |
| 3 | `tcpa` | survivor's own, unchanged | `runTcpaGate` | `{ ok:false, error:gate.message, blocked:true, blockReason:gate.blockReason }` |
| 4 | `deconflict` | **merged** from `dispatch.ts:deconflictGate` | `runDeconflictGate` | `{ ok:false, error:"Outbound deferred: <reason>", blocked:true, blockReason:DECONFLICT_GATE_KEY }` |
| 5 | `vendor_budget` | survivor's own, unchanged | `runVendorBudgetGate` | `{ ok:false, error:"Vendor budget exceeded — outbound voice paused", blocked:true, blockReason:"vendor_budget_exceeded" }` |

Semantics carried, not syntax: the survivor returns `PlaceOutboundResult`, not
`DispatchResult`, so every merged gate builds a refusal in the survivor's shape
with a real reason string sourced from the check that refused. No `providerKey`
field was smuggled across; `blockReason` carries the machine-readable code, which
is what `app/api/voice/initiate-call/route.ts` already turns into a 403 vs 503.

**Order.** Cheap deterministic refusals first, money last, dial after everything.
This is `dispatch.ts`'s own order with the survivor's TCPA gate in the
consent slot. The one gate about spend runs last so a compliance refusal never
spends and the budget never masks a compliance refusal — asserted from each
gate's own `consumerProtection: boolean`, not from a hard-coded index.

**Nothing was weakened.** The TCPA gate and the vendor-budget gate are byte-for-byte
the same checks with the same fail-closed / fail-open contracts; they are merely
preceded by two cheaper refusals. `estimatePlatformVendorCost("twilio_voice", 3)`
kept its 3-minute estimate.

**Not merged, deliberately:** `evaluateOutboundCompliance` (the orphan's consent
check). The survivor already runs `enforceTCPACompliance`, which is stricter on
this channel (DNC + EWC + quiet hours + RND staleness + phone status) and writes
the `outbound_message_compliance_log` row that exists for plaintiff discovery.
Adding a second consent evaluator would have created the two-stacks problem this
slice exists to end. Likewise `dispatch.ts:vendorBudgetPreflight` was not carried:
the survivor has its own budget gate.

### Behaviour changes to expect at rollout

- **Over-touch is now enforced on AI voice.** Default policy is 1 call / 7 days
  per contact (`lib/kernel/deconflict`), counted from `isa_outreach_log`
  (`'voice'`), `marketing_campaign_touchpoints` (`'phone'`) and
  `lifetime_customer_touchpoints` (`'call'`). A second AI ISA call to the same
  contact inside the window now returns `blocked` with an "Outbound deferred"
  reason. Callers that escalate on `!ok` (engage-contact → voice drop → email)
  will take their fallback branch; each fallback runs its own gate for its own
  channel.
- **A dial with an unreadable suppression list now refuses.** `checkSuppression`
  fails closed on a refused read (including the `brokerage_id = ""` → 22P02 case
  its own comment documents). Pre-rollout, with empty tables, this is silent; it
  is not evidence of health either way.
- **Every dial now writes a `deconflict_suppression_log` row**, allowed or not —
  the broker cockpit reads it.

### The autonomy gate is present but UNARMED — the one open thread

`autonomyGate`'s design guarantee is that only a governed manager acting
*unattended* is gated: no `managerKey` and no mapped `systemSource` ⇒ no-op.
`PlaceOutboundParams` now accepts `managerKey`, `systemSource`, `humanApproved`
and `leadId`, and the gate honours them — but **no call site passes them yet**,
because every caller is outside this slice's file scope.

Defaulting was rejected on purpose: `app/api/voice/initiate-call/route.ts` and
`app/actions/voice-call-bridge.ts` are HUMAN-initiated dials, and holding an
agent's own click behind an autonomy posture would be a regression, not a gate.

To arm it, the autonomous senders should pass `systemSource: "ai_isa"` (which
`SYSTEM_SOURCE_TO_MANAGER` maps to the `ai_isa` manager), and the lead-origin
route should pass `leadId`:

| call site | pass |
|---|---|
| `lib/voice-engine/call-executor.ts:87` | `systemSource: "sequence"` (campaign_orchestrator) |
| `lib/application/ai-isa.ts:166` | `systemSource: "ai_isa"` |
| `app/actions/ai-isa/engage-contact.ts:645` | `systemSource: "ai_isa"` (or `"ghost_recovery"`) |
| `app/actions/ai-isa/initiate-engagement.ts:497` | `systemSource: "ai_isa"`, `leadId` |
| `app/api/voice/initiate-call/route.ts:177` | `leadId: resolvedLeadId` only — human-initiated, must stay ungated |
| `app/actions/voice-call-bridge.ts:280` | nothing — human-initiated |

---

## 3. Inline vs extracted — decided, with the evidence

**Extracted**, into `lib/voice/outbound-call-gates.ts`.

The `lib/buyer-offer/expire-offers.ts` precedent was extraction because two
callers (a session path and a cron path) had to share one implementation. That
argument does *not* apply here: after the delete there is exactly one caller, and
the only other dial path (`messaging:placeCall`, the agent-leg whisper bridge)
must NOT run contact suppression. So the deciding evidence was different:

1. **"ONE gate stack, not two" becomes a value, not a reading.** The stack is an
   exported ordered array. Had the gates stayed inline, "one stack" would be a
   property of how a function body happens to be written; now it is a list you
   can print. A sixth gate must join the list to run at all.
2. **The property becomes provable at runtime instead of by grep.** This wave
   already lost two proofs to assertions that counted literal occurrences and
   broke when a correct consolidation moved the code — including one in this very
   slice: `scripts/voice-lane-simulator.ts:319` asserted
   `indexOf("enforceTCPACompliance") < indexOf("callConnector")` **inside
   `twilio-outbound.ts`**, which this consolidation would have broken. It was
   rewritten to assert the construct (the stack runs before the dial; the stack
   contains the tcpa and vendor_budget gates, read from
   `OUTBOUND_CALL_GATE_ORDER`). The new proof *executes* the runner with injected
   gates to prove short-circuiting, which is impossible against an inline body.
3. **"No gate after the dial" becomes structural.** The gates module contains no
   connector call and no Twilio URL — asserted — so a gate physically cannot be
   placed after the dial; the dial is in the caller, after the runner returns.

Cost of the choice: one extra file and one extra dynamic import on the dial path.

---

## 4. Deletions, with survivors named

| deleted | file | survivor | merged first? |
|---|---|---|---|
| `dispatchPhone` (+ `DispatchPhoneParams`) | `lib/providers/dispatch.ts` | `lib/voice/twilio-outbound.ts:placeOutboundAiCall` | yes — autonomy, suppression, de-conflict |
| `resolveSMSProviderForBrokerage` | `lib/providers/messaging/resolve-sms-provider.ts` | `resolveSMSProviderForActor` (same file) | nothing to merge (verified) |

Both leave an in-code record naming the survivor as `file.ts:functionName` and,
for the phone case, listing exactly which gates crossed over and which did not.

`resolveSMSProviderForBrokerage` was re-read in full before deleting: its whole
body was `return resolveSMSProviderForActor({ brokerageId: brokerageId ?? null })`.
No branch, no fallback, no error handling of its own; `ResolveSMSContext`'s fields
are all optional, so the survivor takes the identical call directly. The
brokerage tier, the platform-managed tenant-number tier and the env fallback all
live in the survivor and are reached identically either way. The messaging barrel
(`lib/providers/messaging/index.ts`) only ever imported the actor form, so no
barrel edit was needed.

Two follow-on facts checked so the delete did not create a new orphan:
`lib/providers/messaging:placeCall` keeps its live caller
(`app/actions/voice-call-bridge.ts`), and `dispatch.ts`'s
`vendorBudgetPreflight` / `autonomyGate` / `deconflictGate` all remain in use by
email, SMS, direct mail and video.

---

## 5. Proof

New: `scripts/outbound-call-gates-simulator.ts` — `npm run test:outbound-call-gates`,
registered in the `guard` chain in `package.json` (between
`test:enrichment-suppression` and `test:sweep`).

It asserts **constructs, never spellings**:

- the stack is a non-empty list with no duplicate keys, and carries all five gates;
- every `consumerProtection` gate precedes every spend gate (read off the gates,
  so a new gate cannot silently land on the wrong side of the money);
- the runner short-circuits — *executed* with injected synthetic gates: all-pass
  ⇒ `null` and every gate ran in order; a refusal ⇒ returned as-is and no later
  gate ran; the first refusal wins;
- the gates module holds no connector call / Twilio endpoint at all;
- `placeOutboundAiCall` runs the stack before `callConnector`, and keeps no
  second private copy of a gate beside it (comments stripped first — prose naming
  a gate is not a gate);
- the regression pin for the actual defect: `tcpa-gate.ts` reads `dnc_status` and
  still does **not** read `contact_suppression_list`; `check-suppression.ts` reads
  both and fails closed on either read; the stack contains the suppression gate;
- both deletions are gone and both in-code records name their survivor.

Also updated: `scripts/voice-lane-simulator.ts` (spelling-based ordering
assertion → construct-based, see §3) and the
`scripts/egress-send-guard-simulator.ts` allowlist rationale for
`lib/voice/twilio-outbound.ts`, which now describes the real stack.

`scripts/orphan-export-baseline.json` was re-baselined deliberately after naming
both survivors, as `orphan-export-guard.ts` requires for a capability removal.
Note: the re-baseline snapshots the whole tree, so it also absorbed a concurrent
sibling change in this wave (`lib/voice/voice-resolver.ts:resolveContactFacing`)
that was made in another session while this one ran.
