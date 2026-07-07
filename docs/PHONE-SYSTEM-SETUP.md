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

### ElevenLabs (voices; optional but recommended)
- `ELEVENLABS_API_KEY` — agent voice clones + week-in-review audio. Without
  it, everything still works with Vapi's built-in voices.

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
