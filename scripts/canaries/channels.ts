/**
 * scripts/canaries/channels.ts — CHANNELS canary (wave 144, lane 144J; owner rulings 12 + 11):
 *   the arbiter's channel space carries DIRECT MAIL, voice CALL vs voice DROP (where lawful), avatar / personalized video,
 *   social, ads, portal and a human task as REAL decision options — each behind its consent / frequency / cost / provider
 *   check; the leadership / campaign FORMAT carries direct mail and ads; a creative format is never a delivery channel;
 *   timing is dynamic (ACT NOW / WAIT / EDUCATE / NOTIFY HUMAN / CHANGE CHANNEL) and the model never picks outside the menu.
 * Through the survivors at 967a4866: lib/ai-isa/followup-arbiter.ts arbitrateAndRecordExperience (the ONE entry the ISA engage
 * path, the sequence enroller and the post-close conductor call — driven with an injected model and recorder seams exactly as
 * scripts/intent-driven-followup-guard.ts drives it), lib/ai-isa/lead-action-plan.ts planNextBestExperience,
 * lib/ai-isa/followup-policy.ts, lib/content-intel/market-leadership.ts (LeadershipFormat). Nothing is dispatched.
 *
 * MEASURED AT 967a4866: `ArbiterChannel = "email" | "sms" | "voice" | "video" | "portal"` — a communication option rides
 * email / sms / voice only, so a tenant that permits direct mail or a voice drop cannot have the arbiter choose it (the
 * model's choice is refused as "not permitted" and the planner's verdict stands); LeadershipFormat has no direct mail and no
 * ad — 144F.
 */
