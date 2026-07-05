import type React from "react"
import { redirect } from "next/navigation"
import { requirePlatformStaff } from "@/lib/auth/platform-guard"

export const dynamic = "force-dynamic"

/**
 * ONE subtree gate for the god console. Previously every superadmin/** page self-gated with
 * a copy-pasted `user_type !== 'superadmin'` check (which drifted — some read platform_role,
 * some didn't). This is the single baseline: you must be platform staff to see the subtree.
 * Destructive actions still enforce superadmin at the action layer (requireSuperadmin), so
 * support keeps read/assist access without gaining config power.
 */
export default async function SuperadminLayout({ children }: { children: React.ReactNode }) {
  const gate = await requirePlatformStaff()
  if (!gate.ok) redirect("/dashboard")
  return <>{children}</>
}
