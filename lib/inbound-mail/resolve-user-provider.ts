/**
 * lib/inbound-mail/resolve-user-provider.ts
 *
 * Resolve the inbound email provider FOR A USER.
 *
 * Why per-user (not per-brokerage):
 *   - Brokerage staff (broker, broker_admin, TC, compliance_officer,
 *     compliance_manager) use the brokerage's owned domain — typically routed
 *     through a transactional service (Postmark / SendGrid / Mailgun / Resend).
 *   - Agents + team_leads are INDEPENDENT CONTRACTORS. They use their own
 *     Gmail or Outlook accounts. The provider is theirs, not the brokerage's.
 *
 * Resolution cascade (mirrors the e-sign + SMS providers):
 *   1) platform_credentials WHERE agent_user_id = <user> AND is_active     (user scope)
 *   2) platform_credentials WHERE scope='team'      AND scope_id = team    (team scope)
 *   3) platform_credentials WHERE brokerage_id = <brokerage>               (brokerage scope)
 *
 * For inbound: we accept the first match whose platform is one of the
 * supported inbound-email platforms (gmail | outlook | postmark | sendgrid
 * | mailgun | resend).
 *
 * Identification at webhook time: the webhook payload tells us which user
 * owns the inbox (via Gmail Pub/Sub history's email address, Outlook
 * Graph subscription's client state, or the "To:" address for transactional
 * providers). We look up the matching platform_credentials row by
 * (agent_user_id, platform) and decrypt the OAuth tokens / API key to
 * fetch messages or verify HMAC.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type InboundEmailProvider =
  | "gmail" | "outlook"            // per-user OAuth-based inboxes
  | "postmark" | "sendgrid"        // transactional / brokerage-domain
  | "mailgun"  | "resend"

const INBOUND_EMAIL_PLATFORMS: InboundEmailProvider[] = [
  "gmail","outlook","postmark","sendgrid","mailgun","resend",
]

export interface ResolvedInboundProvider {
  platform:     InboundEmailProvider
  scope:        "agent" | "team" | "brokerage"
  credential_id: string
  brokerage_id: string
  agent_user_id: string | null
  /** OAuth access token (gmail / outlook) or HMAC secret (postmark etc.). */
  access_token: string | null
  refresh_token: string | null
  account_id:   string | null       // email address for OAuth inboxes
  config:       Record<string, unknown>
}

/**
 * Find which inbound-email provider this user uses, walking the cascade.
 *
 * Returns null when neither the user nor any of their teams nor their
 * brokerage has an active inbound-email credential.
 */
export async function resolveInboundEmailProviderForUser(params: {
  userId:        string
  teamId?:       string | null
  brokerageId?:  string | null
}): Promise<ResolvedInboundProvider | null> {
  const supabase = createServiceClient()

  // 1) user scope
  const { data: userCred } = await supabase
    .from("platform_credentials")
    .select("id, platform, brokerage_id, agent_user_id, scope, access_token, refresh_token, account_id, config, is_active")
    .eq("agent_user_id", params.userId)
    .in("platform", INBOUND_EMAIL_PLATFORMS)
    .eq("is_active", true)
    .order("last_tested_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()
  if (userCred) return toResolved(userCred, "agent")

  // 2) team scope (when the user is on a team)
  if (params.teamId) {
    const { data: teamCred } = await supabase
      .from("platform_credentials")
      .select("id, platform, brokerage_id, agent_user_id, scope, access_token, refresh_token, account_id, config, is_active")
      .eq("scope", "team")
      .filter("config->>team_id", "eq", params.teamId)
      .in("platform", INBOUND_EMAIL_PLATFORMS)
      .eq("is_active", true)
      .order("last_tested_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    if (teamCred) return toResolved(teamCred, "team")
  }

  // 3) brokerage scope
  if (params.brokerageId) {
    const { data: brokCred } = await supabase
      .from("platform_credentials")
      .select("id, platform, brokerage_id, agent_user_id, scope, access_token, refresh_token, account_id, config, is_active")
      .eq("brokerage_id", params.brokerageId)
      .eq("scope", "brokerage")
      .in("platform", INBOUND_EMAIL_PLATFORMS)
      .eq("is_active", true)
      .order("last_tested_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    if (brokCred) return toResolved(brokCred, "brokerage")
  }

  return null
}

/**
 * Identify the user by inbound payload. Strategies:
 *   - GMAIL Pub/Sub history: payload includes the email address that triggered
 *     the notification. Match to platform_credentials.account_id where
 *     platform='gmail'.
 *   - OUTLOOK Graph subscription: subscription's clientState is a UUID we
 *     stored when creating the subscription. Match to
 *     platform_credentials.config->>subscription_client_state.
 *   - TRANSACTIONAL providers (Postmark/SendGrid/Mailgun/Resend): the "To:"
 *     address is the routing address. Match the TO recipient against
 *     platform_credentials.account_id where platform IN the transactional set.
 */
export async function resolveUserByInboundIdentifier(params: {
  platform:    InboundEmailProvider
  /** For OAuth inboxes: the email address that received the message. */
  inboxEmail?: string | null
  /** For Outlook: the subscription clientState we stored at sub-create time. */
  outlookClientState?: string | null
  /** For transactional providers: the "To:" address from the inbound payload. */
  toAddress?:  string | null
}): Promise<ResolvedInboundProvider | null> {
  const supabase = createServiceClient()

  if ((params.platform === "gmail" || params.platform === "outlook")) {
    if (params.platform === "outlook" && params.outlookClientState) {
      const { data } = await supabase
        .from("platform_credentials")
        .select("id, platform, brokerage_id, agent_user_id, scope, access_token, refresh_token, account_id, config, is_active")
        .eq("platform", "outlook")
        .filter("config->>subscription_client_state", "eq", params.outlookClientState)
        .eq("is_active", true)
        .maybeSingle()
      if (data) return toResolved(data, (data.scope as any) ?? "agent")
    }
    if (params.inboxEmail) {
      const { data } = await supabase
        .from("platform_credentials")
        .select("id, platform, brokerage_id, agent_user_id, scope, access_token, refresh_token, account_id, config, is_active")
        .eq("platform", params.platform)
        .ilike("account_id", params.inboxEmail)
        .eq("is_active", true)
        .maybeSingle()
      if (data) return toResolved(data, (data.scope as any) ?? "agent")
    }
    return null
  }

  // Transactional: match the To: address against any active credential
  if (params.toAddress) {
    const { data } = await supabase
      .from("platform_credentials")
      .select("id, platform, brokerage_id, agent_user_id, scope, access_token, refresh_token, account_id, config, is_active")
      .eq("platform", params.platform)
      .ilike("account_id", params.toAddress)
      .eq("is_active", true)
      .maybeSingle()
    if (data) return toResolved(data, (data.scope as any) ?? "brokerage")
  }
  return null
}

function toResolved(row: any, scope: "agent" | "team" | "brokerage"): ResolvedInboundProvider {
  return {
    platform:      row.platform as InboundEmailProvider,
    scope,
    credential_id: row.id as string,
    brokerage_id:  row.brokerage_id as string,
    agent_user_id: (row.agent_user_id as string | null) ?? null,
    access_token:  (row.access_token  as string | null) ?? null,
    refresh_token: (row.refresh_token as string | null) ?? null,
    account_id:    (row.account_id    as string | null) ?? null,
    config:        (row.config as Record<string, unknown>) ?? {},
  }
}
