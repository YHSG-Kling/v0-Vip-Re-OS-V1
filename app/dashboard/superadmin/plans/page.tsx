import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { listPlanTiersAction, listAIOverageTermsAction, listOverageTermsChangeLogAction } from "@/app/actions/superadmin/plan-catalog"
import { PlanCatalogManager } from "./plan-catalog-manager"
import { AIOverageTermsCard } from "./ai-overage-terms-card"

export const dynamic = "force-dynamic"

// Superadmin plan-catalog management — create / update / remove tiers, sync price
// from Stripe. The single source of truth for all tier pricing + copy.
export default async function SuperadminPlansPage() {
  const gate = await requirePlatformCapability("plans")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const res = await listPlanTiersAction()
  const tiers = res.ok ? res.tiers : []
  // Overage terms (m479 AI, m666 video, wave 87C Stripe metered price) —
  // administered beside the tier prices, read through the same superadmin
  // action lane (never a raw table read here), with the audited change log.
  const [overage, changeLog] = await Promise.all([listAIOverageTermsAction(), listOverageTermsChangeLogAction()])
  const overageTerms = overage.ok ? overage.terms : []

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Plans &amp; pricing</h1>
        <p className="text-muted-foreground text-sm mt-1">
          The single source of truth for every tier — price, setup fee, blurb, bullets, highlight, limits.
          Signup and billing read these; nothing is hardcoded. Sync a price from Stripe or edit inline.
        </p>
      </div>
      {!res.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load tiers: {res.error}</div>}
      <PlanCatalogManager initialTiers={tiers} />
      {!overage.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load AI overage terms: {overage.error}</div>}
      {!changeLog.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load the overage change log: {changeLog.error}</div>}
      <AIOverageTermsCard initialTerms={overageTerms} initialLog={changeLog.ok ? changeLog.rows : []} />
    </div>
  )
}
