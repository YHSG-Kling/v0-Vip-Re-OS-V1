/**
 * lib/marketing/home-value-email.ts
 *
 * Renders the "Your home is worth $X" email a past client receives quarterly
 * (and on each closing anniversary). Replaces the agent's HomeBot / Cloze /
 * Cash Offer subscription with a brand-compliant email that runs entirely
 * inside the platform — every send routes back to the AI ROI dashboard so
 * the agent sees exactly how much referral business it generated.
 *
 * Brand compliance: footer carries brokerage name + license # (when set) +
 * Equal Housing Opportunity attribution + a working unsubscribe link.
 * dispatchEmail() handles the actual TCPA / opt-out compliance gate.
 */

import type { AnnualHomeValueReport } from "@/lib/marketing/annual-home-value-report"

export interface HomeValueEmailContext {
  report:           AnnualHomeValueReport
  brokerage: {
    name:           string
    logoUrl:        string | null
    licenseNumber:  string | null
    licenseState:   string | null
    primaryColor:   string | null
  }
  agent: {
    firstName:      string | null
    lastName:       string | null
    email:          string | null
    phone:          string | null
    photoUrl:       string | null
  }
  /** Cadence label shown in the subject + intro paragraph */
  cadence:          "anniversary" | "quarterly"
}

const dollars = (n: number | null) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export function buildHomeValueEmailSubject(ctx: HomeValueEmailContext): string {
  const { report, cadence } = ctx
  if (cadence === "anniversary") {
    const yr = report.yearsOwned
    return `Your ${report.propertyAddress.split(",")[0]} home — ${yr} year${yr === 1 ? "" : "s"} later`
  }
  return `Your ${report.propertyAddress.split(",")[0]} home is worth ${dollars(report.currentEstimatedValue)}`
}

