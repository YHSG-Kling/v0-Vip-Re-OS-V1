/**
 * lib/kernel/email-deliverability.ts
 *
 * EMAIL DELIVERABILITY GUARD (owner rule: "guarantee that the emails don't
 * end up in someone's junk or spam folders"). Honesty first: no one can
 * GUARANTEE the inbox — what the OS can guarantee is that every
 * controllable factor is enforced: (1) the sender domain is AUTHENTICATED
 * (SPF/DKIM via SendGrid domain authentication — probed read-only on the
 * go-live board; unauthenticated domains are the #1 junk-folder cause),
 * (2) every outbound draft is LINTED for the spam-filter triggers before
 * a human releases it (pure, deterministic — the approval queue shows the
 * risk), and (3) suppression hygiene already runs (bounces/complaints
 * never re-mailed — lib/platform/suppression-list). PURE lint; the probe
 * is read-only and provider-gated. compliance_officer owns send hygiene.
 */

export interface SpamLint {
  risk: "low" | "medium" | "high"
  reasons: string[]
}

const SPAM_PHRASES = /\b(act now|buy now|limited time only|100% free|risk[- ]free|no obligation|winner|congratulations you|click here now|once in a lifetime|double your|earn extra cash|guaranteed returns?|cash bonus|be your own boss)\b/i

/** PURE: the spam-filter triggers a HUMAN can fix before release. */
export function lintSpamRisk(subject: string | null, body: string): SpamLint {
  const reasons: string[] = []
  const subj = (subject ?? "").trim()

  if (subj && subj === subj.toUpperCase() && /[A-Z]{4,}/.test(subj)) reasons.push("Subject is ALL CAPS — a classic filter trigger.")
  if ((subj.match(/!/g) ?? []).length >= 2 || (body.match(/!{2,}/g) ?? []).length > 0) reasons.push("Stacked exclamation marks read as promotional.")
  if (SPAM_PHRASES.test(`${subj} ${body}`)) reasons.push("Contains a known spam-trigger phrase (act now / 100% free / guaranteed…).")
  const links = (body.match(/https?:\/\//g) ?? []).length
  if (links > 3) reasons.push(`${links} links — link-heavy mail scores worse; keep it to 1–2.`)
  if (/\$\$\$|£££|€€€/.test(body)) reasons.push("Currency-symbol runs ($$$) trigger filters.")
  const capsWords = (body.match(/\b[A-Z]{5,}\b/g) ?? []).length
  if (capsWords >= 3) reasons.push("Multiple SHOUTED words in the body.")
  if (body.trim().length < 40) reasons.push("Very short body — thin content with a link looks like phishing.")

  const risk = reasons.length === 0 ? "low" : reasons.length <= 2 ? "medium" : "high"
  return { risk, reasons }
}

/** READ-ONLY: is at least one SendGrid sender domain fully authenticated
 *  (SPF+DKIM valid)? Provider-gated; never mutates anything. */
export async function probeSendgridDomainAuth(): Promise<
  | { status: "ready"; detail: string }
  | { status: "broken"; detail: string }
  | { status: "not_configured"; detail: string }
> {
  const key = process.env.SENDGRID_API_KEY
  if (!key) return { status: "not_configured", detail: "SENDGRID_API_KEY unset — email sends and domain auth are both unavailable" }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/whitelabel/domains", {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) return { status: "broken", detail: `SendGrid domain list failed (${res.status})` }
    const domains = (await res.json()) as Array<{ domain?: string; valid?: boolean }>
    const valid = (domains ?? []).filter((x) => x.valid === true)
    if (valid.length > 0) return { status: "ready", detail: `Authenticated sender domain: ${valid.map((v) => v.domain).join(", ")} (SPF/DKIM valid — mail is signed, the junk-folder's #1 cause eliminated)` }
    if ((domains ?? []).length > 0) return { status: "broken", detail: "Sender domain exists but DNS is NOT validated — finish the CNAME records or mail lands in spam" }
    return { status: "broken", detail: "No authenticated sender domain — set up SendGrid domain authentication before any campaign" }
  } catch (e: any) {
    return { status: "broken", detail: e?.message ?? "SendGrid unreachable" }
  }
}
