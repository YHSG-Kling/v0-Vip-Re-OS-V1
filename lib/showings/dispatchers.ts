/**
 * lib/showings/dispatchers.ts
 *
 * Per-stop scheduling dispatchers — what the buyer agent sends to listing
 * agents to confirm a tour stop. Three channels:
 *
 *   ShowingTime — for brokerages that use it. We POST to their API to create
 *     a showing request; ShowingTime emails / texts the listing agent and
 *     sends back confirmation via webhook.
 *
 *   SMS         — direct text to listing_agent_phone. Twilio if the brokerage
 *     has it configured; otherwise we return a draft the agent can copy.
 *
 *   Email       — to listing_agent_email. SendGrid if configured; otherwise
 *     a draft the agent can paste into their normal mail client.
 *
 * Each dispatcher takes a stop + tour context and returns either a
 * "sent" result (provider receipt) or a "draft" result (subject+body for
 * the agent to send manually).
 */

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

/**
 * Channels:
 *   showingtime — POST to ShowingTime API
 *   sms         — Twilio when configured; otherwise return an `sms:` deep
 *                 link the agent opens on their phone (sends from agent's
 *                 actual cell so listing-agent replies go directly to them)
 *   email       — Send via the agent's connected Gmail/Outlook OAuth first
 *                 (so it lands in the listing-agent's inbox from the
 *                 buyer-agent's real address); fallback SendGrid; final
 *                 fallback `mailto:` deep link.
 */
export type DispatchChannel = "showingtime" | "sms" | "email"

export interface DispatchContext {
  stop: {
    id: string
    property_address: string | null
    city: string | null
    state: string | null
    zip: string | null
    listing_agent_name: string | null
    listing_agent_phone: string | null
    listing_agent_email: string | null
    listing_agent_company: string | null
    suggested_time: string | null
    suggested_duration_minutes: number | null
  }
  tour: {
    id: string
    tour_date: string | null
    start_time: string | null
  }
  buyerAgent: {
    fullName: string
    phone: string | null
    email: string | null
    licenseNumber: string | null
    brokerageName: string | null
  }
  buyer: {
    firstName: string | null
    lastName:  string | null
    /** True if the buyer's financial-verification gate has passed. Surfaced
     *  in the message so the listing agent knows the buyer is real. */
    isVerified: boolean
  }
}

export interface DispatchResult {
  /** Provider's record ID if the channel actually fired (ShowingTime
   *  request id, Twilio message sid, SendGrid message id). null when the
   *  brokerage has no credentials and we returned a draft for manual send. */
  providerRef: string | null
  /** Channel-shaped payload — agent reviews/edits before sending if no
   *  provider credentials are present. */
  draft: {
    to:      string  // phone OR email OR "(ShowingTime)"
    subject?: string // email only
    body:    string
  }
  /** Whether the dispatcher actually transmitted, vs. handed back a draft. */
  sent: boolean
  /** Optional native deep link for the agent to tap on their phone:
   *    sms:+15551234567?body=...   for SMS (sends from their cell)
   *    mailto:agent@x.com?subject=...&body=...   for email (uses default mail app)
   *  Populated when no provider credentials are present so the UI can show
   *  a one-tap "Open Messages" / "Open Mail" button alongside the draft. */
  deepLink?: string
  /** Provider that actually sent (or would have): 'gmail' | 'outlook' |
   *  'sendgrid' | 'twilio' | 'showingtime' | null when only a draft. */
  via?: string | null
}

// ─── ShowingTime ─────────────────────────────────────────────────────────────

/**
 * Calls the ShowingTime API to schedule a showing. The api key is resolved by the caller
 * through the unified ownership cascade (resolveScopedConnection: agent → team → brokerage →
 * platform), so a ShowingTime key connected in the Connection Center is what's used here.
 * Egress goes through the connector-gateway (callConnector) like every other provider — never a
 * bespoke fetch. Returns the ShowingTime appointment ID on success.
 *
 * NOTE: ShowingTime's public API is partner-only. This implementation uses the published REST
 * shape (POST /v2/appointments). When no credential is connected we still return a stable draft
 * so the agent can manually create the request inside ShowingTime's web UI.
 */
