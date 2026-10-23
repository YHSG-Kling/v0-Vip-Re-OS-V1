# Wave 8 — slice: the four orphaned resolvers

Branch: `claude/settings-consolidation-ui-0cd7lo`
Source brief: `docs/wave8-provider-egress-audit.md` (re-read; corrections below)

Four orphaned siblings of live functions. Per item: what it actually is, the
evidence for that call, what got merged or wired, and what was deliberately left
alone.

---

## Corrections to the audit (asked for, so: stated plainly)

1. **`pickCredTier` is not "ZERO hits tree-wide".** It is named in prose at
   `lib/kernel/manager-registry.ts:457`, in the `phone_system_tenancy` burn
   domain: *"Credential resolution order (pure pickCredTier +
   resolveTenantTwilioCreds)"*. That registry entry described a collaboration
   that did not exist in the code — the resolver restated the ladder inline and
   never called the pure helper. The audit's conclusion (merge inward) was right;
   its count was one prose hit short, and the prose was a **claim the code did
   not honour**. It does now.

2. **`resolveContactFacing` is a duplicate, and the surviving implementation is
   not in the voice module at all.** The audit framed it as "the contact-facing
   half of a voice pair" whose question is "which surfaces speak to contacts".
   That framing found the defect (below), but the platform already had a live,
   richer answer — `lib/video/video-identity.ts:resolveVideoIdentity` with
   `purpose: "contact_facing"` — which the audit does not mention.

3. **`hasPersonalCalendar`'s natural home is not the provider-readiness surface.**
   The brief nominated it. `getBrokerageProviderReadiness` is BROKERAGE-scoped and
   derives from the canonical registry; the personal calendar is a per-USER OAuth
   connection. The existing surface that asks this exact question of this exact
   user is `app/dashboard/settings/calendar/page.tsx`, and that page had a real
   hole in it. Wired there instead. (No new page was invented either way.)

---

## 1. `lib/voice/voice-resolver.ts:resolveContactFacing` — DUPLICATE → deleted

### Survivor

**`lib/video/video-identity.ts:resolveVideoIdentity`** called with
`purpose: "contact_facing"`.

### Evidence it is the duplicate, and the survivor is more complete

| | orphan (`resolveContactFacing`) | survivor (`resolveVideoIdentity`, contact_facing) |
|---|---|---|
| consumers | 0 | 2 contact-facing (`lib/video/listing-pitch-reel.ts:104`, `lib/kernel/deal-room-reel.ts:136`) + 2 internal-report |
| voice source | `agents.voice_id` | `agent_voice_profiles.elevenlabs_voice_id`, honouring the profile the agent SELECTED in `voice_assistant_config` before their default |
| face source | `agents.avatar_id` | `agent_voice_profiles.did_photo_url` |
| no twin on file | substitutes `FALLBACK_VOICE_ID` | returns `voiceId: null` / `avatarPhotoUrl: null` so the caller refuses |
| proof lock | none | `scripts/no-brokerage-face-guard.ts`, `lib/kernel/manager-registry.ts:536` (`video_voice_identity`) |

The decisive fact: **`agents.avatar_id` has ZERO writers anywhere in the tree.**
`grep -rn avatar_id` across `app/ lib/` (excluding `assistant_avatar_id`,
`did_avatar_id`, `provider_avatar_id`, `did_expressive_avatar_id`) finds only
readers — `resolveSelfAvatar`, the deleted `resolveContactFacing`,
`voice-avatar-settings.ts:43` (display), `asset-manager.ts:258` (an
"agentsMissingAvatar" health count), `critical-setup.ts:504` (a readiness check).
So the orphan's avatar half could only ever return
`{ avatarId: null, source: "none" }` — it was not merely uncalled, it was
structurally incapable of resolving a face. Wiring it into a D-ID caller would
have taken a rendering path to a permanently-refusing one.

Its voice half is not independent either: `lib/voice/sync-voice-id.ts` documents
`agents.voice_id` as a **promoted copy** of
`agent_voice_profiles.elevenlabs_voice_id` — the same clone, one hop downstream
of the column the survivor reads.

### The defect this uncovered — and the wire that closes it

`lib/workflow/adapters/video.ts` (the campaign-sequence video channel) resolved
its presenter through **`resolveSelfVoice` + `resolveSelfAvatar`**, and every
video it makes is delivered to a CONTACT (`dispatchVideo({ contactId,
recipientEmail })` at the bottom of the same function). The self resolvers honour
self-view preferences, so:

- an agent whose `agents.voice_preference` is `'generic'` had **every campaign
  video sent to their clients narrated by an ElevenLabs stock voice, under their
  own name** — because that is the voice they chose for their morning brief; and
