import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { loadBrandVoiceProfileAction } from "@/app/actions/brand-voice"
import { BrandVoiceEditor } from "./brand-voice-editor"

export const dynamic = "force-dynamic"

export default async function BrandVoicePage() {
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")
  // Page requires an agent context. Agents must have a resolved agentId.
  // Brokers/admins acting on behalf of agents need a brokerageId at minimum.
  // Any user who is not an agent and has no brokerage context cannot use this page.
  // Lane 90A: an account that still cannot self-provision lands on ONBOARDING
  // (which self-heals again and otherwise shows the setup flow), never on
  // /dashboard, whose router would only send it back here via onboarding.
  if (ctx.userType === "agent" && !ctx.agentId) redirect("/dashboard/onboarding")
  if (ctx.userType !== "agent" && !ctx.brokerageId) redirect("/dashboard/onboarding")

  const { profile } = await loadBrandVoiceProfileAction()

  return (
    <div className="container max-w-3xl mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">BrandVoice Profile</h1>
        <p className="text-muted-foreground mt-1">
          Define your communication style. The AI uses this profile to match your tone,
          avoid prohibited terms, and enforce Fair Housing compliance across all generated content.
        </p>
      </div>
      <BrandVoiceEditor initialProfile={profile ?? null} />
    </div>
  )
}
