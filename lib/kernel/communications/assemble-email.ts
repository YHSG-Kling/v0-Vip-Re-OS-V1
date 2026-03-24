'use server'

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
}

/** Strip HTML tags for plain-text fallback */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

export async function assembleEmail(params: AssembleEmailParams): Promise<AssembledEmail> {
  const supabase = createServiceClient()

  // ── Load user signature ───────────────────────────────────────────────────
  let signatureHtml = ''
  let signatureText = ''

  const { data: brandSettings } = await supabase
    .from('brokerage_brand_settings')
    .select('email_signature_html')
    .eq('brokerage_id', params.brokerageId)
    .maybeSingle()

  if (brandSettings?.email_signature_html) {
    signatureHtml = brandSettings.email_signature_html
    signatureText = stripHtml(brandSettings.email_signature_html)
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
  }
}
