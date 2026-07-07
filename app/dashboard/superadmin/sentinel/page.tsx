import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { OsSentinelBoard } from "./os-sentinel-board"

export const dynamic = "force-dynamic"

// Platform-staff "state of the whole agentic OS" board.
export default async function OsSentinelPage() {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) redirect("/dashboard")

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">OS Sentinel</h1>
        <p className="text-muted-foreground text-sm">One view of the whole agentic OS — every subsystem, the top open incidents, and the self-healing that keeps it running.</p>
      </div>
      <OsSentinelBoard />
    </div>
  )
}
