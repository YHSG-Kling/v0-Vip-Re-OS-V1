/**
 * app/unsubscribe/[token]/page.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The surface a person reaches by typing the code printed on a mail piece.
 *
 *   URL: /unsubscribe/{token}          e.g. /unsubscribe/K7M2NP4RQ8TVWX
 *   Printed as: vipagentos.com/unsubscribe/K7M2N-P4RQ8-TVWX   (42 chars)
 *
 * The token is normalised server-side, so the hyphenated printed form, lower
 * case, and the classic off-paper typos (O for 0, I or L for 1) all resolve to
 * the same recipient. A person should not be turned away by a font.
 *
 * NO AUTHENTICATION, and no id in the URL. The token names ONE recipient row of
 * ONE campaign; the brokerage, the lead and the contact are read off that row and
 * never accepted from the caller.
 *
 * NOTHING IS WRITTEN BY LOADING THIS PAGE. Mail gateways and chat clients fetch
 * URLs unbidden; an opt-out that fired on GET would suppress people who never
 * asked for it. The confirmation POST is the only write.
 */

import { Suspense } from "react"
import { MailUnsubscribeClient } from "./token-client"

export const metadata = {
  title: "Stop receiving mail",
  description: "Manage the mail you receive from us",
  // This page exists to be typed in off paper, never to be indexed.
  robots: { index: false, follow: false },
}

export default async function MailUnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      }
    >
      <MailUnsubscribeClient token={token} />
    </Suspense>
  )
}
