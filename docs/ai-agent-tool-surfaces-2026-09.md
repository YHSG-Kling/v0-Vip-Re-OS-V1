# AI-agent tool surfaces — audit (2026-09-17, lane 72B; widened 2026-09-18, lane 73B)

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
| Phone/voice ISA (Twilio ConversationRelay reception) | `lib/voice/twilio-voice.ts` (`planReceptionTurn`/`planTurnWithPrompt`) | inbound/outbound caller (lead or contact) | `batchDataIsaTools`, ONE bounded call per turn via `toolRequest` (§4) | persona DERIVED per-turn from the call's linked `contacts.id`, else the `buyer` default; property-only tool subset (`lookup_property`, `comparable_property_preview/count`, `verify_address`) | Same budget/metering; a call NEVER runs more than one BatchData tool per spoken turn |
| Platform prospect/support line | `lib/voice/platform-reception.ts` (`planPlatformReceptionTurn`) | a prospect or existing-customer support caller on the PLATFORM's own line | **none — carries the `toolRequest` schema field for parity, never executes it (§4)** | n/a — this line has no brokerage/property context at all | n/a |

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

## 4. Voice ISA — bounded, one-call-per-turn tool requests (lane 73B, item 3)

`lib/voice/reception-brain.ts`'s `VoiceTurnPlan` (the JSON contract every
Twilio ConversationRelay turn returns) now carries an OPTIONAL `toolRequest`
field — a closed enum (`lookup_property`, `comparable_property_preview`,
`comparable_property_count`, `verify_address`; `VOICE_TOOL_NAMES`) plus an
address. `lib/voice/twilio-voice.ts::planReceptionTurn` (the INBOUND tenant
reception brain) executes it: at most ONE tool call per turn, against the
SAME persona-scoped `batchDataIsaTools` registry every chat surface uses
(persona resolved from the call's linked `contacts.id`, else `buyer`), then
RE-PLANS exactly once with the result folded into the prompt — a
`toolRequest` in that RE-PLAN's own response is discarded, never chained.
Wired at both call sites that already resolve a `voice_calls` row
(`app/api/voice/twilio/turn/route.ts`, `app/api/voice/relay/plan/route.ts`),
passing `{ callId, contactId }` from the row they already select.

**FAIL CLOSED WITHOUT A TOKEN / WITHOUT A CALL CONTEXT**: `planTurnWithPrompt`
takes the execution context (`VoiceToolExecContext`) as an OPTIONAL fourth
argument. Any existing caller that does not pass it (the outbound ISA lane
today, `app/api/voice/relay/plan/route.ts`'s `brief` branch) still PARSES a
`toolRequest` off the model's plan but never executes it — additive, not a
silent behavior change. Inside the executor itself, a tool name the resolved
persona's policy (or the platform tier) does not grant simply is not in the
registry `batchDataIsaTools` returns, so the round reports "not available for
this call" back to the model rather than crashing or fabricating a result.

**UNRESOLVED, unchanged in kind from wave 71/72**: this is a bounded MANUAL
round bolted onto the existing JSON-plan turn engine, not a full multi-step
AI-SDK `tool()`-calling loop — `generateTextRouted` is still never called with
a `tools:` argument on the voice lane. Restructuring the whole turn engine
into native tool-calling (so the model could, in principle, request more than
one tool per turn, or the SDK could manage the loop itself) remains a
turn-ENGINE architecture change out of this lane's scope, recorded here
rather than silently claimed as fully solved.

`lib/voice/platform-reception.ts`'s `PlatformTurnPlan` (the PLATFORM
prospect/support line) carries the SAME `toolRequest` field for schema parity
but is documented, in its own doc comment, as ALWAYS `null` and never
executed — that line has no brokerage or property context at all, so there is
nothing a persona-scoped property tool could look up. Recorded as UNRESOLVED
per CLAUDE.md §1 rather than silently wired past a context it does not have.

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
— 57 assertions, 6 layers: strip-comments positive control, the surface
inventory above (tool set matches audience, investor/seller personas never
carry skip-trace tools), the no-user-facing-tool-UI scan (with positive
control), the portal/widget persona-derivation wiring, the voice ISA
`toolRequest` bounded round (§4 — plan → execute → re-plan, a second request
discarded, fail-closed without a token/call-context, the platform-reception
line's parity-only field), and the skip-trace unit-cost constant.
`scripts/batchdata-isa-tools-simulator.ts` (120 assertions — persona
allowlists, cost-tier constriction incl. the monthly-cap-trips-to-lean
downgrade, `resolveToolPersona` derivation, redaction, budget/ordering) and
`scripts/lead-intake-pipeline-simulator.ts` (PeopleData identity resolution)
are the adjacent proofs this doc's claims lean on.
