/**
 * Settings → Notification Rules
 *
 * Broker / admin: full toggle list — enable or disable each brokerage-level
 * notification rule (which events fire, which channels, which recipient roles).
 *
 * Regular agents: read-only view showing which notifications they will receive;
 * editing is brokerage-controlled.
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { listNotificationRules } from "@/lib/kernel/notification-rules"
import { NotificationRulesClient } from "./notification-rules-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Notification Rules | Settings",
  description: "Configure which events trigger notifications and on which channels.",
}

const ADMIN_ROLES = ["broker", "admin", "superadmin", "team_lead"]

export default async function NotificationRulesPage() {
  const ctx = await resolveWriteContext()
  const canEdit = ctx.isAuthenticated && ADMIN_ROLES.includes(ctx.userType)

  let rules: Awaited<ReturnType<typeof listNotificationRules>> = []
  if (ctx.isAuthenticated) {
    try {
      rules = await listNotificationRules({ userId: ctx.userId })
    } catch {
      rules = []
    }
  }

  // For regular agents, filter to only rules that apply to the agent role.
  const displayRules = canEdit ? rules : rules.filter((r) => r.recipient_role === "agent")

  return (
    <div className="container mx-auto px-4 py-6 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Notification Rules</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {canEdit
            ? "Control which events fire notifications, the channel (in-app, email, SMS), and who receives them."
            : "Notifications your brokerage has configured for agents. Contact your broker to change these settings."}
        </p>
      </div>
      <NotificationRulesClient rules={displayRules} canEdit={canEdit} />
    </div>
  )
}
