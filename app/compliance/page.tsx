import { redirect } from "next/navigation"

/**
 * The standalone /compliance dashboard ("Compliance & TRID Monitoring") was a
 * duplicate of the Compliance Command Center — the same content-approval,
 * fair-housing, certifications and violations panels, plus a dead TRID stub.
 * It now redirects to the single canonical hub. The workflow sub-pages under
 * /compliance/* (violations, violations/new, policies, audits, reports,
 * settings) remain and are linked from the Command Center's
 * "Governance & records" section.
 */
export default function CompliancePage() {
  redirect("/dashboard/compliance")
}