export function buildHomeValueEmailHtml(ctx: HomeValueEmailContext): string {
  const { report, brokerage, agent, cadence } = ctx
  const accentColor = brokerage.primaryColor ?? "#4f46e5"
  const agentName   = [agent.firstName, agent.lastName].filter(Boolean).join(" ") || "Your agent"
  const greeting    = report.contactName.split(" ")[0] || "there"

  const equityRow =
    report.estimatedEquity != null && report.estimatedEquity > 0
      ? `<tr><td style="padding:8px 16px;color:#374151;font-size:14px">Estimated equity gained</td>
         <td style="padding:8px 16px;color:#059669;font-size:18px;font-weight:600;text-align:right">+${dollars(report.estimatedEquity)}</td></tr>`
      : ""
  const apprRow =
    report.estimatedAppreciationPercent != null
      ? `<tr><td style="padding:8px 16px;color:#374151;font-size:14px">Appreciation since purchase</td>
         <td style="padding:8px 16px;color:#1f2937;font-size:14px;text-align:right">${report.estimatedAppreciationPercent.toFixed(1)}%</td></tr>`
      : ""

  const intro = cadence === "anniversary"
    ? `Happy ${report.yearsOwned}-year homeowniversary, ${escape(greeting)} — here's a fresh look at where your home stands today.`
    : `Hope you're doing well, ${escape(greeting)}. Here's a quarterly check-in on your home's estimated value.`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escape(buildHomeValueEmailSubject(ctx))}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px">

        <!-- Header band -->
        <tr><td style="padding:24px 24px 16px 24px;background:${accentColor};color:#ffffff">
          ${brokerage.logoUrl ? `<img src="${escape(brokerage.logoUrl)}" alt="${escape(brokerage.name)}" style="height:36px;width:auto;background:#fff;border-radius:6px;padding:4px"/>` : `<div style="font-size:18px;font-weight:600">${escape(brokerage.name)}</div>`}
        </td></tr>

        <!-- Headline -->
        <tr><td style="padding:32px 24px 8px 24px">
          <p style="margin:0 0 8px 0;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.05em">${cadence === "anniversary" ? `${report.yearsOwned}-year homeowniversary` : "Quarterly home value check-in"}</p>
          <h1 style="margin:0;color:#111827;font-size:28px;line-height:1.2;font-weight:700">
            Your home is worth approximately ${dollars(report.currentEstimatedValue)}
          </h1>
          <p style="margin:8px 0 0 0;color:#6b7280;font-size:14px">${escape(report.propertyAddress)}</p>
        </td></tr>

        <!-- Intro -->
        <tr><td style="padding:16px 24px 8px 24px">
          <p style="margin:0;color:#374151;font-size:15px;line-height:1.5">${intro}</p>
        </td></tr>

        <!-- Key numbers table -->
        <tr><td style="padding:8px 24px 16px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
            <tr><td style="padding:8px 16px;color:#374151;font-size:14px">Original purchase price</td>
                <td style="padding:8px 16px;color:#1f2937;font-size:14px;text-align:right">${dollars(report.originalPurchasePrice)}</td></tr>
            <tr><td style="padding:8px 16px;color:#374151;font-size:14px;background:#f9fafb">Estimated value today</td>
                <td style="padding:8px 16px;color:#1f2937;font-size:14px;font-weight:600;text-align:right;background:#f9fafb">${dollars(report.currentEstimatedValue)}</td></tr>
            ${equityRow}
            ${apprRow}
            <tr><td style="padding:8px 16px;color:#6b7280;font-size:12px" colspan="2">Based on ${report.comparablesUsed} comparable sale${report.comparablesUsed === 1 ? "" : "s"} in your area.</td></tr>
          </table>
        </td></tr>

        <!-- Market summary -->
        <tr><td style="padding:8px 24px 16px 24px">
          <p style="margin:0;color:#374151;font-size:14px;line-height:1.5">${escape(report.marketSummary)}</p>
        </td></tr>

        <!-- Agent recommendation + CTA -->
        <tr><td style="padding:16px 24px 8px 24px;background:#f9fafb">
          <p style="margin:0 0 12px 0;color:#1f2937;font-size:14px;line-height:1.5">${escape(report.agentRecommendation)}</p>
          <a href="${agent.email ? `mailto:${encodeURIComponent(agent.email)}?subject=${encodeURIComponent("Question about my home value")}` : "#"}" style="display:inline-block;padding:10px 18px;background:${accentColor};color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600">Talk to ${escape(agentName)}</a>
          ${agent.phone ? `<a href="tel:${escape(agent.phone)}" style="display:inline-block;margin-left:8px;padding:10px 18px;background:#ffffff;border:1px solid #d1d5db;color:#1f2937;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600">${escape(agent.phone)}</a>` : ""}
        </td></tr>

        <!-- Agent signature -->
        <tr><td style="padding:24px 24px 8px 24px;border-top:1px solid #e5e7eb">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              ${agent.photoUrl ? `<td width="56" style="vertical-align:top"><img src="${escape(agent.photoUrl)}" alt="${escape(agentName)}" width="48" height="48" style="border-radius:24px;display:block"/></td>` : ""}
              <td style="vertical-align:top">
                <p style="margin:0;color:#111827;font-size:14px;font-weight:600">${escape(agentName)}</p>
                <p style="margin:2px 0 0 0;color:#6b7280;font-size:12px">${escape(brokerage.name)}${brokerage.licenseNumber ? ` · Lic #${escape(brokerage.licenseNumber)}${brokerage.licenseState ? ` (${escape(brokerage.licenseState)})` : ""}` : ""}</p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Legal footer (Equal Housing + unsubscribe placeholder) -->
        <tr><td style="padding:16px 24px 24px 24px;color:#9ca3af;font-size:11px;line-height:1.5">
          <p style="margin:0 0 6px 0">⌂ Equal Housing Opportunity. This is an estimate based on automated valuation models and recent comparable sales — actual market value may vary.</p>
          <p style="margin:0">{{ unsubscribe_block }}</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}
