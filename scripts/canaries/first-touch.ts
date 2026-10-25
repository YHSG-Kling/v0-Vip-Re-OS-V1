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
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { findLanded } from "./_registry"

export async function run() {
  const c = canary("First touch: lead → CONTACT → portal invite + immediate welcome (+ the personal video when ready) · raw leads never invited · no duplicates on retry")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: an invite is an outbound email")

  // ── 1 · the timing rule (pure) ──
  const { decideWelcomeTiming, classifyPendingWelcome } = await import("../../lib/contact-promotion/conversion-welcome")
  const inFlight = decideWelcomeTiming({ commissioned: true, reason: "commissioned" })
  const noVideo = decideWelcomeTiming({ commissioned: false, reason: "agent_not_video_ready" })
  // Any "send now" arm holds (lane 144F landed `send_now_video_follows`: the welcome goes now AND arms the follow-up) — the rule is
  // "never waits on the render", not one spelling of the action.
  c.rule("144F", "THE WELCOME GOES NOW (ruling 13: 'dispatch the immediately available welcome and follow with the video when the real asset is ready'): with the agent's personal video render IN FLIGHT the welcome + portal information is dispatched immediately — it never waits on the render", /^send_now/.test(String(inFlight.action)), `HEAD: ${inFlight.action} — "${inFlight.reason}"`)
  c.rule("144F", "NO VIDEO POSSIBLE → THE WELCOME STILL GOES AT ONCE, without a video block or a promise of one (green — preserve)", /^send_now/.test(String(noVideo.action)), noVideo.reason)
  // WAVE144 WIRE (lane 144F notes, landed names): the sweeper's verdict takes the WELCOME's own state (WelcomeMessageState) and
  // answers send_video_follow_up / close_video_follow_up; deliverWelcomeVideoFollowUp sends it once (ledger cycle
  // welcome_video_follow_up). At HEAD the classifier ignores the welcome's state and releases the ONE waiting welcome.
  const followUp = findLanded(["lib/contact-promotion", "lib/kernel/client-welcome.ts", "app/api/cron/intro-video-email-backfill"], /\b(welcome_video_follow_?up|deliverWelcomeVideoFollowUp|send_video_follow_up)\b/)
  const base = { status: "rendering", composite: "landed" as const, hasRenderedUrl: true, videoOptOut: false, hasEmail: true }
  const landed = classifyPendingWelcome({ ...base, ageMs: 60_000, welcomeState: "sent" } as never) as { action: string; reason: string }
  const failedRender = classifyPendingWelcome({ ...base, ageMs: 10 * 3_600_000, hasRenderedUrl: false, composite: "pending", welcomeState: "sent" } as never) as { action: string; reason: string }
  c.rule("144F", "THE VIDEO FOLLOWS WHEN THE REAL ASSET LANDS: with the welcome already SENT and the approved personal video rendered, the sweeper's verdict is to send the video as the FOLLOW-UP (never a second welcome; one follow-up per contact) — and a render that never lands closes the follow-up instead of sending anything", followUp !== null && landed.action === "send_video_follow_up" && failedRender.action !== "send_video_follow_up" && !/^send_with_video$/.test(failedRender.action), `${followUp ? `follow-up at ${followUp}` : "HEAD: no follow-up video send"}; landed render (welcome sent) → ${landed.action}; render past the deadline → ${failedRender.action}`)

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
  c.rule("144F", "CONTACT → PORTAL INVITATION with the correct identity: the converted contact holds exactly ONE portal_contact_invites row under ITS tenant (brokerage_id) for ITS agent's contact — the access exists before (and regardless of) any video", conv.success && !!contact && inv.length === 1 && inv[0].brokerage_id === B, `${conv.error ?? ""} invites ${inv.length}${inv[0] ? ` (brokerage ${inv[0].brokerage_id === B ? "ok" : inv[0].brokerage_id})` : ""}`)
  c.rule("144F", "CONTACT → THE WELCOME IS DISPATCHED (a welcome message on the agent → client rail naming the portal, signed as the assigned agent) — immediately, not parked behind a render", welcomes().length === 1 && ["sent", "failed", "queued", "approved"].includes(String(welcomes()[0].status)), `welcome rows ${welcomes().length}${welcomes()[0] ? ` (${welcomes()[0].channel}/${welcomes()[0].status}${welcomes()[0].send_error ? `: ${String(welcomes()[0].send_error).slice(0, 60)}` : ""})` : ""}; intro video ${(svc.tables.agent_intro_videos ?? []).map((v) => `${v.status}${v.error_message ? ` — ${String(v.error_message).slice(0, 50)}` : ""}`).join(",") || "none"}`)
  const before = { inv: invites().length, welcomes: welcomes().length, otp: otpCalls() }
  const again = await convertLeadToContact({ leadId: L, brokerageId: B, agentId: AG, tcpaConsent: true, consentSource: CANARY_TAG })
  c.rule("144F", "NO DUPLICATE INVITE OR FIRST TOUCH ON A RETRIED EVENT (green — preserve): converting the same lead again returns the same contact and adds no invite, no welcome, no auth call", again.success && again.contactId === conv.contactId && invites().length === before.inv && welcomes().length === before.welcomes && otpCalls() === before.otp, JSON.stringify({ before, after: { inv: invites().length, welcomes: welcomes().length, otp: otpCalls() } }))

  c.blind("The welcome's email provider is not reached (the harness refuses OTP / provider calls), so 'dispatched' is the welcome RECORD on the agent → client rail, not a delivered email; the video render (D-ID / Remotion) is never commissioned for real — agent_voice_profiles is not seeded, which is today's live default (0 rows). Form-input → contact (captureFormSubmission) reaches the same converter tail and is the lead-magnet canary's chain.")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
