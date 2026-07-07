// lib/providers/tenancy-matrix.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PROVIDER TENANCY MATRIX — who owns each vendor relationship, decided ONCE
// so it's never re-litigated per feature. Five models:
//
//   platform_metered    — ONE platform account; per-tenant usage metered +
//                         budget-gated (vendor-governance). Tenant sees a meter,
//                         never a signup.
//   platform_subaccount — platform master + an isolated child account per
//                         tenant (Twilio subaccounts): their numbers/usage under
//                         one parent; compliance registration done by the platform.
//   user_oauth          — the USER's own connected account (their Gmail sends
//                         their email); the platform never proxies their identity.
//   tenant_optional_key — platform fallback works; a tenant MAY add their own
//                         key when the license/limits make it theirs (stock
//                         photos: per-user license; Tavily: search quota).
//   byo_top_tier        — bring-your-own credentials, multi_location tier only
//                         (enterprises with existing vendor contracts).
//
// Everything runs on Vercel serverless — no tenant-hosted infrastructure; all
// egress via the connector gateway; every key in env or platform_credentials.

export type TenancyModel =
  | "platform_metered" | "platform_subaccount" | "user_oauth"
  | "tenant_optional_key" | "byo_top_tier"

export interface ProviderTenancy {
  provider: string
  models: TenancyModel[]
  /** The one-line WHY — the decision's rationale, stated so it survives us. */
  why: string
  envVars: string[]
}

export const PROVIDER_TENANCY: ProviderTenancy[] = [
  {
    provider: "twilio",
    models: ["platform_subaccount", "byo_top_tier"],
    why: "Numbers + SMS are the product ('AI answers your phone'), and A2P 10DLC registration is a platform job — subaccounts isolate each tenant's numbers/usage under one parent. BYO only for enterprises with carrier contracts.",
    envVars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
  },
  {
    provider: "vapi",
    models: ["platform_metered"],
    why: "The AI voice brain — one platform account; assistants + numbers are created per tenant via API; minutes metered per brokerage with budget auto-pause.",
    envVars: ["VAPI_API_KEY", "VAPI_WEBHOOK_SECRET", "VAPI_PHONE_NUMBER_ID", "VAPI_ISA_ASSISTANT_ID"],
  },
  {
    provider: "elevenlabs",
    models: ["platform_metered"],
    why: "Voices are platform-owned (one key, per-character metering + budget gate); voice CLONES are per-agent assets riding the platform key — an agent's clone is their identity, the account is ours.",
    envVars: ["ELEVENLABS_API_KEY", "AGENT_ASSISTANT_TOOL_SECRET"],
  },
  {
    provider: "did",
    models: ["platform_metered"],
    why: "Avatar video generation — platform key, per-render metering; agent avatars are per-agent assets on the platform account (same shape as voice clones).",
    envVars: ["DID_API_KEY"],
  },
  {
    provider: "sendgrid",
    models: ["platform_metered", "user_oauth"],
    why: "Agent→contact email prefers the AGENT's own Gmail/Outlook OAuth (their identity, their sent folder, natural replies); SendGrid is the platform transactional fallback only.",
    envVars: ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL"],
  },
  {
    provider: "stripe",
    models: ["platform_metered"],
    why: "The platform's own money rail (subscriptions, setup fees, Stripe Tax flag); vendors use Connect for payouts. Never tenant-owned.",
    envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  },
  {
    provider: "pexels",
    models: ["tenant_optional_key", "platform_metered"],
    why: "Stock licenses cover each USER's own use (never platform redistribution) — a tenant's own free key makes downloads theirs; the platform key is only a fallback for search.",
    envVars: ["PEXELS_API_KEY"],
  },
  {
    provider: "tavily",
    models: ["platform_metered"],
    why: "Competitor/topic harvesting for the platform's own marketing — platform key, honest not-configured when absent.",
    envVars: ["TAVILY_API_KEY"],
  },
  {
    provider: "ai_gateway",
    models: ["platform_metered"],
    why: "All LLM/image inference rides the platform AI gateway with per-tenant cost tracking + the god-switch; tenants never hold model keys.",
    envVars: ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  },
]

/** PURE: look up a provider's tenancy decision. */
export function providerTenancy(provider: string): ProviderTenancy | null {
  return PROVIDER_TENANCY.find((p) => p.provider === provider) ?? null
}