export async function dispatchViaShowingTime(
  ctx: DispatchContext,
  apiKey: string | null,
): Promise<DispatchResult> {
  const draftBody = buildShowingRequestBody(ctx)
  const draft = {
    to:      "(ShowingTime)",
    subject: `Showing request — ${ctx.stop.property_address}`,
    body:    draftBody,
  }

  if (!apiKey) {
    return { providerRef: null, draft, sent: false }
  }

  const res = await callConnector<{ id?: string }>({
    connector: "showingtime",
    baseUrl:   "https://api.showingtime.com",
    path:      "/v2/appointments",
    method:    "POST",
    auth:      { style: "bearer", token: apiKey },
    body: {
      property: {
        address: ctx.stop.property_address,
        city:    ctx.stop.city,
        state:   ctx.stop.state,
        zip:     ctx.stop.zip,
      },
      requested_at:        ctx.tour.tour_date && ctx.stop.suggested_time
        ? `${ctx.tour.tour_date}T${ctx.stop.suggested_time}`
        : null,
      duration_minutes:    ctx.stop.suggested_duration_minutes ?? 30,
      buyer_agent_name:    ctx.buyerAgent.fullName,
      buyer_agent_phone:   ctx.buyerAgent.phone,
      buyer_agent_email:   ctx.buyerAgent.email,
      buyer_agent_license: ctx.buyerAgent.licenseNumber,
      buyer_brokerage:     ctx.buyerAgent.brokerageName,
      notes:               draftBody,
    },
  })

  // Fall back to draft on any non-200; agent can complete manually.
  if (!res.ok || !res.data?.id) {
    return { providerRef: null, draft, sent: false }
  }
  return { providerRef: res.data.id, draft, sent: true }
}

// ─── SMS ─────────────────────────────────────────────────────────────────────

/** Builds the SMS body the buyer agent sends to the listing agent. Kept
 *  short — under one SMS segment when possible. Buyer name used not full
 *  contact details. */
export function buildSmsTemplate(ctx: DispatchContext): string {
  const time = ctx.stop.suggested_time
    ? formatTimeShort(ctx.stop.suggested_time)
    : "TBD"
  const dur  = ctx.stop.suggested_duration_minutes ?? 30
  const date = ctx.tour.tour_date
    ? new Date(ctx.tour.tour_date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "TBD"
  const verified = ctx.buyer.isVerified ? " (financially verified)" : ""

  return [
    `Hi${ctx.stop.listing_agent_name ? " " + ctx.stop.listing_agent_name.split(" ")[0] : ""},`,
    `${ctx.buyerAgent.fullName} here from ${ctx.buyerAgent.brokerageName ?? "[brokerage]"}.`,
    `Looking to show ${ctx.stop.property_address} to my buyer${verified} on ${date} at ${time} (${dur} min).`,
    `Does that work? Reply YES or suggest a time.`,
  ].join(" ")
}

/**
 * SMS dispatcher. Default behaviour is to return an `sms:` deep link the
 * agent taps on their phone — that way the message goes from the agent's
 * REAL cell number and replies route directly back to them, not to a
 * Twilio number that has to forward.
 *
 * If the brokerage has Twilio credentials AND wants centralized sending,
 * we fall back to Twilio and use the agent's profile phone as caller-ID
 * display when the from-number is set up for verified caller-ID.
 */
export async function dispatchViaSms(
  ctx: DispatchContext,
  twilio: { accountSid: string | null; authToken: string | null; fromNumber: string | null } | null,
): Promise<DispatchResult> {
  const body  = buildSmsTemplate(ctx)
  const phone = ctx.stop.listing_agent_phone
  const draft = { to: phone ?? "", body }

  // Always build the `sms:` deep link — the UI can offer it as a one-tap
  // "Open Messages" button regardless of whether Twilio is configured.
  const deepLink = phone
    ? `sms:${phone}${typeof navigator !== "undefined" && /iPhone|iPad/.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(body)}`
    : undefined

  if (!phone) {
    return { providerRef: null, draft, sent: false, deepLink, via: null }
  }

  // If Twilio not configured, return draft + deep link — agent sends from phone.
  if (!twilio?.accountSid || !twilio.authToken || !twilio.fromNumber) {
    return { providerRef: null, draft, sent: false, deepLink, via: null }
  }

  // Twilio path — automated send. Recipient still gets it from the
  // brokerage's Twilio number; replies route to the agent via Twilio's
  // forwarding rules (configured per brokerage).
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64")}`,
          "Content-Type":  "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: twilio.fromNumber,
          To:   phone,
          Body: body,
        }).toString(),
      },
    )
    if (!res.ok) return { providerRef: null, draft, sent: false, deepLink, via: null }
    const data = await res.json().catch(() => null) as { sid?: string } | null
    return {
      providerRef: data?.sid ?? null,
      draft,
      sent:        !!data?.sid,
      deepLink,    // still expose the deep-link in case agent prefers
      via:         data?.sid ? "twilio" : null,
    }
  } catch {
    return { providerRef: null, draft, sent: false, deepLink, via: null }
  }
}

