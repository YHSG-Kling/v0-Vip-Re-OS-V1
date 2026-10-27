// lib/providers/channel-provider-matrix.ts
//
// THE ONE CHANNEL → PROVIDER MATRIX (wave 145, lane 145D — cross-lane contract C1; owner ruling 13, 2026-10-27:
// the two retired third-party voice-AI vendors are no longer used, "the channel provider rules are incorrect again" …
// "stop hallucinating"). This file never names a retired vendor, not even in a comment (test:channel-provider-matrix §I).
//
// WHAT THIS IS. A pure, import-free DATA module that says, for each of the nine follow-up channels the arbiter decides
// between, WHICH provider actually carries the send at HEAD — read from the code that sends, never from a belief about
// it. Every row below names the function that sends, the credential NAME it reads (never a value), who owns the
// account, what books the cost, which gate authorises the send, where the provider calls back, what retries, and what
// evidence the send leaves. scripts/channel-provider-matrix-guard.ts re-proves each claim against stripped source on
// every run (a row that drifts from the code goes red), with a positive control per claim.
//
// WHAT IT CORRECTS (the arbiter's inline rules at b364eb4b, lib/ai-isa/followup-arbiter.ts CHANNEL_PROVIDER_RULES):
//   · email  {categories:["email"]} admitted EVERY readiness row in the email shelf — mailgun, resend, postmark (inbound
//            parse only: lib/inbound-mail/providers.ts verifies + parses their webhooks, nothing sends through them) and
//            gmail / outlook (the agent-identity tier, which the arbiter's door never asks for). The arbiter's sends go
//            dispatchEmail → messaging sendEmail → SendGrid on the PLATFORM key. So email = sendgrid.
//   · sms    {categories:["voice_sms"]} admitted plivo / sinch (vocabulary only — no adapter exists). SMS adapters that
//            exist: twilio, telnyx, bandwidth (lib/providers/messaging/sms-adapters.ts SMS_ADAPTERS).
//   · phone  {categories:["voice_sms"]} admitted telnyx / bandwidth / plivo / sinch. A call is placed ONLY on Twilio
//            (lib/voice/twilio-outbound.ts placeOutboundAiCall — the one dial door). So phone = twilio.
//   · voice_drop {providers:["voicedrop","slybroadcast"]} — right vendor, but the readiness row could never light: its key
//            (VOICEDROP_API_KEY) was in no registry source, so the row read platform_dark forever. Fixed at the source
//            (lib/agentic-os/connector-probe.ts PLATFORM_PROVIDER_KEYS.voicedrop). "slybroadcast" is not a row name.
//   · social {categories:["social"]} admitted buffer (owner-DROPPED, vocabulary only) and podcast_syndicator (not a post),
//            and MISSED meta (shelved as "leadgen"), the main publisher. lib/social/publisher.ts is the truth.
//   · ads    {providers:["meta","google_ads","facebook_ads"]} — "facebook_ads" is no row; google_ads / vibe / openai_ads had
//            NO readiness row at all (none of the registry's sources named them), so only Meta could ever read ready.
//            Now each ad platform is a USER-CONNECTED vendor (lib/agentic-os/vendor-ownership.ts) and reads its row.
//
// HOW TO READ A RULE (the contract shape): any listed readiness row (getBrokerageProviderReadiness) that is `ready`
// makes the channel's PROVIDER pre-check pass. An EMPTY rule (in_app, human_task) means "no external provider carries
// this channel" — it is NOT provider-gated and must never be read as not_ready. The dispatcher's own gates stay
// authoritative at the send; this is the pre-check's vocabulary only.
//
// Retired vendors appear nowhere here (scripts/vendor-retirement-guard.ts keeps them out of every runtime file).
// Video is a FORMAT, never a channel (owner ruling 13; ARBITER_FORMATS in the arbiter).
//
// No imports on purpose: the arbiter is not server-only and reads this module on every evaluation.

