/**
 * lib/listing-presentation/prelisting-delivery.ts
 *
 * Wave 39 — GATE 2 (RELEASE). Producing the pre-listing presentation is
 * automatic (gate 1); RELEASING it to the seller is the single human gate. Once
 * every section render reaches a terminal state, the marketing manager surfaces
 * the ACTUAL finished product — the rendered avatar/voice videos + the
 * announcement email — into the Command Center. A human reviews what will really
 * go out and releases it ONCE per presentation. Nothing drips to the seller
 * until listing_presentations.delivery_approved_at is stamped.
 *
 * Control model (ai-compliance eval skill): an autonomous agent that speaks in
 * the agent's cloned voice + face may PRODUCE autonomously but must never
 * PUBLISH autonomously — the finished artifact is a release-blocker until a
 * human reviews it. Deadline behavior: escalate louder as the appointment nears,
 * but always HOLD — never auto-publish unreviewed creative.
 *
 * The compose + readiness logic is pure (unit-tested); the proposer/sweep use
 * the service client. Not server-only.
 */
import { createServiceClient } from "@/lib/supabase/service"

// ── Pure: render readiness ──────────────────────────────────────────────────

export interface SectionRenderRow {
  section_key:   string
  title:         string | null
  render_status: string | null   // null = no render attached (e.g. text-only)
  output_url:    string | null
  thumbnail_url: string | null
}

