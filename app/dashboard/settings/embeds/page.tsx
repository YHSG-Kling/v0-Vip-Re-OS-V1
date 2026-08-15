/**
 * Settings → Embeds (visible to all agents; brokerage-wide options gated to admin roles)
 *
 * Lets agents/brokers/team-leads manage their embedded AI twin widgets.
 * Each row = one embed config. Click to edit; copy snippet into customer site.
 */

import { listMyEmbeds } from "@/app/actions/embed-widgets"
import { EmbedsListClient } from "./embeds-list-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Embeds | Settings",
  description: "Embed your AI twin on any website. One snippet, copy and paste.",
}

export default async function EmbedsPage() {
  const { widgets, canCreateBrokerageWide } = await listMyEmbeds()

  return (
    <div className="container mx-auto px-4 py-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Embeds</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Drop your AI twin into any website — your personal site, brokerage homepage, IDX
          landing page. Visitors who chat with it become contacts in your CRM automatically.
        </p>
      </div>

      <EmbedsListClient
        widgets={widgets}
        canCreateBrokerageWide={canCreateBrokerageWide}
      />
    </div>
  )
}