/** The nine arbiter channel names (the campaign taxonomy's keys + a task for a person). Local to this module by
 *  contract C1; lib/ai-isa/followup-arbiter.ts ARBITER_CHANNELS is the same list and the guard proves they agree. */
export type ArbiterChannelName =
  | "email" | "sms" | "phone" | "voice_drop" | "in_app" | "direct_mail" | "social" | "ads" | "human_task"

/** A channel's provider rule — readiness CATEGORIES and/or canonical readiness ROW names (any-of). Empty = not provider-gated. */
export interface ChannelProviderRule {
  categories?: readonly string[]
  providers?: readonly string[]
}

/** How much of a channel is real at HEAD. */
export type ChannelVerdict =
  | "BUILT"               // a send function, a credential, a gate, evidence — end to end in code
  | "BUILT_NO_PROVIDER"   // real, and carried by our own surface or a person (nothing external to configure)
  | "BROADCAST_ONLY"      // real, but an audience / broadcast decision — never a 1:1 follow-up rail

/** One audited row: capability → provider → credential → configured? → ownership → cost → authority → send → callback → retry → evidence → verdict. */
export interface ChannelProviderTruth {
  // (keyed by channel in CHANNEL_PROVIDER_TRUTH — the row carries no second copy of its own key)
  /** What the channel does, in the platform's words. */
  capability: string
  /** Canonical readiness row(s) that carry the send — the source of CHANNEL_PROVIDER_MATRIX. */
  providers: readonly string[]
  /** Providers that take part but do NOT deliver (audio, inbound parse, an alternate door) — never a readiness rule. */
  supporting: readonly string[]
  /** Credential NAMES only (env vars / credential-store keys). Never a value. */
  credentials: readonly string[]
  /** How "configured?" is answered at runtime — the reader, never a guess. */
  configuredBy: string
  ownership: string
  cost: string
  authority: string
  send: string
  callback: string
  retry: string
  evidence: string
  verdict: ChannelVerdict
  /** What is NOT true about this channel, said out loud (the "stop hallucinating" column). */
  notes: readonly string[]
}

