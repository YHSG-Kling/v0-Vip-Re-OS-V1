// lib/billing/stripe-webhook-registration.ts
// ─────────────────────────────────────────────────────────────────────────────
// REGISTER THE EVENTS THE BILLING WEBHOOK HANDLES — ON THE STRIPE SDK.
//
// Wave 80A, owner verbatim: "go ahead with the add event to stripe webhook
// endpoint but remember we use stripe sdk." and "i do not want to setup the
// packages yet in stripe until we are ready to push production rollout."
//
// So this module does ONE thing and publishes NOTHING: it finds the PLATFORM
// account's webhook endpoint whose URL is this app's /api/billing/webhook
// (STRIPE_WEBHOOK_ROUTES.tenant_billing under NEXT_PUBLIC_APP_URL), reads its
// enabled_events, and writes current ∪ TENANT_BILLING_WEBHOOK_EVENTS back
// through `stripe.webhookEndpoints.update` — the SDK, never a raw fetch. No
// product, no price, no endpoint is CREATED: an endpoint that does not exist
// is reported by name (the operator registers the URL once in the dashboard
// or a later, separately-ruled action creates it), because minting a live
// endpoint is a production-rollout step and the owner has not asked for it.
//
// WHY THE UNION AND NOT THE MISSING LIST: `enabled_events` on update REPLACES
// the whole list (Stripe API reference, webhook_endpoints/update). Writing only
// what the route needs would drop every event another consumer registered on
// the same endpoint. planWebhookEventUnion (pure, lib/billing/stripe-account-
// scope.ts) computes the union and the guard drives it without a network.
//
// FAIL CLOSED, BY NAME: no platform Stripe credential → refused (nothing was
// read, nothing was written); no NEXT_PUBLIC_APP_URL → refused (we cannot say
// WHICH of the account's endpoints is ours, and guessing would rewrite someone
// else's); the endpoint absent → refused; a Stripe refusal → the SDK's own
// sentence. `apply: false` is the dry run the launch checklist's drift item
// reads — it lists and plans, and never calls update.

import "server-only"
import type Stripe from "stripe"
import { getPlatformStripe } from "@/lib/stripe"
import {
  STRIPE_WEBHOOK_ROUTES,
  TENANT_BILLING_WEBHOOK_EVENTS,
  planWebhookEventUnion,
  type StripeWebhookEndpoint,
  type WebhookEventUnionPlan,
} from "./stripe-account-scope"

export type StripeWebhookRegistrationResult =
  | {
      ok: true
      endpoint: StripeWebhookEndpoint
      url: string
      webhookEndpointId: string
      /** The endpoint's status as Stripe reports it — a `disabled` endpoint
       *  receives nothing even with every event enabled. */
      status: string
      livemode: boolean
      before: string[]
      after: string[]
      plan: WebhookEventUnionPlan
      /** true when webhookEndpoints.update was called and returned. */
      applied: boolean
      /** The other endpoints on the account that were NOT ours, by URL — so an
       *  operator can see a stale duplicate. */
      otherEndpointUrls: string[]
    }
  | {
      ok: false
      reason: "stripe_unconfigured" | "app_url_unset" | "endpoint_not_registered" | "stripe_refused"
      error: string
      /** Present on endpoint_not_registered: the URL we looked for and what exists. */
      expectedUrl?: string
      otherEndpointUrls?: string[]
    }

/** PURE: the absolute URL Stripe must deliver to. Trailing slash and case on
 *  the host are normalised so a dashboard-typed URL matches. Null when the
 *  app URL is unset — the caller refuses rather than matching on path alone. */
export function expectedWebhookUrl(appUrl: string | undefined | null, endpoint: StripeWebhookEndpoint = "tenant_billing"): string | null {
  const base = (appUrl ?? "").trim().replace(/\/+$/, "")
  if (!base) return null
  return `${base}${STRIPE_WEBHOOK_ROUTES[endpoint]}`
}

