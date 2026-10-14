import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"
import { SystemProvidersClient } from "./system-providers-client"

export const dynamic = "force-dynamic"

/**
 * /dashboard/admin/system/providers — the PLATFORM console for provider connection
 * tests (wave 141, lane 141I; owner: platform-managed providers → staff see full
 * provider/error/evidence, the TENANT sees sanitized capability status only).
 *
 * The console used to be the route itself ("use client", no gate), reachable by
 * any signed-in tenant admin who typed the URL: it listed the platform's env-var
 * names and offered "Test Connection" buttons the API then refused. The same
 * session → platform-staff resolution the sibling consoles use (lib/auth/
 * platform-guard.ts requireSuperadmin → isPlatformSuperadminIdentity, platform
 * staff live in `platform_role`, never a `superadmin` user_type fallback) now
 * decides BEFORE anything renders; a non-staff caller is told so in place
 * (RoleGateNotice — page-role-gate-roster P5: a `redirect("/dashboard")` on a
 * role refusal is "a click that appeared to do nothing"; the notice reveals no
 * platform data). Fail closed: an unauthenticated or unresolved caller gets the
 * same notice, never the console.
 */
export default async function SystemProvidersPage() {
  const gate = await requireSuperadmin()
  if (!gate.ok) return <RoleGateNotice surface="The platform providers console" audience="platform staff with total control (superadmin)" />
  return <SystemProvidersClient />
}
