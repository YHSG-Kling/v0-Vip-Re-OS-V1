# Phone System — Production Setup Runbook (Platform-Owned)

The commercial model (enforced in `lib/voice/twilio-tenancy.ts`): **the platform
owns Twilio + Vapi and resells metered**. Tenants never create accounts —
"AI answers your phone" is the product, not an integration checklist. This is
the one-time setup the PLATFORM OWNER does; everything per-tenant after that is
automatic.

## 1. One-time platform setup (~30 minutes)

### Twilio (numbers + SMS carrier)
1. Create the **platform master account** at twilio.com (or use the existing one).
2. Complete **A2P 10DLC brand registration** for the platform entity (Console →
   Messaging → Regulatory Compliance). This is the carrier-compliance step
   tenants never have to see.
3. Env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
   (the platform's own fallback number).

### Vapi (the AI voice brain)
1. Create the platform account at vapi.ai → copy the API key →
   `VAPI_API_KEY`.
2. Set a webhook secret of your choosing → `VAPI_WEBHOOK_SECRET` (the code
   sends it with every number registration; Vapi echoes it back on events).
3. Buy or import ONE platform fallback number in the Vapi dashboard → its id →
   `VAPI_PHONE_NUMBER_ID` (used when an agent has no bound number yet).
4. Create the outbound ISA assistant in the dashboard (or reuse an existing
   one) → its id → `VAPI_ISA_ASSISTANT_ID`. Outbound calls override its
   prompt/voice per call, so the dashboard config is just the shell.
5. `NEXT_PUBLIC_APP_URL` must be the real production origin — number
   registration writes `<APP_URL>/api/voice/vapi-webhook?brokerage_id=<id>`
   as each number's server URL.

### ElevenLabs (voices — PLATFORM-OWNED)
- `ELEVENLABS_API_KEY` — one platform account. Agent voice **clones** are
  per-agent assets created on the platform key (usage metered per character,
  vendor budget auto-pause per brokerage). Without the key, everything still
  works with Vapi's built-in voices.

### SMS (same commercial model as voice)
- SMS resolution order per send: the agent's own connected provider (their
  credentials) → **platform-managed: the agent's own provisioned number via
  the tenant's Twilio subaccount** → shared env number (legacy fallback).
  Zero tenant setup; texts come from the number the contact recognizes.
- **A2P 10DLC note:** messaging from subaccount numbers requires campaign
  registration per subaccount (Twilio ISV flow). Do the platform's primary
  brand registration once; register each tenant subaccount's campaign as
  volume grows — until then their SMS rides the registered platform number.

The full who-owns-which-vendor decision table lives in
`lib/providers/tenancy-matrix.ts` (platform_metered / platform_subaccount /
user_oauth / tenant_optional_key / byo_top_tier — with the WHY per provider).

## 2. What happens automatically per tenant (no dashboard visits)

1. **First number provision** (broker clicks "provision number", or
   auto-provision on onboarding): a **Twilio subaccount** is created for the
   brokerage (`ensureTenantSubaccount`) and the number is purchased *inside
   it* — tenant-isolated numbers and usage under one parent.
2. **"AI answers calls" toggled ON** (AI Identity settings): the tenant's
   inbound **assistant is created from their identity profile** (name, welcome
   message, tone, cloned voice, forwarding number) with the legal preamble
   (AI disclosure + recording announcement) and the four in-call tools
   (book appointment / transfer to agent / text properties / in-house showing
   request, each capability-gated per brokerage) — then their numbers are
   **imported into Vapi** bound to that assistant + our webhook.
3. **Outbound AI calls** dial from the agent's own bound number (platform
   fallback otherwise), always through the TCPA chokepoint (DNC, consent,
   quiet hours, RND) + vendor budget gate.
4. **Metering**: every call lands in `voice_calls`/`vapi_voice_calls` with
   cost; the tenant sees their meter on Phone Settings; budget ceilings
   auto-pause voice.

## 3. The legal posture (uniform, national)

- **AI disclosure on every AI call**, inbound and outbound (FCC 2024 AI-voice
  ruling under TCPA; CA B.O.T. Act / Utah AI Policy Act / Colorado AI Act).
  Structural, not prompt-hoped: `withAiCallDisclosures` prepends it whenever
  the first message doesn't already identify the AI, and the system prompt
  orders honest confirmation if the caller asks.
- **Recording announcement on every recorded call** (13 all-party-consent
  states; one national posture instead of state guessing).
- **Outbound calls to consumers**: prior-express-consent enforced at the dial
  chokepoint (fails closed), quiet hours 8am–9pm recipient-local, RND
  staleness checks, every decision logged to the compliance ledger.
- **BYO Twilio** (multi-location tier): the tenant assumes carrier
  registration for their own account; the same runtime gates still apply.

## 4. Migration note (webhook consolidation)

`/api/voice/vapi-webhook` is the authoritative endpoint (header
`x-vapi-secret`). `/api/webhooks/vapi` (HMAC `x-vapi-signature`) remains a
thin compatible shim — if any assistant/number in the Vapi dashboard still
points at it, migrate the server URL to the authoritative endpoint and match
the credential scheme, then the shim can be removed.

## ConversationRelay (streaming voice — the newest Twilio conversational transport)

The default inbound lane is turn-based (`<Gather>` → plan → TwiML) and runs 100%
on Vercel. To upgrade to real-time streaming (sub-second turns, barge-in):