export const CHANNEL_PROVIDER_TRUTH: Readonly<Record<ArbiterChannelName, ChannelProviderTruth>> = Object.freeze({
  email: {
    capability: "1:1 email to a contact (and transactional notices)",
    providers: ["sendgrid"],
    supporting: ["gmail", "outlook", "mailgun", "postmark", "resend"],
    credentials: ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL", "agent_api_credentials gmail / outlook (agent OAuth, identity tier only)"],
    configuredBy: "platformEnvConfigured('sendgrid') in getBrokerageProviderReadiness (lib/platform/provider-posture.ts); the sender reads process.env.SENDGRID_API_KEY",
    ownership: "PLATFORM (one SendGrid account on the platform key); the agent's OWN mailbox only on doors that pass sendAsAgentUserId (client welcome, welcome avatar video, client video delivery, outside-offer loop) — never the arbiter's door",
    cost: "VENDOR_PRICING.sendgrid / EMAIL_SEND_COST_USD booked by logVendorUsage (vendor_usage_tracking) only on a provider-accepted send; vendorBudgetPreflight before the call",
    authority: "dispatchEmail gates (autonomy, consent / CAN-SPAM, suppression, de-confliction, content-safety backstop, vendor-budget pre-flight) + the email-verification gate in sendEmail",
    send: "lib/providers/dispatch.ts dispatchEmail → lib/providers/messaging/index.ts sendEmail (Tier 1 lib/providers/email/personal-email-adapter.ts sendPersonalEmail when sendAsAgentUserId; Tier 2 SendGrid POST /v3/mail/send via callConnector)",
    callback: "/api/webhooks/sendgrid-events (delivery / open / bounce, correlated by sg_message_id); replies arrive at /api/webhooks/inbound-mail and /api/providers/inbound",
    retry: "single-shot POST (a replay would send the message twice); a refused or failed send is ledgered, never silently resent",
    evidence: "withActionLedger('comms.email.send') row + message_provider_logs (recordProviderLog) + vendor_usage_tracking",
    verdict: "BUILT",
    notes: [
      "MAILGUN DOES NOT SEND: it appears only as an INBOUND provider (signature verify + parse in lib/inbound-mail/providers.ts and lib/providers/inbound-router.ts; adapter lifecycle 'inbound_only'). The same is true of postmark and resend.",
      "A tenant-stored sendgrid / mailgun / resend / postmark credential is read by NO sender — the outbound key is the platform env key only.",
      "A provider_overrides 'email' selection changes only the label dispatchEmail reports and books; the bytes still leave through SendGrid (or the agent's mailbox).",
    ],
  },
  sms: {
    capability: "1:1 text message to a consented contact",
    providers: ["twilio", "telnyx", "bandwidth"],
    supporting: [],
    credentials: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "tenant BYO: provider_overrides(sms) + platform_credentials twilio / telnyx / bandwidth"],
    configuredBy: "getBrokerageProviderReadiness rows twilio (platform subaccount / env) and telnyx / bandwidth (tenant connection); the sender resolves resolveSMSProviderForActor",
    ownership: "PLATFORM by default (Twilio master + per-tenant subaccount numbers); tenant BYO Twilio / Telnyx / Bandwidth on the multi-location tier",
    cost: "VENDOR_PRICING.twilio_sms booked by logVendorUsage on accept; vendorBudgetPreflight before the call",
    authority: "TCPA chokepoint enforceTCPACompliance (consent, DNC fresh scrub, quiet hours, opt-out; a LEAD is refused) + dispatchSms gates",
    send: "lib/providers/dispatch.ts dispatchSms → lib/providers/messaging/index.ts sendSMS → SMS_ADAPTERS (lib/providers/messaging/sms-adapters.ts: twilio / telnyx / bandwidth via callConnector)",
    callback: "/api/webhooks/twilio-sms-status (delivery status); inbound replies /api/providers/inbound; STOP keywords /api/sms/inbound-optout",
    retry: "single-shot POST; a failed send is ledgered",
    evidence: "withActionLedger('comms.sms.send') + outbound_message_compliance_log (the TCPA decision) + message_provider_logs",
    verdict: "BUILT",
    notes: ["plivo and sinch are vocabulary only (no adapter) — never an SMS provider."],
  },
  phone: {
    capability: "a live AI voice call (the Twilio-native turn engine) to a consented contact",
    providers: ["twilio"],
    supporting: ["elevenlabs"],
    credentials: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "tenant Twilio creds (BYO → subaccount → master, lib/voice/twilio-tenancy.ts)"],
    configuredBy: "getBrokerageProviderReadiness row twilio",
    ownership: "PLATFORM (Twilio subaccount per tenant); BYO Twilio on the multi-location tier",
    cost: "pre-flight estimatePlatformVendorCost('twilio_voice') in lib/voice/outbound-call-gates.ts; billed minutes booked by /api/voice/twilio/status (usage_logs)",
    authority: "lib/voice/outbound-call-gates.ts (autonomy → suppression → TCPA chokepoint → DNC / quiet hours → budget)",
    send: "lib/voice/twilio-outbound.ts placeOutboundAiCall (Twilio Calls API, machineDetection on) — the ONE dial door",
    callback: "/api/voice/twilio/outbound (answer + AMD), /api/voice/twilio/turn, /api/voice/twilio/status, /api/voice/twilio/recording",
    retry: "single-shot dial; a no-answer is an outcome, the next touch is the arbiter's decision",
    evidence: "voice_calls row + outbound_message_compliance_log",
    verdict: "BUILT",
    notes: [
      "Retired AI-call vendors carry no call: the only dial door is Twilio-native (test:vendor-retirement keeps their names out of runtime code).",
      "A machine-answered call may <Play> an ElevenLabs-rendered voicemail (renderVoiceDrop, wave 58) — that is the AMD leg of a CALL (the phone rang), not a ringless voice drop.",
    ],
  },
  voice_drop: {
    capability: "a ringless voicemail drop (the phone does not ring) to a consented contact",
    providers: ["voicedrop"],
    supporting: ["elevenlabs"],
    credentials: ["VOICEDROP_API_KEY", "VOICEDROP_PROVIDER (default slybroadcast)", "VOICEDROP_FROM_PHONE", "ELEVENLABS_API_KEY (only when the preset is a TTS script, not pre-uploaded audio)"],
    configuredBy: "getBrokerageProviderReadiness row voicedrop (env VOICEDROP_API_KEY via PLATFORM_PROVIDER_KEYS.voicedrop); audio needs the preset's audio_url or ELEVENLABS_API_KEY + the agent's cloned voice",
    ownership: "PLATFORM (one ringless-voicemail account on the platform key; the agent's cloned voice is a per-agent asset on the platform ElevenLabs account)",
    cost: "meterVendorSpend vendor 'voicedrop', one unit per delivered drop, priceState 'unknown' (no primary-source API price) + ElevenLabs characters for a synthesized script",
    authority: "orchestrateVoicedropSend ensureCompliance: lead-stage refusal (a LEAD never gets a drop) → evaluateOutbound(messageType phone) → enforceTCPACompliance fresh scrub — a ringless drop is regulated as a call",
    send: "lib/voicedrop/orchestrate-voicedrop-send.ts orchestrateVoicedropSend → audio (preset audio_url, else lib/voice/render-voice-drop.ts renderVoiceDrop on ElevenLabs) → callConnector('voicedrop', mobile-sphere gateway)",
    callback: "none — the provider returns a job id only; the booking keys on it (idempotency) and lib/outcomes/reconciliation.ts reads it",
    retry: "single-shot; a failed drop returns its reason and the caller falls back (engage-contact: email)",
    evidence: "vendor_usage_tracking booking (idempotency voicedrop:<provider>:<job_id>) + an activities row + kernel event AI_ISA_CONTACT_VOICEDROP_SENT (engage-contact) — NOT an agent_action_ledger row (LAW 5 gap, see lane notes)",
    verdict: "BUILT",
    notes: [
      "ElevenLabs is the AUDIO (text-to-speech in the agent's cloned voice), never the delivery: a TTS API cannot leave a voicemail.",
      "Twilio does not ship ringless voicemail; the Twilio voicemail path is the AMD leg of a phone CALL (channel phone).",
    ],
  },
  in_app: {
    capability: "a message on the client's own portal (optionally a browser push)",
    providers: [],
    supporting: ["web_push"],
    credentials: ["VAPID_PRIVATE_KEY (browser push only — optional)"],
    configuredBy: "the contact's portal login (contacts.has_login) — the arbiter's consent check; push needs the web_push row",
    ownership: "PLATFORM (our portal + our Supabase); browser push services are free",
    cost: "none",
    authority: "portal access (an invited, logged-in contact only)",
    send: "the portal message writers (agent_client_messages) + lib/providers/web-push.ts for the optional push",
    callback: "the portal read state",
    retry: "n/a (stored, not transmitted)",
    evidence: "the stored message row",
    verdict: "BUILT_NO_PROVIDER",
    notes: ["Not provider-gated: an empty rule must never read as not_ready."],
  },
  direct_mail: {
    capability: "a printed and mailed letter / postcard / card",
    providers: ["lob"],
    supporting: [],
    credentials: ["LOB_API_KEY"],
    configuredBy: "getBrokerageProviderReadiness row lob (PLATFORM_PROVIDER_KEYS.lob)",
    ownership: "PLATFORM (one Lob account; budget-gated per tenant)",
    cost: "DIRECT_MAIL_PIECE_COST_USD booked on accept; vendorBudgetPreflight before the call",
    authority: "dispatchDirectMail gates (mail opt-out, suppression, the send-time CASS gate lib/providers/mailing-cass-gate.ts, budget)",
    send: "lib/providers/dispatch.ts dispatchDirectMail → Lob (lib/providers/lob/client.ts)",
    callback: "/api/webhooks/lob-events",
    retry: "single-shot (a replay prints and posts twice)",
    evidence: "withActionLedger('comms.direct_mail.send') + vendor_usage_tracking",
    verdict: "BUILT",
    notes: ["A mailed piece needs a brokerage-chosen Lob template (dispatchDirectMail requires templateId)."],
  },
  social: {
    capability: "a post on the tenant's own connected social accounts",
    providers: ["meta", "linkedin", "twitter", "tiktok", "youtube", "pinterest"],
    supporting: [],
    credentials: ["platform_credentials facebook / instagram / linkedin / … (tenant OAuth)"],
    configuredBy: "getBrokerageProviderReadiness rows meta (facebook + instagram fold here), linkedin, twitter, tiktok, youtube, pinterest — tenant connections",
    ownership: "TENANT (their own accounts, their own OAuth)",
    cost: "none to the platform (the tenant's own accounts)",
    authority: "approval-gated publish only (app/api/cron/publish-social-posts publishes social_posts with approval_status='approved'; platform-social publishes approved drafts) — test:egress-send-guard",
    send: "lib/social/publisher.ts publishToSocialPlatform (native per-platform OAuth publishers)",
    callback: "/api/webhooks/linkedin, /api/webhooks/twitter, /api/webhooks/meta-dm",
    retry: "single-shot publish",
    evidence: "the social_posts row (status + external id)",
    verdict: "BROADCAST_ONLY",
    notes: [
      "buffer is NOT a publisher (owner dropped it; adapter lifecycle vocabulary_only) — yet lib/kernel/providers.ts SYSTEM_DEFAULTS.social still names it (Outside-lane).",
      "A post is a broadcast: the arbiter considers and refuses social for a 1:1 follow-up.",
    ],
  },
  ads: {
    capability: "a paid ad campaign on the tenant's own ad account (Meta, Google Ads, streaming TV via Vibe, ChatGPT ads via OpenAI Ads)",
    providers: ["meta", "google_ads", "vibe", "openai_ads"],
    supporting: [],
    credentials: ["platform_credentials facebook (Meta ads OAuth)", "platform_credentials google_ads (Google Ads OAuth) + GOOGLE_ADS_DEVELOPER_TOKEN", "Connection OS 'vibe' (client credentials)", "Connection OS 'openai_ads' (Ads API key)"],
    configuredBy: "getBrokerageProviderReadiness rows meta / google_ads / vibe / openai_ads (tenant connections); the launch precheck is lib/ads/connection-status.ts isAdPlatformConnected",
    ownership: "TENANT (their ad accounts; ad spend is the tenant's)",
    cost: "the tenant's own ad spend (ledger 'tenant_account'); an Ads Manager action is clamped by MAX_AD_DAILY_BUDGET_USD (lib/ads/ad-manager.ts)",
    authority: "human approval: Ads Manager proposals (ad_manager_actions), the creative approval queue (ad_creative_variations.approval_status), the fair-housing audience gates (lib/kernel/ads.ts), the TV broadcast gate (classifyPublicVideo + a READY TV master) and, for a topic spot, the APPROVED topic (lib/ads/ctv-campaign.ts)",
    send: "lib/ads/connectors/registry.ts getConnector → meta.ts / google.ts / vibe-ctv.ts / chatgpt.ts; TV: lib/ads/ctv-campaign.ts stageCtvCampaign → launchCtvCampaignOnVibe → lib/providers/vibe.ts; ChatGPT: lib/providers/openai-ads.ts dispatchChatgptCampaign",
    callback: "performance is PULLED (lib/ads/ad-performance-ingest.ts, cron ad-performance-sync); Meta lead ads push /api/webhooks/meta-leadgen",
    retry: "single-shot create (a replayed create duplicates spend; OpenAI Ads creates carry an Idempotency-Key); GET reads retry once in the gateway",
    evidence: "ad_campaigns row (status flips to live ONLY on a provider-confirmed launch) + kernel event ad_campaign_launched + ad_manager_actions",
    verdict: "BROADCAST_ONLY",
    notes: [
      "An ad audience is a separate governed Ads Manager action — the arbiter considers and refuses ads for a 1:1 follow-up.",
      "Google Ads could not be connected at b364eb4b: the OAuth callback stored platform 'google', which the live platform_credentials CHECK refuses; it is 'google_ads' end to end after m862 is applied (see AD_PLATFORMS.google_ads).",
    ],
  },
  human_task: {
    capability: "a task for a person (the agent) instead of an automated send",
    providers: [],
    supporting: [],
    credentials: [],
    configuredBy: "always available — a person, not a provider",
    ownership: "the tenant's own staff",
    cost: "none",
    authority: "the agent's own judgement",
    send: "an activities row (activity_type followup_moment_due) written by the arbiter's task path",
    callback: "the activity's completion",
    retry: "n/a — a task is stored for a person, never transmitted",
    evidence: "the activities row",
    verdict: "BUILT_NO_PROVIDER",
    notes: ["Not provider-gated: an empty rule must never read as not_ready."],
  },
})

