import { redirect } from "next/navigation"
import Link from "next/link"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { PlatformReceptionPanel } from "../connectors/platform-reception-panel"

export const dynamic = "force-dynamic"

// Platform COMMUNICATIONS console — the spec's staff tool surfaced first-class
// (audit drift #6: the AI phone reception existed but was buried under
// Connectors). This page MOUNTS the existing panel — keep-one, no twin. Gate:
// 'support' (support + admin + superadmin monitor and work the comms lanes);
// number-binding and other config actions stay superadmin-gated at the action
// layer, so support keeps read/assist without config power.
export default async function PlatformCommunicationsPage() {
  const gate = await requirePlatformCapability("support")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: requires platform support capability</div>

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Communications</h1>
          <p className="text-muted-foreground text-sm mt-1">
            The platform's own lines: the AI phone reception (inbound calls answered for the
            platform itself), plus the outbound rails staff reach subscribers and prospects on.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/home" className="rounded-md border px-3 py-1 text-sm">Home</Link>
          <Link href="/dashboard/superadmin/support" className="rounded-md border px-3 py-1 text-sm">Support inbox</Link>
          <Link href="/dashboard/superadmin/growth" className="rounded-md border px-3 py-1 text-sm">Growth outreach</Link>
          <Link href="/dashboard/superadmin/suppression" className="rounded-md border px-3 py-1 text-sm">Suppression list</Link>
        </div>
      </div>

      {/* The platform phone reception — the SAME panel the connectors page mounts. */}
      <PlatformReceptionPanel />
    </div>
  )
}
