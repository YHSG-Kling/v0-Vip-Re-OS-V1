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
//
// ── WAVE 146 (lane 146B, contract C7) — EVERY CHANNEL SAYS WHETHER IT LISTENS ──────────────────────────────────
// OWNER RULING 3 (2026-10-29): "All providers need to also be able to be listening and watching if there is a receiving
// end not just outputting where applicable. communication should be able to track both incoming and outgoing no matter
// which channel is used." Every row below now carries `receive` — supported / via (webhook | poll | none) / the events it
// takes / the ingress route / the ONE canonical record an inbound lands on — read from the route that receives, never
// from a belief about it. PROVIDER_RECEIVE_TRUTH (end of file) says the same per PROVIDER, beside what the vendor's own
// documentation says it CAN deliver (primary source + read date), so a documented-but-unbuilt receiver is visible as a
// gap instead of being claimed. scripts/channel-provider-matrix-guard.ts §J re-proves every route against stripped source.

/** How a channel LISTENS (contract C7). `via` is the transport the code at HEAD actually runs; "none" is a declaration. */
export interface ChannelReceiveTruth {
  supported: boolean
  via: "webhook" | "poll" | "none"
  /** The inbound events this channel takes at HEAD (replies, delivery / read / engagement callbacks, opt-outs). */
  events: readonly string[]
  /** The primary ingress route (an app/ path) when via is webhook / the cron when via is poll. */
  route?: string
  /** Further ingress routes for the same channel (status callbacks, keyword doors, a second provider's door). */
  alsoRoutes?: readonly string[]
  /** The ONE canonical history an inbound lands on (contract C1 for the provider-carried channels). */
  record: string
  /** What is NOT true or NOT built about this channel's receive side, said out loud. */
  gaps: readonly string[]
}

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
  /** WAVE 146 (contract C7): the RECEIVE side, as truthfully as the send side above. */
  receive: ChannelReceiveTruth
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
    receive: {
      supported: true,
      via: "webhook",
      events: ["reply (inbound parse: sendgrid / mailgun / postmark / resend; agent mailbox push: gmail / outlook)", "processed", "delivered", "deferred", "bounce", "dropped", "open", "click", "spamreport", "unsubscribe"],
      route: "/api/webhooks/inbound-mail",
      alsoRoutes: ["/api/providers/inbound", "/api/webhooks/sendgrid-events"],
      record: "a contact's reply → messages on the contact's ONE conversation (recordInboundCommunication, lib/communications/inbound-record.ts); a lead's reply → lead_conversation_history through the lead door (evaluateInboundLeadSignal); delivery / engagement → the outcome ledger (ingestProviderTruth) + message_provider_logs",
      gaps: [
        "Before wave 146 a KNOWN CONTACT's emailed reply landed nowhere in the history — /api/webhooks/inbound-mail filed only its attachments and /api/providers/inbound handled only a LEAD's email; both now record it (C1).",
        "An unknown sender is never filed as a contact: it runs RAW → dedup → enrich → THE lead gate (lib/lead-pipeline/unknown-sender-identification.ts).",
      ],
    },
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
    receive: {
      supported: true,
      via: "webhook",
      events: ["inbound text / WhatsApp-over-Twilio (MessageSid)", "STOP / START / HELP keywords", "delivery status (queued / sent / delivered / undelivered / failed)"],
      route: "/api/providers/inbound",
      alsoRoutes: ["/api/webhooks/twilio-sms-status", "/api/sms/inbound-optout"],
      record: "a contact's text → messages (lib/voice/sms-inbound.ts recordInboundMessage, idempotent on MessageSid — the same table and thread C1 writes); a lead's text → lead_conversation_history (m488 unique on provider_ref); status → the outcome ledger + message_provider_logs",
      gaps: [
        "Telnyx (message.received) and Bandwidth (message-received) document inbound webhooks, but lib/providers/inbound-router.ts normalizes and verifies Twilio only — a BYO Telnyx / Bandwidth number's replies are NOT received (lane 146E owns the router; Outside-lane).",
      ],
    },
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
    receive: {
      supported: true,
      via: "webhook",
      events: ["inbound call (the tenant's own number)", "answer + answering-machine detection", "conversation turns", "call status / billed minutes", "recording"],
      route: "/api/voice/twilio/inbound",
      alsoRoutes: ["/api/voice/twilio/status", "/api/voice/twilio/turn", "/api/voice/twilio/recording", "/api/voice/twilio/outbound"],
      record: "voice_calls (direction inbound / outbound, contact- or lead-keyed) — the inbox's voice lane reads it",
      gaps: ["A call is recorded on voice_calls, never as a messages row: the universal inbox unions both, so it is one history without a second copy."],
    },
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
    receive: {
      supported: false,
      via: "none",
      events: [],
      record: "none at HEAD — the provider's job id is booked (vendor_usage_tracking idempotency voicedrop:<provider>:<job_id>) and lib/outcomes/reconciliation.ts TRUTH_SOURCES.voice_drop says source null (unverifiable)",
      gaps: [
        "Slybroadcast DOCUMENTS a per-number disposition postback (c_dispo_url: campaign id | destination | dial status | fail reason | delivery time | carrier; the receiver must answer 'OK') — NOT BUILT: orchestrateVoicedropSend sends no c_dispo_url and no route receives it. Building it is three files outside this lane (the sender, a secret-gated route, the truth source) — lane 146B notes, Outside-lane.",
        "A REPLY to a drop arrives as a call or a text to the caller-ID number, so it is received by the phone / sms channels — never by this one.",
      ],
    },
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
    receive: {
      supported: true,
      // First-party push: the contact's portal posts the reply to our own route the moment it is sent (no external
      // provider, no poll). Declared as a webhook because that is the transport shape — an event pushed at event time.
      via: "webhook",
      events: ["portal reply (client_to_agent)", "read receipt"],
      route: "/api/portal/messages/send",
      alsoRoutes: ["/api/cron/message-needs-response"],
      record: "client_portal_messages (direction client_to_agent) — MESSAGE_FROM_CONTACT fires at once and the hourly sweep escalates an unread one",
      gaps: ["Not an external provider: nothing to configure, and nothing a third party can drop."],
    },
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
    receive: {
      supported: true,
      via: "webhook",
      events: ["created", "rendered_pdf", "mailed (enterprise)", "in_transit", "in_local_area", "processed_for_delivery", "delivered", "re-routed", "returned_to_sender"],
      route: "/api/webhooks/lob-events",
      record: "the outcome ledger (TRUTH_SOURCES.direct_mail — lob.event_webhook) — delivery TRACKING, not a conversation",
      gaps: ["Paper has no reply channel: a person answers a letter by calling, texting, emailing, scanning a QR code or filling a form — each received by its own channel, never by Lob."],
    },
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
    receive: {
      supported: true,
      via: "webhook",
      events: [
        "Messenger DM", "Instagram DM", "WhatsApp message",
        "Facebook Page comment (feed item=comment)", "Facebook Page mention", "Instagram comment (+ ad_id on an ad)", "Instagram mention",
        "LinkedIn organization COMMENT / SHARE_MENTION", "LinkedIn DM (approved partners only)",
        "X DM / mention / reply (Account Activity API)",
      ],
      route: "/api/webhooks/meta-dm",
      alsoRoutes: ["/api/webhooks/whatsapp", "/api/webhooks/linkedin", "/api/webhooks/twitter"],
      record: "messages on the social thread (conversations type social_dm / social_comment) through recordInboundCommunication — idempotent on (provider, provider message / comment id); then the arbiter's inbound responder (respondToInboundCommunication)",
      gaps: [
        "TikTok (authorization / video publish events only), YouTube (PubSubHubbub = video uploads only; comments are POLL-only via commentThreads.list) and Pinterest (no webhooks) deliver no comment or message push — none is received here (no poller is built).",
        "A public comment reply is an external publication: it is always PROPOSED for a person, never auto-posted, and no comment-reply sender exists yet (lane 146E owns lib/social publishing).",
        "LinkedIn's Messages API is restricted to approved partners and X's Account Activity API needs a paid (pay-per-use / enterprise) tier — both are WAITING_EXTERNAL entitlements.",
      ],
    },
  },
  ads: {
    capability: "a paid ad campaign on the tenant's own ad account (Meta, Google Ads, streaming TV via Vibe, GroundTruth or StackAdapt, ChatGPT ads via OpenAI Ads)",
    providers: ["meta", "google_ads", "vibe", "openai_ads", "groundtruth", "stackadapt"],
    supporting: [],
    credentials: ["platform_credentials facebook (Meta ads OAuth)", "platform_credentials google_ads (Google Ads OAuth) + GOOGLE_ADS_DEVELOPER_TOKEN", "Connection OS 'vibe' (client credentials)", "Connection OS 'openai_ads' (Ads API key)", "Connection OS 'groundtruth' (X-GT-API-KEY + X-GT-USER-ID + account id)", "Connection OS 'stackadapt' (GraphQL API token + advertiser id)"],
    configuredBy: "getBrokerageProviderReadiness rows meta / google_ads / vibe / openai_ads / groundtruth / stackadapt (tenant connections); the launch precheck is lib/ads/connection-status.ts isAdPlatformConnected",
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
    receive: {
      supported: true,
      via: "webhook",
      events: ["Meta lead-ad submission (leadgen)", "Instagram ad comment (ad_id on the comments webhook)", "performance / spend / conversions (PULLED)"],
      route: "/api/webhooks/meta-leadgen",
      alsoRoutes: ["/api/webhooks/meta-dm", "/api/cron/ad-performance-sync"],
      record: "a lead-ad submission → the gated lead pipeline (lib/ads/ad-lead-intake.ts); an ad comment → messages on the social thread (C1) + the arbiter (1:1 ad follow-up through contract C2); performance → ad_campaigns metrics (ad-performance-ingest)",
      gaps: [
        "Performance is a PULL on a cron, never real-time. Lane 146E's per-platform receive facts are merged (wave 146, 146Z) into PROVIDER_RECEIVE_TRUTH.ad_performance and AD_PLATFORMS.<key>.evidence:",
        "meta — webhook (lead-form submission, /api/webhooks/meta-leadgen) + poll (spend / impressions / clicks / leads / conversions); google_ads — poll only (no lead-form webhook route); vibe_tv / openai_ads — poll only, no responses (TV and ChatGPT ads carry no reply object);",
        "groundtruth — poll (provider_status, spend, impressions, clicks, conversions; no webhook documented; leads / responses declared unsupported); stackadapt — poll (provider_status incl. review pending / rejected, spend, impressions, clicks, conversions, conversion_revenue); its documented webhooks are not built (payload + signature unreadable without an account).",
      ],
    },
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
    receive: {
      supported: false,
      via: "none",
      events: [],
      record: "the activities row's own completion — a task is not a conversation, nothing external answers it",
      gaps: ["A person's follow-up is recorded by the channel they used to make it (their call, text or email lands on that channel's history)."],
    },
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

// Wave 146 (lane 146Z, merging lane 146E's "Matrix facts for lane B" — owner ruling 8): GroundTruth and StackAdapt are two
// more TV CONNECTIONS on the ONE TV gateway (lib/ads/ctv-campaign.ts launchTvCampaign), not a second TV subsystem.
export type AdPlatformKey = "meta" | "google_ads" | "vibe_tv" | "openai_ads" | "groundtruth" | "stackadapt"

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
    verified: true,
    readinessRow: "google_ads",
    campaignPlatforms: ["google"],
    credential: "platform_credentials platform 'google_ads' (OAuth google_ads) + GOOGLE_ADS_DEVELOPER_TOKEN",
    adapter: "lib/ads/connectors/google.ts googleConnector (googleAds:mutate, Customer Match offline jobs, searchStream)",
    contract: "developers.google.com/google-ads/api (GOOGLE_ADS_API_VERSION in lib/agentic-os/connector-registry.ts)",
    evidence: "VERIFIED (wave 145, lane 145Z): m862 is APPLIED LIVE and scripts/check-vocabularies.ts regenerated — the live platform_credentials CHECK admits 'google_ads', the OAuth callback (app/api/integrations/oauth/[provider]/route.ts) writes 'google_ads' and every reader asks for it (adCredentialPlatform); test:channel-provider-matrix derived it ('google_ads is now DERIVABLE as verified'). At b364eb4b the callback wrote 'google', which the live CHECK refused. Verified = the capability is real and its credential storable; GOOGLE_ADS_DEVELOPER_TOKEN is still WAITING_EXTERNAL (no live call is claimed).",
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
  groundtruth: {
    key: "groundtruth",
    label: "Streaming TV (GroundTruth)",
    verified: true,
    readinessRow: "groundtruth",
    campaignPlatforms: ["groundtruth"],
    credential: "Connection OS provider 'groundtruth' (X-GT-API-KEY + X-GT-USER-ID + account id, tenant-issued on request; platform_credentials CHECK admits 'groundtruth' — m881 APPLIED LIVE)",
    adapter: "lib/providers/groundtruth-ads.ts launchGroundtruthCampaign (GROUNDTRUTH_DECLARATION) via lib/ads/connectors/groundtruth.ts, launched through the ONE TV gateway lib/ads/ctv-campaign.ts launchTvCampaign",
    contract: "api-docs.groundtruth.com (create campaign / adgroup / creative; reporting totals; mediatype ctv / ott — read 2026-10-29)",
    evidence: "real capability: tenant credential resolver (resolveGroundtruthCredential), gateway egress (callConnector 'groundtruth'), the broadcast gate + a READY TV master (refuses creative_source !== tv_master before any provider call), geography-only targeting, status / spend / conversions polled by the ad-performance ingest. No live call has been made — credentials are WAITING_EXTERNAL; CTV inventory entitlement is account-level and UNKNOWN until one exists. Receive: poll only (no webhook documented; leads / responses declared unsupported).",
  },
  stackadapt: {
    key: "stackadapt",
    label: "Streaming TV (StackAdapt)",
    verified: true,
    readinessRow: "stackadapt",
    campaignPlatforms: ["stackadapt"],
    credential: "Connection OS provider 'stackadapt' (GraphQL API token + advertiser id, tenant-issued on request; platform_credentials CHECK admits 'stackadapt' — m881 APPLIED LIVE)",
    adapter: "lib/providers/stackadapt-ads.ts launchStackadaptCampaign (STACKADAPT_DECLARATION) via lib/ads/connectors/stackadapt.ts, launched through the ONE TV gateway lib/ads/ctv-campaign.ts launchTvCampaign",
    contract: "docs.stackadapt.com + the published @stackadapt/pa-typescript-sdk 0.73.0 GraphQL schema (the GraphQL reference is behind a login — read 2026-10-29)",
    evidence: "real capability: tenant credential resolver (resolveStackadaptCredential), gateway egress (callConnector 'stackadapt'), the broadcast gate + a READY TV master, geography-only targeting, campaignDelivery polled by the ad-performance ingest (async Progress = pending). No live call has been made — credentials are WAITING_EXTERNAL. Receive: poll only — webhooks (CAMPAIGN_CREATION / CAMPAIGN_UPDATES / CREATIVE_CREATION) are documented but their payload and signature are not readable without an account, so no route is built.",
  },
})

