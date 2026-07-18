"use server"

// app/actions/superadmin/platform-social.ts
// ─────────────────────────────────────────────────────────────────────────────
// COMPANY-CHANNEL ACTIONS — connect/verify/disconnect the platform's OWN social
// accounts, and dispatch approved product drafts through the real publisher when
// (and only when) the channel is connected AND the publisher supports it with
// the tokens we actually hold. Gated by the platform 'marketing' capability
// (requirePlatformCapability — override-aware); every connect start, disconnect,
// and auto-publish is audited. NO fake sends: a channel that can't dispatch says
// exactly why, and the manual copy-&-post flow stays.

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  getPlatformSocialAccounts,
  startPlatformSocialConnect,
  disconnectPlatformChannel,
  verifyPlatformChannel,
  getChannelPublishCredential,
  channelDispatchSupport,
  fetchChannelProfile,
  isPlatformSocialChannel,
  CHANNEL_LABELS,
  type PlatformSocialAccountView,
  type PlatformSocialChannel,
} from "@/lib/platform/platform-social"
import { canTransitionDraft } from "@/lib/platform/product-content"
import { publishToSocialPlatform } from "@/lib/social/publisher"
import { getPublishedPostUrl } from "@/lib/social/get-published-post-url"

type Gate = { ok: true; userId: string; email: string } | { ok: false; error: string }

async function gate(opts: { requireWrite?: boolean } = {}): Promise<Gate> {
  const g = await requirePlatformCapability("marketing", opts)
  if (!g.ok || !g.userId) return { ok: false, error: g.error ?? "Forbidden" }
  const svc = createServiceClient()
  const { data } = await svc.from("users").select("email").eq("id", g.userId).maybeSingle()
  return { ok: true, userId: g.userId, email: (data as any)?.email ?? "" }
}

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>, targetType = "platform_social_account") {
  try {
    const svc = createServiceClient(); const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: targetType, target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-social audit] failed:", err) }
}

// ── List / status ─────────────────────────────────────────────────────────────

export async function listPlatformSocialAccountsAction(): Promise<
  { ok: true; accounts: PlatformSocialAccountView[] } | { ok: false; error: string }
> {
  const auth = await gate()
  if (!auth.ok) return auth
  try {
    const accounts = await getPlatformSocialAccounts(createServiceClient())
    return { ok: true, accounts }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Failed to load company channels" }
  }
}

// ── Connect (start) ───────────────────────────────────────────────────────────

export async function startPlatformSocialConnectAction(channel: string): Promise<
  | { ok: true; url: string }
  | { ok: true; needsCreds: true; missingEnv: string[] }
  | { ok: false; error: string }
> {
  const auth = await gate({ requireWrite: true })
  if (!auth.ok) return auth
  if (!isPlatformSocialChannel(channel)) return { ok: false, error: `Unknown channel: ${channel}` }
  const start = startPlatformSocialConnect(channel)
  if ("needsCreds" in start) {
    // Honest: the OAuth app isn't configured — name the exact env vars.
    return { ok: true, needsCreds: true, missingEnv: start.missingEnv }
  }
  await audit(auth.userId, auth.email, "platform_social.connect_started", channel, { url: start.url })
  return { ok: true, url: start.url }
}

// ── Disconnect ────────────────────────────────────────────────────────────────

export async function disconnectPlatformSocialAction(channel: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await gate({ requireWrite: true })
  if (!auth.ok) return auth
  if (!isPlatformSocialChannel(channel)) return { ok: false, error: `Unknown channel: ${channel}` }
  const res = await disconnectPlatformChannel(createServiceClient(), channel)
  if (res.ok) {
    await audit(auth.userId, auth.email, "platform_social.disconnected", channel, {})
    revalidatePath("/dashboard/superadmin/growth")
  }
  return res
}

// ── Verify (honest provider ping) ─────────────────────────────────────────────

export async function verifyPlatformSocialAction(channel: string): Promise<
  { ok: boolean; status?: string; accountName?: string | null; error?: string }