- an agent with `agents.assistant_avatar_id` set had their **self-view twin, not
  their clone**, fronting the video the client watched.

That is the exact "silently using the self voice" defect the brief predicted, and
it was in the fifth consumer of `resolveSelfVoice` (the other four —
`standup-audio`, `brief-audio`, `agent-assistant/session`, `internal/voice-tts` —
are genuinely self-listening and were left alone).

**Wired:** the adapter now calls `resolveVideoIdentity(ctx.supabase, {
brokerageId, agentUserId, purpose: "contact_facing" })`, the same resolver the
listing-pitch reel and the Deal Room reel already use. One notion of the
presenter, not two.

Two consequential behaviour changes, both deliberate:

- The adapter now passes `avatarImageUrl` (a `did_photo_url`) instead of
  `actorId`. `lib/did/index.ts:resolveAvatarSource` accepts either and refuses
  when neither is present. *(Note: `avatarImageUrl` was declared in this function
  before and never assigned — it was dead.)*
- An agent with **no twin** now gets an explicit skip naming Twin Studio, instead
  of falling through to a D-ID submit. Previously such an agent could still
  render if they had an `assistant_avatar_id`; that is the self-view face, and
  the no-brokerage-face rule says a contact-facing render must refuse rather than
  substitute.

### Deletion record

In-code, at the top of `lib/voice/voice-resolver.ts`: the module is re-declared
**SELF ONLY**, the survivor is named as
`lib/video/video-identity.ts:resolveVideoIdentity`, and the reason the
`FALLBACK_VOICE_ID` substitution was **not** ported is stated. The dead
`export type VoiceContext = "self" | "contact_facing"` went with it (no consumer
anywhere). The prose reference at `app/actions/voice-avatar-settings.ts:107` was
rewritten to name the survivor, so no dangling symbol survives in a comment.

### Surfaces checked and deliberately left alone

- **`app/api/voice/twilio/inbound|turn`, `app/api/voice/relay/plan`** — the voice
  call lane speaks through Twilio's own TTS (`<Say>` / ConversationRelay
  `voice="en-US-Journey-O"`), not ElevenLabs. There is no ElevenLabs voice id to
  resolve on that lane at all. Putting one there means streaming ElevenLabs
  through ConversationRelay — a real feature, and not a resolver swap.
- **`app/api/portal/ai-chat/route.ts`** — the assistant a contact talks to. Text
  only: no voice, no avatar. It does resolve the agent's name + photo inline
  (lines 171-182) in a shape close to the orphan's `agentName`, but it needs
  `agents.photo_url`/`profile_image_url`, which neither resolver returns. Left
  alone rather than half-fitted.
- **`lib/agents/seller-update-reel-producer.ts:sellerUpdateFacts`** uses
  `resolveSelfAvatar` to record which face fronts a seller's living video. That
  is a *fact recorded for drift detection*, and the render itself resolves its
  presenter elsewhere (`recordRenderQueued` → the D-ID rail). Changing the
  recorded fact without first establishing what the render actually uses would
  make the living-video drift detector compare the wrong things. **Flagged, not
  touched** — it is the next honest question in this area.

---

## 2. `lib/voice/twilio-tenancy.ts:pickCredTier` — MERGE INWARD (kept, now used)

Not a duplicate to delete: it is the pure half of a decision the impure resolver
was restating.

**Read both.** `resolveTenantTwilioCreds` made the identical tier decision inline
as three sequential `if`s in the identical order (BYO → subaccount → master).
Same ladder, two copies, and only the copy needing a database and two env vars
could be exercised. `resolveTenantTwilioCreds` now **fetches** and `pickCredTier`
**decides**; the ordering is testable for the first time.