/** The ONE streaming-TV ad provider (an AD_PLATFORMS key). No second TV subsystem exists or may be added; TV creative
 *  derives from an APPROVED topic-bank topic through lib/ads/ctv-campaign.ts stageCtvCampaign({ topicId, assetId }). */
export const TV_AD_PROVIDER = "vibe_tv" as const satisfies AdPlatformKey

// ── PER-PROVIDER RECEIVE TRUTH (wave 146, lane 146B — contract C7, owner ruling 3) ─────────────────────────────
//
// One row per provider that carries (or could carry) a channel. `send` / `receive` are what the CODE at HEAD does;
// `documented` is what the vendor's own primary source says it CAN deliver (URL + the date it was read). A provider
// whose documentation offers a receiver the code does not run carries `gap` — visible, never claimed. Ad platforms'
// own status / spend / conversion readback is lane 146E's to publish ("## Matrix facts for lane B"); the ad rows here
// are only what this lane read in the code.

export type ReceiveTransport = "webhook" | "poll" | "none"

export interface ProviderReceiveTruth {
  /** The arbiter channel the provider carries. */
  channel: ArbiterChannelName
  /** Does the code at HEAD send through it ("built"), or is it receive-only here ("receive_only")? */
  send: "built" | "receive_only"
  /** What the code at HEAD receives. */
  receive: { supported: boolean; via: ReceiveTransport; events: readonly string[]; route?: string }
  /** What the vendor documents it CAN deliver to a receiver (primary source, read date). */
  documented: { via: ReceiveTransport; events: readonly string[]; source: string }
  /** Documented but not built (and who owns the gap). Absent = the code receives what is documented and matters here. */
  gap?: string
}