> {
  const auth = await gate()
  if (!auth.ok) return auth
  if (!isPlatformSocialChannel(channel)) return { ok: false, error: `Unknown channel: ${channel}` }
  const res = await verifyPlatformChannel(createServiceClient(), channel)
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: res.ok, status: res.status, accountName: res.accountName ?? null, error: res.error }
}

// ── Auto-publish an approved product draft through the real publisher ─────────

export async function publishProductDraftAction(input: { id: string }): Promise<
  { ok: true; permalink: string } | { ok: false; error: string }
> {
  const auth = await gate({ requireWrite: true })
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const { data: draft } = await svc.from("platform_social_drafts")
    .select("id, channel, angle, content, hashtags, status, media_type")
    .eq("id", input.id).maybeSingle()
  if (!draft) return { ok: false, error: "Draft not found" }
  if ((draft as any).status !== "approved") return { ok: false, error: "Approve the draft before publishing" }
  if ((draft as any).media_type === "video") {
    return { ok: false, error: "Auto-publish covers text posts only — upload the rendered video on the channel and record the permalink manually" }
  }

  const channel = (draft as any).channel as string
  if (!isPlatformSocialChannel(channel)) return { ok: false, error: `Unknown channel: ${channel}` }
  const support = channelDispatchSupport(channel)
  if (!support.supported || !support.publisherPlatform) {
    return { ok: false, error: support.reason ?? `${CHANNEL_LABELS[channel]} auto-publish is not supported — copy & post manually` }
  }

  const cred = await getChannelPublishCredential(svc, channel)
  if (!cred.ok) return cred

  // LinkedIn posts as the member — the author URN needs the person id. If the
  // connect-time profile ping didn't capture it, fetch it now (and persist).
  let accountId = cred.accountId
  if (support.publisherPlatform === "linkedin" && !accountId) {
    const profile = await fetchChannelProfile(channel, cred.accessToken)
    if (!profile.ok || !profile.accountId) {
      return { ok: false, error: "LinkedIn did not return the member id — run Verify on the channel, or copy & post manually" }
    }
    accountId = profile.accountId
    const { data: acct } = await svc.from("platform_social_accounts").select("credential_ref").eq("platform", channel).maybeSingle()
    if (acct?.credential_ref) {
      await svc.from("platform_credentials").update({ account_id: accountId, updated_at: new Date().toISOString() }).eq("id", acct.credential_ref)
    }
  }

  // Hashtags are stored as one string ("#RealEstate #AI …"); the publisher
  // re-prefixes '#', so strip it here.
  const hashtags = String((draft as any).hashtags ?? "")
    .split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean)

  const result = await publishToSocialPlatform(support.publisherPlatform, {
    content: (draft as any).content,
    accessToken: cred.accessToken,
    accountId: accountId ?? "",
    hashtags,
  })
  if (!result.success) {
    return { ok: false, error: result.error ?? `Publish to ${CHANNEL_LABELS[channel]} failed` }
  }

  const permalink = result.externalPostId
    ? getPublishedPostUrl(support.publisherPlatform, result.externalPostId)
    : null
  if (!permalink) {
    // The post DID go out but the provider returned no id — never invent a link.
    await audit(auth.userId, auth.email, "platform_content.auto_published_unlinked", input.id, { channel }, "platform_social_draft")
    return { ok: false, error: `Posted to ${CHANNEL_LABELS[channel]}, but the provider returned no post id — find the post on the channel and mark it posted with the permalink (do NOT publish again)` }
  }

  const check = canTransitionDraft("approved", "posted", permalink)
  if (!check.ok) return { ok: false, error: check.reason ?? "Invalid transition" }
  const { error: updateError } = await svc.from("platform_social_drafts")
    .update({ status: "posted", permalink, updated_at: new Date().toISOString() })
    .eq("id", input.id).eq("status", "approved")
  if (updateError) {
    return { ok: false, error: `Posted (${permalink}) but recording it failed: ${updateError.message} — mark posted manually with that permalink` }
  }

  await audit(auth.userId, auth.email, "platform_content.auto_published", input.id, {
    channel, permalink, externalPostId: result.externalPostId,
  }, "platform_social_draft")
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true, permalink }
}
