import { Suspense } from "react"
import IntegrationsContent from "./integrations-content"

export default function IntegrationsPage() {
  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Integrations & API Connections</h1>
        <p className="text-muted-foreground">
          Connect your external services to sync data and publish content seamlessly.
        </p>
      </div>

      <Suspense fallback={<div>Loading integrations...</div>}>
        <IntegrationsContent />
      </Suspense>
    </div>
  )
}
