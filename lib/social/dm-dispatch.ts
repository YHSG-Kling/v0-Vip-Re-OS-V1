// lib/social/dm-dispatch.ts
//
// OUTBOUND SOCIAL DM DISPATCH — the reply half of the unified inbox's social
// lane. The meta-dm webhook (Messenger/IG) and the WhatsApp webhook ingest
// inbound DMs; this module sends the agent's reply back out through the
// TENANT'S OWN connected account (social_media_accounts — the OAuth identity
// each tenant connects in Settings → Social).
//
// Platform truth (never claim a send we can't make):
//   facebook   — Messenger Send API: POST /{page_id}/messages with the PAGE
//                token. Reply-only ("RESPONSE") inside Meta's 24-hour window.
//   instagram  — IG Messaging rides the linked Page: same /{page_id}/messages
//                edge, recipient is the IG-scoped sender id. Same 24h window.
//   whatsapp   — Cloud API: POST /{phone_number_id}/messages, bearer token.
//                Free-form text only inside WhatsApp's 24h customer window.
//   linkedin/twitter — their APIs do not offer DM send to standard apps;
//                honest unsupported (the inbox keeps its log-only composer).
//
// All egress rides the ONE connector-gateway (same rule as lib/social/publisher).

import { callConnector } from "@/lib/agentic-os/connector-gateway"

/** Graph version pinned to match lib/social/publisher.ts. */
const GRAPH = "https://graph.facebook.com"
const GRAPH_V = "v18.0"

export type SocialDmPlatform = "facebook" | "instagram" | "whatsapp" | "linkedin" | "twitter"

// Capability map lives in dm-support.ts (pure, client-safe); re-exported here
// so server code has one import site.
export { socialDmSupport, type SocialDmSupport } from "./dm-support"
import { socialDmSupport } from "./dm-support"

export interface DispatchSocialDmParams {
  platform: SocialDmPlatform
  /** social_media_accounts.account_id — page id (Meta) or phone_number_id (WhatsApp). */
  accountId: string
  /** The connected account's access token (page token / WABA token). */
  accessToken: string
  /** Platform-scoped recipient: PSID/IGSID (Meta) or wa_id digits (WhatsApp). */
  recipientId: string
  text: string
}

export interface DispatchSocialDmResult {
  success: boolean
  providerMessageId?: string
  error?: string
  /** True when the platform can never send (vs a transient/provider failure). */
  unsupported?: boolean
}

/** Map Meta's messaging error codes to plain language the agent can act on. */
function friendlyMetaError(raw: string): string {
  const s = raw ?? ""
  if (/\b(?:code"?:\s*)?10\b/.test(s) || /outside.*window|24 ?hour|message sent outside/i.test(s)) {
    return "Outside the platform's 24-hour reply window — the contact must message you again before the API allows a reply. Reply from the platform inbox instead."
  }
  if (/OAuth|token|expired|Session has expired|190/i.test(s)) {
    return "The connected account's access token is invalid or expired — reconnect it in Settings → Social."
  }
  return s || "The platform rejected the message."
}

/**
 * dispatchSocialDm — the one outbound social DM egress.
 * Never throws; returns a structured result the caller persists honestly.
 */
export async function dispatchSocialDm(params: DispatchSocialDmParams): Promise<DispatchSocialDmResult> {
  const support = socialDmSupport(params.platform)
  if (!support.supported) {
    return { success: false, unsupported: true, error: support.reason }
  }
  if (!params.accessToken) {
    return { success: false, error: "No access token on the connected account — reconnect it in Settings → Social." }
  }
  if (!params.recipientId) {
    return { success: false, error: "No platform recipient id on this thread — replies are only possible on threads the contact started." }
  }

  try {
    if (params.platform === "whatsapp") {
      // WhatsApp Cloud API — bearer token, phone_number_id edge.
      const res = await callConnector<any>({
        connector: "whatsapp",
        baseUrl: GRAPH,
        path: `${GRAPH_V}/${params.accountId}/messages`,
        method: "POST",
        auth: { style: "bearer", token: params.accessToken },
        body: {
          messaging_product: "whatsapp",
          to: params.recipientId,
          type: "text",
          text: { body: params.text.slice(0, 4096) },
        },
      })
      if (!res.ok) return { success: false, error: friendlyMetaError(res.error ?? "") }
      return { success: true, providerMessageId: res.data?.messages?.[0]?.id }
    }

    // Messenger + Instagram — both ride the PAGE's messages edge with the page
    // token (IG DMs are addressed by the IG-scoped id the webhook captured).
    const res = await callConnector<any>({
      connector: params.platform,
      baseUrl: GRAPH,
      path: `${GRAPH_V}/${params.accountId}/messages`,
      method: "POST",
      auth: { style: "query", name: "access_token", value: params.accessToken },
      body: {
        recipient: { id: params.recipientId },
        messaging_type: "RESPONSE", // reply-only: we only answer threads the person started
        message: { text: params.text.slice(0, 2000) },
      },
    })
    if (!res.ok) return { success: false, error: friendlyMetaError(res.error ?? "") }
    return { success: true, providerMessageId: res.data?.message_id ?? res.data?.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "DM dispatch failed" }
  }
}
