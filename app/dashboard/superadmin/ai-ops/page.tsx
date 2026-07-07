import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { getAiOpsAction } from "@/app/actions/superadmin/ai-ops"
import { AiOpsConsole } from "./ai-ops-console"
import { ManagerOpsPanel } from "./manager-ops-panel"
import { RotationRisksPanel } from "./rotation-risks-panel"

export const dynamic = "force-dynamic"

export default async function SuperadminAiOpsPage() {
  const gate = await requirePlatformCapability("ai_ops")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: platform staff only</div>

  const res = await getAiOpsAction(24)
  if (!res.ok) return <div className="p-6 text-red-600">Failed: {res.error}</div>
  return (
    <div className="space-y-6">
      <AiOpsConsole data={res.data} />
      <div className="p-6 pt-0 space-y-6"><ManagerOpsPanel /><RotationRisksPanel /></div>
    </div>
  )
}
