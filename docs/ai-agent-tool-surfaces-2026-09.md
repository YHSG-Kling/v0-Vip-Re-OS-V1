# AI-agent tool surfaces — audit (2026-09-17, lane 72B)

Owner correction (verbatim, wave 72): *"I didn't want you to create tools
that didn't make sense. these tools are not for users to use but the ai
agent that has to service the chat/phones etc. we want the ai agents to be
able to support the tenants or the real estate agents."*

This is the TOOL-SET companion to `docs/ai-agent-surfaces-2026-09.md` (which
covers MODEL routing/cost per surface). This doc covers which BatchData/
RentCast/PeopleData tools each AI-agent surface carries, why, and who pays.

## 1. Surface × audience × tool set × cost rule

| Surface | Route(s) | Audience | Tool set | Persona / gate | Cost rule |
|---|---|---|---|---|---|
| ISA inbound-email handler | `app/actions/ai-isa/handle-inbound-email.ts` | a LEAD (email reply) | `buildISATools` (existing ISA action tools) + `batchDataIsaTools` | `persona: 'isa'` always — this handler qualifies a known lead's own thread, never an investor-portal visitor | BatchData: platform spend, `meterVendorSpend`, per-conversation budget `BATCHDATA_ISA_BUDGET_CENTS` (default $2.00), metered per tool call inside `lib/ai-isa/batchdata-isa-tools.ts` |
| D-ID live-avatar brain | `app/api/did/custom-llm/route.ts` | anonymous visitor or a known contact, spoken | `batchDataIsaTools` | persona derived from the resolved contact's `contact_persona` column (`'investor'` → investor persona, else `'isa'`) — never a request body | Same BatchData budget/metering as above; AI model turn booked to `ai_tool_usage` via `streamTextRouted` with `manager: "ai_isa"` |
| In-app agent copilot | `app/api/internal/ai-chat/route.ts` | tenant staff / licensed agent (authenticated, `users.user_type` checked) | `batchDataMcpTools` (FULL account MCP catalogue, ungoverned) + `rentCastMcpTools` (agent-copilot RentCast lookups) | no persona split — staff get the whole toolkit; tenant/session-resolved `brokerageId`/`user.id`, never body | Both metered per call; RentCast MCP is copilot-only (every scheduled/bulk pull stays on the typed REST client, `lib/property/rentcast-typed.ts`, to avoid double-billing LLM tokens on top of the per-request rate) |
| **Portal contact assistant** (wired this lane) | `app/api/portal/ai-chat/route.ts` | a known, access-checked CONTACT (buyer/seller/owner/investor) | `batchDataIsaTools` — **was carrying no tool set at all before this lane** | persona derived from the ACCESS-CHECKED contact row's `contact_persona` (`'investor'` → investor persona, else `'isa'`); `conversationKey = contactId`; `contactId` passed so verify/DNC verdicts persist onto the contact | Same BatchData budget/metering, scoped per contact conversation; AI turn booked via `streamTextRouted` `manager: 'ai_isa'` |
| **Website visitor widget** (wired this lane) | `app/api/widget/message/route.ts` | anonymous, PRE-lead website visitor (no auth, session-token only) | `batchDataIsaTools` — **was carrying no tool set at all before this lane** | `persona: 'isa'` always (an anonymous visitor can never be the investor persona — that requires an authenticated investor contact); `conversationKey = session.id`; `contactId` from the session's own linked contact when capture already happened, else `null` | Same BatchData budget/metering, scoped per widget session; identity for the ledger is the session's own tenant, never the request body |
| Onboarding setup assistant | `app/api/onboarding/assistant/route.ts` | a NEW AGENT learning the platform | **none** (correctly) | n/a — KB-grounded platform Q&A, no property-data need | n/a |
| Agent reply-draft copilot | `app/api/chat/stream/route.ts` (`agent_chat_stream`) | licensed agent (drafts a suggestion the agent sends in their OWN voice) | **none** (correctly) | n/a — this route never itself talks to a client under a persona; the file's own comment documents why it does not even load the brand-voice cascade the persona-speaking surfaces above share | n/a |
| Internal voice-command dispatcher | `app/api/internal/voice-command/route.ts` | tenant staff (spoken/typed platform commands: "who's hot", "draft save-plays") | **none** (correctly) | n/a — a command CLASSIFIER that extracts entities and dispatches EXISTING actions, not an open-ended chat surface a property-lookup tool belongs on | n/a |
| Phone/voice ISA (Twilio ConversationRelay reception) | `lib/voice/twilio-voice.ts` (`planTurnWithPrompt`), `lib/voice/platform-reception.ts` | inbound/outbound caller (lead, contact, or a platform prospect) | **none — UNRESOLVED, see §3** | n/a | n/a |

