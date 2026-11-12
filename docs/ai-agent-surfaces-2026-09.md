# AI agent surfaces — provider, model and cost breakdown (2026-09-12)

Owner question (wave 59): *"break down ai agents for the website questions,
portal and in app and be sure that we are using the best provider and cost
effective since the platform pays the provider and it is billed in the
tenant's ai usage. all model/ai goes through the vercel ai gateway. if sdk is
available, we can use that if it is better than an api/mcp."*

Research method: Exa web search + fetch (skill: exa-search) against Vercel's
AI Gateway docs, model catalog pages and three 2026 cheap-tier comparisons
(APIpulse 2026-05-14/15, Chanl 2026-04-23, dreaming.press 2026-07-24), plus the
ecc `agentic-os` / `product-capability` lenses for the surface breakdown and
the homebuyinginstitute "Future of AI in Real Estate 2026–2030" outlook
(agentic systems mainstream 2026–27; 300% lead volume / 40% conversion gains
reported by firms automating follow-up; AVM error ~2.8%).

## 1. Transport: AI SDK 6 through the gateway — keep it, that IS the SDK

| Option | Verdict | Why |
|---|---|---|
| **AI SDK 6 (`ai@6.0.16`, `@ai-sdk/gateway`) → Vercel AI Gateway** | **KEEP (current)** | Zero token markup, provider list price, one key, per-request cost/usage metadata, automatic provider failover, `providerOptions.gateway.models` model fallbacks, prompt-cache pass-through, `ToolLoopAgent`/tool loop built in. Vercel's own guidance: "the string itself is the routing instruction". |
| Provider SDKs (OpenAI/Anthropic/Google direct) | NO | Second lane off the single bill/egress; CLAUDE.md §4/§5 already forbid it. |
| MCP servers as the agent brain | NO (as brain) | MCP is a tool transport, not a model. The in-app copilot already exposes its staging tools as AI SDK `tool()`s; wrapping them in MCP adds a hop and nothing else. |
| Twilio Agent Connect / ElevenLabs Conversational AI as the text brain | NO | Ruled in `docs/twilio-vs-elevenlabs-voice-2026-09.md` §6 — voice-only concerns; the brain stays ours. |
| D-ID Agents (Express v4) for the live avatar | KEEP (front-end SDK `@d-id/client-sdk`) | D-ID renders the face and streams audio; the **brain is our `app/api/did/custom-llm` route**, so it shares the same prompt cascade and model routing as every other surface. |

`WorkflowAgent` (`@ai-sdk/workflow`, durable tool steps + `needsApproval`)
is the upgrade path for approval-gated autonomous actions (offer drafting,
outbound sends) — noted, not adopted this wave: our approval rail and
signal loops already persist those steps in Postgres.

## 2. Gateway catalog (verified 2026-09-12 on vercel.com/ai-gateway/models)

| Slug | In / Out per 1M | Cache read | Ctx | TTFT (gateway-measured) | Notes |
|---|---|---|---|---|---|
| `openai/gpt-5-mini` | $0.25 / $2.00 | ~$0.025 | 400K | ~0.3 s | cheapest per token; strong short tool calls |
| `google/gemini-2.5-flash-lite` | $0.10 / $0.40 | $0.01 | 1M | 0.2 s | fastest/cheapest; loosest policy adherence |
| `google/gemini-2.5-flash` | $0.30 / $2.50 | $0.03 | 1M | 0.4 s | latency champion with thinking toggle; vision |
| `anthropic/claude-haiku-4.5` | $1.00 / $5.00 | $0.10 (write $1.25) | 200K | 0.4–0.6 s | best tool-call accuracy, structured output 99.1% schema-conformant, strongest policy adherence |
| `anthropic/claude-sonnet-4.6` | $3.00 / $15.00 | $0.30 (write $3.75) | 1M | 0.7–1.0 s | long-form, compliance-checked content |
| `perplexity/sonar`, `perplexity/sonar-pro` | (unchanged) | — | — | — | live-web research lanes only |

**What the repo was running (stale, §6 defect):** `lib/ai/models.ts`
MODEL_CONFIG pointed at `claude-sonnet-4-20250514`, `claude-haiku-4-20250514`
(no such model) and `gemini-2.0-flash-exp`; `lib/ai/resolve-model.ts` kept a
SECOND alias table (`claude-haiku` → `claude-haiku-3-5`); and
`lib/ai/cost-tracking.ts` priced Haiku at $0.25/$1.25 (Haiku 3.5) — every
Haiku turn booked into `ai_tool_usage` was under-billed ~4×. Wave 59 lane A
merges the two alias tables onto one catalog with verified slugs and prices.

