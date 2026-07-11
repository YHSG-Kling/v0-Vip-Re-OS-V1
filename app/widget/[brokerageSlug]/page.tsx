import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { WidgetChatClient } from './widget-chat-client'
import { randomBytes } from 'crypto'

export const dynamic = 'force-dynamic'

// Minimal layout — no shared shell, no nav, safe to iframe
export default async function WidgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ brokerageSlug: string }>
  searchParams: Promise<{ team?: string; agent?: string }>
}) {
  const { brokerageSlug } = await params
  const sp = await searchParams
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

  // ── 2. Load the AI identity at the REQUESTED TIER (owner rule: the
  //    brokerage site answers as the brokerage's assistant, the team page
  //    as the TEAM's, the agent page as the AGENT's) — the same
  //    agent → team → brokerage cascade the video/phone identity uses.
  //    ?team=<teamSlug> / ?agent=<agentSlug> scope the widget; both must
  //    belong to THIS brokerage (a foreign slug falls back to brokerage).
  let identity: { assistant_name: string | null; avatar_url: string | null; tone: string | null; welcome_message: string | null } | null = null
  let entityName = brokerage.name

  if (sp.agent) {
    const { data: agentRow } = await supabase
      .from('agents')
      .select('id, team_id, users(first_name, last_name)')
      .eq('public_slug', sp.agent)
      .eq('brokerage_id', brokerage.id)
      .maybeSingle()
    if (agentRow) {
      const u = Array.isArray((agentRow as any).users) ? (agentRow as any).users[0] : (agentRow as any).users
      entityName = [u?.first_name, u?.last_name].filter(Boolean).join(' ') || brokerage.name
      const { data: p } = await supabase.from('ai_identity_profiles')
        .select('assistant_name, avatar_url, tone, welcome_message')
        .eq('scope_type', 'agent').eq('scope_id', (agentRow as any).id).maybeSingle()
      identity = p
      if (!identity && (agentRow as any).team_id) {
        const { data: tp } = await supabase.from('ai_identity_profiles')
          .select('assistant_name, avatar_url, tone, welcome_message')
          .eq('scope_type', 'team').eq('scope_id', (agentRow as any).team_id).maybeSingle()
        identity = tp
      }
    }
  } else if (sp.team) {
    const { data: teamRow } = await supabase
      .from('teams')
      .select('id, name')
      .eq('public_slug', sp.team)
      .eq('brokerage_id', brokerage.id)
      .maybeSingle()
    if (teamRow) {
      entityName = (teamRow as any).name ?? brokerage.name
      const { data: p } = await supabase.from('ai_identity_profiles')
        .select('assistant_name, avatar_url, tone, welcome_message')
        .eq('scope_type', 'team').eq('scope_id', (teamRow as any).id).maybeSingle()
      identity = p
    }
  }
  if (!identity) {
    const { data: p } = await supabase
      .from('ai_identity_profiles')
      .select('assistant_name, avatar_url, tone, welcome_message')
      .eq('scope_id', brokerage.id)
      .eq('scope_type', 'brokerage')
      .maybeSingle()
    identity = p
  }

  const assistantName  = identity?.assistant_name ?? 'AI Assistant'
  const assistantAvatar = identity?.avatar_url ?? null
  const accentColor    = brokerage.primary_color ?? '#1d4ed8'
  const welcomeMessage =
    identity?.welcome_message ??
    `Hi! I'm ${assistantName} from ${entityName}. Ask me anything about buying, selling, or local market conditions.`

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
        <title>{assistantName} — {entityName}</title>
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