// ─── Email ───────────────────────────────────────────────────────────────────

export function buildEmailTemplate(ctx: DispatchContext): { subject: string; body: string } {
  const time = ctx.stop.suggested_time ? formatTimeShort(ctx.stop.suggested_time) : "TBD"
  const dur  = ctx.stop.suggested_duration_minutes ?? 30
  const date = ctx.tour.tour_date
    ? new Date(ctx.tour.tour_date + "T00:00:00").toLocaleDateString(undefined, {
        weekday: "long", month: "long", day: "numeric",
      })
    : "TBD"
  const subject = `Showing request — ${ctx.stop.property_address}`
  const body = [
    `Hi${ctx.stop.listing_agent_name ? " " + ctx.stop.listing_agent_name.split(" ")[0] : ""},`,
    ``,
    `I'd like to show ${ctx.stop.property_address} to my buyer${ctx.buyer.isVerified ? " (financially verified)" : ""} on ${date} at ${time} (${dur} minutes).`,
    ``,
    `Please confirm whether this time works, or suggest an alternative. Access details welcome.`,
    ``,
    `Thanks,`,
    `${ctx.buyerAgent.fullName}`,
    ctx.buyerAgent.brokerageName ?? "",
    ctx.buyerAgent.phone ?? "",
    ctx.buyerAgent.email ?? "",
    ctx.buyerAgent.licenseNumber ? `License #${ctx.buyerAgent.licenseNumber}` : "",
  ].filter(Boolean).join("\n")
  return { subject, body }
}

/**
 * Email dispatcher. Priority order:
 *   1. Agent's connected Gmail/Outlook (via OAuth) — sends FROM the
 *      agent's actual address, replies route to their inbox naturally.
 *   2. SendGrid — sends from the agent's address as a regular email.
 *   3. `mailto:` deep link — agent's default mail client opens with
 *      subject + body pre-filled. Final fallback.
 *
 * Personal-OAuth email is the strongly preferred path because it builds
 * the agent's real-relationship history with the listing agent — the
 * thread lives in their actual mail account and replies thread cleanly.
 */