## 3. Per-surface breakdown

Consistency ruling: **one brand-voice prompt cascade** (`loadBrandVoicePrompt`),
one persona/identity per agent (the same name, photo, cloned voice and
avatar twin the videos use), one knowledge base. The *model* may differ per
latency/cost lane; the *personality* never does.

| Surface | Route(s) | Who talks | Shape | Primary → fallback | Est. cost / 1k turns* |
|---|---|---|---|---|---|
| **Website visitor Q&A** (public site, embed widget) | `app/api/widget/message`, `app/embed/[publicId]`, `SiteChatLauncher` | anonymous visitor | short turns, lead capture, FAQ, "call me back", tour request | `openai/gpt-5-mini` → `google/gemini-2.5-flash` | ~$1.10 |
| **Portal contact assistant** | `app/api/portal/ai-chat` | known contact (buyer/seller/owner) | relationship-critical, tools (home value, documents, showings, offer intent) | `anthropic/claude-haiku-4.5` (system prompt cached) → `openai/gpt-5-mini` | ~$2.60 cached / ~$4.80 uncached |
| **In-app agent copilot** | `app/api/chat/stream`, `app/api/internal/ai-chat` | licensed agent / staff | multi-step staging tools, role-scoped, high volume | `anthropic/claude-haiku-4.5` → `openai/gpt-5-mini`; long-form drafts escalate to `anthropic/claude-sonnet-4.6` (existing AI_TASK_ROUTING content lanes) | ~$3.50 |
| **Live avatar brain** (D-ID Express v4 on site/widget/portal) | `app/api/did/custom-llm` | visitor or contact, spoken | latency-critical, 1–2 sentence replies | `google/gemini-2.5-flash` → `openai/gpt-5-mini` | ~$0.90 |
| **Onboarding setup assistant** | `app/api/onboarding/assistant` | new agent | KB-grounded Q&A, quality over latency | `anthropic/claude-sonnet-4.6` → `anthropic/claude-haiku-4.5` | ~$12 |
| **Phone receptionist / ISA** | `lib/voice/reception-brain.ts` via ConversationRelay | caller | spoken, TCPA-gated | unchanged (wave 58): Haiku-class brain, ElevenLabs voice | see voice doc |

\*Assumes ~1.2k input (brand prompt + history) and ~150 output tokens per
turn; cached rows assume Anthropic prompt caching on the system prompt.

Why not Flash-Lite everywhere: it is 4–10× cheaper but scored worst on
policy adherence and enum/schema conformance in every 2026 comparison —
on a fair-housing-sensitive, lead-routing surface that is the one axis we
cannot trade. Why not Haiku everywhere: 2.3× the cost of GPT-5 mini for
anonymous FAQ turns that never touch a tool. Routing by surface, as above,
is the 40–60% blended saving the comparisons measure.

## 4. Billing invariants (platform pays, tenant is metered)

1. Every routed call books `ai_tool_usage` keyed on the TENANT (null user is
   fine for anonymous visitor/avatar turns) — `streamTextRouted.onFinish`.
2. The price table in `cost-tracking.ts` carries a `lastUpdated` and a source
   URL per row; a proof asserts every catalog slug has a price row.
3. Gateway-side: set a spend budget per environment key; per-request
   `only`/`order` provider filters cost nothing; team-wide allowlists cost
   $0.10/1k requests (not needed).
4. Prompt caching on Anthropic lanes (`providerOptions.anthropic.cacheControl`
   on the system message) — the single largest lever at volume.

## 5. Other providers considered

- **HeyGen / Synthesia / Tavus** — no (owner ruling, `docs/avatar-provider-recommendation-2026-09.md`).
- **Twilio Agent Connect, ElevenLabs Conversational AI 2.0** — no (voice doc §6).
- **OpenAI Realtime / Gemini Live for the avatar** — not through the gateway
  as text; D-ID Express v4 already handles the real-time face+voice leg and
  our custom-llm brain keeps consistency. Revisit only if D-ID's LiveKit
  latency proves inadequate in production.
- **Cost-aware router (Vercel guide, 2026-06-17)** — adopted as the
  per-surface `AI_TASK_ROUTING` keys above rather than a per-request
  classifier; the surfaces already classify the difficulty.

## 6. Blind spots

Gateway catalog fetched via web pages (the session's egress policy blocks
`ai-gateway.vercel.sh` directly); prices are list, not committed-tier; per-turn
cost estimates are modelled, not measured — the ledger proof measures them
once production traffic lands.
