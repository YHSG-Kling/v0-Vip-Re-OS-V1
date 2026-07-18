import {
  listWebhookSubscriptions,
  listWebhookDeliveries,
  getDeveloperTokenState,
  getDevelopersDocsData,
} from "@/app/actions/tenant-webhooks"
import { DevelopersClient } from "./developers-client"

export const metadata = {
  title: "Developers | Settings",
  description:
    "Outbound webhooks (signed, retried, honest delivery log) and brokerage-scoped Agentic-API tokens — the tenant developer surface.",
}

/**
 * DEVELOPERS — the tenant self-serve platform rail. Webhook subscriptions fan
 * out from the canonical lifecycle_events ledger (one tap, no bespoke emit
 * sites), every POST is HMAC-signed Stripe-style, and API tokens follow the
 * exact agent_credentials idiom the platform uses. Everything on this page is
 * gated server-side to the TENANCY PRINCIPAL (broker/admin; the solo agent on
 * solo tier; the team lead on team tier) — the actions enforce it, this page
 * just renders the honest result.
 */
export default async function DevelopersPage() {
  const [subs, deliveries, tokenState, docs] = await Promise.all([
    listWebhookSubscriptions(),
    listWebhookDeliveries(50),
    getDeveloperTokenState(),
    getDevelopersDocsData(),
  ])

  // Not the tenancy principal (or unauthenticated): honest, no fake data.
  if (!subs.ok) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Developers</h1>
          <p className="text-gray-600 mt-2">Outbound webhooks and API tokens for your brokerage</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <p className="text-gray-700 font-medium">Principal access required</p>
          <p className="text-gray-500 text-sm mt-1">
            Webhooks and API tokens are managed by the tenancy principal — the broker or admin
            (the account owner on Solo, the team lead on Team). {subs.error}
          </p>
        </div>
      </div>
    )
  }

  return (
    <DevelopersClient
      initialSubscriptions={subs.rows}
      initialDeliveries={deliveries.ok ? deliveries.rows : []}
      deliveriesError={deliveries.ok ? null : deliveries.error}
      tokenState={tokenState.ok ? tokenState.state : null}
      tokenStateError={tokenState.ok ? null : tokenState.error}
      docs={docs}
    />
  )
}
