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
    why: "Avatar CREATION + video generation for tenants — platform key, per-render metering; each agent's avatar is their per-agent asset living on the platform account (same shape as voice clones). No HeyGen.",
    envVars: ["DID_API_KEY"],
  },
  {
    provider: "remotion",
    models: ["platform_metered"],
    why: "Programmatic video renders run on OUR serverless infrastructure (no per-render vendor) — platform-owned by construction; the company license is a platform obligation once team size crosses Remotion's threshold.",
    envVars: [],
  },
  {
    provider: "scrapers",
    models: ["platform_metered"],
    why: "The scraper FLEET (Apify actors across source families — FSBO/expired/probate/etc.) is platform plumbing — tenants buy OUTCOMES (leads in their pipeline), never scraper accounts. LEGAL LINE: scrape only publicly available data, honor robots/ToS exposure at the platform level, and EVERY scraped record passes the suppression + DNC/TCPA scrub before any tenant can touch it — the platform carries the compliance, not the agent.",
    envVars: ["APIFY_API_TOKEN"],
  },
  {
    provider: "batchdata",
    models: ["platform_metered"],
    why: "Far more than skip tracing: property data + comparables, AVM chain input, geocoding, relisting detection, DNC/TCPA phone scrubbing, address/phone verification. LEGAL LINE: skip-trace/contact data is NON-FCRA — it must never be used for credit, tenancy, or employment screening; contact-data use stays behind the TCPA/DNC gates.",
    envVars: ["BATCHDATA_API_KEY"],
  },
  {
    provider: "peoplesdata",
    models: ["platform_metered"],
    why: "Contact/person enrichment for the lead pipeline (PeopleData/PDL rail) — platform key, enrichment lands via the merge/column-map so tenant records stay canonical. Same NON-FCRA legal line as all enrichment data.",
    envVars: ["PEOPLEDATA_API_KEY", "PDL_API_KEY"],
  },
  {
    provider: "rentcast",
    models: ["platform_metered"],
    why: "Property/AVM data (valuation provider chain) — platform key; data rides into tenant features (CMAs, equity triggers), the vendor relationship is ours.",
    envVars: ["RENTCAST_API_KEY"],
  },
  {
    provider: "exa",
    models: ["platform_metered"],
    why: "Web/competitive-intel search — platform key powering competitor-ad watch and research features; metered like the other intelligence vendors.",
    envVars: ["EXA_API_KEY"],
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
    why: "TWO money flows on one platform account: (1) the platform's own rail — tenant subscriptions, setup fees, Stripe Tax flag, vendor marketplace subscriptions; (2) TENANTS charging THEIR counterparties (vendors, clients) via Stripe CONNECT accounts (stripe_account_id) — the tenant's money never mixes with ours. Never tenant-owned keys.",
    envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  },
  {
    provider: "quickbooks",
    models: ["user_oauth", "platform_metered"],
    why: "DUAL USE: tenant accounting is the TENANT's book (their own OAuth, their company file, their accountant — the platform syncs but never owns the ledger); AND the platform runs its OWN QuickBooks company for platform revenue/expenses (subscriptions, vendor fees) — two connections, never mixed.",
    envVars: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"],
  },
  {
    provider: "supabase_storage",
    models: ["platform_metered"],
    why: "ALL tenant media lives on OUR Supabase buckets (videos/avatars/TTS in video-assets, listing media, agent media, documents) — never on the vendor: D-ID/ElevenLabs/Remotion outputs are copied home so a vendor account change never strands a tenant's assets. Bookends (intro/outro/B-roll/music) + THUMBNAILS are the common video package every render composes from; QR codes are the common marketing primitive (marketing_asset_qr_links) stitching physical → digital attribution.",
    envVars: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
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
