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
//                         key when the account/license makes the data or the
//                         usage theirs, and theirs then WINS (IDX Broker: their
//                         own MLS board's feed; stock photos: per-user license).
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
    why: "Numbers + SMS are the product ('AI answers your phone'), and A2P 10DLC registration is a platform job — subaccounts isolate each tenant's numbers/usage under one parent. BYO only for enterprises with carrier contracts. STRATEGIC CONVERGENCE (owner decision, now DONE for voice): Twilio is the home for the whole comms brain — turn-based conversational voice AI + ConversationRelay (the separate Vapi dependency is RETIRED), Conversations for the UNIFIED INBOX including social messaging surfaces (WhatsApp/FB Messenger), Voice Intelligence for call semantics, and Verify/Lookup/SHAKEN-STIR for fraud protection.",
    envVars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
  },
  {
    provider: "vapi",
    models: ["platform_metered"],
    why: "RETIRED voice lane (owner decision — fully replaced by Twilio-native). The Vapi client, both webhook routes, the inbound-assistant/number-import wiring, and the vapi_voice_calls billing table were REMOVED; every inbound reception and outbound AI call now runs turn-based on pure Twilio (VoiceUrl → our webhook, <Gather input=speech> → the AI gateway → TwiML), no third-party voice-AI vendor, fully serverless. Retained here only as vendor-ownership history — nothing in the app calls Vapi.",
    envVars: [],
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
    why: "The scraper FLEET is FOUR platform-owned lanes: Apify actors (direct-site source families — FSBO/expired/etc.), ZenRows (anti-bot rendering for hard targets), Zyte (the BACKUP scraper lane — owner decision: kept as failover when Apify/ZenRows can't reach a target; client wiring pending), and the FREE OSINT lane (court/public-records filings — divorce/probate/foreclosure/tax-lien/eviction/bankruptcy → motivated-seller raw records, no vendor cost). Tenants buy OUTCOMES (leads in their pipeline), never scraper accounts. DROPPED by owner decision: sinch, plivo (Twilio/Telnyx/Bandwidth cover SMS), plaid, buffer (native social OAuth covers publishing). LEGAL LINE: publicly available data only, robots/ToS exposure carried at the platform level, and EVERY scraped record passes the suppression + DNC/TCPA scrub before any tenant can touch it.",
    envVars: ["APIFY_API_TOKEN", "ZENROWS_API_KEY", "ZYTE_API_KEY"],
  },
  {
    provider: "batchdata",
    models: ["platform_metered"],
    why: "The MOTIVATED-SELLER + niche-seller sourcing engine (investor buy-box, distress/equity niches, comparables, AVM chain input, geocoding, relisting detection) PLUS the compliance utilities (DNC/TCPA phone scrub, address/phone verification) — skip tracing is one feature among many. LEGAL LINE: contact data is NON-FCRA — never for credit, tenancy, or employment screening; every sourced contact stays behind the TCPA/DNC gates.",
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
    why: "PLATFORM-GATED (owner ruling): ONE platform RentCast account serves every tenant, per-tenant metered + budget-gated. A tenant does NOT bring their own RentCast key and is never offered the option — lib/connections/scope.ts is the arbiter and deliberately keeps RentCast out of the user-connectable providers. That gate IS the spend governance: a key resolved per tenant would be spend the platform cannot see, meter, or cap on a provider the product owns, so lib/property/rentcast.ts getApiKey reads the platform env key ONLY and carries brokerageId purely for metering/attribution. This is the DEFAULT for-sale property feed + AVM/valuation chain; a tenant's own IDX Broker feed (its own row below) changes which SOURCE answers a listing search, never whose RentCast credential pays for the AVM. VERIFIED LIVE: the AVM cascade (Perplexity free tier → OSINT → paid RentCast/BatchData/ZenRows-Zillow behind usePaidProviders + the vendor budget gate) runs on real connector-gateway calls with per-call metering — an earlier stale header claimed stubs; corrected after verification.",
    envVars: ["RENTCAST_API_KEY"],
  },
  {
    provider: "idxbroker",
    models: ["tenant_optional_key"],
    why: "TENANT-SETTABLE (owner ruling), and the exact MIRROR of RentCast above — stated as a pair so the two can never drift into each other again. A tenant who sets up their own IDX Broker account uses THEIRS: their MLS board's data is the whole point of connecting it. lib/idxbroker-client.ts forBrokerage resolves the full ownership cascade via resolveScopedConnection (agent → team → brokerage → platform) and only then falls back to the platform IDXBROKER_API_KEY, so the most specific connected account WINS and the platform key is the floor, never the ceiling. Offered per-tier as the only selectable `listing` provider in lib/connections/scope.ts. Deliberately NOT platform_metered: IDX Broker is a USER_CONNECTED_VENDOR (lib/agentic-os/vendor-ownership.ts) — the tenant pays their own IDX/MLS bill, so the gate is whether the account is CONNECTED, not the platform vendor budget, and no per-call cost is metered against the platform.",
    envVars: ["IDXBROKER_API_KEY"],
  },
  {
    provider: "exa",
    models: ["platform_metered"],
    why: "Exa is a full NEURAL-SEARCH rail, not just competitor watch: BUYER-INTENT discovery (people describing a home search in their own words across forums/blogs/social — what keyword scrapers miss), competitor-ad intelligence, and research features. Platform key, metered; sourced identities ride the same viability + consent gates as every lead lane.",
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
