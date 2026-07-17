import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { ProvidersClient } from "./providers-client"

export const dynamic = "force-dynamic"

// Superadmin: platform ENV-credential status for system-level providers
// (scraping + AI media + property data). These credentials are platform-wide
// env vars, not per-tenant connectors — the value itself is never sent to the
// client, only whether it is configured. Moved here from the legacy
// /admin/system/providers console (keep-one consolidation); gate matches the
// other provider surfaces ('providers' capability).
export default async function SuperadminEnvProvidersPage() {
  const gate = await requirePlatformCapability("providers")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  // Determine which provider env vars are configured (server-only check —
  // the value itself is never sent to the client).
  const configured: Record<string, boolean> = {
    zenrows: !!process.env.ZENROWS_API_KEY,
    batchdata: !!process.env.BATCHDATA_API_KEY,
    apify: !!process.env.APIFY_API_KEY,
    did: !!process.env.DID_API_KEY,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    housecanary: !!(
      process.env.HOUSECANARY_API_KEY || process.env.HOUSECANARY_API_SECRET
    ),
  }

  return <ProvidersClient configured={configured} />
}
