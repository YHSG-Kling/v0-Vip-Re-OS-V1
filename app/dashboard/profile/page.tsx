import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { AgentSignaturePanel } from "@/app/dashboard/settings/components/os/agent-signature-panel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { User } from "lucide-react"

export const metadata = { title: "My Profile | Settings" }

export default async function AgentProfilePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, first_name, last_name, email, role, brokerage_id, email_signature")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  return (
    <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">My Profile</h1>
        <p className="text-sm text-muted-foreground">
          Manage your personal settings and email signature.
        </p>
      </div>

      {/* Identity summary — read-only, edit via admin */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <User className="h-4 w-4" />
            Account Info
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Name</p>
            <p className="font-medium">
              {[profile.first_name, profile.last_name].filter(Boolean).join(" ") || "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Email</p>
            <p className="font-medium">{profile.email ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Role</p>
            <p className="font-medium capitalize">{profile.role ?? "—"}</p>
          </div>
        </CardContent>
      </Card>

      {/* Personal email signature */}
      <AgentSignaturePanel currentSignature={profile.email_signature ?? null} />
    </main>
  )
}
