import { Suspense } from "react"
import { WorkflowsContent } from "./workflows-content"

export default function WorkflowsPage() {
  return (
    <Suspense fallback={<div>Loading workflows...</div>}>
      <WorkflowsContent />
    </Suspense>
  )
}
