import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Mail, CalendarDays } from "lucide-react"

export const dynamic = "force-dynamic"

// One OAuth consent per provider grants BOTH mail and calendar (the route requests both
// scopes). Tokens are stored agent-scoped in agent_api_credentials (gmail / outlook).
const PROVIDERS = [
  { key: "google", label: "Google (Gmail + Calendar)", service: "gmail", oauth: "/api/integrations/oauth/google" },
  { key: "microsoft", label: "Microsoft (Outlook + Calendar)", service: "outlook", oauth: "/api/integrations/oauth/microsoft" },
] as const

export default async function ConnectionsSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const ctx = await getAgentContext().catch(() => null)
  const connected = new Map<string, string | null>()
  if (ctx?.agentId) {
    const svc = createServiceClient()
    const { data } = await svc
      .from("agent_api_credentials")
      .select("service_name, config, is_active")
      .eq("agent_id", ctx.agentId)
      .in("service_name", ["gmail", "outlook"])
      .eq("is_active", true)
    for (const c of data ?? []) connected.set(c.service_name, (c.config as any)?.email ?? null)
  }

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Email &amp; Calendar</h1>
        <p className="text-sm text-muted-foreground">
          Connect your Google or Microsoft account once — it powers both sending email from your
          own mailbox and booking on your own calendar. Available to every tier.
        </p>
      </div>

      {PROVIDERS.map((p) => {
        const email = connected.get(p.service)
        const isConnected = connected.has(p.service)
        return (
          <Card key={p.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                {p.label}
                {isConnected && <Badge variant="default">connected{email ? ` · ${email}` : ""}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Mail className="h-3.5 w-3.5" /> Send from your mailbox</span>
                <span className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> Book on your calendar</span>
              </div>
              <Button asChild size="sm" variant={isConnected ? "outline" : "default"}>
                <a href={p.oauth}>{isConnected ? "Reconnect" : "Connect"}</a>
              </Button>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
