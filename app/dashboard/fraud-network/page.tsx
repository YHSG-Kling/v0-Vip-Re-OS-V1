import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { FRAUD_TYPOLOGY, FRAUD_CHANNELS, FRAUD_EVIDENCE_KINDS, FRAUD_REPORT_AGENCIES, FRAUD_CLAIM_CLASSES, EVIDENCE_STORAGE_NOT_ENABLED } from "@/lib/fraud-network/network"
import { getFraudNetworkViewer } from "@/app/actions/fraud-network"
import { FraudNetworkClient } from "./fraud-network-client"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"

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
  // THE PAGE'S GATE: a participating tenant seat of an ACTIVE tenant, or platform safety staff. Everyone else (a client or
  // vendor seat, a paused or departed tenant) is told why — never a blank screen or a silent bounce.
  if (!viewer.tenant && !viewer.staff) {
    return <RoleGateNotice surface="The Fraud & Trust Network" audience="the staff seats of an active member business (agents, coordinators, ISAs, team leads, brokers and compliance officers) and platform safety staff" />
  }
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
