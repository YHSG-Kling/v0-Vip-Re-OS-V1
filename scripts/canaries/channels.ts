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

  // ── 2 · DIRECT MAIL is a real decision option ──
  const mail = await arbitrate(base(["email", "direct_mail"]), decideWith("communication", "direct_mail"))
  c.rule("144F", "DIRECT MAIL IS A REAL ARBITER OPTION (ruling 12: 'the arbiter's channel space is missing DIRECT MAIL'): a contact whose policy permits direct mail (a mailable, CASS-verified, non-suppressed address and the tenant's mail budget) can have the arbiter choose direct mail for a communication — the choice is honoured (source ai, channel direct_mail) and rides the existing direct-mail dispatch, never a string the dispatcher ignores", mail.source === "ai" && String(mail.channel) === "direct_mail", `HEAD: ${mail.source}/${mail.channel ?? "null"} — ${mail.fallbackReason ?? ""} (followup-arbiter.ts CHANNELS_FOR_KIND: communication → email | sms | voice)`)

  // ── 3 · VOICE CALL vs VOICE DROP ──
  const drop = await arbitrate(base(["voice_drop"]), decideWith("communication", "voice_drop"))
  const call = await arbitrate(base(["voice"]), decideWith("communication", "voice"))
  c.rule("144F", "VOICE CALL AND VOICE DROP ARE DISTINCT OPTIONS (ruling 12: 'voice call, voice drop where lawful'): with only a ringless voice drop permitted (lawful in the jurisdiction, consent on file, the drop provider configured) the arbiter can choose voice_drop — distinct from a live voice call, which keeps its own consent and call-hours rules", drop.source === "ai" && String(drop.channel) === "voice_drop" && call.channel === "voice", `HEAD: drop ${drop.source}/${drop.channel ?? "null"} (${drop.fallbackReason ?? ""}); call ${call.source}/${call.channel}`)

  // ── 4 · the channel space as a whole (source census of the ONE type) ──
  const arbSrc = strippedRepo("lib/ai-isa/followup-arbiter.ts") ?? ""
  const typeLine = /export\s+type\s+ArbiterChannel\s*=\s*([^\n;]+)/.exec(arbSrc)?.[1] ?? ""
  const members = (typeLine.match(/["']([a-z_]+)["']/g) ?? []).map((s) => s.replace(/["']/g, ""))
  const wanted = ["direct_mail", "voice_drop", "ads", "social", "portal", "video"]
  const missing = wanted.filter((w) => !members.some((m) => m === w || (w === "ads" && /^(ad|ads|paid_ads?)$/.test(m))))
  c.rule("144F", "THE CHANNEL SPACE CARRIES EVERY REGISTERED DELIVERY CHANNEL (ruling 12: voice call, voice drop, AI avatar / personalized video, social, ads, portal, human task, direct mail): ArbiterChannel names direct_mail, voice_drop, ads, social, portal and video as decision options (a human task stays the agent_intervention option)", missing.length === 0, `HEAD ArbiterChannel = ${members.join(" | ")}; missing ${missing.join(", ") || "none"}`)

  // ── 5 · FORMAT ≠ CHANNEL; the leadership format carries direct mail + ads ──
  const lead = strippedRepo("lib/content-intel/market-leadership.ts") ?? ""
  const fmtLine = /export\s+type\s+LeadershipFormat\s*=\s*([^\n;]+)/.exec(lead)?.[1] ?? ""
  const formats = (fmtLine.match(/["']([a-z_]+)["']/g) ?? []).map((s) => s.replace(/["']/g, ""))
  c.rule("144F", "LEADERSHIP / CAMPAIGN FORMAT CARRIES DIRECT MAIL AND ADS (ruling 12: 'leadership/campaign format is missing direct mail and possibly ads'): a market-leadership opportunity can be produced as a direct-mail piece or an ad creative — formats, which the channel arbiter then DELIVERS (a format is never dispatched as if it were a channel)", formats.some((f) => /^direct_mail|postcard|mailer$/.test(f)) && formats.some((f) => /^(ad|ads|ad_creative|paid_ad)$/.test(f)), `HEAD LeadershipFormat = ${formats.join(" | ")}`)

  // ── 6 · dynamic timing: wait is bounded, a human is never left out (green — preserve) ──
  const wait = await arbitrate(base(["email"]), async () => ({ optionId: "wait", channel: null, waitHours: 9999, rationale: "Hold — they asked to talk after the holidays.", evidence: ["intent"], confidence: 0.9 }))
  c.rule("144F", "DYNAMIC TIMING IS BOUNDED (green — preserve): a model WAIT outside the tenant policy's bounds (9,999 h) is refused and the planner's verdict stands — waiting is a decision with limits, never an indefinite deferral; speed-to-lead and the one fixed send are outside the arbiter (their own canary)", wait.source === "deterministic" && /outside|waitHours/.test(wait.fallbackReason ?? ""), `${wait.source}: ${wait.fallbackReason}`)

  c.blind("The arbiter ran with an injected model (no AI spend) and the recorder seams (no ledger / delegate / emit write). Consent, CASS and suppression gates for direct mail are asserted as the CONDITION on the option, not driven (no address is seeded); the dispatcher (lib/providers/dispatch.ts) is not called — nothing is sent.")
  return c.report([], 0)
}
