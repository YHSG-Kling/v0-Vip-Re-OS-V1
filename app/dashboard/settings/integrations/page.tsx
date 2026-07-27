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
  } catch (err) {
    // A permission boundary is not a load failure. This surface manages the brokerage's
    // provider credentials, so a non-admin reaching it should be told that plainly and
    // pointed at the place they CAN connect their own accounts — telling them to
    // "refresh" sends them in a loop against a wall that will never move.
    const forbidden = err instanceof Error && /Forbidden/i.test(err.message)
    if (forbidden) {
      return (
        <div className="p-6 max-w-lg space-y-2">
          <p className="text-sm font-medium">Provider credentials are managed by your broker</p>
          <p className="text-sm text-muted-foreground">
            These are the brokerage&apos;s shared API keys and provider routing. To connect your
            own accounts — email, calendar, social, CRM — go to{" "}
            <a href="/settings/connections" className="text-blue-600 hover:underline">
              Settings → Connections
            </a>
            .
          </p>
        </div>
      )
    }
    return (
      <div className="p-6 text-red-600 text-sm">
        Failed to load integrations. Please refresh the page.
      </div>
    )
  }

  return <IntegrationsClient credentials={credentials} overrides={overrides} />
}
