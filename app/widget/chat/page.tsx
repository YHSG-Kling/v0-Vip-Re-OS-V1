// app/widget/chat/page.tsx
// Embeddable chat widget page — rendered inside an iframe by widget-loader.js.
// Receives: ?agent=AGENT_ID&brokerage=BROKERAGE_SLUG_OR_ID&position=right|left
// No auth required. Initializes a widget session, then streams AI responses.
//
// WHY THIS PAGE NOW RESOLVES INSTEAD OF THE CLIENT. The embed snippet in
// Settings → Widget bakes the brokerage's internal uuid into the host page, and
// the client used to POST that uuid to /api/widget/session as the tenant. The
// server already had everything it needed to answer that question itself, so it
// asks it here: the uuid (or slug) is resolved to the brokerage's PUBLIC slug
// server-side, and only the slug travels to the session route — which resolves
// it again and gates on widget_enabled + agent membership. Both spellings of
// ?brokerage= keep working, so no already-pasted embed snippet breaks.

import { Suspense } from "react"
import { createServiceClient } from "@/lib/supabase/service"
import WidgetChatClient from "./widget-chat-client"

export const metadata = {
  title: "Chat Widget",
  robots: { index: false },
}

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function WidgetChatPage({
  searchParams,
}: {
  searchParams: Promise<{ brokerage?: string; agent?: string; scope?: string; id?: string }>
}) {
  const sp = await searchParams

  // Same two param shapes the client used to read: ?agent= and ?scope=agent&id=.
  const requestedAgentId =
    sp.agent || (sp.scope === "agent" ? sp.id : undefined) || null
  const requestedBrokerage = sp.brokerage?.trim() ?? ""

  let brokerageSlug: string | null = null
  if (requestedBrokerage) {
    const supabase = createServiceClient()
    const query = supabase.from("brokerages").select("slug")
    const { data, error } = await (
      UUID_RE.test(requestedBrokerage)
        ? query.eq("id", requestedBrokerage)
        : query.eq("slug", requestedBrokerage)
    ).maybeSingle()
    if (error) console.error("[widget/chat] brokerage lookup failed:", error.message)
    brokerageSlug = data?.slug ?? null
  }

  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-sm text-gray-400">Loading...</div>}>
      <WidgetChatClient brokerageSlug={brokerageSlug} agentId={requestedAgentId} />
    </Suspense>
  )
}
