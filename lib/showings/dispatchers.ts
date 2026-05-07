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
}

// ─── ShowingTime ─────────────────────────────────────────────────────────────

/**
 * Calls the ShowingTime API to schedule a showing. Requires a brokerage-level
 * ShowingTime API key on the brokerage_credentials table. Returns the
 * ShowingTime appointment ID on success.
 *
 * NOTE: ShowingTime's public API is partner-only. This implementation uses
 * the published REST shape (POST /v2/appointments). When the brokerage has
 * no credentials we still return a stable draft so the agent can manually
 * create the request inside ShowingTime's web UI.
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

  try {
    const res = await fetch("https://api.showingtime.com/v2/appointments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
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
      }),
    })
    if (!res.ok) {
      // Fall back to draft on any non-200; agent can complete manually
      return { providerRef: null, draft, sent: false }
    }
    const data = await res.json().catch(() => null) as { id?: string } | null
    return {
      providerRef: data?.id ?? null,
      draft,
      sent:        !!data?.id,
    }
  } catch {
    return { providerRef: null, draft, sent: false }
  }
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
 * SMS dispatcher. Uses brokerage Twilio credentials when present; otherwise
 * returns the draft for manual send.
 */
export async function dispatchViaSms(
  ctx: DispatchContext,
  twilio: { accountSid: string | null; authToken: string | null; fromNumber: string | null } | null,
): Promise<DispatchResult> {
  const body = buildSmsTemplate(ctx)
  const draft = { to: ctx.stop.listing_agent_phone ?? "", body }

  const phone = ctx.stop.listing_agent_phone
  if (!phone || !twilio?.accountSid || !twilio.authToken || !twilio.fromNumber) {
    return { providerRef: null, draft, sent: false }
  }

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
    if (!res.ok) return { providerRef: null, draft, sent: false }
    const data = await res.json().catch(() => null) as { sid?: string } | null
    return { providerRef: data?.sid ?? null, draft, sent: !!data?.sid }
  } catch {
    return { providerRef: null, draft, sent: false }
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

/** Email dispatcher. Uses SendGrid when configured; otherwise returns draft. */
export async function dispatchViaEmail(
  ctx: DispatchContext,
  sendgridApiKey: string | null,
): Promise<DispatchResult> {
  const tpl = buildEmailTemplate(ctx)
  const draft = {
    to:      ctx.stop.listing_agent_email ?? "",
    subject: tpl.subject,
    body:    tpl.body,
  }

  if (!ctx.stop.listing_agent_email || !sendgridApiKey || !ctx.buyerAgent.email) {
    return { providerRef: null, draft, sent: false }
  }

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${sendgridApiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ctx.stop.listing_agent_email }] }],
        from:             { email: ctx.buyerAgent.email, name: ctx.buyerAgent.fullName },
        reply_to:         { email: ctx.buyerAgent.email },
        subject:          tpl.subject,
        content:          [{ type: "text/plain", value: tpl.body }],
      }),
    })
    return {
      providerRef: res.headers.get("x-message-id"),
      draft,
      sent:        res.ok,
    }
  } catch {
    return { providerRef: null, draft, sent: false }
  }
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