/** DERIVED from CHANNEL_PROVIDER_TRUTH — the contract C1 shape the arbiter imports (lane 145E replaces its inline rules). */
export const CHANNEL_PROVIDER_MATRIX: Readonly<Record<ArbiterChannelName, ChannelProviderRule>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(CHANNEL_PROVIDER_TRUTH) as ArbiterChannelName[]).map((c) => {
      const providers = CHANNEL_PROVIDER_TRUTH[c].providers
      return [c, providers.length ? Object.freeze({ providers }) : Object.freeze({})]
    }),
  ) as Record<ArbiterChannelName, ChannelProviderRule>,
)

// ── AD PLATFORMS ─────────────────────────────────────────────────────────────────────────────────
//
// facebook and instagram ARE Meta (one Graph API credential, campaign platforms 'facebook' / 'instagram').
// `verified` = the capability is real in code end to end (credential storable + resolvable, a connector that launches
// through the gateway, an approval gate, a reporting read-back, a door that calls it) AND the vendor's API contract was
// read at its primary source. It does NOT mean a live launch has happened — no tenant holds an ad credential today
// (live DB, 2026-10-27: integration_credentials / platform_credentials / agent_api_credentials all 0 rows), so every
// platform's live proof is WAITING_EXTERNAL (lane notes).

