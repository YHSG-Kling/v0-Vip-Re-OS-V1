import { redirect, notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { UserEditForm } from "./user-edit-form"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ userId: string }>
}

export default async function UserEditPage({ params }: Props) {
  const { userId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: caller } = await supabase
    .from("users")
    .select("role, user_type, brokerage_id")
    .eq("id", user.id)
    .single()

  const callerRole = caller?.user_type ?? caller?.role ?? ""
  if (!["admin", "superadmin"].includes(callerRole)) redirect("/dashboard")

  // Load target user
  const { data: target } = await supabase
    .from("users")
    .select("id, first_name, last_name, email, user_type, role, status, brokerage_id, created_at")
    .eq("id", userId)
    .single()

  if (!target) notFound()

  // Non-superadmin admin scoped to own brokerage
  if (callerRole === "admin" && caller?.brokerage_id && target.brokerage_id !== caller.brokerage_id) {
    redirect("/admin/users")
  }

  // Load brokerages for superadmin dropdown
  let brokerages: { id: string; name: string }[] = []
  if (callerRole === "superadmin") {
    const { data } = await supabase
      .from("brokerages")
      .select("id, name")
      .order("name", { ascending: true })
    brokerages = data ?? []
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/admin/users"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Users
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold">Edit User</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {target.email}
        </p>
      </div>

      <UserEditForm
        user={target}
        callerRole={callerRole}
        callerBrokerageId={caller?.brokerage_id ?? null}
        brokerages={brokerages}
      />
    </div>
  )
}
