// lib/home-value/report-email.ts
//
// THE SELLER'S OWN REPORT, BY EMAIL — pure composition, no I/O.
//
// The owner's ruling: "the report will show up in their portal and also an email will
// be sent with it ... both the email and the portal will be given a way to schedule a
// listing appotintment as well which needs to be atleast 7 days out."
//
// TWO RULES THIS FILE EXISTS TO HOLD.
//
//  1. EVERY FIGURE IS PASSED IN, NEVER DERIVED. This composer does no arithmetic on
//     value: the caller reads the stored `home_value_estimates` row and hands the low /
//     mid / high / confidence / methodology it found. That is why the email and the
//     portal card cannot disagree — there is exactly one source and neither surface
//     recomputes it. If the range is not there, the caller does not send; this file
//     will never invent a number to fill a gap.
//
//  2. THE METHOD IS NAMED IN THE EMAIL. When the stored methodology is
//     'sqft_regional_average' no comparable sale could be sourced and the range is
//     square footage times a regional rate. The email says exactly that, in the
//     seller's words, instead of dressing it up as a comparative market analysis.
//
// SELLER-SAFETY, and the distinction that is easy to get backwards: this email SHOWS
// the seller their own estimated value. That is the product they asked for. It is NOT
// the pre-listing presentation drip (lib/listing-presentation/section-drip.ts), which
// is deliberately price-withheld because it is marketing that runs BEFORE the meeting.
// Two different artefacts, two different disciplines; neither leaks into the other.
//
// The HTML is a FRAGMENT on purpose. dispatchEmail → assembleEmail appends the
// signature, the unsubscribe block and the legal disclosures to whatever body it is
// given, so a full <html> document would push all three outside the document.

import { LISTING_APPOINTMENT_MIN_LEAD_DAYS } from "./listing-appointment"

/** The stored figures, exactly as `home_value_estimates` holds them. */
export interface HomeValueReportEmailInput {
  /** Seller's first name, for the greeting. Blank falls back to a neutral opener. */
  firstName: string | null
  /** The subject property as the request recorded it. */
  propertyAddress: string
  estimatedValueLow: number
  estimatedValueMid: number
  estimatedValueHigh: number
  /** 0-100 as the column stores it. Null when the row carries none. */
  confidenceScore: number | null
  /** home_value_estimates.methodology — 'ai_cma' | 'sqft_regional_average' | … */
  methodology: string | null
  /** home_value_estimates.market_trend — 'unknown' is a real, printable answer. */
  marketTrend: string | null
  /** How many comparable sales the stored comps_json actually holds. */
  compsCount: number
  /** The stored narrative + disclaimers. Rendered verbatim, never rewritten. */
  aiNarrative: string | null
  /** The seller's own full report page (the same one the portal links to). */
  reportUrl: string
  /** The seller's portal home. Omitted when no portal could be provisioned. */
  portalUrl: string | null
  /** Deep link to the listing-appointment scheduler (the ≥7-day one). */
  listingAppointmentUrl: string
  /** Who this is from, for the closing line. Blank falls back to "your agent". */
  agentName: string | null
}

export interface ComposedHomeValueReportEmail {
  subject: string
  html: string
  text: string
}

const money = (n: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n)

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * How the number was produced, said plainly. The seller is told which of the two it
 * is, because "estimated value" means something different in each case.
 */
function methodSentence(methodology: string | null, compsCount: number): string {
  if (methodology === "ai_cma") {
    return compsCount > 0
      ? `This range comes from ${compsCount} recent comparable ${compsCount === 1 ? "sale" : "sales"} near you, each adjusted for the differences between that home and yours.`
      : `This range comes from recent comparable sales near you, adjusted for the differences between those homes and yours.`
  }
  if (methodology === "sqft_regional_average") {
    return (
      "We could not find enough recent comparable sales near your home to build a comparative market analysis, " +
      "so this range is a regional average price per square foot. It does not account for your home's condition, " +
      "upgrades, lot, or where it sits in the neighborhood — an in-person visit is what closes that gap."
    )
  }
  // Any other admitted methodology (attom / housecanary / manual): name it rather
  // than claim a CMA that was not run.
  return methodology
    ? `This range was produced by our ${methodology.replace(/_/g, " ")} valuation method.`
    : "This range is an estimate based on the property details you provided."
}

/** Market direction in seller language. 'unknown' stays unknown — it is a real answer. */
function trendSentence(marketTrend: string | null): string | null {
  switch (marketTrend) {
    case "appreciating":
      return "Prices in your area have been rising over the past year."
    case "depreciating":
      return "Prices in your area have been softening over the past year."
    case "stable":
      return "Prices in your area have held roughly flat over the past year."
    default:
      // 'unknown' or absent: we have no market_data row covering this ZIP or city.
      return null
  }
}

/**
 * Compose the seller's home-value report email. Pure: same input, same bytes out.
 */
