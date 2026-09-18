# AI-agent tool surfaces — audit (2026-09-17, lane 72B; widened 2026-09-18, lane 73B; voice turn engine restructured 2026-09-18, lane 73E)

Owner correction (verbatim, wave 72): *"I didn't want you to create tools
that didn't make sense. these tools are not for users to use but the ai
agent that has to service the chat/phones etc. we want the ai agents to be
able to support the tenants or the real estate agents."*

Owner, wave 73, verbatim: *"there should be tools for the ai agents that will
help with their chats and calls for a real estate customer which can be all
different personas. if batchdata is going to be expensive, tools should be
constricted."*

This is the TOOL-SET companion to `docs/ai-agent-surfaces-2026-09.md` (which
covers MODEL routing/cost per surface). This doc covers which BatchData/
RentCast/PeopleData tools each AI-agent surface carries, why, and who pays.

## 1. Surface × audience × tool set × cost rule

| Surface | Route(s) | Audience | Tool set | Persona / gate | Cost rule |
|---|---|---|---|---|---|
| ISA inbound-email handler | `app/actions/ai-isa/handle-inbound-email.ts` | a LEAD (email reply) | `buildISATools` (ISA action tools) + `buildCustomerFreeTools` (free — own context, showing/call request, our own listings) + `batchDataIsaTools` + `rentCastMcpTools` (persona-filtered) | persona DERIVED (`resolveToolPersona`) from the linked contact's own `contact_type`/`contact_persona`/`home_owner_status`, else the lead's own `persona`/`home_owner_status`/`lead_type` — never `'isa'` as a literal any more | BatchData: platform spend, `meterVendorSpend`, per-persona budget (§2); RentCast: platform spend, `meterVendorSpend`, per call |
| D-ID live-avatar brain | `app/api/did/custom-llm/route.ts` | anonymous visitor or a known contact, spoken | `buildCustomerFreeTools` + `batchDataIsaTools` + `rentCastMcpTools` (persona-filtered) | persona DERIVED (`resolveToolPersona`) from the resolved contact's own context; an anonymous visitor (no contact) resolves to the `buyer` default — never a request body | Same as above; AI model turn booked to `ai_tool_usage` via `streamTextRouted` with `manager: "ai_isa"` |
| In-app agent copilot | `app/api/internal/ai-chat/route.ts` | tenant staff / licensed agent (authenticated, `users.user_type` checked) | `batchDataMcpTools` (FULL account MCP catalogue) **now filtered by `BATCHDATA_TOOL_TIER`** + `rentCastMcpTools` (agent-copilot RentCast lookups, unfiltered — RentCast is not the expensive vendor) | no PERSONA split — staff get the whole toolkit, narrowed only by the platform COST TIER (§3); tenant/session-resolved `brokerageId`/`user.id`, never body | Both metered per call; the tier constriction applies here TOO (owner: "if batchdata is going to be expensive, tools should be constricted" — that includes staff) |
| Portal contact assistant | `app/api/portal/ai-chat/route.ts` | a known, access-checked CONTACT (buyer/seller/investor/renter/relocation/sphere) | `buildCustomerFreeTools` + `batchDataIsaTools` + `rentCastMcpTools` (persona-filtered) | persona DERIVED from the ACCESS-CHECKED contact row's own `contact_type`/`contact_persona`/`home_owner_status`; `conversationKey = contactId` | Same BatchData/RentCast metering, scoped per contact conversation |
| Website visitor widget | `app/api/widget/message/route.ts` | anonymous, PRE-lead website visitor (no auth, session-token only) | `buildCustomerFreeTools` + `batchDataIsaTools` + `rentCastMcpTools` (persona-filtered) | persona DERIVED from the session's own linked contact when capture already happened this session, else the `buyer` default (an anonymous visitor can never be the investor/seller/sphere persona — those all require a known contact); `conversationKey = session.id` | Same metering, scoped per widget session; identity for the ledger is the session's own tenant, never the request body |
| Onboarding setup assistant | `app/api/onboarding/assistant/route.ts` | a NEW AGENT learning the platform | **none** (correctly) | n/a — KB-grounded platform Q&A, no property-data need | n/a |
| Agent reply-draft copilot | `app/api/chat/stream/route.ts` (`agent_chat_stream`) | licensed agent (drafts a suggestion the agent sends in their OWN voice) | **none** (correctly) | n/a — this route never itself talks to a client under a persona | n/a |
| Internal voice-command dispatcher | `app/api/internal/voice-command/route.ts` | tenant staff (spoken/typed platform commands: "who's hot", "draft save-plays") | **none** (correctly) | n/a — a command CLASSIFIER, not an open-ended chat surface | n/a |
| Phone/voice ISA (Twilio ConversationRelay reception) | `lib/voice/twilio-voice.ts` (`planReceptionTurn`/`planTurnWithPrompt`) | inbound/outbound caller (lead or contact) | `batchDataIsaTools`, NATIVE AI-SDK multi-step tool-calling, bounded `maxSteps` ≤3 + a hard per-turn deadline (§4) | persona DERIVED per-turn from the call's linked `contacts.id`, else the `buyer` default; property-only tool subset (`lookup_property`, `comparable_property_preview/count`, `verify_address`) | Same budget/metering; bounded by `VOICE_TOOL_ROUND_MAX_STEPS`/`VOICE_TOOL_ROUND_DEADLINE_MS`, a thrown/timed-out round falls back to the plan-only path |
| Platform prospect/support line | `lib/voice/platform-reception.ts` (`planPlatformReceptionTurn`) | a prospect or existing-customer support caller on the PLATFORM's own line | `platform_faq_lookup` ONLY — a tenant-free platform-KB tool, native calling, SAME bounded ceiling (§4) | n/a — this line has no brokerage/property context, so no property tool; the FAQ tool takes no persona | Free (internal KB read); no BatchData/RentCast tool on this line |

