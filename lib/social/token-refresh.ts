// lib/social/token-refresh.ts
// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL TOKEN LIFECYCLE — the vendor audit's worst gap: the OAuth refresh
// runner only scanned email/calendar/accounting credentials, so social tokens
// in social_media_accounts silently expired and publishing just started
// failing. Two honest mechanisms:
//   1. META LONG-LIVED EXCHANGE — Facebook/Instagram user tokens are renewable
//      by exchange (fb_exchange_token → ~60 more days). Tokens inside the
//      renewal window are exchanged automatically via the connector gateway.
//   2. EXPIRY WATCHDOG — everything else (LinkedIn without a refresh token,
//      failed exchanges): the tenant admin is notified to RECONNECT before
//      expiry, once per account per week. No fake refresh, no silent death.

export const RENEWAL_WINDOW_DAYS = 10

export interface SocialTokenRow {
  id: string
  platform: string | null
  brokerage_id: string | null
  user_id: string | null
  account_name: string | null
  access_token: string | null
  refresh_token: string | null
  token_expires_at: string | null
  is_active: boolean | null
}

export type TokenPlan = "exchange_meta" | "refresh_linkedin" | "notify_reconnect" | "healthy" | "skip"

/** PURE: what should happen to this account's token right now? */
export function planTokenAction(row: SocialTokenRow, now: Date = new Date()): TokenPlan {
  if (!row.is_active || !row.access_token) return "skip"
  if (!row.token_expires_at) return "healthy" // no expiry recorded (e.g. page tokens) — nothing to do
  const msLeft = new Date(row.token_expires_at).getTime() - now.getTime()
  if (msLeft > RENEWAL_WINDOW_DAYS * 86_400_000) return "healthy"
  const platform = (row.platform ?? "").toLowerCase()
  if (platform === "facebook" || platform === "instagram" || platform === "meta") return "exchange_meta"
  if (platform === "linkedin" && row.refresh_token) return "refresh_linkedin"
  return "notify_reconnect"
}

export interface TokenSweepResult { scanned: number; exchanged: number; refreshed: number; notified: number; errors: number }

/** The sweep — rides the existing credential-refresh cron. */
export async function runSocialTokenSweep(svc: any, now: Date = new Date()): Promise<TokenSweepResult> {
  const r: TokenSweepResult = { scanned: 0, exchanged: 0, refreshed: 0, notified: 0, errors: 0 }
  const { data: rows } = await svc.from("social_media_accounts")
    .select("id, platform, brokerage_id, user_id, account_name, access_token, refresh_token, token_expires_at, is_active")
    .eq("is_active", true).limit(500)

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")

  for (const row of (rows ?? []) as SocialTokenRow[]) {
    r.scanned += 1
    const plan = planTokenAction(row, now)
    try {
      if (plan === "exchange_meta") {
        const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID
        const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET
        if (!appId || !appSecret) {
          await notifyReconnect(svc, row, now); r.notified += 1; continue
        }
        const res = await callConnector<{ access_token?: string; expires_in?: number }>({
          connector: "meta", baseUrl: "https://graph.facebook.com", path: "/v19.0/oauth/access_token", method: "GET",
          query: {
            grant_type: "fb_exchange_token",
            client_id: appId, client_secret: appSecret,
            fb_exchange_token: row.access_token!,
          },
        })
        if (res.ok && res.data?.access_token) {
          await svc.from("social_media_accounts").update({
            access_token: res.data.access_token,
            token_expires_at: new Date(now.getTime() + (res.data.expires_in ?? 60 * 86_400) * 1000).toISOString(),
            updated_at: now.toISOString(),
          }).eq("id", row.id)
          r.exchanged += 1
        } else {
          await notifyReconnect(svc, row, now); r.notified += 1
        }
      } else if (plan === "refresh_linkedin") {
        const cid = process.env.LINKEDIN_CLIENT_ID
        const csec = process.env.LINKEDIN_CLIENT_SECRET
        if (!cid || !csec) { await notifyReconnect(svc, row, now); r.notified += 1; continue }
        const res = await callConnector<{ access_token?: string; expires_in?: number; refresh_token?: string }>({
          connector: "linkedin", baseUrl: "https://www.linkedin.com", path: "/oauth/v2/accessToken", method: "POST",
          bodyType: "form",
          body: { grant_type: "refresh_token", refresh_token: row.refresh_token!, client_id: cid, client_secret: csec },
        })
        if (res.ok && res.data?.access_token) {
          await svc.from("social_media_accounts").update({
            access_token: res.data.access_token,
            refresh_token: res.data.refresh_token ?? row.refresh_token,
            token_expires_at: new Date(now.getTime() + (res.data.expires_in ?? 60 * 86_400) * 1000).toISOString(),
            updated_at: now.toISOString(),
          }).eq("id", row.id)
          r.refreshed += 1
        } else {
          await notifyReconnect(svc, row, now); r.notified += 1
        }
      } else if (plan === "notify_reconnect") {
        await notifyReconnect(svc, row, now); r.notified += 1
      }
    } catch { r.errors += 1 }
  }
  return r
}

/** One reconnect nudge per account per week — to the connecting user, else the
 *  brokerage's admins. Honest copy: reconnect, or posting stops on <date>. */
async function notifyReconnect(svc: any, row: SocialTokenRow, now: Date): Promise<void> {
  const isoWeekTag = `[social-token:${row.id}:${now.toISOString().slice(0, 10).slice(0, 8)}]`
  const { data: dup } = await svc.from("notifications").select("id")
    .eq("type", "social_token_expiring").eq("entity_id", row.id)
    .gte("created_at", new Date(now.getTime() - 7 * 86_400_000).toISOString()).limit(1).maybeSingle()
  if (dup) return
  let userIds: string[] = row.user_id ? [row.user_id] : []
  if (userIds.length === 0 && row.brokerage_id) {
    const { data: admins } = await svc.from("users").select("id")
      .eq("brokerage_id", row.brokerage_id).in("user_type", ["broker", "broker_admin", "admin"]).limit(5)
    userIds = ((admins ?? []) as any[]).map((u) => u.id)
  }
  const expires = row.token_expires_at ? new Date(row.token_expires_at).toLocaleDateString() : "soon"
  for (const uid of userIds) {
    await svc.from("notifications").insert({
      user_id: uid, brokerage_id: row.brokerage_id, type: "social_token_expiring",
      title: `Reconnect ${row.platform ?? "social"} — posting stops ${expires}`,
      body: `The ${row.platform ?? "social"} connection${row.account_name ? ` (${row.account_name})` : ""} is expiring and can't be renewed automatically. Reconnect it in Settings → Social to keep scheduled posts flowing. ${isoWeekTag}`,
      entity_type: "social_media_account", entity_id: row.id, priority: "high", channel: "in_app", is_read: false,
    }).then(undefined, () => {})
  }
}