/** PURE: two webhook URLs name the same endpoint. Host case-insensitive,
 *  trailing slash ignored, query and fragment ignored (Stripe stores none). */
export function sameWebhookUrl(a: string, b: string): boolean {
  const norm = (u: string): string => {
    try {
      const p = new URL(u.trim())
      return `${p.protocol}//${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, "")}`
    } catch {
      return u.trim().replace(/\/+$/, "").toLowerCase()
    }
  }
  return norm(a) === norm(b)
}

export async function syncStripeWebhookEvents(opts: {
  endpoint?: StripeWebhookEndpoint
  /** false = dry run (list + plan, no update). */
  apply: boolean
  /** Injected for the proof; production omits it and gets the platform client. */
  stripe?: Pick<Stripe, "webhookEndpoints">
  appUrl?: string | null
}): Promise<StripeWebhookRegistrationResult> {
  const endpoint = opts.endpoint ?? "tenant_billing"
  if (endpoint !== "tenant_billing") {
    return { ok: false, reason: "stripe_refused", error: `The ${endpoint} endpoint's event vocabulary is not derivable from its route (it dispatches through an event map, not a switch); only tenant_billing is registered here.` }
  }
  const expected = expectedWebhookUrl(opts.appUrl === undefined ? process.env.NEXT_PUBLIC_APP_URL : opts.appUrl, endpoint)
  if (!expected) {
    return { ok: false, reason: "app_url_unset", error: "NEXT_PUBLIC_APP_URL is not set, so which of the account's webhook endpoints is this app's cannot be known. Nothing was read or written." }
  }

  let stripe: Pick<Stripe, "webhookEndpoints">
  try {
    stripe = opts.stripe ?? (await getPlatformStripe())
  } catch (err) {
    return { ok: false, reason: "stripe_unconfigured", error: `The platform's Stripe credential could not be resolved: ${err instanceof Error ? err.message : String(err)}. Nothing was read or written.` }
  }

  const endpoints: Stripe.WebhookEndpoint[] = []
  try {
    for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) endpoints.push(ep)
  } catch (err) {
    return { ok: false, reason: "stripe_refused", error: `Stripe refused webhookEndpoints.list: ${err instanceof Error ? err.message : String(err)}` }
  }

  const ours = endpoints.find((ep) => sameWebhookUrl(ep.url, expected))
  const otherEndpointUrls = endpoints.filter((ep) => ep !== ours).map((ep) => ep.url)
  if (!ours) {
    return {
      ok: false,
      reason: "endpoint_not_registered",
      error: `No webhook endpoint on the platform's Stripe account delivers to ${expected}. Register that URL once (Stripe dashboard → Developers → Webhooks) and set its signing secret as STRIPE_WEBHOOK_SECRET; this action does not create endpoints (nothing is published in Stripe before production rollout). ${endpoints.length} endpoint(s) exist on the account.`,
      expectedUrl: expected,
      otherEndpointUrls,
    }
  }

  const before = [...(ours.enabled_events ?? [])]
  const plan = planWebhookEventUnion(before, TENANT_BILLING_WEBHOOK_EVENTS)
  let after = before
  let applied = false
  if (opts.apply && !plan.inSync) {
    try {
      const updated = await stripe.webhookEndpoints.update(ours.id, {
        enabled_events: plan.enabledAfter as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
      })
      after = [...(updated.enabled_events ?? [])]
      applied = true
    } catch (err) {
      return { ok: false, reason: "stripe_refused", error: `Stripe refused webhookEndpoints.update(${ours.id}): ${err instanceof Error ? err.message : String(err)}. The endpoint still enables ${before.length} event(s).` }
    }
  }

  return {
    ok: true,
    endpoint,
    url: ours.url,
    webhookEndpointId: ours.id,
    status: String(ours.status ?? "unknown"),
    livemode: Boolean(ours.livemode),
    before,
    after,
    plan,
    applied,
    otherEndpointUrls,
  }
}
