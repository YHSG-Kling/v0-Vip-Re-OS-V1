import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { FRAUD_TYPOLOGY, FRAUD_CHANNELS, FRAUD_EVIDENCE_KINDS, FRAUD_REPORT_AGENCIES, FRAUD_CLAIM_CLASSES, EVIDENCE_STORAGE_NOT_ENABLED } from "@/lib/fraud-network/network"
import { getFraudNetworkViewer } from "@/app/actions/fraud-network"
import { FraudNetworkClient } from "./fraud-network-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Fraud & Trust Network | Dashboard",
  description: "Shared fraud-tactic warnings, private incident reports and safe verification steps",
}

/**
 * /dashboard/fraud-network — wave 156, lane 156J. Every legitimate tenant shape (solo agent, team, brokerage,
 * multi-location) reaches the same community with its authorized seats; platform safety staff see the moderation
 * panel on the same page. The page decides nothing: every read and write goes through app/actions/fraud-network.ts.
 */
export default async function FraudNetworkPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  const viewer = await getFraudNetworkViewer()
  return (
    <FraudNetworkClient
      viewer={viewer}
      typology={FRAUD_TYPOLOGY.map((t) => ({ kind: t.kind, label: t.label, evidenceChecklist: [...t.evidenceChecklist], protectiveAction: t.protectiveAction }))}
      channels={[...FRAUD_CHANNELS]}
      evidenceKinds={[...FRAUD_EVIDENCE_KINDS]}
      agencies={[...FRAUD_REPORT_AGENCIES]}
      claimClasses={[...FRAUD_CLAIM_CLASSES]}
      evidenceStorageNote={EVIDENCE_STORAGE_NOT_ENABLED}
    />
  )
}
