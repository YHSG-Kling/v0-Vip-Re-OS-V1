import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { WidgetChatClient } from './widget-chat-client'
import { randomBytes } from 'crypto'

export const dynamic = 'force-dynamic'

// Minimal layout — no shared shell, no nav, safe to iframe
export default async function WidgetPage({
  params,
}: {
  params: Promise<{ brokerageSlug: string }>
}) {
  const { brokerageSlug } = await params
  const supabase = await createClient()

  // ── 1. Load brokerage by slug ─────────────────────────────────────────────
  const { data: brokerage, error: brokerageError } = await supabase
    .from('brokerages')
    .select('id, name, slug, widget_enabled, primary_color')
    .eq('slug', brokerageSlug)
    .single()

  if (brokerageError || !brokerage || brokerage.widget_enabled === false) {
    notFound()
  }

  // ── 2. Load AI identity profile for this brokerage ────────────────────────
  const { data: identity } = await supabase
    .from('ai_identity_profiles')
    .select('assistant_name, avatar_url, tone, welcome_message')
    .eq('scope_id', brokerage.id)
    .eq('scope_type', 'brokerage')
    .maybeSingle()

  const assistantName  = identity?.assistant_name ?? 'AI Assistant'
  const assistantAvatar = identity?.avatar_url ?? null
  const accentColor    = brokerage.primary_color ?? '#1d4ed8'
  const welcomeMessage =
    identity?.welcome_message ??
    `Hi! I'm ${assistantName} from ${brokerage.name}. Ask me anything about buying, selling, or local market conditions.`

  // ── 3. Generate a one-time session token (persisted by the session API) ───
  //    The client calls POST /api/widget/session on mount to create the DB row.
  //    We pre-generate the token server-side so it can be baked into the page.
  const sessionToken = randomBytes(24).toString('hex')

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{assistantName} — {brokerage.name}</title>
      </head>
      <body style={{ margin: 0, padding: 0, height: '100%', overflow: 'hidden' }}>
        <WidgetChatClient
          brokerageSlug={brokerageSlug}
          sessionToken={sessionToken}
          config={{
            assistantName,
            assistantAvatar,
            brokerageName: brokerage.name,
            accentColor,
            welcomeMessage,
          }}
        />
      </body>
    </html>
  )
}
