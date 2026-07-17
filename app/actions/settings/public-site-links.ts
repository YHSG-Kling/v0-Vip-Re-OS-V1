"use server"

// The DISCOVERABILITY fix for the zero-hosting website system (round-16
// archaeology: the /site, /team and /p public surfaces were fully built and
// intact — b74cdbc8, 0f312e46, 86651e07 — but no dashboard surface ever showed
// the tenant their own live URL). This action resolves the caller's public
// site links from the SAME slug columns the routes key on.

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export interface PublicSiteLinks {
  brokerageSite: { url: string; name: string } | null
  teamSite: { url: string; name: string } | null
  agentProfile: { url: string; name: string } | null
}

export async function getMyPublicSiteLinks(): Promise<
  { ok: true; links: PublicSiteLinks } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  const base = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const svc = createServiceClient()

  const links: PublicSiteLinks = { brokerageSite: null, teamSite: null, agentProfile: null }

  const { data: brk } = await svc
    .from("brokerages").select("slug, name").eq("id", ctx.brokerageId).maybeSingle()
  if (brk?.slug) links.brokerageSite = { url: `${base}/site/${brk.slug}`, name: brk.name ?? "Your brokerage" }

  if (ctx.agentId) {
    const { data: ag } = await svc
      .from("agents").select("public_slug, team_id").eq("id", ctx.agentId).maybeSingle()
    if (ag?.public_slug) {
      links.agentProfile = { url: `${base}/p/${ag.public_slug}`, name: "Your agent profile" }
    }
    if (ag?.team_id) {
      const { data: team } = await svc
        .from("teams").select("public_slug, name").eq("id", ag.team_id).maybeSingle()
      if (team?.public_slug) links.teamSite = { url: `${base}/team/${team.public_slug}`, name: team.name ?? "Your team" }
    }
  }

  return { ok: true, links }
}
