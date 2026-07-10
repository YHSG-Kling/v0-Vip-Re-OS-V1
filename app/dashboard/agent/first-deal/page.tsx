import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { FirstDealClient } from "./first-deal-client"

export const metadata = {
  title: "First Deal",
  description: "A guided path from your first contact to your first close.",
}

/**
 * /dashboard/agent/first-deal — the agent's "I just finished onboarding,
 * now how do I close my first deal?" surface.
 *
 * Server-loads every milestone signal from the live DB so each checkbox
 * reflects real completion state — no client polling, no stub flags.
 *
 * Milestones in order:
 *   1. Onboarding certified         → agent_onboarding.status='completed'
 *                                     or certification_achieved=true
 *   2. Avatar + voice cloned        → agent_voice_profiles has both
 *                                     elevenlabs_voice_id AND did_avatar_id
 *   3. Tech stack connected         → ≥1 connected provider per required type
 *                                     (sms, email, esign) on platform_credentials
 *   4. First contact added          → ≥1 contact owned by this agent
 *   5. BBA signed                   → ≥1 buyer_broker_agreement with signed_at
 *   6. First offer drafted          → ≥1 offer owned by this agent
 *   7. Under contract               → ≥1 transaction owned by this agent
 *   8. First close                  → ≥1 transaction.status='closed'
 *                                     or close_date <= today()
 */
export default async function FirstDealPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const svc = createServiceClient()

  // ── Resolve agent identity ─────────────────────────────────────────────────
  const { data: profile } = await svc
    .from("users")
    .select("brokerage_id, first_name")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const { data: agentRow } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  // ── Load every milestone signal in parallel ────────────────────────────────
  const agentRowId = agentRow?.id ?? null
  const brokerageId = profile.brokerage_id

  const [
    onboardingRes,
    voiceRes,
    techStackRes,
    contactCountRes,
    bbaCountRes,
    offerCountRes,
    underContractCountRes,
    closedCountRes,
  ] = await Promise.all([
    svc
      .from("agent_onboarding")
      .select("status, certification_achieved, completion_percentage")
      .eq("user_id", user.id)
      .maybeSingle(),

    agentRowId
      ? svc
          .from("agent_voice_profiles")
          .select("elevenlabs_voice_id, did_avatar_id")
          // agent_voice_profiles.agent_id FKs agents(id) — verified via
          // pg_constraint. NOT users.id.
          .eq("agent_id", agentRowId)
          .maybeSingle()
      : Promise.resolve({ data: null }),

    svc
      .from("platform_credentials")
      .select("platform, is_active")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true),

    agentRowId
      ? svc
          .from("contacts")
          .select("id", { count: "exact", head: true })
          .eq("agent_id", agentRowId)
          .is("deleted_at", null)
      : Promise.resolve({ count: 0 }),

    agentRowId
      ? svc
          .from("buyer_broker_agreements")
          .select("id", { count: "exact", head: true })
          .eq("agent_id", agentRowId)
          .not("signed_at", "is", null)
      : Promise.resolve({ count: 0 }),

    agentRowId
      ? svc
          .from("offers")
          .select("id", { count: "exact", head: true })
          .eq("agent_id", agentRowId)
      : Promise.resolve({ count: 0 }),

    agentRowId
      ? svc
          .from("transactions")
          .select("id", { count: "exact", head: true })
          .eq("agent_id", agentRowId)
      : Promise.resolve({ count: 0 }),

    agentRowId
      ? svc
          .from("transactions")
          .select("id", { count: "exact", head: true })
          .eq("agent_id", agentRowId)
          .or(`status.eq.closed,close_date.lte.${new Date().toISOString().slice(0, 10)}`)
      : Promise.resolve({ count: 0 }),
  ])

  // ── Tech-stack provider coverage ───────────────────────────────────────────
  // Map provider name → category (matches the integration-tester
  // PROVIDER_METADATA values). The required set is sms + email + esign.
  const SMS_PROVIDERS    = new Set(["twilio", "bandwidth", "vonage"])
  const EMAIL_PROVIDERS  = new Set(["sendgrid", "mailgun", "resend"])
  const ESIGN_PROVIDERS  = new Set(["docusign", "dotloop", "skyslope"])
  const connectedProviders = (techStackRes.data ?? []).map((p: any) => p.platform)
  const hasSms   = connectedProviders.some((p: string) => SMS_PROVIDERS.has(p))
  const hasEmail = connectedProviders.some((p: string) => EMAIL_PROVIDERS.has(p))
  const hasEsign = connectedProviders.some((p: string) => ESIGN_PROVIDERS.has(p))

  // ── Resolve every milestone to a boolean ───────────────────────────────────
  const onboarding = onboardingRes.data
  const voice      = voiceRes.data

  const milestones = {
    onboardingCertified:
      onboarding?.status === "completed" || onboarding?.certification_achieved === true,
    avatarVoiceReady:
      !!voice?.elevenlabs_voice_id && !!voice?.did_avatar_id,
    techStackConnected: hasSms && hasEmail && hasEsign,
    firstContactAdded:  (contactCountRes.count ?? 0) > 0,
    bbaSigned:          (bbaCountRes.count ?? 0) > 0,
    firstOfferDrafted:  (offerCountRes.count ?? 0) > 0,
    underContract:      (underContractCountRes.count ?? 0) > 0,
    firstClose:         (closedCountRes.count ?? 0) > 0,
  }

  return (
    <FirstDealClient
      firstName={profile.first_name ?? null}
      milestones={milestones}
      onboardingPercent={onboarding?.completion_percentage ?? 0}
      techStackDetail={{ hasSms, hasEmail, hasEsign }}
      agentHasRow={agentRowId !== null}
    />
  )
}
