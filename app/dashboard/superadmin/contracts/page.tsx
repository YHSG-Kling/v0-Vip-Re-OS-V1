import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  listSubscriptionContractTemplatesAction,
  listTenantContractSignaturesAction,
} from "@/app/actions/superadmin/subscription-contracts"
import { SubscriptionContractsManager } from "./subscription-contracts-manager"

export const dynamic = "force-dynamic"

// LANE 1 (m481) — platform staff author the subscription agreement a tenant
// signs to activate their subscription (owner ruling: "platform contracts for
// tenants has to be written in order for the tenant to sign"). Reads under the
// 'billing' capability; writes are superadmin-only in the actions.
export default async function SuperadminContractsPage() {
  const gate = await requirePlatformCapability("billing")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: platform billing access only</div>

  const [templatesRes, signaturesRes] = await Promise.all([
    listSubscriptionContractTemplatesAction(),
    listTenantContractSignaturesAction(),
  ])

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Subscription contracts</h1>
        <p className="text-muted-foreground text-sm mt-1">
          The platform-authored agreement a tenant signs to put their subscription in writing.
          One template is active at a time; tenants sign it in-app on their billing page and the
          signature lands in tenant_contract_signatures. Editing the body bumps the version —
          every signature stays pinned to the version that was on screen.
        </p>
      </div>
      {!templatesRes.ok && (
        <div className="rounded border p-4 text-sm text-red-600">Failed to load templates: {templatesRes.error}</div>
      )}
      {!signaturesRes.ok && (
        <div className="rounded border p-4 text-sm text-red-600">Failed to load signatures: {signaturesRes.error}</div>
      )}
      <SubscriptionContractsManager
        initialTemplates={templatesRes.ok ? templatesRes.templates : []}
        initialSignatures={signaturesRes.ok ? signaturesRes.signatures : []}
        canWrite={gate.role === "superadmin"}
      />
    </div>
  )
}
