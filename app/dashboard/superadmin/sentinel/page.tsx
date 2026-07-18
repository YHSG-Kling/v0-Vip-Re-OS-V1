import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { OsSentinelBoard } from "./os-sentinel-board"
import { SentinelActionQueue } from "./sentinel-action-queue"

export const dynamic = "force-dynamic"

// Platform-staff "state of the whole agentic OS" board + the Platform Sentinel
// Manager's proposed-action queue (daily fleet watch → drafted outreach that
// staff approve or dismiss — app/api/cron/platform-sentinel fills it).
export default async function OsSentinelPage() {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) redirect("/dashboard")

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">OS Sentinel</h1>
        <p className="text-muted-foreground text-sm">One view of the whole agentic OS — every subsystem, the top open incidents, and the self-healing that keeps it running. Below it: the sentinel&apos;s daily proposed actions for the subscriber fleet, drafted and waiting on your approval.</p>
      </div>
      <SentinelActionQueue />
      <OsSentinelBoard />
    </div>
  )
}