export function composeHomeValueReportEmail(
  input: HomeValueReportEmailInput,
): ComposedHomeValueReportEmail {
  const addr = input.propertyAddress?.trim() || "your home"
  const greetingName = input.firstName?.trim() || null
  const agent = input.agentName?.trim() || "your agent"

  const low = money(input.estimatedValueLow)
  const mid = money(input.estimatedValueMid)
  const high = money(input.estimatedValueHigh)

  const method = methodSentence(input.methodology, input.compsCount)
  const trend = trendSentence(input.marketTrend)
  const confidence =
    typeof input.confidenceScore === "number"
      ? `Confidence in this range: ${Math.round(input.confidenceScore)}%.`
      : null

  const subject = `Your home value report — ${addr}`

  const narrativeParas = (input.aiNarrative ?? "")
    .split("\n\n")
    .map((p) => p.trim())
    .filter(Boolean)

  // ── HTML (fragment — assembleEmail appends signature / unsubscribe / legal) ──
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;color:#0F172A;line-height:1.55;max-width:600px">
  <p style="margin:0 0 16px">${greetingName ? `Hi ${escapeHtml(greetingName)},` : "Hi,"}</p>
  <p style="margin:0 0 20px">Here's the home value report you asked for on <strong>${escapeHtml(addr)}</strong>.</p>

  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #E2E8F0;border-radius:10px;background:#F8FAFC;margin:0 0 20px">
    <tr><td style="padding:22px 20px;text-align:center">
      <p style="margin:0 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#64748B">Estimated value</p>
      <p style="margin:0 0 6px;font-size:30px;font-weight:700;color:#0F172A">${escapeHtml(mid)}</p>
      <p style="margin:0;font-size:14px;color:#475569">Range ${escapeHtml(low)} &ndash; ${escapeHtml(high)}</p>
    </td></tr>
  </table>

  <p style="margin:0 0 14px;color:#334155">${escapeHtml(method)}</p>
  ${trend ? `<p style="margin:0 0 14px;color:#334155">${escapeHtml(trend)}</p>` : ""}
  ${confidence ? `<p style="margin:0 0 20px;font-size:13px;color:#64748B">${escapeHtml(confidence)}</p>` : ""}

  ${narrativeParas.map((p) => `<p style="margin:0 0 14px;color:#334155">${escapeHtml(p)}</p>`).join("\n  ")}

  <p style="margin:24px 0 10px">
    <a href="${escapeHtml(input.reportUrl)}" style="display:inline-block;background:#0F172A;color:#FFFFFF;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">View your full report</a>
  </p>
  ${
    input.portalUrl
      ? `<p style="margin:0 0 24px;font-size:14px;color:#475569">It's also waiting in your client portal, along with everything else on your sale: <a href="${escapeHtml(input.portalUrl)}" style="color:#1D4ED8">open your portal</a>.</p>`
      : ""
  }

  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #C7D2FE;border-radius:10px;background:#EEF2FF;margin:0 0 20px">
    <tr><td style="padding:20px">
      <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#1E1B4B">Ready to talk about actually selling?</p>
      <p style="margin:0 0 14px;font-size:14px;color:#3730A3">Book a listing appointment with ${escapeHtml(agent)} — the sit-down where you'll see the pricing strategy and the full marketing plan for ${escapeHtml(addr)}. We schedule these at least ${LISTING_APPOINTMENT_MIN_LEAD_DAYS} days out so there's time to prepare your listing plan properly before we meet.</p>
      <a href="${escapeHtml(input.listingAppointmentUrl)}" style="display:inline-block;background:#4338CA;color:#FFFFFF;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Schedule a listing appointment</a>
    </td></tr>
  </table>

  <p style="margin:0;font-size:12px;color:#94A3B8">This is an estimate for informational purposes, not an appraisal. Actual value depends on condition, upgrades, and what buyers are doing in your neighborhood right now.</p>
</div>`

  // ── Plain text (same figures, same order) ──
  const textLines = [
    greetingName ? `Hi ${greetingName},` : "Hi,",
    "",
    `Here's the home value report you asked for on ${addr}.`,
    "",
    `ESTIMATED VALUE: ${mid}`,
    `Range: ${low} - ${high}`,
    "",
    method,
    ...(trend ? [trend] : []),
    ...(confidence ? [confidence] : []),
    ...(narrativeParas.length ? ["", ...narrativeParas] : []),
    "",
    `View your full report: ${input.reportUrl}`,
    ...(input.portalUrl ? [`Open your portal: ${input.portalUrl}`] : []),
    "",
    `READY TO TALK ABOUT SELLING?`,
    `Book a listing appointment with ${agent} — the sit-down where you'll see the pricing strategy and the full marketing plan for ${addr}. We schedule these at least ${LISTING_APPOINTMENT_MIN_LEAD_DAYS} days out so there's time to prepare your listing plan properly before we meet.`,
    `Schedule: ${input.listingAppointmentUrl}`,
    "",
    "This is an estimate for informational purposes, not an appraisal. Actual value depends on condition, upgrades, and what buyers are doing in your neighborhood right now.",
  ]

  return { subject, html, text: textLines.join("\n") }
}
