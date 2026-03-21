import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

export default async function SettingsUsersPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("user_type, role")
    .eq("id", user.id)
    .single()

  const userType = profile?.user_type ?? profile?.role ?? "agent"

  if (["admin", "broker", "superadmin"].includes(userType)) {
    redirect("/admin")
  }

  // Agents and other roles don't have user management access
  redirect("/dashboard/settings/general")
}
