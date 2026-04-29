import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getVideoTemplates } from "@/app/actions/video-generation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const metadata = {
  title: "Video Templates | Dashboard",
}

export default async function VideoTemplatesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, team_id")
    .eq("user_id", user.id)
    .maybeSingle()

  const templates = await getVideoTemplates()

  // Filter: system, brokerage-wide, team-scoped (if agent has a team), own agent templates
  const visible = templates.filter(t =>
    t.is_system ||
    (t.brokerage_id === userData?.brokerage_id && !t.agent_id && !t.team_id) ||
    (t.team_id && t.team_id === agentRow?.team_id) ||
    t.agent_id === agentRow?.id
  )

  const canCreateBrokerageTemplate = ["broker", "admin", "superadmin"].includes(userData?.user_type ?? "")
  const canCreateTeamTemplate = ["team_lead", "broker", "admin", "superadmin"].includes(userData?.user_type ?? "")

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Video Templates</h1>
          <p className="text-muted-foreground mt-1">Reusable script templates for your video library</p>
        </div>
        <Button asChild>
          <Link href="/dashboard/videos/templates/new">New Template</Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.map(template => (
          <Card key={template.id}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base leading-snug">{template.template_name}</CardTitle>
                {template.is_system && <Badge variant="secondary">System</Badge>}
                {!template.is_system && !template.agent_id && !template.team_id && <Badge variant="outline">Brokerage</Badge>}
                {template.team_id && <Badge variant="outline">Team</Badge>}
                {template.agent_id === agentRow?.id && <Badge>Mine</Badge>}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline" className="capitalize text-xs">
                  {template.category?.replace(/_/g, " ")}
                </Badge>
                {template.duration_seconds && (
                  <Badge variant="secondary" className="text-xs">{template.duration_seconds}s</Badge>
                )}
              </div>
              {template.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">{template.description}</p>
              )}
              <div className="flex gap-2">
                <Button asChild size="sm" className="flex-1">
                  <Link href={`/dashboard/videos/create?template_id=${template.id}`}>Use</Link>
                </Button>
                {(template.agent_id === agentRow?.id || ["broker","admin","superadmin"].includes(userData?.user_type ?? "")) && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/dashboard/videos/templates/${template.id}/edit`}>Edit</Link>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {visible.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          No templates yet.{" "}
          <Link href="/dashboard/videos/templates/new" className="underline">
            Create your first template.
          </Link>
        </div>
      )}
    </div>
  )
}
