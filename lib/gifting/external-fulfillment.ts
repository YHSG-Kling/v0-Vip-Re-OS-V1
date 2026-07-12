/**
 * lib/gifting/external-fulfillment.ts
 *
 * EXTERNAL GIFT FULFILLMENT — the automation seam the gifting loop was
 * missing (owner directive: "we could bring like Etsy or a gifting
 * real-estate platform to automate the gifting"). The in-app loop is
 * already honest end-to-end (AI recommendation → client_gifts order →
 * pay-task / manual-task fallbacks); THIS adds hands-free physical
 * fulfillment through a commerce-API gifting provider when the PLATFORM
 * configures one (owner rule: providers are platform setup).
 *
 * v1 provider: Goody (api.ongoody.com — a real B2B gifting commerce API
 * with curated catalogs and recipient-notification flows; the recipient
 * confirms their own address, which suits real estate perfectly).
 * Provider-gated: GIFTING_PROVIDER=goody + GIFTING_API_KEY set → a REAL
 * order attempt with the provider's real response recorded; anything
 * else → { attempted: false } and the existing task fallback stands —
 * ZERO regression, never a simulated fulfillment.
 */

import { callConnector } from "@/lib/agentic-os/connector-gateway"

export interface ExternalFulfillmentResult {
  attempted: boolean
  ok: boolean
  provider: string | null
  /** the provider's REAL order id — never fabricated. */
  externalOrderId: string | null
  error: string | null
}

export interface FulfillGiftArgs {
  recipientName: string
  recipientEmail: string | null
  /** the provider product/catalog id when the step pinned one; Goody can
   *  also send a "recipient picks" gift when configured on the account. */
  productId?: string | null
  message: string | null
  costCapCents?: number | null
}

export async function fulfillGiftExternally(args: FulfillGiftArgs): Promise<ExternalFulfillmentResult> {
  const provider = (process.env.GIFTING_PROVIDER ?? "").toLowerCase()
  const apiKey = process.env.GIFTING_API_KEY
  const none: ExternalFulfillmentResult = { attempted: false, ok: false, provider: null, externalOrderId: null, error: null }

  if (provider !== "goody" || !apiKey) return none // unconfigured → the task fallback stands
  if (!args.recipientEmail) {
    return { attempted: false, ok: false, provider, externalOrderId: null, error: "recipient email required for provider fulfillment" }
  }

  const [firstName, ...rest] = args.recipientName.trim().split(/\s+/)
  const res = await callConnector<{ id?: string; batch?: { id?: string } }>({
    connector: "goody",
    baseUrl: "https://api.ongoody.com",
    path: "/v1/order_batches",
    method: "POST",
    auth: { style: "bearer", token: apiKey },
    body: {
      from_name: "Your agent",
      send_method: "email_and_link",
      recipients: [{ first_name: firstName || "Friend", last_name: rest.join(" ") || "", email: args.recipientEmail }],
      ...(args.productId ? { cart: { items: [{ product_id: args.productId, quantity: 1 }] } } : {}),
      message: args.message ?? undefined,
    },
  })

  if (!res.ok) {
    return { attempted: true, ok: false, provider, externalOrderId: null, error: res.error ?? `provider rejected (${res.status ?? "—"})` }
  }
  const orderId = res.data?.id ?? res.data?.batch?.id ?? null
  if (!orderId) {
    return { attempted: true, ok: false, provider, externalOrderId: null, error: "provider returned no order id" }
  }
  return { attempted: true, ok: true, provider, externalOrderId: orderId, error: null }
}
