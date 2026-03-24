/**
 * app/unsubscribe/page.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Kernel OS email/SMS unsubscribe endpoint.
 * URL: /unsubscribe?contactId={id}&channel=email|sms
 *
 * On confirm: updates contacts row, inserts suppression row, shows success.
 * No authentication required — link is sent in email footers.
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
