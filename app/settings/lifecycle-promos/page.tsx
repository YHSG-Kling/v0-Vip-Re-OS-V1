/**
 * app/settings/lifecycle-promos/page.tsx
 *
 * Wave 28 — Settings page for the 7 listing-lifecycle promo moments.
 * Each row shows the effective auto-spawn setting + an inline toggle.
 * "Reset to default" deletes the agent's override so the resolution
 * chain falls back to team / brokerage / platform_default.
 *
 * For Wave 28 the page exposes AGENT-scope overrides only. Team and
 * brokerage scope writes come in a follow-up commit once the role-checked
 * shell + tier-aware visibility wiring lands.
 */
import { getMyLifecyclePromoPolicy } from "@/app/actions/lifecycle-promo-policy"
import { LifecyclePromoSettingsClient } from "./client"

export const dynamic = "force-dynamic"

export default async function LifecyclePromosSettingsPage() {
  const result = await getMyLifecyclePromoPolicy()
  if (!result.success || !result.events) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Lifecycle Promo Settings</h1>
        <p className="text-red-600">{result.error ?? "Could not load settings"}</p>
      </div>
    )
  }
  return <LifecyclePromoSettingsClient events={result.events} />
}
