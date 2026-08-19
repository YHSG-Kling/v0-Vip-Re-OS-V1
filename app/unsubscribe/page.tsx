/**
 * app/unsubscribe/page.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEGACY email/SMS unsubscribe surface.
 * URL: /unsubscribe?contactId={id}&channel=email|sms|mail
 *
 * KEPT because `lib/kernel/communications/assemble-email.ts:126` stamps this
 * exact URL into the footer of every non-transactional email the product sends,
 * and delivered email cannot be recalled. It is repaired rather than removed —
 * see app/api/unsubscribe/route.ts for the full account of what was broken
 * (short version: it queried the wrong one of the two unique uuid columns on
 * `contacts`, so it never matched a real link, and its write would have been an
 * FK violation that supabase-js resolves and the writer discards).
 *
 * ITS CREDENTIAL IS AN ENTITY ID, WHICH IS NOT A SECRET. Anyone who is forwarded
 * one marketing email holds a working suppression capability for the original
 * addressee. That is inherent to the link shape and cannot be fixed here; every
 * suppression written through it is therefore labelled `email_footer_unverified`
 * in the compliance ledger.
 *
 * THE SHAPE THAT DOES NOT HAVE THAT PROBLEM is the per-recipient token:
 *   /unsubscribe/{token}  →  app/unsubscribe/[token]/page.tsx
 * one opaque 70-bit credential per mail piece, minted by m493, printable on a
 * postcard, revocable, and scoped to a single recipient of a single campaign.
 *
 * No authentication required on either — the caller is a member of the public.
 */

import { Suspense } from 'react'
import { UnsubscribeClient } from './unsubscribe-client'

export const metadata = {
  title: 'Unsubscribe',
  description: 'Manage your communication preferences',
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-muted-foreground">Loading...</p></div>}>
      <UnsubscribeClient />
    </Suspense>
  )
}