## 2. Persona × tool × cap × tier matrix (lane 73B)

`ToolPersona` (`lib/ai-isa/persona-tool-policy.ts`) is DERIVED from the SAME
vocabulary every contact/lead row already carries — never a second one (§6):
`contacts_contact_type_check` (buyer/seller/both/sphere/referral_partner/
lifetime_customer/…), `contacts_contact_persona_check` (`investor`/`relocated`/…),
`home_owner_status` (`renter`/`owner`/`any`). `resolveToolPersona` is the ONE
function that turns those columns into a persona; priority: `investor` persona
column > `relocated` > `renter` home-owner status > `seller` contact type >
`sphere`/`referral_partner`/`lifetime_customer` contact type > default `buyer`.

| Persona | BatchData tools (before tier filter) | RentCast tools | Per-conversation cap | Redaction |
|---|---|---|---|---|
| `buyer` | `comparable_property_preview`, `comparable_property_count` | listing/valuation-shaped (`/listing\|sale\|value\|avm\|market/i`) | $1.00 | property-only |
| `seller` | `lookup_property`, `comparable_property_preview`, `comparable_property_count`, `verify_address` — **skip-trace never**, it does not exist in this registry | none | $2.00 | identity (their own property) |
| `investor` | `search_properties_preview/count/page`, `comparable_property_preview/count`, `investor_buybox_preview/count` — **no skip-trace/owner-contact tool, unchanged wave 68/69 ruling** | none | $2.00 | property-only (`toInvestorFacingToolRow`) |
| `renter` | **none** | rental-shaped (`/rent/i`) | $0.00 | property-only |
| `relocation` | `search_properties_preview`, `search_properties_count` (never `_page`) | market/listing-shaped (`/market\|listing/i`) | $0.50 | property-only |
| `sphere` | `verify_phone`, `check_dnc_status`, `check_tcpa_status` — **only when the caller declares the conversation `outboundEligible: true` (default false, fail closed)** | none | $0.50 | identity (no property rows to redact) |
| `staff` (in-app copilot) | the FULL, ungoverned `batchDataMcpTools` catalogue, narrowed only by the platform TIER below (§3) — no persona allowlist | the full `rentCastMcpTools` catalogue, unfiltered | n/a (tier-only) | none (staff sees raw MCP output) |

