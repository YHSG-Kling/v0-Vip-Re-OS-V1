import {
  getPlatformCredentials,
  getProviderOverrides,
} from "@/app/actions/settings/integrations"
import { IntegrationsClient } from "./integrations-client"

export const metadata = { title: "Integrations | Settings" }

export default async function IntegrationsPage() {
  let credentials: Awaited<ReturnType<typeof getPlatformCredentials>> = []
  let overrides: Awaited<ReturnType<typeof getProviderOverrides>> = []

  try {
    ;[credentials, overrides] = await Promise.all([
      getPlatformCredentials(),
      getProviderOverrides(),
    ])
  } catch {
    return (
      <div className="p-6 text-red-600 text-sm">
        Failed to load integrations. Please refresh the page.
      </div>
    )
  }

  return <IntegrationsClient credentials={credentials} overrides={overrides} />
}
