/**
 * scripts/canaries/first-touch.ts — FIRST TOUCH canary (wave 144, lane 144J; owner ruling 13 "the ONE fixed send"):
 *   the moment a lead / new form input becomes a CONTACT it gets its portal invitation (a valid activation path, the correct
 *   tenant + agent identity) plus the welcome — dispatched IMMEDIATELY — and the agent's personal welcome video FOLLOWS when
 *   the real asset is ready and authorized; raw leads never get the portal invite; a retried conversion sends no duplicate
 *   invite or first touch. Speed-to-lead remains its own exception.
 * Through the survivors at 967a4866: lib/kernel/crm.ts convertLeadToContact (the qualified-only conversion door — the lead
 * canary's chain) → lib/contact-promotion/conversion-welcome.ts deliverConversionWelcome (portal grant FIRST, then the welcome),
 * lib/contact-promotion/portal-access.ts (PORTAL_EXCLUDED_CONTACT_TYPES), and the PURE timing rule decideWelcomeTiming /
 * classifyPendingWelcome. In memory: the OTP / email provider is the harness's refusal, so nothing is sent.
 *
 * MEASURED AT 967a4866: the ONE welcome WAITS for the personal video ("the EMAIL waits for the video", up to
 * WELCOME_VIDEO_WAIT_MS) — ruling 13 (wave 144) reverses it: send the immediately available welcome now, follow with the video
 * when it lands — 144F.
 *
 * WAVE 145 (lane 145E) — RE-ASSERTED: owner ruling 17 (2026-10-27) REVERSES ruling 13's timing — "the welcome email with the
 * login info for the newly converted contact has to wait for the avatar welcome email from the agent to finish and auto send
 * after"; "failure = visible pending/recoverable state with a human-approved exception, never falsely sent, never silently
 * pending forever". The steps below that pinned "the welcome goes now" now assert ruling 17's rule on the same survivors: a
 * render in flight HOLDS the one welcome; the sweeper releases it WITH the validated video; no possible video HOLDS it and files
 * ONE human-approved exception (approval_items `welcome_without_video`). The invite / raw-lead / retry steps are unchanged.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { findLanded } from "./_registry"

export async function run() {
  const c = canary("First touch: lead → CONTACT → portal invite + the ONE welcome WITH the agent's video when ready (else a human-approved exception) · raw leads never invited · no duplicates on retry")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: an invite is an outbound email")

  // ── 1 · the timing rule (pure) ──
  const { decideWelcomeTiming, classifyPendingWelcome } = await import("../../lib/contact-promotion/conversion-welcome")
  const inFlight = decideWelcomeTiming({ commissioned: true, reason: "commissioned" })
  const noVideo = decideWelcomeTiming({ commissioned: false, reason: "agent_not_video_ready" })
  // WAVE 145 (ruling 17): any HOLD spelling for a render in flight; never a send before the video.
  c.rule("144F", "THE WELCOME WAITS FOR THE AGENT'S VIDEO (ruling 17: 'has to wait for the avatar welcome … to finish and auto send after'): with the personal video render IN FLIGHT the one welcome is HELD — it is never sent ahead of the video", /^hold_for_video$/.test(String(inFlight.action)), `HEAD: ${inFlight.action} — "${inFlight.reason}"`)
  c.rule("144F", "NO VIDEO POSSIBLE → THE WELCOME IS HELD FOR A HUMAN-APPROVED EXCEPTION (ruling 17: never falsely sent, never silently pending) — not sent without the video on the system's own say", /^hold_for_exception$/.test(String(noVideo.action)), noVideo.reason)
  // WAVE144 WIRE (lane 144F notes, landed names): the sweeper's verdict takes the WELCOME's own state (WelcomeMessageState) and
  // answers send_video_follow_up / close_video_follow_up; deliverWelcomeVideoFollowUp sends it once (ledger cycle
  // welcome_video_follow_up). At HEAD the classifier ignores the welcome's state and releases the ONE waiting welcome.
  const followUp = findLanded(["lib/contact-promotion", "lib/kernel/client-welcome.ts", "app/api/cron/intro-video-email-backfill"], /\b(welcome_video_follow_?up|deliverWelcomeVideoFollowUp|send_video_follow_up)\b/)
  const base = { status: "rendering", composite: "landed" as const, hasRenderedUrl: true, videoOptOut: false, hasEmail: true }
  // WAVE 145 (ruling 17): a HELD welcome (state 'none') + the validated video → the ONE welcome WITH the video; a render that never
  // lands → the human-approved exception (never 'send without the video'). The wave-144 follow-up survives only as the transition
  // arm for a welcome that already went (welcomeState 'sent') — still never a second welcome.
  const landedHeld = classifyPendingWelcome({ ...base, ageMs: 60_000, welcomeState: "none" } as never) as { action: string; reason: string }
  const failedHeld = classifyPendingWelcome({ ...base, ageMs: 10 * 3_600_000, hasRenderedUrl: false, composite: "pending", welcomeState: "none" } as never) as { action: string; reason: string }
  const landedSent = classifyPendingWelcome({ ...base, ageMs: 60_000, welcomeState: "sent" } as never) as { action: string; reason: string }
  c.rule("144F", "AUTO-SENT WITH THE VIDEO WHEN READY: a held welcome + the validated personal video → the sweeper sends the ONE welcome WITH it; a render that never lands → a human-approved exception, never a send without the video (a welcome that already went under ruling 13 still never gets a second one)", followUp !== null && landedHeld.action === "send_with_video" && failedHeld.action === "hold_for_exception" && landedSent.action === "send_video_follow_up", `held + landed → ${landedHeld.action}; held + past the deadline → ${failedHeld.action}; transition (welcome sent) → ${landedSent.action}`)

  // ── 2 · the chain: raw lead → (no invite) → qualified → CONTACT → invite + welcome ──
  const B = uuid(), U = uuid(), AG = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} First-Touch Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-touch` }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, first_name: "Casey", last_name: "Agent" }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, first_name: "Casey", last_name: "Agent", is_active: true, email: `agent@${CANARY_EMAIL_DOMAIN}` }],
  })
  setSvc(svc)
  const email = `jordan.touch@${CANARY_EMAIL_DOMAIN}`
  const { data: ins, error: insErr } = await svc.from("leads").insert({ brokerage_id: B, first_name: "Jordan", last_name: "Touch", email, phone: "5125550177", phone_digits: "5125550177", lead_type: "buyer", source: "website", source_family: "acquisition", source_channel: "digital", lifecycle_state: "raw", lead_stage: "new", is_active: true, ai_isa_owner: true, lead_score: 0, notes: CANARY_TAG, created_at: nowIso() }).select("id").single()
  const L = (ins as { id: string } | null)?.id ?? ""
  const invites = () => (svc.tables.portal_contact_invites ?? []).filter((r) => r.brokerage_id === B || JSON.stringify(r).includes(email))
  const otpCalls = () => (svc.canary.authCalls ?? []).length
  c.rule("144F", "RAW LEADS NEVER GET THE PORTAL INVITE (green — preserve): a captured lead (brokerage-owned, unqualified) has no portal_contact_invites row and no invite email", !insErr && invites().length === 0, `lead ${L}; invites ${invites().length}`)
  const { convertLeadToContact } = await import("../../lib/kernel/crm")
  const early = await convertLeadToContact({ leadId: L, brokerageId: B, agentId: AG, tcpaConsent: true, consentSource: CANARY_TAG })
  c.rule("144B", "THE PROMOTION IS GUARDED AT ITS WRITE (green — preserve): an unqualified lead is refused at the conversion door — no contact, no invite", !early.success && invites().length === 0, early.error ?? "converted")
  await svc.from("leads").update({ lead_stage: "qualified", lead_score: 80, lead_temperature: "hot", updated_at: nowIso() }).eq("id", L).eq("brokerage_id", B).select("id")
  const conv = await convertLeadToContact({ leadId: L, brokerageId: B, agentId: AG, tcpaConsent: true, consentSource: CANARY_TAG })
  const contact = (svc.tables.contacts ?? []).find((x) => x.id === conv.contactId)
  const inv = invites().filter((r) => r.contact_id === conv.contactId)
  // The welcome rides the agent → client rail (agent_client_messages.recipient_contact_id — the live column); the provider is the
  // harness's refusal, so an ATTEMPTED dispatch reads status 'failed' with its send_error (honest), never 'sent'.
  const welcomes = () => (svc.tables.agent_client_messages ?? []).filter((m) => m.recipient_contact_id === conv.contactId && m.brokerage_id === B)
  // WAVE 145 (ruling 17): the human-approved exception for a welcome no video can ride (the ONE approval queue).
  const exceptions = () => (svc.tables.approval_items ?? []).filter((a) => a.item_id === conv.contactId && a.brokerage_id === B && a.item_type === "welcome_without_video")
  c.rule("144F", "CONTACT → PORTAL INVITATION with the correct identity: the converted contact holds exactly ONE portal_contact_invites row under ITS tenant (brokerage_id) for ITS agent's contact — the access exists before (and regardless of) any video", conv.success && !!contact && inv.length === 1 && inv[0].brokerage_id === B, `${conv.error ?? ""} invites ${inv.length}${inv[0] ? ` (brokerage ${inv[0].brokerage_id === B ? "ok" : inv[0].brokerage_id})` : ""}`)
  c.rule("144F", "CONTACT → NO VIDEO CAN RIDE THE WELCOME (the agent has no avatar — today's live default) → the welcome is HELD (no welcome sent) and ONE pending human-approved exception is filed for this contact under its tenant — visible, recoverable, never falsely sent", welcomes().length === 0 && exceptions().length === 1 && exceptions()[0].status === "pending", `welcome rows ${welcomes().length}; exceptions ${exceptions().map((a) => a.status).join(",") || "none"}; intro video ${(svc.tables.agent_intro_videos ?? []).map((v) => `${v.status}${v.error_message ? ` — ${String(v.error_message).slice(0, 50)}` : ""}`).join(",") || "none"}`)
  const before = { inv: invites().length, welcomes: welcomes().length, otp: otpCalls(), exceptions: exceptions().length }
  const again = await convertLeadToContact({ leadId: L, brokerageId: B, agentId: AG, tcpaConsent: true, consentSource: CANARY_TAG })
  c.rule("144F", "NO DUPLICATE INVITE OR FIRST TOUCH ON A RETRIED EVENT (green — preserve): converting the same lead again returns the same contact and adds no invite, no welcome, no auth call — and (wave 145) no second exception", again.success && again.contactId === conv.contactId && invites().length === before.inv && welcomes().length === before.welcomes && otpCalls() === before.otp && exceptions().length === before.exceptions, JSON.stringify({ before, after: { inv: invites().length, welcomes: welcomes().length, otp: otpCalls(), exceptions: exceptions().length } }))

  c.blind("The welcome's email provider is not reached (the harness refuses OTP / provider calls), so 'dispatched' is the welcome RECORD on the agent → client rail, not a delivered email; the video render (D-ID / Remotion) is never commissioned for real — agent_voice_profiles is not seeded, which is today's live default (0 rows). Form-input → contact (captureFormSubmission) reaches the same converter tail and is the lead-magnet canary's chain.")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
