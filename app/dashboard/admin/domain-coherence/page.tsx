// app/dashboard/admin/domain-coherence/page.tsx
// RSC — calls kernel directly (no Supabase queries — registry only).
// Passes pre-built report as initial prop to client workspace.
// Access: superadmin / admin / broker

import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { generateDomainCoherenceReport } from "@/lib/kernel/routes"
import { DomainCoherenceWorkspace } from "@/app/components/features/admin/domain-coherence/DomainCoherenceWorkspace"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Domain Coherence | Admin",
  description: "Route registry audit — classify ownership, detect duplicates, validate contracts",
}

export default async function DomainCoherencePage() {
  const context = await getAgentContext()

  if (!context?.isAuthenticated) {
    redirect("/login")
  }

  const allowedRoles = ["admin", "superadmin", "broker", "broker_admin"]
  if (!allowedRoles.includes(context.userType)) {
    redirect("/dashboard/admin")
  }

  // Run all 8 kernel commands synchronously — pure registry, no DB, fast
  const report = generateDomainCoherenceReport({ includeRecommendations: true })

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <DomainCoherenceWorkspace initialReport={report} />
    </div>
  )
}