1. Deploy `tools/relay-companion/server.mjs` anywhere that can hold a WebSocket
   (Fly/Railway/Render/VPS). Env: `APP_URL`, `RELAY_SHARED_SECRET`, `PORT`.
2. Set on Vercel: `CONVERSATION_RELAY_WSS_URL=wss://<companion-host>/relay` and
   the same `RELAY_SHARED_SECRET`.
3. Done — inbound answers switch to `<Connect><ConversationRelay>` at every
   scope (platform + brokerage + agent). Unset the env to fall back to Gather.

The companion is brainless: every prompt is one authenticated POST to
`/api/voice/relay/plan`, where the SAME brains/gates run (TCPA, opt-out honor,
booking, prospect capture; transfers execute server-side via a live-call REST
redirect — the companion never holds Twilio credentials).

## A2P 10DLC (carrier registration — required for business SMS deliverability)

Tenant-facing: Dashboard → Admin → Phone Settings → "Carrier registration".
The broker enters the real business profile once (legal name, 9-digit EIN,
address, contact); "Run / resume registration" walks the whole ISV chain —
TrustHub customer profile → A2P trust product → brand → messaging service (in
the tenant's subaccount, inbound pointed at `/api/providers/inbound`) → number
pooling → LOW_VOLUME campaign. Brand/campaign reviews are asynchronous
(hours–days): re-running the button polls and resumes; failures surface
Twilio's reason verbatim. State persists on `platform_credentials`
(`twilio_a2p`) so every step is idempotent.

## Verifying Twilio contracts (official docs MCP)

Twilio ships an MCP server + Agent Skills for AI coding agents at
https://github.com/twilio/ai (docs endpoint: `https://mcp.twilio.com/docs`,
tools `twilio__search` / `twilio__retrieve`). When building against any Twilio
API surface (ConversationRelay, TrustHub/A2P, Messaging Services), verify the
parameter contract there before shipping — the same verified-contract
discipline used for RentCast. Note: the repo is builder tooling only; it has
no runtime voice framework, which is why this app's turn lane + brainless
relay companion is the correct serverless architecture.

### A2P contract notes (verified against Twilio docs, July 2026)

- Secondary customer profile policy: `RNdfbf3fae0e1107f8aded0e7cead80bf5`
  (the `RN806dd…` SID is the STARTER/sole-prop policy — wrong for EIN brands).
- `MessageSamples` is an array (2–5 samples, 20–1024 chars each).
- Since June 30, 2026 every campaign REQUIRES `PrivacyPolicyUrl` and
  `TermsAndConditionsUrl` — the tenant's business profile collects both.
- `SubscriberOptIn`/`AgeGated`/`DirectLending` are explicit; keyword opt-in
  declared → `OptInMessage` + `OptInKeywords` supplied.
- PRE-PRODUCTION VERIFICATION: run the chain with Twilio's Mock-brand API —
  `runA2pRegistration(svc, brokerageId, { mock: true })` sets `Mock=true` on
  the BrandRegistration so the whole ISV sequence exercises end-to-end with
  no real TCR filing or fees. Do this once per environment before go-live.

## Conversational Intelligence (native transcription + language operators)

Optional, env-gated: create an Intelligence Service in the Twilio console,
set `TWILIO_INTELLIGENCE_SERVICE_SID=GA…` on Vercel, and register the
service's webhook as
`https://<app>/api/voice/twilio/intelligence?token=<RELAY_SHARED_SECRET>`.
Relay-lane calls then get Twilio-native transcription + operators
(summarization, sentiment, custom operators); results MERGE onto the call
ledger — our own intelligence sweep's fields always win, Twilio fills gaps
(voice_calls.summary/sentiment) and operator results ride
call_analyses.intent_signals. Unset the env and nothing attaches.

## One-click pre-production A2P verification

Superadmin → Connectors → "Verify A2P pipeline (mock)": enter a tenant's
brokerage id (needs a provisioned number + saved business profile) and the
whole ISV chain runs against the live account with a MOCK brand — no TCR
filing, no fees, honest per-step errors. Audited to superadmin_audit_log.

## Stripe AI tooling (github.com/stripe/ai)

Stripe's official AI stack: a remote MCP server at `https://mcp.stripe.com`
(OAuth — authorize it in claude.ai connector settings for agent tooling) and
`@stripe/token-meter`, which bills AI token/minute usage straight into Stripe
meters. That library is the designated path when we turn the per-tenant AI
metering (ai_tool_usage / voice rollups) into USAGE-BASED line items on top
of subscription tiers — adopt post-launch, not days before it.

## Stripe live setup (done via the Stripe MCP, July 2026)

PRICING IS NOT FINAL (owner decision) — the four placeholder prices created
during setup verification were ARCHIVED and subscription_tiers.stripe_price_id
reset to NULL. Pricing day is ONE CLICK: edit each tier's price in
Superadmin → Plans, then press its "Publish" button
(publishTierToStripeAction) — it creates the live Stripe product+price from
the DB value, archives any previously linked one (existing subscriptions
keep billing), and links the new id. No code change, no MCP needed.
REMAINING OWNER STEP: register the webhook endpoint
`https://<app>/api/webhooks/stripe` in the Stripe dashboard (subscription +
checkout events) and set STRIPE_WEBHOOK_SECRET — the readiness board now
flags Stripe as broken until it's set (paid signups never activate without it).
