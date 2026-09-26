// app/dashboard/admin/domain-coherence/page.tsx
// RSC — platform-staff only. Every panel of data on this page is produced by a
// SERVER ACTION in app/actions/admin/domain-coherence.ts, so the page and the
// action agree on ONE authorization decision instead of two, and the client
// never recomputes the registry for itself.
//
// Access: platform staff with the 'sentinel' capability (superadmin / platform
// admin). This route's own registry entry in lib/kernel/routes.ts declares
// accessLevel "superadmin"; the page previously admitted tenant broker/admin
// users, contradicting the very registry it renders. It also listed
// "broker_admin", which is not a member of the users.user_type CHECK
// vocabulary at all — a dead literal in a live gate.

import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  actionEnumerateDomainRoutes,
  actionClassifyRouteOwnership,
  actionDetectDuplicateManagerSurfaces,
  actionValidateCanonicalManagerUsage,
  actionValidateProviderBackedFeatures,
  actionValidateContractIntegrity,
  actionGenerateDomainCoherenceReport,
} from "@/app/actions/admin/domain-coherence"
import { DomainCoherenceWorkspace } from "@/app/components/features/admin/domain-coherence/DomainCoherenceWorkspace"

export const dynamic = "force-dynamic"

// The audit inputs live on the SERVER. They used to be duplicated inside the
// client workspace, which then recomputed the whole registry in the browser.
const COHERENCE_KERNEL_MODULES = [
  "lib/kernel/portal.ts",
  "lib/kernel/billing.ts",
  "lib/kernel/vendors.ts",
  "lib/kernel/education.ts",
  "lib/kernel/video.ts",
  "lib/kernel/lead-magnets.ts",
  "lib/kernel/communication-compliance.ts",
  "lib/kernel/forms.ts",
  "lib/kernel/routes.ts",
  "lib/kernel/transactions.ts",
  "lib/kernel/listings.ts",
]

const COHERENCE_PROVIDER_DOMAINS = [
  "portal", "billing", "vendors", "education", "video",
  "lead_magnets", "compliance", "forms", "transactions", "listings",
]

export const metadata = {
  title: "Domain Coherence | Platform",
  description: "Route registry audit — classify ownership, detect duplicates, validate contracts",
}

export default async function DomainCoherencePage() {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.userId) {
    return <div className="p-6 text-red-600">Not authenticated.</div>
  }
  if (!gate.ok) {
    return (
      <div className="p-6 text-red-600">
        Forbidden — domain coherence is platform governance data and requires platform staff access.
      </div>
    )
  }

  // All seven reads go through the gated server actions. If any is refused the
  // workspace renders that refusal rather than an empty, clean-looking audit.
  const [report, routes, ownership, duplicates, managers, providers, contracts] = await Promise.all([
    actionGenerateDomainCoherenceReport(),
    actionEnumerateDomainRoutes({ includePersonaRoutes: true }),
    actionClassifyRouteOwnership(),
    actionDetectDuplicateManagerSurfaces(),
    actionValidateCanonicalManagerUsage({ kernelModules: COHERENCE_KERNEL_MODULES }),
    actionValidateProviderBackedFeatures({ domains: COHERENCE_PROVIDER_DOMAINS }),
    actionValidateContractIntegrity(),
  ])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <DomainCoherenceWorkspace
        initial={{ report, routes, ownership, duplicates, managers, providers, contracts }}
        staffRole={gate.role ?? "superadmin"}
      />
    </div>
  )
}