export const PROVIDER_RECEIVE_TRUTH: Readonly<Record<string, ProviderReceiveTruth>> = Object.freeze({
  sendgrid: {
    channel: "email", send: "built",
    receive: { supported: true, via: "webhook", events: ["inbound parse (reply)", "processed", "delivered", "deferred", "bounce", "dropped", "open", "click", "spamreport", "unsubscribe"], route: "/api/webhooks/sendgrid-events" },
    documented: { via: "webhook", events: ["Inbound Parse (POSTs each received message)", "Event Webhook: processed / dropped / delivered / deferred / bounce / open / click / spam report / unsubscribe / group (un)subscribe"], source: "twilio.com/docs/sendgrid/for-developers/tracking-events/event + the SendGrid API guide's Inbound Parse section (read 2026-10-29)" },
  },
  mailgun: {
    channel: "email", send: "receive_only",
    receive: { supported: true, via: "webhook", events: ["inbound route (reply)"], route: "/api/webhooks/inbound-mail" },
    documented: { via: "webhook", events: ["routes forward received mail", "event webhooks"], source: "documentation.mailgun.com user manual — webhooks / routes (carried from lib/providers/inbound-router.ts; not re-read this wave)" },
    gap: "Mailgun sends nothing here (145D) — its delivery event webhooks have no send to report on.",
  },
  postmark: {
    channel: "email", send: "receive_only",
    receive: { supported: true, via: "webhook", events: ["inbound webhook (reply)"], route: "/api/webhooks/inbound-mail" },
    documented: { via: "webhook", events: ["inbound webhook", "delivery / bounce / open / click webhooks"], source: "postmarkapp.com/developer/webhooks (carried from lib/inbound-mail/providers.ts; not re-read this wave)" },
    gap: "Inbound only — Postmark sends nothing here, so its delivery webhooks have nothing to report.",
  },
  resend: {
    channel: "email", send: "receive_only",
    receive: { supported: true, via: "webhook", events: ["inbound (reply)"], route: "/api/webhooks/inbound-mail" },
    documented: { via: "webhook", events: ["email received", "email delivery events"], source: "resend.com/docs (carried from lib/inbound-mail/providers.ts; not re-read this wave)" },
    gap: "Inbound only — Resend sends nothing here.",
  },
  gmail: {
    channel: "email", send: "built",
    receive: { supported: true, via: "webhook", events: ["Pub/Sub push → history fetch (the agent's own mailbox)"], route: "/api/webhooks/inbound-mail" },
    documented: { via: "webhook", events: ["users.watch → Cloud Pub/Sub push of mailbox history"], source: "developers.google.com/gmail/api/guides/push (carried from lib/inbound-mail/oauth-fetchers.ts; not re-read this wave)" },
  },
  outlook: {
    channel: "email", send: "built",
    receive: { supported: true, via: "webhook", events: ["Graph change notification (validationToken handshake) → message fetch"], route: "/api/webhooks/inbound-mail" },
    documented: { via: "webhook", events: ["Microsoft Graph subscriptions on messages"], source: "learn.microsoft.com/graph/webhooks (carried from app/api/webhooks/inbound-mail/route.ts; not re-read this wave)" },
  },
  twilio: {
    channel: "sms", send: "built",
    receive: { supported: true, via: "webhook", events: ["inbound SMS / WhatsApp (MessageSid)", "status callback", "STOP keywords", "inbound call + call status + recording"], route: "/api/providers/inbound" },
    documented: { via: "webhook", events: ["incoming message webhook", "status callback", "voice webhooks"], source: "twilio.com/docs/messaging/guides/webhook-request (carried from lib/providers/inbound-router.ts; not re-read this wave)" },
  },
  telnyx: {
    channel: "sms", send: "built",
    receive: { supported: false, via: "none", events: [] },
    documented: { via: "webhook", events: ["message.received (inbound SMS/MMS)", "message.sent / message.finalized"], source: "developers.telnyx.com/api-reference/callbacks/inbound-message (read 2026-10-29; ed25519-signed: telnyx-signature-ed25519 + telnyx-timestamp)" },
    gap: "NOT BUILT: lib/providers/inbound-router.ts verifies and normalizes Twilio only, so a tenant's BYO Telnyx number sends but never hears a reply — lane 146E owns the router (Outside-lane).",
  },
  bandwidth: {
    channel: "sms", send: "built",
    receive: { supported: false, via: "none", events: [] },
    documented: { via: "webhook", events: ["message-received (InboundCallbackURL)", "message-delivered / message-failed (OutboundCallbackURL)"], source: "dev.bandwidth.com/docs/messaging/webhooks (read 2026-10-29; at-least-once delivery, dedupe by message.id)" },
    gap: "NOT BUILT: same as telnyx — the inbound router normalizes Twilio only (lane 146E, Outside-lane).",
  },
  voicedrop: {
    channel: "voice_drop", send: "built",
    receive: { supported: false, via: "none", events: [] },
    documented: { via: "webhook", events: ["per-number disposition postback via c_dispo_url (campaign id | destination | dial status | fail reason | delivery time | carrier; the receiver answers 'OK')", "campaign results on request (poll)"], source: "slybroadcast.com/documentation + slybroadcast.com/documentationjson (read 2026-10-29)" },
    gap: "NOT BUILT: no c_dispo_url is sent and no route receives it; lib/outcomes/reconciliation.ts TRUTH_SOURCES.voice_drop stays null (unverifiable) until the sender, a secret-gated route and the truth source land together (lane 146B notes, Outside-lane).",
  },
  lob: {
    channel: "direct_mail", send: "built",
    receive: { supported: true, via: "webhook", events: ["letter / postcard / self_mailer tracking events"], route: "/api/webhooks/lob-events" },
    documented: { via: "webhook", events: ["mailed (enterprise)", "in_transit", "in_local_area", "processed_for_delivery", "delivered", "re-routed", "returned_to_sender", "return-envelope tracking (enterprise)"], source: "help.lob.com/print-and-mail/getting-data-and-results/tracking-your-mail (read 2026-10-29)" },
  },
  meta: {
    channel: "social", send: "built",
    receive: { supported: true, via: "webhook", events: ["Messenger DM (message.mid)", "Instagram DM", "Page feed comment (item=comment, verb=add)", "Page mention", "Instagram comment (comment_id / id; ad_id on an ad)", "Instagram mention"], route: "/api/webhooks/meta-dm" },
    documented: { via: "webhook", events: ["page: feed (item / verb / comment_id / post_id / parent_id / from / message / created_time), mention, messages", "instagram: comments, live_comments, mentions, messages"], source: "developers.facebook.com/docs/graph-api/webhooks/reference/page + developers.facebook.com/documentation/instagram-platform/webhooks/examples (read 2026-10-29)" },
    gap: "A comment REPLY (POST /{comment-id}/comments; Instagram /{comment-id}/replies) has no sender in the code — a proposed public reply is answered by a person on the platform until lane 146E builds that publish door.",
  },
  whatsapp: {
    channel: "social", send: "built",
    receive: { supported: true, via: "webhook", events: ["Cloud API message (messages[].id = wamid)"], route: "/api/webhooks/whatsapp" },
    documented: { via: "webhook", events: ["messages", "statuses"], source: "developers.facebook.com WhatsApp Cloud API webhooks (carried from app/api/webhooks/whatsapp/route.ts; not re-read this wave)" },
    gap: "Delivery / read statuses are acknowledged and skipped (lib/outcomes has no WhatsApp lane).",
  },
  linkedin: {
    channel: "social", send: "built",
    receive: { supported: true, via: "webhook", events: ["ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS: COMMENT / SHARE_MENTION (notificationId)", "DM (approved partners only)"], route: "/api/webhooks/linkedin" },
    documented: { via: "webhook", events: ["organization social action notifications: LIKE / COMMENT / SHARE / SHARE_MENTION / ADMIN_COMMENT / COMMENT_EDIT / COMMENT_DELETE (rw_organization_admin; batched by 10; redelivered every 5 min for 8 h)", "Messages API — approved partners only"], source: "learn.microsoft.com/linkedin/marketing/community-management/organizations/organization-social-action-notifications + learn.microsoft.com/linkedin/shared/integrations/communications/messages (read 2026-10-29)" },
    gap: "LinkedIn DMs need the partner-restricted Messages API (WAITING_EXTERNAL); a comment reply needs the organization-social write door (lane 146E).",
  },
  twitter: {
    channel: "social", send: "built",
    receive: { supported: true, via: "webhook", events: ["direct_message_events (DM)", "tweet_create_events (mention / reply)"], route: "/api/webhooks/twitter" },
    documented: { via: "webhook", events: ["Account Activity API: posts, @mentions, replies, DMs sent / received, likes, follows, …"], source: "docs.x.com/x-api/account-activity/introduction (read through its enterprise fundamentals mirror 2026-10-29): pay-per-use (3 subscriptions, 1 webhook) or enterprise; dedupe by event id" },
    gap: "The Account Activity subscription is a paid X entitlement (WAITING_EXTERNAL); X marks it as moving to the X Activity API.",
  },
  tiktok: {
    channel: "social", send: "built",
    receive: { supported: false, via: "none", events: [] },
    documented: { via: "webhook", events: ["authorization.removed", "video.upload.failed", "video.publish.completed", "portability.download.ready — no comment or message event"], source: "developers.tiktok.com/docs/en/webhooks-events (read 2026-10-29)" },
    gap: "TikTok offers no comment / DM push to a standard app — nothing to receive.",
  },
  youtube: {
    channel: "social", send: "built",
    receive: { supported: false, via: "none", events: [] },
    documented: { via: "poll", events: ["PubSubHubbub push = video upload / title / description changes only", "comments: commentThreads.list (poll)"], source: "developers.google.com/youtube/v3/guides/push_notifications + /guides/implementation/comments (read 2026-10-29)" },
    gap: "Comments are poll-only and no poller is built — declared, not claimed.",
  },
  pinterest: {
    channel: "social", send: "built",
    receive: { supported: false, via: "none", events: [] },
    documented: { via: "none", events: ["no webhooks in API v5; pin comments are not readable through the API"], source: "developers.pinterest.com/docs/api/v5 + community.pinterest.biz/t/pinterest-api/38318 (read 2026-10-29)" },
  },
  meta_lead_ads: {
    channel: "ads", send: "built",
    receive: { supported: true, via: "webhook", events: ["leadgen (lead-ad form submission)"], route: "/api/webhooks/meta-leadgen" },
    documented: { via: "webhook", events: ["page: leadgen"], source: "developers.facebook.com/docs/graph-api/webhooks/reference/page (read 2026-10-29)" },
  },
  ad_performance: {
    channel: "ads", send: "built",
    receive: { supported: true, via: "poll", events: ["impressions / spend / clicks / conversions per campaign (meta, google_ads, vibe_tv, openai_ads, groundtruth, stackadapt)", "provider_status (groundtruth ACTIVE / PAUSED; stackadapt incl. review pending / rejected)", "conversion_revenue (stackadapt)"], route: "/api/cron/ad-performance-sync" },
    documented: { via: "poll", events: ["each platform's insights / reporting API"], source: "lane 146E's notes (\"## Matrix facts for lane B\") own the per-platform contract — merged by lane 146Z" },
  },
  portal: {
    channel: "in_app", send: "built",
    receive: { supported: true, via: "webhook", events: ["client_to_agent reply", "read receipt"], route: "/api/portal/messages/send" },
    documented: { via: "webhook", events: ["first-party — our own portal"], source: "app/api/portal/messages/send/route.ts (our code)" },
  },
})
