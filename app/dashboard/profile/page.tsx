import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { AgentSignaturePanel } from "@/app/dashboard/settings/components/os/agent-signature-panel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { User } from "lucide-react"
import { getAgentSettings } from "@/app/actions/agent-settings"
import { getSocialAccounts } from "@/app/actions/social-publishing"
import { getMyProfile, getMyAgentIdentity } from "@/app/actions/user-profile"
import { AgentIdentityCard } from "./agent-identity-card"
import { VideoSettingsCard, SocialAccountsCard, PersonalWebsiteCard } from "./profile-settings-client"

export const metadata = { title: "My Profile" }

export default async function AgentProfilePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, first_name, last_name, email, role, user_type, brokerage_id, email_signature")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const [agentSettings, socialAccounts, myProfile, identityRes] = await Promise.all([
    getAgentSettings(user.id),
    getSocialAccounts(user.id, profile.user_type ?? profile.role ?? "agent"),
    getMyProfile(),
    getMyAgentIdentity(),
  ])

  const resolvedRole = (profile.user_type ?? profile.role ?? "") as string
  const isAgent = ["agent", "team_lead", "isa"].includes(resolvedRole)

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">My Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your professional identity — what clients see on presentations, email, and your site.
        </p>
      </div>

      {/* WHO YOU ARE — walkthrough [44]: this card used to be read-only ("edit via
          admin"), which is why Profile read as just another Settings page. An agent's
          name, license, phone and bio are their professional identity; they own them. */}
      {identityRes.success ? (
        <AgentIdentityCard
          identity={identityRes.identity}
          email={profile.email ?? null}
          role={resolvedRole || null}
          isAgent={isAgent}
        />
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <User className="h-4 w-4" />
              Who you are
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Couldn&apos;t load your profile: {identityRes.error}
          </CardContent>
        </Card>
      )}

      {/* Personal real-estate website (canonical embed origin + blog byline) */}
      <PersonalWebsiteCard initialUrl={myProfile.profile?.personal_website_url ?? null} />

      {/* Personal email signature */}
      <AgentSignaturePanel currentSignature={profile.email_signature ?? null} />

      {/* D-ID avatar + ElevenLabs voice IDs */}
      <VideoSettingsCard
        userId={user.id}
        initialAvatarId={agentSettings.avatarId ?? null}
        initialVoiceId={agentSettings.voiceId ?? null}
      />

      {/* Social media account connections */}
      <SocialAccountsCard userId={user.id} initialAccounts={socialAccounts} />
    </main>
  )
}
