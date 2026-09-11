// lib/embed/resolve-site-embed.ts
// ─────────────────────────────────────────────────────────────────────────────
// MOUNTS THE PUBLIC-WEBSITE SURFACE (owner ruling, wave 58, verbatim: "we are
// using d-id express v4 for live agent for website, widget, in portal as
// options"). Before this, the tenant's OWN public website (app/site/[slug],
// app/p/[agentSlug]) offered ONLY text chat — SiteChatLauncher pointed at
// /widget/[brokerageSlug], and that widget's own header records the D-ID live
// avatar being explicitly RETIRED there in m336 ("the real live/voice/talking
// agent is the EMBED widget"). Two of the owner's three named surfaces
// (website, widget) were both routed at the SAME text-only door; the
// embeddable-widget system (/embed/[publicId], embed_widgets) already carries
// the full D-ID Agents SDK experience (text/voice/live mode switching, lead
// capture) — this resolves the tenant's OWN active embed_widgets row so
// SiteChatLauncher can open THAT instead, reusing one live-agent
// implementation across both surfaces rather than building a second one (§6).
//
// Falls back to null (text-only /widget/[brokerageSlug]) when no active embed
// is configured — NEVER fabricates one. Configuring one is a real, existing
// action (Settings → Website Embeds); this only resolves what already exists.
//
// PREFERENCE ORDER: an embed scoped to THIS exact agent (the agent's own
// public profile) before a brokerage-wide one (the site's shared assistant) —
// never guesses across a different agent's likeness/voice (see
// app/api/embed/session/route.ts's own comment on why a brokerage-wide embed
// never silently borrows an agent's twin).

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface SiteLiveAgentEmbed {
  publicId: string
}

export async function resolveSiteLiveAgentEmbed(
  supabase: SupabaseClient,
  params: { brokerageId: string; agentId?: string | null },
): Promise<SiteLiveAgentEmbed | null> {
  if (params.agentId) {
    const { data: agentScoped } = await supabase
      .from("embed_widgets")
      .select("public_id")
      .eq("brokerage_id", params.brokerageId)
      .eq("agent_id", params.agentId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (agentScoped?.public_id) return { publicId: agentScoped.public_id }
  }

  const { data: brokerageWide } = await supabase
    .from("embed_widgets")
    .select("public_id")
    .eq("brokerage_id", params.brokerageId)
    .is("agent_id", null)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  return brokerageWide?.public_id ? { publicId: brokerageWide.public_id } : null
}
