import { redirect, notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getVideoTemplateById } from "@/app/actions/video-generation"
import { TemplateFormClient } from "../../template-form-client"

export const metadata = {
  title: "Edit Video Template | Dashboard",
}

export default async function EditVideoTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
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
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  const template = await getVideoTemplateById(id)
  if (!template) notFound()

  // Only the owning agent or broker/admin can edit
  const canEdit =
    template.agent_id === agentRow?.id ||
    ["broker", "admin", "superadmin"].includes(userData?.user_type ?? "")

  if (!canEdit) redirect("/dashboard/videos/templates")

  return (
    <div className="container mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Edit Template</h1>
        <p className="text-muted-foreground mt-1">{template.template_name}</p>
      </div>
      <TemplateFormClient
        brokerageId={userData?.brokerage_id ?? ""}
        agentId={agentRow?.id ?? ""}
        userType={userData?.user_type ?? "agent"}
        initial={template}
      />
    </div>
  )
}
