/**
 * System 5.8: Buyer Fatigue Predictor — Brokerage Dashboard Page
 *
 * Shows all buyers with fatigue score >= 35 (watch/warning/critical),
 * sorted by score descending. Agents can dismiss alerts inline.
 * Auth: requires broker or admin role (validated via profiles table).
 */

import { redirect }          from "next/navigation"
import Link                  from "next/link"
import { createClient }      from "@/lib/supabase/server"
import {
  getHighFatigueBuyers,
  getBrokerageFatigueAlerts,
} from "@/app/actions/buyer-fatigue"
import { BrokerageFatigueDashboard } from "./brokerage-fatigue-dashboard"

export const metadata = {
  title:       "Buyer Fatigue Dashboard",
  description: "Monitor and manage buyer fatigue across all active buyers.",
}

export default async function BrokerageFatiguePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Validate broker/admin role
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard")
  if (!["broker", "admin", "manager"].includes(profile.role ?? "")) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id

  const [buyersRes, alertsRes] = await Promise.all([
    getHighFatigueBuyers(brokerageId),
    getBrokerageFatigueAlerts(brokerageId),
  ])

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Buyer Fatigue Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Buyers with elevated fatigue risk — review and take action
            </p>
          </div>
          <Link
            href="/dashboard/brokerage"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Back to Brokerage
          </Link>
        </div>
      </div>

      <div className="px-6 py-6 max-w-6xl mx-auto">
        <BrokerageFatigueDashboard
          buyers={buyersRes.success ? ((buyersRes as any).data ?? []) : []}
          alerts={alertsRes.success ? ((alertsRes as any).data ?? []) : []}
          brokerageId={brokerageId}
        />
      </div>
    </div>
  )
}
