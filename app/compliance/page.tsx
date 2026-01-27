import { Suspense } from "react"
import { ComplianceContent } from "./compliance-content"

export default function CompliancePage() {
  return (
    <Suspense fallback={<div>Loading compliance dashboard...</div>}>
      <ComplianceContent />
    </Suspense>
  )
}