export type AdPlatformKey = "meta" | "google_ads" | "vibe_tv" | "openai_ads"

export interface AdPlatformTruth {
  key: AdPlatformKey
  label: string
  verified: boolean
  /** The canonical getBrokerageProviderReadiness row this platform maps to. */
  readinessRow: string
  /** ad_campaigns.platform values it runs (the live CHECK vocabulary). */
  campaignPlatforms: readonly string[]
  /** Where the credential lives (a name, never a value). */
  credential: string
  /** The code that launches it (named "adapter", never "connector:" — test:provider-adapter reads a `connector:` literal as a gateway egress). */
  adapter: string
  /** The vendor contract, as read (primary source + date). */
  contract: string
  /** Why verified / not — the evidence, or the exact missing piece. */
  evidence: string
}

export const AD_PLATFORMS: Readonly<Record<AdPlatformKey, AdPlatformTruth>> = Object.freeze({
  meta: {
    key: "meta",
    label: "Meta (Facebook + Instagram)",
    verified: true,
    readinessRow: "meta",
    campaignPlatforms: ["facebook", "instagram"],
    credential: "platform_credentials platform 'facebook' (OAuth meta_ads; instagram ads ride the facebook credential)",
    adapter: "lib/ads/connectors/meta.ts metaConnector (Graph API via lib/providers/meta/client.ts)",
    contract: "developers.facebook.com/docs/graph-api (versioned path)",
    evidence: "credential value admitted by the live CHECK; adCredentialPlatform maps instagram → facebook; publish + Custom Audience + insights in the connector; lead ads webhook /api/webhooks/meta-leadgen",
  },
  google_ads: {
    key: "google_ads",
    label: "Google Ads",
    verified: false,
    readinessRow: "google_ads",
    campaignPlatforms: ["google"],
    credential: "platform_credentials platform 'google_ads' (OAuth google_ads) + GOOGLE_ADS_DEVELOPER_TOKEN",
    adapter: "lib/ads/connectors/google.ts googleConnector (googleAds:mutate, Customer Match offline jobs, searchStream)",
    contract: "developers.google.com/google-ads/api (GOOGLE_ADS_API_VERSION in lib/agentic-os/connector-registry.ts)",
    evidence: "NOT VERIFIED — the connector is real, but at b364eb4b no credential could be stored: the OAuth callback (app/api/integrations/oauth/[provider]/route.ts) wrote platform 'google', which the live platform_credentials_platform_check refuses (and the Connection OS folds 'google' onto gmail). Lane 145D: the callback and every reader now say 'google_ads' (adCredentialPlatform) and m862 admits it — WRITTEN, NOT APPLIED, so the live store still refuses it. Flips to verified once m862 is applied and the CHECK cache regenerated (test:channel-provider-matrix derives it and says so). lib/integrations/ad-campaign-vocabulary.ts still lists google in AD_PLATFORMS_WITHOUT_CONNECTIONS (display; Outside-lane). GOOGLE_ADS_DEVELOPER_TOKEN is WAITING_EXTERNAL.",
  },
  vibe_tv: {
    key: "vibe_tv",
    label: "Streaming TV (Vibe)",
    verified: true,
    readinessRow: "vibe",
    campaignPlatforms: ["vibe_ctv"],
    credential: "Connection OS provider 'vibe' (client credentials; platform_credentials CHECK admits 'vibe')",
    // Named by FILE, never by the dispatch symbol: test:tv-spot greps raw text for the symbol to prove only the CTV lane calls it.
    adapter: "lib/ads/ctv-campaign.ts stageCtvCampaign / launchCtvCampaignOnVibe → lib/providers/vibe.ts (the one CTV dispatch; and lib/ads/connectors/vibe-ctv.ts)",
    contract: "developers.vibe.co (REST APIs to launch, manage and measure CTV campaigns — read 2026-10-27)",
    evidence: "the ONE streaming-TV path: broadcast gate + READY TV master at stage AND launch; a topic spot needs an APPROVED topic (contract C5); flips live only on a Vibe-confirmed publish",
  },
  openai_ads: {
    key: "openai_ads",
    label: "ChatGPT ads (OpenAI Ads)",
    verified: true,
    readinessRow: "openai_ads",
    campaignPlatforms: ["chatgpt"],
    credential: "Connection OS provider 'openai_ads' (the Ads API key, scoped to one ad account; platform_credentials CHECK admits 'openai_ads')",
    adapter: "lib/providers/openai-ads.ts dispatchChatgptCampaign / fetchOpenaiCampaignInsights (via lib/ads/connectors/chatgpt.ts and lib/ads/chatgpt-campaign.ts)",
    contract: "developers.openai.com/ads/api-quickstart — GET /ad_account, POST /upload {image_url}, POST /campaigns {budget.lifetime_spend_limit_micros} (read 2026-10-27; the code speaks the same chain)",
    evidence: "real capability: credential resolver (resolveOpenaiAdsCredential), gateway egress, approved-creative gate, activate-only-on-success, insights read-back; doors: app/actions/chatgpt-ads.ts, the Ads Manager, the ads page",
  },
})

/** The ONE streaming-TV ad provider (an AD_PLATFORMS key). No second TV subsystem exists or may be added; TV creative
 *  derives from an APPROVED topic-bank topic through lib/ads/ctv-campaign.ts stageCtvCampaign({ topicId, assetId }). */
export const TV_AD_PROVIDER = "vibe_tv" as const satisfies AdPlatformKey