Every free/no-cost tool (`get_my_context`, `search_our_listings`, and
`request_showing` when a contactId is known — `lib/ai-isa/customer-context-
tools.ts::buildCustomerFreeTools`) is available to EVERY persona, ALWAYS tried
before a paid BatchData/RentCast tool — the model's own instructions and each
surface's tool ordering both push this: free internal DB/CRM lookups first,
BatchData/RentCast only when the free tools cannot answer.

## 3. Cost-tier constriction (lane 73B — "if batchdata is going to be expensive, tools should be constricted")

`BATCHDATA_TOOL_TIER` (env, default `lean`) is a SECOND, PLATFORM-WIDE filter
applied on top of every persona's allowlist AND on top of the staff copilot's
full catalogue (`lib/ai-isa/persona-tool-policy.ts::filterToolsByTier`):

- **`full`** — no restriction; each persona's/staff's tool set stands as-is.
- **`lean`** (default) — preview/count tools, `lookup_property`, and the
  verify-prefixed/`check_dnc_status`/`check_tcpa_status` compliance tools
  survive; any `_page` pull or other bulk/full-record tool (including a
  future skip-trace tool the staff copilot's MCP catalogue might expose) is
  cut. The filter is GENERIC on tool NAME, not tied to one registry's shape.
- **`off`** — zero BatchData tools of any kind, for any persona or staff.
  RentCast and the free internal tools are untouched.

`BATCHDATA_TOOL_MONTHLY_CAP_CENTS` (env, default $500.00) is the platform's
BatchData spend ceiling for the current calendar month — read from
`vendor_usage_tracking` (`vendor_name = 'batchdata'`, the SAME sum the
BatchData wallet billing diagnostic already reads for display). Once the
current month's platform BatchData spend reaches the cap, a configured
`"full"` tier auto-downgrades to `"lean"` for every surface
(`resolveEffectiveBatchDataToolTier`, 5-minute in-process cache). The
downgrade never goes further to `"off"` on spend alone — an explicit `off`
env value is required for that, an operator decision, never automatic.

## 4. Voice ISA — native multi-step AI-SDK tool-calling (lane 73E, restructured off 73B)

**Wave 73B** (2026-09-18, earlier this wave) bolted a hand-rolled
`toolRequest` JSON field onto the turn-plan contract and a manual
plan→execute→re-plan protocol in `lib/voice/twilio-voice.ts`, bounded to
exactly one tool call per turn, because the turn engine had never been
restructured onto real AI-SDK tool-calling. **Lane 73E did that
restructuring.** That manual field/enum/parser are TOMBSTONED in
`lib/voice/reception-brain.ts`, naming this section as the survivor.

**The design now**: `lib/voice/twilio-voice.ts::planTurnWithPrompt` — the
shared engine both the inbound reception brain (`planReceptionTurn`) and the
outbound-brief lane ride — takes an OPTIONAL `VoiceToolExecContext` (`{
brokerageId, agentId, contactId, conversationKey }`, resolved from the CALL
row, never the caller's speech). When present, it:

1. Resolves the call's tool persona the same way every other AI-agent surface
   does (`resolveToolPersona` off the linked contact's `contact_type`/
   `contact_persona`/`home_owner_status`, defaulting `buyer` for an anonymous
   caller).
2. Builds the SAME persona-scoped `batchDataIsaTools` registry every chat
   surface uses, narrowed to `VOICE_TOOL_ALLOWLIST` — the same four names
   wave 73B's closed enum named (`lookup_property`,
   `comparable_property_preview`, `comparable_property_count`,
   `verify_address`; never skip-trace/dnc/tcpa on a phone call).
3. If that narrowed set is non-empty (a token is configured AND this
   persona's policy grants at least one), makes ONE `generateTextRouted` call
   with a REAL `tools:` map + `maxSteps: VOICE_TOOL_ROUND_MAX_STEPS` (bounded
   to ≤3 — the turn-engine design ceiling; the SDK's own multi-step loop
   decides whether/how many times to call, so a turn CAN now use more than
   one tool, unlike 73B's hard one-call cap) + a hard
   `abortSignal: AbortSignal.timeout(VOICE_TOOL_ROUND_DEADLINE_MS)`. Every
   tool result is folded into the model's own context by the SDK's loop —
   exactly once, no manual re-prompt construction on this repo's side.
4. If that call throws for ANY reason (including the deadline firing —
   an AI-SDK abort surfaces as a thrown error, so this repo does not need to
   special-case its exact shape), it FALLS BACK to the plain, no-tools
   single-call path — **fail safe, never silence on a live call**. That
   fallback is the SAME code path used when `toolCtx` is omitted entirely, or
   when the narrowed tool set is empty (nothing to offer costs nothing —
   the tool-enabled call is skipped outright rather than made with an empty
   `tools:` map).

Wired at both call sites that already resolve a `voice_calls` row
(`app/api/voice/twilio/turn/route.ts`, `app/api/voice/relay/plan/route.ts`),
passing `{ callId, contactId }` unchanged from wave 73B.

**The per-turn deadline (`VOICE_TOOL_ROUND_DEADLINE_MS`, env-tunable, default
4000ms)** is a DERIVED policy ceiling (CLAUDE.md §2 — published with its
reasoning, not asserted as a measurement): `docs/twilio-vs-elevenlabs-voice-2026-09.md`
records ConversationRelay's OWN transport latency at ~491ms median
(versusref.com, Jul 2026) and this engine's turn-based `<Gather>` round trip —
one no-tool model call, the same shape as the plan-only fallback above — at
"~1-2s" in that same comparison table. A bounded native round can run up to
`VOICE_TOOL_ROUND_MAX_STEPS` sequential model round trips, some interleaved
with a live BatchData MCP call, so the default budgets roughly 2-3x the
single-call baseline — inside the ~3-5s window voice-UX practice treats as
"still feels live" before dead air reads as a dropped call. **UNRESOLVED**:
this has not been retuned against real production call audio (none exists in
this environment) — the constant is env-overridable for exactly that reason.

**`lib/voice/platform-reception.ts`'s `planPlatformReceptionTurn`** (item 5 of
the restructuring) — this line genuinely has NO brokerage/property context
(it is the PLATFORM's own prospect/support line, not a tenant's), so it still
carries none of the persona-scoped property tools. But it DOES now carry ONE
safe, TENANT-FREE tool: `platform_faq_lookup`, wired the same native way
(`tools:` + the SAME `VOICE_TOOL_ROUND_MAX_STEPS`/`_DEADLINE_MS` ceiling +
plan-only fallback on throw). It calls `lib/intelligence/kb-search.ts::searchKB(query, null, 3)`
— `brokerageId: null` — which the `match_help_topics` RPC's own WHERE clause
(`h.brokerage_id IS NULL OR h.brokerage_id = p_brokerage_id`) degrades to
"only platform-wide `help_topics_kb` rows" when `p_brokerage_id` is NULL, so
this can never surface a brokerage's private help content — the SAME
tenant-free KB rail `app/api/onboarding/assistant/route.ts` already reads
(its own `searchKB` call passes a real `brokerageId` and additionally sees
that tenant's own rows; the platform line only ever sees the `IS NULL` set).

## 5. Investor-persona property-only enforcement (unchanged in RULE, generalized in SCOPE)

`lib/ai-isa/batchdata-isa-tools.ts`'s `investor` persona registry has **no
skip-trace / owner-contact tool NAME in it at all** — `lookup_property`,
`verify_address`, `verify_phone`, `check_dnc_status`, `check_tcpa_status` are
never registered for `investor` (lane 73B: every registry entry is now gated
through `isToolAllowedForPersona(ctx.persona, "<name>")` against `persona-
tool-policy.ts`'s ONE table, not a hand-rolled `if (ctx.persona === "…")`
literal per tool). Every investor-persona result also passes through
`toInvestorFacingToolRow` (an ALLOWLIST: address/city/state/zip/
estimatedValue/beds/baths/propertyType/quickListTags/likelihoodBand) before
the model ever sees it — the same redaction shape
`lib/buyer-search/investor-facing.ts` already uses for the off-market portal
cards (one vocabulary, CLAUDE.md §6). Lane 73B extends this SAME redaction to
every "property-only" persona (buyer/renter/relocation), not investor alone —
only `seller` (looking at their own home) and `sphere` (no property rows in
its tool set) get the identity mapper. Proved by
`scripts/ai-agent-tool-surfaces-simulator.ts` Layer 1B and by
`scripts/batchdata-isa-tools-simulator.ts` §2/§5.

## 6. No user-facing tool UI (audit result)

Grepped `app/dashboard` for direct AI-agent tool-function call sites
(`skipTraceProperty`, `lookupProperty`, `searchPropertiesPage`, `verifyPhone`,
`comparablePropertyPreview`, `investorBuyboxPreview`, `reverseSkipTrace`,
`skip_trace_property`) across every `.ts`/`.tsx` file under the tree —
**zero hits**. The three dashboard files that DO mention BatchData/RentCast
by name are STATUS/SETTINGS surfaces, never a "run this tool" button:

- `app/dashboard/admin/markets/markets-client.tsx` — BatchData feed STATUS
  (listings tracked, source-enabled flags) for platform staff, read-only.
- `app/dashboard/superadmin/env-providers/providers-client.tsx` — provider
  CONNECTION status (key configured / not), not a tool invocation.
- `app/dashboard/settings/integrations/lead-sources/lead-sources-client.tsx`
  — tenant lead-source SETTINGS copy.

No dashboard page was found that lets a human directly run skip-trace,
property lookup, comps, or buy-box matching. Proved with a POSITIVE CONTROL
(CLAUDE.md §2): the same scanner run against a fixture that DOES contain a
tool-invocation call site correctly finds it, before the real scan reports
zero on the actual tree (`scripts/ai-agent-tool-surfaces-simulator.ts` Layer 2).

`lib/voice/tool-registry.ts` exists in the tree but is a DIFFERENT registry
(voice COMMAND names — "transfer", "book showing" — not an AI-SDK tool map or
the persona-scoped BatchData registry) and was checked and found to carry no
BatchData/RentCast/PeopleData reference at all — see §4 above for what the
voice lane's `toolRequest` field now does and what remains UNRESOLVED there.

## 7. Proof

`scripts/ai-agent-tool-surfaces-simulator.ts` (`npm run test:ai-agent-tool-surfaces`)
— strip-comments positive control, the surface inventory above (tool set
matches audience, investor/seller personas never carry skip-trace tools), the
no-user-facing-tool-UI scan (with positive control), the portal/widget
persona-derivation wiring, the voice ISA's native multi-step tool-calling
turn engine (§4 — persona-filtered `tools:` reaching `generateTextRouted`,
the `maxSteps`/deadline bound, cost-avoidance when nothing is offered, the
timeout→plan-only fail-safe fallback, no toolCtx → unchanged plain call, and
the platform-reception line's ONE tenant-free FAQ tool), and the skip-trace
unit-cost constant.
`scripts/batchdata-isa-tools-simulator.ts` (120 assertions — persona
allowlists, cost-tier constriction incl. the monthly-cap-trips-to-lean
downgrade, `resolveToolPersona` derivation, redaction, budget/ordering) and
`scripts/lead-intake-pipeline-simulator.ts` (PeopleData identity resolution)
are the adjacent proofs this doc's claims lean on.

## 8. Qualification playbook (lane 74B)

Owner, wave 74 verbatim: "the ai agents need to not be salesy but also try to
get them qualified so that they can setup a meeting/showing, get their
contact info, what their intent is, property address that they are selling,
determine their persona, etc. they can setup followup whether calling them
again when they are ready, sending a list of properties that they just told
us their criteria for, setting up a time to look up their property value and
give them a call back to discuss or did they want to setup an appt for an
agent to come out to discuss/no obligation, etc. typical real estate talk
unless there is a competitor which is doing this another more inventive way.
this goes for the platform ai agents."

**One playbook, mounted everywhere** — `lib/ai-isa/qualification-playbook.ts`
(`buildQualificationPrompt`, `QUALIFICATION_GOALS`,
`QUALIFICATION_FOLLOW_UP_MENU`). Every hand-rolled qualification paragraph
this doc's §1 surfaces used to carry independently is now a call into this
one builder, tombstoned in place at its old location. Goals: contact info,
intent (buy/sell/both/invest/rent/relocate), persona (m589 vocabulary),
seller property address, buyer criteria, timeline (the live 1-3/3-6/6-12
bucket CHECK — CLAUDE.md §5), financing status. Conversational rules: never
salesy, one question at a time, mirror their words, value before ask, fair
housing in the writing prompt (never characterize a neighborhood or infer a
demographic fact). Follow-up menu: `schedule_callback`,
`send_matching_listings`, `schedule_home_value_review`,
`find_listing_appointment_slots` + `book_listing_appointment`, `request_showing`
— the free ACTION tools in
`lib/ai-isa/customer-context-tools.ts`, contactId/leadId-locked, every write
via `sentinelWrite`, every action publishing a `manager_signals` row
(`qualification_call_requested` / `qualification_criteria_captured` /
`qualification_valuation_handoff` / `listing_appointment_pending_confirmation`
— wave 75C survivor of the retired `qualification_appointment_handoff` —
`lib/kernel/signal-registry.ts` + `lib/kernel/manager-signals.ts`
`SIGNAL_HANDLERS`) so the Shopping Agent / Listing Concierge loops pick the
follow-up up autonomously beside the immediate agent notification each tool
already sends. `record_qualification` writes persona/intent/address/
criteria/timeline/financing to the columns that already exist — no new
migration (every column this lane touches — `contacts`/`leads`
`contact_persona`/`persona`, `timeline`, `lender_status`, `property_type`,
`address`, `qualification_summary`, `contact_type`/`lead_type`, and
`property_preferences`'s existing `preferred_price_*`/`inferred_*` columns —
was already live).

**Listing appointment (wave 75C, owner verbatim: "the no obligation meeting
should be marked as a listing appointment so that the workflow creates the
follow up until the appt which should be at least a week out ... the calendar
should be hooked up so that the ai agent can find a time and day that works
for the person and set up the appt right then and the agent just confirms
it. then the auto calendar emails go out and is pushed to their portal in
app.")** — `lib/ai-isa/listing-appointment.ts` is the ONE survivor:
`findAgentAppointmentSlots` reads the assigned agent's OWN connected
Google/Microsoft calendar (`lib/providers/calendar/personal-calendar.ts`'s
existing REST adapter over the connector gateway — `googleapis` is not a repo
dependency, so no new SDK) and fails CLOSED to a callback offer when nothing
is connected — it never invents a slot. `bookListingAppointment` books a
TENTATIVE hold ≥7 days out on `calendar_events`
(`event_type='listing_appointment'`, already a live enum member — no CHECK
constraint exists on that column, so no migration was needed) at
`status='pending_agent_confirmation'`, and reuses the EXISTING agent
action-queue rail (`portal_event_stream` + `app/actions/portal-stream.ts`'s
`dispositionPortalEventAction`) for "the agent just confirms it" — no new UI.
Confirming fires `confirmListingAppointment`: the Google event flips to
`confirmed`, auto calendar emails go out to BOTH agent and contact with an
ICS attachment (`lib/providers/messaging/index.ts`'s `sendEmail` extended
with `icsAttachment`), and a portal in-app card is pushed (the same
`portal_event_stream` table `getCustomerPortalFeed` already reads). The
5-day / 2-day / morning-of reminder cadence runs from
`sendListingAppointmentReminders` (cron `listing-appointment-reminders`,
owner `listing_concierge`); a reschedule supersedes (cancels) the prior open
appointment, which removes it from that cadence — "cancel on reschedule."
Proof: `test:listing-appointment`. Never surfaces an AVM value (owner
ruling: "never give the person a value over the conversation").

**Cost-ranked tool order** (owner: "tools for the ai agents should not be
using batchdata tools if there are less expensive tools to look up
properties") — `persona-tool-policy.ts`'s `costRankForTool` (0 internal / 1
RentCast / 2 BatchData preview-count-lookup-verify / 3 BatchData
page/skip-trace) and `selectToolsForPersona`, which sorts a surface's merged
tool map cheapest-first and DROPS a BatchData tool (`lookup_property`,
`comparable_property_preview/count`) when a RentCast tool already in the
SAME registry covers the need — property lookup and comps respectively.
Valuation has no such drop because it is never offered as a raw tool at all;
`schedule_home_value_review` calls the AVM chain directly (RentCast-first,
BatchData only when the chain reaches it and the platform tier is not
`"off"`), so there is nothing to rank-compete there. Every chat surface
(`handle-inbound-email.ts`, `widget/message`, `portal/ai-chat`,
`did/custom-llm`) and the voice line (`twilio-voice.ts`'s
`VOICE_TOOL_ALLOWLIST` build) route their merged property/free tool maps
through `selectToolsForPersona` before handing them to the model.

**Competitor scan (2026 AI real-estate ISA / conversational agents)** — one
Exa search across Structurely (Aisa Holmes), Ylopo (rAIya), Lofty AI Sales
Agent, Follow Up Boss AI, Roof AI, and Perspective AI:

| Move | Source | Adopted? | Why |
|---|---|---|---|
| Probe a vague/conditional answer with ONE follow-up instead of recording it as a flat field ("it depends on the school district" → ask, don't drop) | Perspective AI's stated differentiator over scripted-branch competitors | **Adopted** | Added to `conversationalRulesBlock()` — a real conversational gain that fits "never a form disguised as a sentence" exactly. |
| Explicit lead-situation tagging that drives downstream automation (Lofty's "AI: Intend to Sell" / "AI: Need Financing" / "AI: Investor" tag table) | Lofty AI Sales Agent qualification docs | **Already covered, reinforced** | This is what `record_qualification` writing `contact_persona`/`lender_status`/`contact_type` already does structurally (a real column, not a display tag) — no new build needed. |
| Behavioral prospecting — surfacing intent from in-platform behavior (listings viewed, price ranges browsed) rather than only responding to inbound | Lofty AI Sales Agent | **Already covered, declined as net-new** | `lib/behavior-learning/*`, `external_behavior`, `lead_property_searches`, and `property_preferences.inferred_*` already do this; this lane is the CONVERSATION half, not the behavior-mining half. |
| Hot/Warm/Cold routing with a 15-minute hot-lead SLA and a distinct handoff message style per tier | Multiple (Structurely/Ylopo docs, "Bot-to-Human Handoff Protocol") | **Already covered, declined as net-new** | `lead_temperature`/`urgency_level` + the existing ISA escalation/handoff signal kinds already carry this distinction; this lane's four new signals are `handoff`/`update` kind exactly along those lines. |
| Deliberate human-mimicking delays/casual filler so the lead does not realize it is an AI | Structurely's Aisa Holmes | **Declined** | Conflicts with the platform's own AI-disclosure rule (`lib/communication/call-disclosures.ts`, and every voice/reception prompt's "if asked whether you are an AI, confirm honestly and immediately") — a compliance line this lane does not get to move. |
| Multi-language auto-detection (Lofty: English/Spanish/Mandarin/French) | Lofty AI Sales Agent | **Declined for this lane** | Out of scope for the qualification-playbook build; a real capability, but a separate i18n project, not a qualification-conversation change. |

## 9. Follow-up action tools & cost-ranked selection — proof

`scripts/qualification-playbook-simulator.ts` (`npm run test:qualification-playbook`)
proves: every surface's system prompt contains the shared
`buildQualificationPrompt` call (stripped source) with no duplicated
qualification prose remaining (a positive-control fixture proves the scanner
still catches duplicated prose if it existed); the four follow-up tools
write via `sentinelWrite` and are persona/contactId-locked from `ctx`, never
a model-suppliable id; `costRankForTool`/`selectToolsForPersona` sort
cheapest-first and drop a BatchData tool a cheaper tool covers, with a
POSITIVE CONTROL proving a need only BatchData covers (the seller persona's
`lookup_property`, since sellers never get RentCast) survives; and
`record_qualification` only ever writes columns
`scripts/schema-snapshot.ts` lists as live.