export interface ReadinessResult {
  ready:     boolean          // every attached render is terminal (none queued/rendering)
  succeeded: number
  pending:   number           // queued | rendering — gate must keep waiting
  failed:    number
  videos:    Array<{ section_key: string; title: string; output_url: string; thumbnail_url: string | null }>
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"])

/**
 * Pure: is the finished product ready for a human to review? Ready when no
 * attached render is still queued/rendering. We propose once renders settle and
 * at least one succeeded — the human reviews the real videos, not placeholders.
 */
export function evaluateRenderReadiness(rows: SectionRenderRow[]): ReadinessResult {
  let succeeded = 0, pending = 0, failed = 0
  const videos: ReadinessResult["videos"] = []
  for (const r of rows) {
    if (!r.render_status) continue                       // text-only section — nothing to wait on
    if (!TERMINAL.has(r.render_status)) { pending++; continue }
    if (r.render_status === "succeeded") {
      succeeded++
      if (r.output_url) videos.push({ section_key: r.section_key, title: r.title ?? r.section_key, output_url: r.output_url, thumbnail_url: r.thumbnail_url })
    } else { failed++ }
  }
  return { ready: pending === 0 && succeeded > 0, succeeded, pending, failed, videos }
}

// ── Pure: the announcement email the seller will receive on release ─────────

export interface EmailComposeInput {
  agentName:       string
  brokerageName:   string
  propertyAddress: string
  sectionTitles:   string[]
  portalUrl:       string
  /**
   * 'buyer' switches the copy to the buyer-consultation deck — a buyer has no
   * property being sold, so the seller wording ("plan to sell your home",
   * "your home's numbers") would make wrong claims to a client. Absent ⇒ the
   * seller copy, unchanged.
   */
  audience?:       "seller" | "buyer"
}
export interface ComposedEmail { subject: string; previewText: string; html: string; text: string }

/**
 * Pure: compose the client-facing announcement email. SELLER-SAFE on the seller
 * path — it sells the relationship + the market and points to the portal; the
 * home's value is deferred to the meeting (no price anywhere). The buyer path
 * announces the home-buying plan ahead of the consultation. Either way this is
 * the "email" a human reviews at gate 2 before it is ever sent.
 */
export function composePrelistingEmail(input: EmailComposeInput): ComposedEmail {
  const buyer = input.audience === "buyer"
  const addr = input.propertyAddress || "your home"
  const subject = buyer
    ? "Your personalized home-buying plan"
    : `Your personalized listing plan for ${addr}`
  const previewText = buyer
    ? `${input.agentName} built your home-buying plan — see it before our consultation.`
    : `${input.agentName} built a custom plan to sell ${addr} — see it before our meeting.`
  const items = input.sectionTitles.map((t) => `<li style="margin:4px 0">${escapeHtml(t)}</li>`).join("")
  const opening = buyer
    ? `Ahead of our consultation, I put together a personalized plan for your home search — financing, the homes that fit, offer strategy, and the path to closing — with a short video walking you through each part.`
    : `Ahead of our listing appointment, I put together a personalized plan to position and market <strong>${escapeHtml(addr)}</strong> in today's market — with a short video walking you through each part.`
  const closing = buyer
    ? `Bring your questions — we'll map the whole search together when we meet. Looking forward to it.`
    : `I'll walk you through your home's specific numbers when we meet. Looking forward to it.`
  const cta = buyer ? "Open your plan" : "Open your listing plan"
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#0F172A;line-height:1.5">
  <p>Hi,</p>
  <p>${opening}</p>
  <p>Inside your portal you'll find:</p>
  <ul>${items}</ul>
  <p><a href="${escapeAttr(input.portalUrl)}" style="display:inline-block;background:#F59E0B;color:#0F172A;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${cta}</a></p>
  <p>${closing}</p>
  <p>— ${escapeHtml(input.agentName)}<br/>${escapeHtml(input.brokerageName)}</p>
  </body></html>`
  const textOpening = buyer
    ? `Ahead of our consultation, I put together a personalized home-buying plan for you, with a short video for each part:`
    : `Ahead of our listing appointment, I put together a personalized plan to sell ${addr}, with a short video for each part:`
  const textClosing = buyer
    ? `Bring your questions — we'll map the whole search together when we meet.`
    : `I'll walk you through your home's specific numbers when we meet.`
  const text = `Hi,\n\n${textOpening}\n${input.sectionTitles.map((t) => ` • ${t}`).join("\n")}\n\n${cta}: ${input.portalUrl}\n\n${textClosing}\n\n— ${input.agentName}\n${input.brokerageName}`
  return { subject, previewText, html, text }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
}
function escapeAttr(s: string): string { return escapeHtml(s) }

// ── Proposer: surface the finished product for human release ────────────────

export interface ProposeDeliveryResult { proposed: boolean; ready?: boolean; actionId?: string; reason?: string }

/**
 * If the presentation's renders have settled and at least one succeeded, propose
 * the RELEASE into the Command Center — carrying the real video URLs + the
 * composed email so the human reviews the actual product. Idempotent: one open
 * release proposal per presentation; never re-proposes once released.
 */
export async function proposePrelistingDeliveryWhenReady(
  presentationId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<ProposeDeliveryResult> {
  const supabase = client ?? createServiceClient()

  const { data: pres } = await supabase
    .from("listing_presentations")
    .select("id, brokerage_id, contact_id, agent_user_id, property_address, appointment_at, delivery_approved_at, presentation_type")
    .eq("id", presentationId)
    .maybeSingle()
  if (!pres?.brokerage_id) return { proposed: false, reason: "presentation not found" }
  if (pres.delivery_approved_at) return { proposed: false, reason: "already released" }
  // Buyer-consultation decks ride the SAME gate: produce autonomously, release
  // by a human. Only the reviewed copy differs.
  const buyerDeck = (pres as { presentation_type?: string | null }).presentation_type === "buyer_consultation"

  // Idempotent — don't re-propose if a release for this presentation is open/done.
  const { data: existing } = await supabase
    .from("marketing_agent_actions")
    .select("id")
    .eq("brokerage_id", pres.brokerage_id)
    .eq("action_type", "approve_prelisting_delivery")
    .contains("action_input", { presentation_id: presentationId })
    .in("status", ["proposed", "approved", "executing", "succeeded"])
    .maybeSingle()
  if (existing) return { proposed: false, ready: true, actionId: (existing as { id: string }).id, reason: "already proposed" }

  // Join sections → their renders to evaluate readiness + collect finished videos.
  const { data: sections } = await supabase
    .from("presentation_sections")
    .select("section_key, title, render_id")
    .eq("presentation_id", presentationId)
    .order("section_order")
  const secList = (sections ?? []) as Array<{ section_key: string; title: string | null; render_id: string | null }>
  if (secList.length === 0) return { proposed: false, reason: "no sections" }

  const renderIds = secList.map((s) => s.render_id).filter((x): x is string => !!x)
  const renderById = new Map<string, { render_status: string | null; output_url: string | null; thumbnail_url: string | null }>()
  if (renderIds.length) {
    const { data: renders } = await supabase
      .from("remotion_composition_renders")
      .select("id, render_status, output_url, thumbnail_url")
      .in("id", renderIds)
    for (const r of (renders ?? []) as Array<{ id: string; render_status: string | null; output_url: string | null; thumbnail_url: string | null }>) {
      renderById.set(r.id, { render_status: r.render_status, output_url: r.output_url, thumbnail_url: r.thumbnail_url })
    }
  }
  const rows: SectionRenderRow[] = secList.map((s) => {
    const r = s.render_id ? renderById.get(s.render_id) : undefined
    return { section_key: s.section_key, title: s.title, render_status: r?.render_status ?? null, output_url: r?.output_url ?? null, thumbnail_url: r?.thumbnail_url ?? null }
  })
  const readiness = evaluateRenderReadiness(rows)
  if (!readiness.ready) return { proposed: false, ready: false, reason: `renders not ready (${readiness.pending} pending, ${readiness.succeeded} done)` }

  // Compose the announcement email the human will review.
  let agentName = "Your Agent", brokerageName = "Your Brokerage"
  if (pres.agent_user_id) {
    const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", pres.agent_user_id).maybeSingle()
    const full = [(u as { first_name?: string } | null)?.first_name, (u as { last_name?: string } | null)?.last_name].filter(Boolean).join(" ").trim()
    if (full) agentName = full
  }
  const { data: brk } = await supabase.from("brokerages").select("name").eq("id", pres.brokerage_id).maybeSingle()
  brokerageName = (brk as { name?: string } | null)?.name ?? brokerageName
  const appBase = (process.env.NEXT_PUBLIC_APP_URL ?? "https://app.example.com").replace(/\/$/, "")
  const portalUrl = buyerDeck && pres.contact_id
    ? `${appBase}/portal/${pres.contact_id}/journey`
    : `${appBase}/portal/listing-plan/${presentationId}`
  const email = composePrelistingEmail({
    agentName, brokerageName,
    propertyAddress: pres.property_address ?? "your home",
    sectionTitles:   secList.map((s) => s.title ?? s.section_key),
    portalUrl,
    audience:        buyerDeck ? "buyer" : "seller",
  })

  const { data: action, error } = await supabase
    .from("marketing_agent_actions")
    .insert({
      brokerage_id: pres.brokerage_id,
      action_type:  "approve_prelisting_delivery",
      action_input: {
        presentation_id: presentationId,
        appointment_at:  pres.appointment_at ?? null,
        property_address: pres.property_address ?? null,
        // Same key the email composer takes ("audience", not presentation_type) —
        // the Command Center reads it to label a buyer-consultation release as
        // such instead of showing seller wording for both deck types.
        audience:        buyerDeck ? "buyer" : "seller",
        video_renders:   readiness.videos,
        email:           { subject: email.subject, preview_text: email.previewText, preview_html: email.html },
      },
      rationale: buyerDeck
        ? `The finished buyer-consultation deck for this buyer is rendered (${readiness.succeeded} video${readiness.succeeded === 1 ? "" : "s"}) and the announcement email is drafted. Review the actual videos + email below, then RELEASE — the buyer sees nothing until you do.`
        : `The finished pre-listing presentation for ${pres.property_address ?? "this seller"} is rendered (${readiness.succeeded} video${readiness.succeeded === 1 ? "" : "s"}) and the announcement email is drafted. Review the actual videos + email below, then RELEASE — the seller sees nothing until you do.`,
      status: "proposed",
    })
    .select("id")
    .single()
  if (error || !action) return { proposed: false, ready: true, reason: error?.message ?? "insert failed" }
  return { proposed: true, ready: true, actionId: (action as { id: string }).id }
}

export interface SendEmailResult { sent: boolean; reason?: string }

/**
 * Send the seller-facing announcement email on RELEASE. Routes through the
 * canonical dispatchEmail so it passes the same suppression + de-conflict +
 * compliance gates as every other outbound. Seller-safe (no price). Best-effort:
 * a missing recipient/provider returns { sent:false } rather than throwing — the
 * presentation is already released and the portal drip still runs.
 */
export async function sendPrelistingAnnouncementEmail(
  presentationId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<SendEmailResult> {
  const supabase = client ?? createServiceClient()
  const { data: pres } = await supabase
    .from("listing_presentations")
    .select("id, brokerage_id, contact_id, agent_user_id, property_address, presentation_type")
    .eq("id", presentationId)
    .maybeSingle()
  if (!pres?.brokerage_id || !pres.contact_id) return { sent: false, reason: "no contact" }
  const buyerDeck = (pres as { presentation_type?: string | null }).presentation_type === "buyer_consultation"

  const { data: contact } = await supabase.from("contacts").select("email").eq("id", pres.contact_id).maybeSingle()
  const to = (contact as { email?: string | null } | null)?.email ?? null
  if (!to) return { sent: false, reason: "contact has no email" }

  let agentName = "Your Agent", from: string | null = null
  if (pres.agent_user_id) {
    const { data: u } = await supabase.from("users").select("first_name, last_name, email").eq("id", pres.agent_user_id).maybeSingle()
    const uu = u as { first_name?: string; last_name?: string; email?: string | null } | null
    const full = [uu?.first_name, uu?.last_name].filter(Boolean).join(" ").trim()
    if (full) agentName = full
    from = uu?.email ?? null
  }
  if (!from) return { sent: false, reason: "no from address" }

  const { data: brk } = await supabase.from("brokerages").select("name").eq("id", pres.brokerage_id).maybeSingle()
  const appBase2 = (process.env.NEXT_PUBLIC_APP_URL ?? "https://app.example.com").replace(/\/$/, "")
  const portalUrl = buyerDeck
    ? `${appBase2}/portal/${pres.contact_id}/journey`
    : `${appBase2}/portal/listing-plan/${presentationId}`
  const { data: sections } = await supabase
    .from("presentation_sections").select("section_key, title").eq("presentation_id", presentationId).order("section_order")
  const email = composePrelistingEmail({
    agentName,
    brokerageName:   (brk as { name?: string } | null)?.name ?? "Your Brokerage",
    propertyAddress: pres.property_address ?? "your home",
    sectionTitles:   ((sections ?? []) as Array<{ section_key: string; title: string | null }>).map((s) => s.title ?? s.section_key),
    portalUrl,
    audience:        buyerDeck ? "buyer" : "seller",
  })

  try {
    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const res = await dispatchEmail({
      brokerageId:    pres.brokerage_id,
      contactId:      pres.contact_id,
      from, to,
      subject:        email.subject,
      html:           email.html,
      text:           email.text,
      channelPurpose: "update",
      systemSource:   "prelisting_drip",
      metadata:       { presentation_id: presentationId },
    })
    return { sent: !!res.success, reason: res.success ? undefined : res.error }
  } catch (e) {
    return { sent: false, reason: (e as Error).message }
  }
}

export interface SweepResult { scanned: number; proposed: number; waiting: number }

/**
 * Drip-cron sweep: for every held presentation (delivery_approved_at IS NULL)
 * that has materialized sections, try to raise the gate-2 release proposal once
 * its renders settle. Idempotent across ticks (the proposer's open-proposal
 * guard). Best-effort per presentation — one failure never blocks the rest.
 */
export async function sweepPrelistingDeliveryGate(
  opts: { limit?: number } = {},
  client?: ReturnType<typeof createServiceClient>,
): Promise<SweepResult> {
  const supabase = client ?? createServiceClient()
  // Held presentations that have at least one scheduled section.
  const { data: held } = await supabase
    .from("presentation_sections")
    .select("presentation_id")
    .eq("status", "scheduled")
    .limit(500)
  const ids = Array.from(new Set((held ?? []).map((r: { presentation_id: string }) => r.presentation_id)))

  let proposed = 0, waiting = 0, scanned = 0
  for (const pid of ids.slice(0, opts.limit ?? 50)) {
    // Skip already-released presentations cheaply.
    const { data: p } = await supabase.from("listing_presentations").select("delivery_approved_at").eq("id", pid).maybeSingle()
    if ((p as { delivery_approved_at?: string | null } | null)?.delivery_approved_at) continue
    scanned++
    try {
      const res = await proposePrelistingDeliveryWhenReady(pid, supabase)
      if (res.proposed) proposed++
      else if (res.ready === false) waiting++
    } catch { /* per-presentation best-effort */ }
  }
  return { scanned, proposed, waiting }
}
