import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ReferralPanelClient } from "./referral-panel-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = {
  title: "Refer an Agent",
  description: "Share your personalized recruiting link and earn referral credit when someone joins.",
}

/**
 * /dashboard/agent/refer — agent-facing recruiting referral hub.
 *
 * Every agent gets a personalised link they can text/email/post:
 *   {APP_URL}/recruiting/{brokerage.slug}?ref={agent.id}
 *
 * When someone fills out the public landing page from that URL,
 * recruits.recruiter_agent_id is stamped automatically. Broker can see
 * who referred whom in /dashboard/recruiting-roi. The agent sees their
 * own pipeline of referrals on this page.
 */
export default async function AgentReferralPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const svc = createServiceClient()
  const [{ data: profile }, { data: agentRow }] = await Promise.all([
    svc.from("users").select("first_name, brokerage_id").eq("id", user.id).maybeSingle(),
    svc.from("agents").select("id").eq("user_id", user.id).maybeSingle(),
  ])
  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")
  if (!agentRow?.id) redirect("/dashboard/agent/setup")

  const { data: brokerage } = await svc
    .from("brokerages")
    .select("name, slug, recruiting_pitch")
    .eq("id", profile.brokerage_id)
    .maybeSingle()
  if (!brokerage?.slug) redirect("/dashboard/agent")

  // Pull this agent's referral pipeline
  const { data: referrals } = await svc
    .from("recruits")
    .select("id, first_name, last_name, email, status, created_at, provisioned, referral_source")
    .eq("recruiter_agent_id", agentRow.id)
    .order("created_at", { ascending: false })
    .limit(25)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.vipre.os"
  const referralUrl = `${appUrl}/recruiting/${brokerage.slug}?ref=${agentRow.id}`

  return (
    <ReferralPanelClient
      firstName={profile.first_name ?? null}
      brokerageName={brokerage.name}
      brokeragePitch={brokerage.recruiting_pitch ?? null}
      referralUrl={referralUrl}
      referrals={(referrals ?? []).map((r: any) => ({
        id:         r.id,
        firstName:  r.first_name,
        lastName:   r.last_name,
        email:      r.email,
        status:     r.status,
        createdAt:  r.created_at,
        provisioned: r.provisioned ?? false,
      }))}
    />
  )
}
