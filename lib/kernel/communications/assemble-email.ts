/**
 * lib/kernel/communications/assemble-email.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Kernel OS mandatory email assembly order:
 *   body → user signature → unsubscribe block → legal disclosures
 *
 * RULE: This function MUST be called for:
 *   - manual email sends
 *   - AI-generated drafts
 *   - market update emails
 *   - newsletter and campaign email sends
 *   - ISA email follow-up
 *
 * The signature is ALWAYS below the body and ABOVE unsubscribe + legal.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface AssembleEmailParams {
  bodyHtml: string
  bodyText?: string
  userId: string
  brokerageId: string
  contactId?: string | null
  /** Controls whether unsubscribe block is appended */
  channelPurpose?: 'conversation' | 'campaign' | 'update' | 'transactional'
}

export interface AssembledEmail {
  html: string
  text: string
  /** Whether a user or brokerage signature was appended */
  signatureIncluded: boolean
  /** Whether an unsubscribe block was appended */
  unsubscribeIncluded: boolean
  /** Whether legal disclosures were appended */
  disclosuresIncluded: boolean
}

/** Strip HTML tags for plain-text fallback */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

export async function assembleEmail(params: AssembleEmailParams): Promise<AssembledEmail> {
  const supabase = createServiceClient()

  // ── Load signature: agent → team → brokerage waterfall ──────────────────
  // Kernel OS multi-tier order (most-specific wins):
  //   1. Per-user signature (users.email_signature) — solo agent or team member override
  //   2. Team-level signature (teams.branding_override.email_signature_html) — team tier
  //   3. Brokerage-level signature (brokerage_brand_settings.email_signature_html) — brokerage / multi-location default
  let signatureHtml = ''
  let signatureText = ''

  // 1. Try per-user signature
  const { data: userRow } = await supabase
    .from('users')
    .select('email_signature, team_id')
    .eq('id', params.userId)
    .maybeSingle()

  if (userRow?.email_signature) {
    signatureHtml = userRow.email_signature
    signatureText = stripHtml(userRow.email_signature)
  } else if (userRow?.team_id) {
    // 2. Team-level signature lives inside teams.branding_override JSONB
    const { data: team } = await supabase
      .from('teams')
      .select('branding_override')
      .eq('id', userRow.team_id)
      .maybeSingle()

    const teamSig = (team?.branding_override as any)?.email_signature_html
    if (teamSig) {
      signatureHtml = teamSig
      signatureText = stripHtml(teamSig)
    }
  }

  if (!signatureHtml) {
    // 3. Fall back to brokerage-level signature
    const { data: brandSettings } = await supabase
      .from('brokerage_brand_settings')
      .select('email_signature_html')
      .eq('brokerage_id', params.brokerageId)
      .maybeSingle()

    if (brandSettings?.email_signature_html) {
      signatureHtml = brandSettings.email_signature_html
      signatureText = stripHtml(brandSettings.email_signature_html)
    }
  }

  // ── Build unsubscribe block ───────────────────────────────────────────────
  // Only for conversation, campaign, and update channels (not transactional)
  let unsubscribeHtml = ''
  let unsubscribeText = ''

  const needsUnsubscribe =
    !params.channelPurpose || params.channelPurpose !== 'transactional'

  if (needsUnsubscribe && params.contactId) {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.vipagentos.com'
    const unsubUrl = `${baseUrl}/unsubscribe?contactId=${params.contactId}&channel=email`

    unsubscribeHtml = `
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;font-size:12px;color:#6b7280;">
  <p>You are receiving this email because you opted in to communications from our brokerage.</p>
  <p><a href="${unsubUrl}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a> from marketing emails</p>
</div>`

    unsubscribeText = `\n\n---\nYou are receiving this email because you opted in. To unsubscribe: ${unsubUrl}`
  }

  // ── Load legal disclosures ────────────────────────────────────────────────
  const legalDisclosureHtml = `
<div style="margin-top:8px;font-size:11px;color:#9ca3af;text-align:center;line-height:1.4;">
  <p>Equal Housing Opportunity. All information is deemed reliable but not guaranteed.</p>
</div>`

  const legalDisclosureText = '\n\nEqual Housing Opportunity. All information is deemed reliable but not guaranteed.'

  // ── Assemble in Kernel OS order ───────────────────────────────────────────
  // body → signature → unsubscribe → legal
  const htmlParts = [
    params.bodyHtml,
    signatureHtml,
    unsubscribeHtml,
    legalDisclosureHtml,
  ].filter(Boolean)

  const textParts = [
    params.bodyText ?? stripHtml(params.bodyHtml),
    signatureText,
    unsubscribeText,
    legalDisclosureText,
  ].filter(Boolean)

  return {
    html: htmlParts.join('\n\n'),
    text: textParts.join('\n\n'),
    signatureIncluded: !!signatureHtml,
    unsubscribeIncluded: needsUnsubscribe && !!params.contactId,
    disclosuresIncluded: true,
  }
}