import { LIVE, canary } from "./_harness"
import { strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"

export async function run() {
  const c = canary("Channels: the arbiter weighs direct mail / voice call / voice drop / video / social / ads / portal / human task as real, gated options · format ≠ channel · the model never leaves the menu")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const lap = await import("../../lib/ai-isa/lead-action-plan")
  const arb = await import("../../lib/ai-isa/followup-arbiter")
  const policyMod = await import("../../lib/ai-isa/followup-policy")
  type Input = import("../../lib/ai-isa/lead-action-plan").NextBestExperienceInput
  const NOW = new Date("2026-10-25T15:00:00.000Z")
  const intent = (score: number) => ({ score, trend: "rising", velocityPerDay: 2, accelerationPerDay2: 0, confidence: "high", independentSources: 3, momentumRank: score, evidence: [] }) as never
  const base = (allowedChannels: string[], over: Partial<Input> = {}): Input => ({
    now: NOW, subject: "contact", nba: { intent: intent(80), memoryFacts: [] },
    person: { contactType: "seller", persona: "move_up", hasAssignedAgent: true },
    behavior: { touchpoints7d: 0, lastTouchpointChannel: null, portalEducationViews: 0 },
    transaction: null, education: null, fatigue: { riskLevel: null },
    policy: { complianceHardFlag: false, allowedChannels, autoSendAllowed: true, videoAllowed: true },
    ...over,
  } as Input)
  const policy = policyMod.platformFollowupPolicy()
  const sink = { ledger: async (_c: Record<string, unknown>, run: () => Promise<unknown>) => run(), emit: async () => ({ inserted: true }), delegate: async () => ({ ok: true, delegation: { id: "d1" } }) }
  const decideWith = (optionId: string, channel: string | null) => async () => ({ optionId, channel, waitHours: null, rationale: "Rising intent and no touch this week; this channel suits their stated preference.", evidence: ["intent", "history"], confidence: 0.85 })
  const arbitrate = async (input: Input, decide: () => Promise<Record<string, unknown>>) => {
    const r = await arb.arbitrateAndRecordExperience(memSupabase({}, { uuidIds: true, stampCreatedAt: true }), { brokerageId: "B", contactId: "C", input, plan: lap.planNextBestExperience(input), now: NOW, policy, systemSource: "canary" }, { decide: decide as never, record: sink })
    return r.decision!
  }

  // ── 1 · the model never leaves the menu (green — preserve) ──
  const offMenu = await arbitrate(base(["email"]), decideWith("communication", "sms"))
  const onMenu = await arbitrate(base(["email", "sms"]), decideWith("communication", "sms"))
  c.rule("144F", "THE MODEL CHOOSES ONLY AMONG WHAT IS PERMITTED (green — preserve): with only email permitted, a model reply naming SMS is REFUSED and the planner's verdict stands (source deterministic, reason stated); with SMS permitted the same reply is honoured (source ai, channel sms) — every decision carries its rationale and evidence", offMenu.source === "deterministic" && /not permitted|not on the menu/.test(offMenu.fallbackReason ?? "") && onMenu.source === "ai" && onMenu.channel === "sms" && onMenu.evidence.length > 0, `off-menu: ${offMenu.source} (${offMenu.fallbackReason}); on-menu: ${onMenu.source}/${onMenu.channel} menu ${onMenu.menu.join(",")}`)

  // RE-ASSERTED (lane 144Z) — steps 2–4 were written against the arbiter's OLD shape (a `type ArbiterChannel = "…" | "…"` line, a
  // 'voice' channel, a 'video' channel, and an UNSEEDED person, so every per-channel check read "no contact"). Lane 144F rebuilt the
  // space on the owner's rule: `ARBITER_CHANNELS` is a const array (the campaign taxonomy's keys + human_task), `phone` is the live
  // call ('voice' is a read-side alias), `in_app` is the portal ('portal' an alias) and VIDEO IS A FORMAT riding a channel — never a
  // channel (owner ruling 12). The rule asserted is unchanged; the steps now SEED exactly what F's gates check
  // (lib/ai-isa/followup-arbiter.ts evaluateChannelReadiness: consent columns on the contact row, the tenant's ISA channel settings,
  // the de-confliction cap, provider readiness, price + budget) through the seams F's notes name (deps.readiness, `deliverable` =
  // CONTACT_ENGAGEMENT_DELIVERABLE — the engage path that can dispatch mail / call / drop), and each carries a REFUSAL CONTROL so a
  // green cannot come from a gate that never ran.
  const B = "11111111-1111-4111-8111-111111111111", CT = "22222222-2222-4222-8222-222222222222"
  const consentRow = (over: Record<string, unknown> = {}) => ({ id: CT, brokerage_id: B, email: "pat@example.test", email_opt_out: false, email_unsubscribed: false, phone: "+15555550100", tcpa_consent: true, sms_opt_out: false, phone_opt_out: false, call_stop_flag: false, dnc_status: false, direct_mail_opt_out: false, mailing_address: "1 Main St, Pensacola, FL 32501", mailing_address_verified: true, opt_out_channels: [], has_login: true, ...over })
  const readyRows = (o: { lob?: boolean; voicedrop?: boolean } = {}) => ({ rows: [
    { provider: "sendgrid", category: "email", ready: true }, { provider: "twilio", category: "voice_sms", ready: true },
    { provider: "voicedrop", category: "other", ready: o.voicedrop ?? true }, { provider: "lob", category: "mail", ready: o.lob ?? true },
  ] })
  const arbitrateSeeded = async (allowed: string[], decide: () => Promise<Record<string, unknown>>, w: { contact?: Record<string, unknown>; lob?: boolean; voicedrop?: boolean; remaining?: number } = {}) => {
    const seed = { contacts: [consentRow(w.contact)], buyer_fatigue_scores: [{ id: "f1", brokerage_id: B, contact_id: CT, contributing_factors: { saturated_channels: [] }, last_calculated_at: NOW.toISOString() }], signal_reactivations: [] }
    const input = base(allowed)
    const r = await arb.arbitrateAndRecordExperience(memSupabase(seed, { uuidIds: true, stampCreatedAt: true }), {
      brokerageId: B, contactId: CT, input, plan: lap.planNextBestExperience(input), now: NOW, policy, systemSource: "canary",
      deliverable: arb.CONTACT_ENGAGEMENT_DELIVERABLE,
    }, {
      decide: decide as never, record: sink,
      readiness: { providers: async () => readyRows(w), budget: async () => ({ allowed: true, remainingBudget: w.remaining ?? 100 }), prices: async () => ({ email: 0.001, sms: 0.0079, phone: 0.014, voice_drop: null, direct_mail: 0.78 }) },
    })
    return r.decision!
  }
  const reply = (over: Record<string, unknown>) => async () => ({ optionId: "communication", channel: "email", format: null, waitHours: null, rationale: "They asked for paper and have not opened email in weeks.", evidence: ["channels", "history"], confidence: 0.85, ...over })

  // ── 2 · DIRECT MAIL is a real decision option ──
  const mail = await arbitrateSeeded(["email", "direct_mail"], reply({ channel: "direct_mail" }))
  const mailOptedOut = await arbitrateSeeded(["email", "direct_mail"], reply({ channel: "direct_mail" }), { contact: { direct_mail_opt_out: true } })
  const mailNoProvider = await arbitrateSeeded(["email", "direct_mail"], reply({ channel: "direct_mail" }), { lob: false })
  const mailOverBudget = await arbitrateSeeded(["email", "direct_mail"], reply({ channel: "direct_mail" }), { remaining: 0.1 })
  const refused = (d: { source: string; channel: unknown }) => d.source === "deterministic" && d.channel !== "direct_mail"
  c.rule("144F", "DIRECT MAIL IS A REAL ARBITER OPTION (ruling 12: 'the arbiter's channel space is missing DIRECT MAIL'): a contact whose policy permits direct mail (a mailable, CASS-verified, non-suppressed address, the tenant's mail setting, a mail provider and the tenant's budget) can have the arbiter choose direct mail for a communication — the choice is honoured (source ai, channel direct_mail, a printed format) and hands the engage path's direct-mail dispatch its spelling, never a string the dispatcher ignores; the SAME choice is refused when the person opted out of mail, when no mail provider is ready, or when the piece is over the remaining budget", mail.source === "ai" && String(mail.channel) === "direct_mail" && ["printed_letter", "postcard", "handwritten_card"].includes(String(mail.format)) && arb.touchChannelForDecision(mail) === "direct_mail" && refused(mailOptedOut) && refused(mailNoProvider) && refused(mailOverBudget), `chosen: ${mail.source}/${mail.channel ?? "null"}/${mail.format ?? "null"} → dispatch ${arb.touchChannelForDecision(mail)}; opted-out ${mailOptedOut.source}; no provider ${mailNoProvider.source}; over budget ${mailOverBudget.source}`)

  // ── 3 · VOICE CALL vs VOICE DROP ──
  const drop = await arbitrateSeeded(["voice_drop"], reply({ channel: "voice_drop" }))
  const callUnderDropOnly = await arbitrateSeeded(["voice_drop"], reply({ channel: "phone" }))
  const call = await arbitrateSeeded(["phone"], reply({ channel: "voice" }))
  const dropNoConsent = await arbitrateSeeded(["voice_drop"], reply({ channel: "voice_drop" }), { contact: { tcpa_consent: false } })
  const dropNoProvider = await arbitrateSeeded(["voice_drop"], reply({ channel: "voice_drop" }), { voicedrop: false })
  c.rule("144F", "VOICE CALL AND VOICE DROP ARE DISTINCT OPTIONS (ruling 12: 'voice call, voice drop where lawful'): with only a ringless voice drop permitted (consent on file, the drop provider configured) the arbiter can choose voice_drop (voicemail audio, dispatched as the engage path's 'voicedrop') — and a live CALL is then NOT permitted (a separate option); a tenant that permits the phone line can have the call (canonical 'phone', format live_call — 'voice' is a read-side alias); the drop is refused without TCPA consent or without its provider", drop.source === "ai" && String(drop.channel) === "voice_drop" && drop.format === "voicemail_audio" && arb.touchChannelForDecision(drop) === "voicedrop" && callUnderDropOnly.source === "deterministic" && call.source === "ai" && call.channel === "phone" && call.format === "live_call" && dropNoConsent.source === "deterministic" && dropNoProvider.source === "deterministic", `drop ${drop.source}/${drop.channel ?? "null"}/${drop.format ?? "null"}; call under drop-only ${callUnderDropOnly.source} (${(callUnderDropOnly.fallbackReason ?? "").slice(0, 60)}); call ${call.source}/${call.channel}/${call.format}; drop w/o consent ${dropNoConsent.source}; w/o provider ${dropNoProvider.source}`)

  // ── 4 · the channel space as a whole: every delivery channel is a decision option; video is a FORMAT on a channel ──
  const space = arb.ARBITER_CHANNELS as readonly string[]
  const wanted = ["direct_mail", "voice_drop", "phone", "ads", "social", "in_app", "human_task"]
  const missing = wanted.filter((w) => !space.includes(w))
  const portalIsInApp = arb.ARBITER_CHANNEL_ALIASES.portal === "in_app" && arb.ARBITER_CHANNEL_ALIASES.voice === "phone"
  const videoNotAChannel = !space.includes("video") && !("video" in arb.ARBITER_CHANNEL_ALIASES) && (arb.ARBITER_FORMATS as readonly string[]).includes("avatar_video")
  const videoOnEmail = await arbitrateSeeded(["email"], reply({ channel: "email", format: "avatar_video" }))
  const videoAsChannel = await arbitrateSeeded(["email"], reply({ channel: "video" }))
  const videoByMail = await arbitrateSeeded(["email", "direct_mail"], reply({ channel: "direct_mail", format: "avatar_video" }))
  c.rule("144F", "THE CHANNEL SPACE CARRIES EVERY REGISTERED DELIVERY CHANNEL (ruling 12: voice call, voice drop, AI avatar / personalized video, social, ads, portal, human task, direct mail — and 'never conflate a creative format with a delivery channel'): ARBITER_CHANNELS names direct_mail, voice_drop, phone, ads, social, in_app (the portal) and human_task as decision options; an avatar video is a FORMAT the arbiter can send on a channel that carries it (email) — naming 'video' as a channel is refused, and a format a channel cannot carry (a video by mail) is refused", missing.length === 0 && portalIsInApp && videoNotAChannel && videoOnEmail.source === "ai" && videoOnEmail.channel === "email" && videoOnEmail.format === "avatar_video" && videoAsChannel.source === "deterministic" && videoByMail.source === "deterministic", `ARBITER_CHANNELS = ${space.join(" | ")}; missing ${missing.join(", ") || "none"}; portal→in_app ${portalIsInApp}; video on email ${videoOnEmail.source}/${videoOnEmail.format ?? "null"}; 'video' as channel ${videoAsChannel.source} (${(videoAsChannel.fallbackReason ?? "").slice(0, 60)}); video by mail ${videoByMail.source}`)

  // ── 5 · FORMAT ≠ CHANNEL; the leadership format carries direct mail + ads ──
  const lead = strippedRepo("lib/content-intel/market-leadership.ts") ?? ""
  const fmtLine = /export\s+type\s+LeadershipFormat\s*=\s*([^\n;]+)/.exec(lead)?.[1] ?? ""
  const formats = (fmtLine.match(/["']([a-z_]+)["']/g) ?? []).map((s) => s.replace(/["']/g, ""))
  c.rule("144F", "LEADERSHIP / CAMPAIGN FORMAT CARRIES DIRECT MAIL AND ADS (ruling 12: 'leadership/campaign format is missing direct mail and possibly ads'): a market-leadership opportunity can be produced as a direct-mail piece or an ad creative — formats, which the channel arbiter then DELIVERS (a format is never dispatched as if it were a channel)", formats.some((f) => /^direct_mail|postcard|mailer$/.test(f)) && formats.some((f) => /^(ad|ads|ad_creative|paid_ad)$/.test(f)), `HEAD LeadershipFormat = ${formats.join(" | ")}`)

  // ── 6 · dynamic timing: wait is bounded, a human is never left out (green — preserve) ──
  const wait = await arbitrate(base(["email"]), async () => ({ optionId: "wait", channel: null, waitHours: 9999, rationale: "Hold — they asked to talk after the holidays.", evidence: ["intent"], confidence: 0.9 }))
  c.rule("144F", "DYNAMIC TIMING IS BOUNDED (green — preserve): a model WAIT outside the tenant policy's bounds (9,999 h) is refused and the planner's verdict stands — waiting is a decision with limits, never an indefinite deferral; speed-to-lead and the one fixed send are outside the arbiter (their own canary)", wait.source === "deterministic" && /outside|waitHours/.test(wait.fallbackReason ?? ""), `${wait.source}: ${wait.fallbackReason}`)

  c.blind("The arbiter ran with an injected model (no AI spend), the recorder seams (no ledger / delegate / emit write) and the readiness seams (provider scan, budget, price table) on an in-memory contact row. The per-channel PRE-checks are driven (consent columns, tenant settings, provider, budget); the send-time gates — the CASS verification (lib/providers/mailing-cass-gate.ts), suppression, de-confliction and the dispatcher's own consent gate (lib/providers/dispatch.ts) — are not called: nothing is sent. Step 1 / step 6 still run on an UNSEEDED person (the tenant-list menu) — that is the 'readiness not loaded' arm.")
  return c.report([], 0)
}
