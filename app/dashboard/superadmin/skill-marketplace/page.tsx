// app/dashboard/superadmin/skill-marketplace/page.tsx — wave 108, lane 108A.
// The platform's approval queue for THIRD-PARTY (and platform) skills: intake → the evaluation suite runs at
// once → platform staff approve → publish → revoke. Tenant-authored skills are decided by their own tenant
// admin (Settings → Assistant), never here. The page gates on platform staff; every door re-gates server-side
// (app/actions/skill-marketplace.ts).
import { redirect } from "next/navigation"
import { requirePlatformStaff } from "@/lib/auth/platform-guard"
import { SkillMarketplacePanel } from "@/components/skills/skill-marketplace-panel"

export const dynamic = "force-dynamic"

export default async function SkillMarketplacePage() {
  const staff = await requirePlatformStaff()
  if (!staff.ok) redirect("/dashboard")
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Skill marketplace</h1>
        <p className="text-sm text-muted-foreground">
          Third-party skills are data declarations composed of registered capabilities. They run only through the kernel
          gate — tenant isolation, entitlement, authority, metering and the action ledger — and only after passing evaluation.
        </p>
      </div>
      <SkillMarketplacePanel mode="platform" />
    </div>
  )
}