## 2. Investor-persona property-only enforcement (unchanged this lane, re-verified)

`lib/ai-isa/batchdata-isa-tools.ts`'s `investor` persona registry has **no
skip-trace / owner-contact tool NAME in it at all** — `lookup_property`,
`verify_address`, `verify_phone`, `check_dnc_status`, `check_tcpa_status` are
all gated `if (ctx.persona === "isa")` and never registered for `investor`.
Every investor-persona result also passes through `toInvestorFacingToolRow`
(an ALLOWLIST: address/city/state/zip/estimatedValue/beds/baths/propertyType/
quickListTags/likelihoodBand) before the model ever sees it — the same
redaction shape `lib/buyer-search/investor-facing.ts` already uses for the
off-market portal cards (one vocabulary, CLAUDE.md §6). Proved by
`scripts/ai-agent-tool-surfaces-simulator.ts` Layer 1B and by
`scripts/batchdata-isa-tools-simulator.ts`.

## 3. No user-facing tool UI (audit result)

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

## 4. Unresolved — phone/voice ISA has no AI-SDK tool-calling architecture

`lib/voice/twilio-voice.ts::planTurnWithPrompt` (the inbound/outbound phone
reception brain riding Twilio ConversationRelay) and
`lib/voice/platform-reception.ts::planPlatformReceptionTurn` (the platform
prospect-line reception brain) both call `generateTextRouted` with a plain
prompt and parse a STRUCTURED JSON PLAN out of the model's text response
(`parseTurnPlan` / `parsePlatformTurnPlan`) — they do **not** use AI-SDK
`tool()` registrations at all. This is a deliberate, pre-existing,
latency-sensitive design (the callback-task loop built in wave 55 rides the
same JSON-plan shape) and predates this lane.

Giving the phone ISA `batchDataIsaTools` (e.g. so a caller asking "what's my
home worth" gets a real `lookup_property` answer) would need the turn engine
itself restructured into a multi-step tool-calling loop compatible with
ConversationRelay's real-time audio turn-taking — a turn-ENGINE
architecture change, not a tool-set gap this lane's scope covers. Recorded
as **UNRESOLVED** per CLAUDE.md §1 ("when you cannot prove it either way,
write unresolved rather than guessing") rather than silently wired past the
existing design or silently skipped without comment. `lib/voice/tool-registry.ts`
exists in the tree but is a DIFFERENT registry (voice COMMAND names —
"transfer", "book showing" — not an AI-SDK tool map) and was checked and
found to carry no BatchData/RentCast/PeopleData reference at all.

## 5. Proof

`scripts/ai-agent-tool-surfaces-simulator.ts` (`npm run test:ai-agent-tool-surfaces`)
— 35 assertions, 4 layers: strip-comments positive control, the surface
inventory above (tool set matches audience, investor persona never carries
skip-trace tools), the no-user-facing-tool-UI scan (with positive control),
the portal/widget context-derivation wiring, and the skip-trace unit-cost
constant (task 3). `scripts/batchdata-isa-tools-simulator.ts` and
`scripts/lead-intake-pipeline-simulator.ts` (PeopleData identity resolution,
task 2) are the adjacent proofs this doc's claims lean on.
