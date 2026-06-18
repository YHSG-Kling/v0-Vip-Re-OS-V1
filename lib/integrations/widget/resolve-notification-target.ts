import { createServiceClient } from "@/lib/supabase/service"

export interface NotificationTarget {
  user_id: string
  display_name?: string
}

/**
 * Resolves who should receive a widget notification based on widget scope.
 * agent → agent's user_id
 * team  → team lead's user_id
 * brokerage → lead router user from global_settings, else first broker/admin
 */
export async function resolveWidgetNotificationTarget(
  scope: "agent" | "team" | "brokerage",
  ownerId: string
): Promise<NotificationTarget | null> {
  const supabase = createServiceClient()

  if (scope === "agent") {
    const { data } = await supabase
      .from("users")
      .select("id, first_name, last_name")
      .eq("id", ownerId)
      .maybeSingle()
    if (!data) return null
    return { user_id: data.id, display_name: `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim() }
  }

  if (scope === "team") {
    const { data } = await supabase
      .from("teams")
      .select("team_lead_id, name")
      .eq("id", ownerId)
      .maybeSingle()
    if (!data?.team_lead_id) return null
    return { user_id: data.team_lead_id, display_name: data.name ?? "Team Lead" }
  }

  // Brokerage scope: check global_settings.additional_settings.lead_router_user_id first
  const { data: gs } = await supabase
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", ownerId)
    .maybeSingle()

  const leadRouterId = (gs?.additional_settings as any)?.lead_router_user_id as string | undefined
  if (leadRouterId) {
    return { user_id: leadRouterId }
  }

  // Fallback: first broker/admin user in the brokerage
  const { data: brokerUser } = await supabase
    .from("users")
    .select("id")
    .eq("brokerage_id", ownerId)
    .in("user_type", ["broker", "admin", "superadmin"])
    .limit(1)
    .maybeSingle()

  return brokerUser ? { user_id: brokerUser.id } : null
}