The logic did not differ, so there was no "which is correct" to settle. Verified
against the live shape: `platform_credentials` rows keyed
`twilio_byo` / `twilio_subaccount` with `account_id` + `access_token`, plus the
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` master env pair — exactly the three
booleans `pickCredTier` takes.

### Defect fixed at the same time (fail-open → fail-closed)

The read was `const { data: rows } = await svc.from("platform_credentials")…` —
**no `error` destructured**. supabase-js *resolves* a refused query, so an RLS
refusal or a transport error arrived as `data: null` and fell straight through
the ladder to the **platform master account**. That is not a degraded answer, it
is the wrong tenant's account: the call would be placed and billed on the
platform's own Twilio, from a number the brokerage does not own. A refused read
now returns `null` — the same answer every one of the 12 callers already handles
for "nothing configured".

Zero *rows* still falls through to master. That is the documented legacy path for
tenants provisioned before subaccounts existed, and it is a fact, not a failure.

`lib/kernel/manager-registry.ts:457` already claimed "pure `pickCredTier` +
`resolveTenantTwilioCreds`". The claim is now true.

---

## 3. `lib/providers/tenancy-matrix.ts:providerTenancy` — WIRED

**The surface that re-derives tenancy is `lib/platform/provider-posture.ts`.** It
is the only file in `app/ lib/` outside the matrix itself that touches the
ownership models at all (`grep` for `byo_top_tier|platform_subaccount|
platform_metered|tenant_optional_key|user_oauth` → two lines, both at
`provider-posture.ts:717-718`), and what it does there is **fold the five models
into two booleans**:

```
platformHint |= platform_metered | platform_subaccount | tenant_optional_key
tenantHint   |= user_oauth | byo_top_tier | tenant_optional_key
```

That fold is lossy in a way that reaches a live screen. `byo_top_tier` — which
the matrix scopes to the *multi_location tier only*, an enterprise escape hatch —
lands in the same bucket as `user_oauth`. So **Twilio**, whose matrix row is
`["platform_subaccount", "byo_top_tier"]` and whose stated product promise is
*"tenants never touch a Twilio signup"*, was rendered to brokers as
**"Connect · waiting on you"** and counted in *"N lanes are waiting on you —
connect the account in Settings"* on two live panels:

- `app/dashboard/system/components/os/provider-health-panel.tsx`
- `app/dashboard/admin/onboarding/components/os/provider-readiness-panel.tsx`

### What was wired

`getBrokerageProviderReadiness` now consults `providerTenancy(provider)` — the
lookup back to the ruling itself — for two things:

1. a new optional `tenantActionable` on `BrokerageReadinessInput`. `undefined`
   (no matrix row) preserves the pre-existing branch exactly; an explicit
   `false` moves the row from `needs_connection` (broker's job) to
   `platform_dark` (staff's job). `ready` is untouched in both cases, so
   `lib/agentic-os/resolve-app-capability.ts:platformLaneReady` — which reads
   only `row.ready` — is unaffected.
2. the per-row `note`, which is the sentence a broker actually reads. Twilio now
   says *"The platform provisions this for you — bringing your own account is a
   multi-location-tier option, never a requirement"* instead of *"Connect your
   account to switch this on."*

Measured on an empty tenant with no TWILIO env: `needsConnection` 36 → 35,
`platformDark` 23 → 24, `ready` and `total` unchanged. Exactly one provider
reassigned, and it is the one the matrix rules on.

The two helpers (`tenantActionableFor`, `readinessNote`) are **deliberately not
exported** — their only consumer is in the same file, and an exported helper with
no cross-file caller would be a brand-new orphan in the very file that measures
them.

### Left alone

`lib/agentic-os/vendor-ownership.ts` (`PLATFORM_VENDORS` /
`USER_CONNECTED_VENDORS`) is a second, hand-kept answer to a *related* question —
which gate applies, budget or connection. It covers vendors that have no matrix
row at all, and it is load-bearing for the budget gate. Collapsing it into the
matrix is a real consolidation, and it is not this slice.

---

## 4. `lib/providers/calendar/personal-calendar.ts:hasPersonalCalendar` — WIRED

Not a duplicate. Its siblings `createEventViaPersonal` /
`getAvailabilityViaPersonal` are live via `lib/providers/calendar/index.ts:78,87`;
this is the readiness predicate for the same connection.

### The hole it fills

`app/dashboard/settings/calendar/page.tsx` is the one surface where an agent is
told about their calendars. Everything on it concerned
`calendar_provider_accounts` — a registry that, as the page's own header says,
"stores no OAuth token" and delivers nothing.

The calendar that **actually receives bookings** is a different thing:
`lib/providers/calendar/index.ts` routes `createCalendarEvent` /
`getAvailability` through the personal Google/Microsoft OAuth connection, and
falls back to a **mock event id and mock business-hours slots** when it does not
resolve. So an agent with no personal calendar connected books appointments that
report success and land nowhere — and the page they would check said nothing
about it in either direction.

**Wired:** a "Your Bookings Calendar" panel, rendered from
`hasPersonalCalendar(user.id)`. Real data (the live token check, including a
refresh attempt), three real states:

- **Connected** — an account is on file and its token is current.
- **Not connected** — no account with a usable token: either none is connected or
  the stored token could no longer be refreshed. Says so, says what it costs
  (mock bookings, generic availability), and links to `/settings/connections`,
  the Connection Center that offers gmail/outlook under its `calendar` domain.
- **Could not be checked** — a thrown error is shown as an error and explicitly
  told the reader *not* to read it as "not connected". Different facts.

`user.id` is a `users.id` from `auth.getUser()`; `getFreshPersonalToken` resolves
`agents` by `user_id` internally. No id space is crossed and nothing is `??`'d.

The predicate's signature was left exactly as it was. `false` is deliberately not
split into "never connected" vs "token expired" — `getFreshPersonalToken` cannot
distinguish them without a second read and the remedy is identical, so the
surface states both possibilities rather than guessing.

---

## Files changed

| file | why |
|---|---|
| `lib/voice/voice-resolver.ts` | `resolveContactFacing` + `VoiceContext` deleted; module re-declared SELF ONLY with the survivor named in-code |
| `lib/workflow/adapters/video.ts` | **surface** — contact-delivered video moved off the self resolvers onto `resolveVideoIdentity(purpose:"contact_facing")`; honest no-twin refusal |
| `app/actions/voice-avatar-settings.ts` | prose reference to the deleted symbol rewritten to name the survivor |
| `lib/voice/twilio-tenancy.ts` | `resolveTenantTwilioCreds` now calls `pickCredTier`; refused read fails closed |
| `lib/platform/provider-posture.ts` | **surface** — readiness consults `providerTenancy` for actionability + note |
| `lib/providers/calendar/personal-calendar.ts` | wiring record on `hasPersonalCalendar` (no signature change) |
| `app/dashboard/settings/calendar/page.tsx` | **surface** — "Your Bookings Calendar" panel |
| `scripts/provider-readiness-simulator.ts` | proof for the tenancy wiring |

Not touched, per the split: `lib/voice/twilio-outbound.ts`,
`lib/providers/dispatch.ts`, `lib/providers/messaging/*`.
`lib/providers/calendar/index.ts` was in scope and needed no change — the mock
fallback it documents is the very thing the new panel now warns about.

---

## Proofs

New assertions in `scripts/provider-readiness-simulator.ts` (24 → 34 checks).
They assert the **property**, not a spelling — a correct consolidation that moves
the code keeps passing:

- the pure branch, both directions: `tenantActionable:false` on a tenant-scoped
  lane → `platform_dark`; omitted or `true` → the pre-existing
  `needs_connection`; a connected tenant still wins with `live_connected`.
- `providerTenancy` is reachable and returns `null` for an unknown name.
- **end to end through the real `getBrokerageProviderReadiness`** against a stub
  client returning zero credential rows (pre-rollout truth: the tables ARE
  empty): *no provider whose matrix models contain neither `user_oauth` nor
  `tenant_optional_key` is ever reported as the broker's move*, checked over the
  real `PROVIDER_TENANCY` so a new row obeys it automatically; the mirror
  property for tenant-initiated providers; and every row carries a non-empty
  note.

Nothing counts literal occurrences.

### Guard results

| guard | result |
|---|---|
| `npm run test:orphan-exports` | ✅ PASS — 1427 unreferenced (baseline 1429); burn-down in `personal-calendar.ts` 1→0 and `tenancy-matrix.ts` 1→0 |
| `npm run test:use-server-exports` | ✅ PASS — 3 passed, 0 failed |
| `npm run test:provider-readiness` | ✅ PASS — 34 passed, 0 failed |
| `npm run test:voice-lane` | ✅ PASS — 131 passed, 0 failed |
| `npm run test:capability-contract` | ✅ PASS — 80 passed, 0 failed |
| `npm run test:living-video` | ✅ PASS — 142 passed, 0 failed |
| `scripts/no-brokerage-face-guard.ts` | ✅ PASS — 23 passed, 0 failed |
| `npm run test:campaign-channels` | ✅ PASS — 26 passed, 0 failed |

Central typecheck is the orchestrator's; not run here by instruction.

### One thing the orphan guard did NOT independently bless — stated so nobody trusts it further than it deserves

The first run of `test:orphan-exports` in this slice **failed**, on the
concurrent agent's work:

```
  ✗ CAPABILITY REMOVED — 1 export(s) exist NOWHERE in the tree:
     - lib/providers/dispatch.ts:dispatchPhone
```

Between that run and the next, **that agent re-baselined**
(`scripts/orphan-export-baseline.json` is modified in the working tree and I did
not run `ORPHAN_EXPORT_BASELINE=1`). Their snapshot was taken while my deletion
was already on disk, so the new baseline records
`lib/voice/voice-resolver.ts → ['resolveSelfVoice', 'resolveSelfAvatar']`.

The green tail above is therefore honest about *growth* — no new unwired export —
but it did **not** independently adjudicate the removal of
`resolveContactFacing`; that deletion was absorbed by someone else's
re-baseline. The named survivor and the reasoning are in this ledger and in
`lib/voice/voice-resolver.ts` for exactly that reason.