export async function dispatchViaEmail(
  ctx: DispatchContext,
  agentUserId: string | null,
  sendgridApiKey: string | null,
): Promise<DispatchResult> {
  const tpl = buildEmailTemplate(ctx)
  const to = ctx.stop.listing_agent_email ?? ""
  const draft = { to, subject: tpl.subject, body: tpl.body }

  const deepLink = to
    ? `mailto:${to}?subject=${encodeURIComponent(tpl.subject)}&body=${encodeURIComponent(tpl.body)}`
    : undefined

  if (!to) {
    return { providerRef: null, draft, sent: false, deepLink, via: null }
  }

  // 1. Try the agent's connected Gmail/Outlook OAuth account first.
  if (agentUserId) {
    try {
      const { sendPersonalEmail } = await import("@/lib/providers/email/personal-email-adapter")
      const personal = await sendPersonalEmail({
        agentUserId,
        to,
        subject:  tpl.subject,
        htmlBody: bodyToHtml(tpl.body),
        textBody: tpl.body,
      })
      if (personal.success) {
        return {
          providerRef: personal.messageId ?? null,
          draft,
          sent:        true,
          via:         personal.provider ?? "personal",
          deepLink,
        }
      }
      // If reason is 'no_personal_account' or 'token_refresh_failed',
      // fall through to SendGrid.
    } catch {
      // Continue to SendGrid fallback
    }
  }

  // 2. SendGrid fallback.
  if (sendgridApiKey && ctx.buyerAgent.email) {
    const res = await callConnector({
      connector: "sendgrid",
      baseUrl: "https://api.sendgrid.com",
      path: "/v3/mail/send",
      method: "POST",
      auth: { style: "bearer", token: sendgridApiKey },
      body: {
        personalizations: [{ to: [{ email: to }] }],
        from:             { email: ctx.buyerAgent.email, name: ctx.buyerAgent.fullName },
        reply_to:         { email: ctx.buyerAgent.email },
        subject:          tpl.subject,
        content:          [{ type: "text/plain", value: tpl.body }],
      },
    })
    if (res.ok) {
      return {
        providerRef: res.headers["x-message-id"] ?? null,
        draft,
        sent:        true,
        via:         "sendgrid",
        deepLink,
      }
    }
  }

  // 3. mailto: deep link — agent uses their default mail client.
  return { providerRef: null, draft, sent: false, deepLink, via: null }
}

function bodyToHtml(text: string): string {
  // Convert a plain-text body to a minimal HTML representation that
  // preserves line breaks. Gmail/Outlook adapters expect htmlBody.
  return `<div>${text.split("\n").map(l => l.length === 0 ? "<br>" : escapeHtml(l)).join("<br>")}</div>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildShowingRequestBody(ctx: DispatchContext): string {
  const time = ctx.stop.suggested_time ? formatTimeShort(ctx.stop.suggested_time) : "TBD"
  const dur  = ctx.stop.suggested_duration_minutes ?? 30
  const date = ctx.tour.tour_date
    ? new Date(ctx.tour.tour_date + "T00:00:00").toLocaleDateString(undefined, {
        weekday: "long", month: "long", day: "numeric",
      })
    : "TBD"
  return [
    `Buyer agent: ${ctx.buyerAgent.fullName}${ctx.buyerAgent.licenseNumber ? ` (License #${ctx.buyerAgent.licenseNumber})` : ""}`,
    `Brokerage:   ${ctx.buyerAgent.brokerageName ?? "—"}`,
    `Buyer:       ${[ctx.buyer.firstName, ctx.buyer.lastName].filter(Boolean).join(" ") || "(name withheld)"}${ctx.buyer.isVerified ? " — financially verified" : ""}`,
    `Property:    ${ctx.stop.property_address}`,
    `Date:        ${date}`,
    `Time:        ${time} (${dur} minutes)`,
    "",
    "Please confirm or propose an alternative time.",
  ].join("\n")
}

function formatTimeShort(t: string): string {
  const [hh, mm] = t.split(":").map(Number)
  if (hh == null || mm == null) return t
  const period = hh >= 12 ? "PM" : "AM"
  const h12 = hh % 12 || 12
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`
}
