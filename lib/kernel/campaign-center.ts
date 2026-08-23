// lib/kernel/campaign-center.ts
//
// THE CAMPAIGN COMMAND CENTER — one surface for everything the marketing bench staged.
// The plays (Farm, Launch War Room, Intent Campaign, Lookalike, idle-hands) draft across
// social, email, newsletter, blog, direct mail, ads, neighbor farms, and open houses —
// all gated. Without one place to see them, the agent approves piecemeal and loses the
// thread. This aggregator pulls every channel's PENDING/DRAFT rows into one feed, grouped
// by channel, each row carrying its play (from the AI brief/rationale) so the agent sees
// "here's the whole campaign — approve it." Read-only; NOT server-only.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export type CampaignChannel = "social" | "email" | "newsletter" | "blog" | "direct_mail" | "ad" | "podcast" | "neighbor_farm" | "open_house"

export interface CampaignItem {
  channel: CampaignChannel
  id: string
  title: string
  /** The play that staged it (parsed from the brief/rationale: FARM PLAY / LAUNCH … / INTENT …). */
  play: string | null
  status: string
  createdAt: string
}

export interface CampaignCenterData {
  items: CampaignItem[]
  byChannel: Record<string, number>
  byPlay: Record<string, number>
  total: number
}

/** Pure: extract the play tag from an AI brief / rationale / name. */
export function playTagOf(text: string | null | undefined): string | null {
  const t = (text ?? "").toUpperCase()
  if (t.includes("FARM PLAY")) return "Farm Play"
  if (t.includes("LAUNCH WAR ROOM") || t.includes("LAUNCH ")) return "Launch War Room"
  if (t.includes("INTENT CAMPAIGN")) return "Intent Campaign"
  if (t.includes("LOOKALIKE")) return "Lookalike"
  if (t.includes("IDLE HANDS")) return "Idle Hands"
  return null
}

/** Load the brokerage's staged-but-unapproved campaign drafts across every channel. */
export async function loadCampaignCenter(brokerageId: string, client?: Svc): Promise<CampaignCenterData> {
  const supabase = client ?? createServiceClient()
  const items: CampaignItem[] = []

  const [social, email, nl, blog, dm, ads, podcasts, farms, ohs] = await Promise.all([
    supabase.from("social_posts").select("id, post_type, post_brief, approval_status, created_at").eq("brokerage_id", brokerageId).eq("approval_status", "pending").limit(200),
    supabase.from("email_campaigns").select("id, campaign_name, approval_status, created_at").eq("brokerage_id", brokerageId).eq("approval_status", "pending").limit(200),
    supabase.from("newsletter_campaigns").select("id, campaign_name, approval_status, created_at").eq("brokerage_id", brokerageId).eq("approval_status", "pending_review").limit(200),
    supabase.from("blog_posts").select("id, title, publish_status, created_at").eq("brokerage_id", brokerageId).eq("publish_status", "pending_review").limit(200),
    supabase.from("direct_mail_campaigns").select("id, campaign_name, approval_status, created_at").eq("brokerage_id", brokerageId).eq("approval_status", "pending").limit(200),
    supabase.from("ad_campaigns").select("id, campaign_name, status, created_at, targeting_config").eq("brokerage_id", brokerageId).eq("status", "draft").limit(200),
    // Podcast episodes the bench/auto-producer staged — pending the agent's review before
    // they syndicate to the user's configured podcast channels (Transistor).
    supabase.from("podcast_episodes").select("id, title, approval_status, created_at").eq("brokerage_id", brokerageId).eq("approval_status", "pending_review").limit(200),
    supabase.from("neighbor_notification_campaigns").select("id, status, created_at, listing_id").eq("brokerage_id", brokerageId).eq("status", "awaiting_seller_permission").limit(200),
    // open_house_events is the survivor; `open_houses` was a second spelling of it
    // and was retired by m543 (title merged onto this table in the same migration).
    supabase.from("open_house_events").select("id, title, status, created_at").eq("brokerage_id", brokerageId).eq("status", "draft").limit(200),
  ])

  for (const s of (social.data ?? []) as any[]) items.push({ channel: "social", id: s.id, title: `Social: ${String(s.post_type ?? "post").replace(/_/g, " ")}`, play: playTagOf(s.post_brief), status: s.approval_status, createdAt: s.created_at })
  for (const e of (email.data ?? []) as any[]) items.push({ channel: "email", id: e.id, title: e.campaign_name, play: playTagOf(e.campaign_name), status: e.approval_status, createdAt: e.created_at })
  for (const n of (nl.data ?? []) as any[]) items.push({ channel: "newsletter", id: n.id, title: n.campaign_name, play: playTagOf(n.campaign_name), status: n.approval_status, createdAt: n.created_at })
  for (const b of (blog.data ?? []) as any[]) items.push({ channel: "blog", id: b.id, title: b.title, play: playTagOf(b.title), status: b.publish_status, createdAt: b.created_at })
  for (const d of (dm.data ?? []) as any[]) items.push({ channel: "direct_mail", id: d.id, title: d.campaign_name, play: playTagOf(d.campaign_name), status: d.approval_status, createdAt: d.created_at })
  for (const a of (ads.data ?? []) as any[]) items.push({ channel: "ad", id: a.id, title: a.campaign_name, play: playTagOf(a.campaign_name) ?? playTagOf((a.targeting_config?.play ?? "")), status: a.status, createdAt: a.created_at })
  for (const p of (podcasts.data ?? []) as any[]) items.push({ channel: "podcast", id: p.id, title: `Podcast: ${p.title}`, play: playTagOf(p.title), status: p.approval_status, createdAt: p.created_at })
  for (const f of (farms.data ?? []) as any[]) items.push({ channel: "neighbor_farm", id: f.id, title: "Neighbor farm (awaiting seller OK)", play: "Farm Play", status: f.status, createdAt: f.created_at })
  for (const o of (ohs.data ?? []) as any[]) items.push({ channel: "open_house", id: o.id, title: o.title, play: "Launch War Room", status: o.status, createdAt: o.created_at })

  const byChannel: Record<string, number> = {}
  const byPlay: Record<string, number> = {}
  for (const it of items) {
    byChannel[it.channel] = (byChannel[it.channel] ?? 0) + 1
    const p = it.play ?? "Other"
    byPlay[p] = (byPlay[p] ?? 0) + 1
  }
  items.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
  return { items, byChannel, byPlay, total: items.length }
}

export interface ApproveResult { ok: boolean; note?: string }

/**
 * Approve one campaign item through its channel's own gate (the agent's decision). The
 * content channels flip to 'approved' and their existing publish/send crons take over.
 * The two special channels can't be one-click approved and say why:
 *   · neighbor_farm needs the SELLER's permission (a separate consent step)
 *   · open_house needs a DATE (the system never fabricates one)
 */
export async function approveCampaignItem(
  brokerageId: string, channel: CampaignChannel, id: string, approverUserId: string, client?: Svc,
): Promise<ApproveResult> {
  const supabase = client ?? createServiceClient()
  const stamp = new Date().toISOString()
  const upd = async (table: string, patch: Record<string, unknown>, statusCol: string, fromState: string) => {
    const { data } = await supabase.from(table).update(patch).eq("id", id).eq("brokerage_id", brokerageId).eq(statusCol, fromState).select("id").maybeSingle()
    return !!data
  }
  switch (channel) {
    case "social":       return { ok: await upd("social_posts", { approval_status: "approved", approved_by: approverUserId, approved_at: stamp }, "approval_status", "pending") }
    case "email":        return { ok: await upd("email_campaigns", { approval_status: "approved" }, "approval_status", "pending") }
    case "newsletter":   return { ok: await upd("newsletter_campaigns", { approval_status: "approved" }, "approval_status", "pending_review") }
    case "blog":         return { ok: await upd("blog_posts", { publish_status: "approved", approval_status: "approved" }, "publish_status", "pending_review") }
    case "direct_mail":  return { ok: await upd("direct_mail_campaigns", { approval_status: "approved", status: "approved" }, "approval_status", "pending") }
    case "ad":           return { ok: await upd("ad_campaigns", { status: "approved" }, "status", "draft") }
    case "podcast":      return { ok: await upd("podcast_episodes", { approval_status: "approved" }, "approval_status", "pending_review") }
    case "neighbor_farm": return { ok: false, note: "Neighbor farms need the seller's written permission — grant it on the listing before this can go out." }
    case "open_house":   return { ok: false, note: "Set a date for this open house — the system never schedules one for you." }
  }
}

/** Approve every approvable item of a play in one shot (the special channels are left for
 *  their own flow). Returns how many were approved + which need a separate step. */
export async function approveCampaignPlay(
  brokerageId: string, play: string, approverUserId: string, client?: Svc,
): Promise<{ approved: number; needsAttention: number }> {
  const supabase = client ?? createServiceClient()
  const data = await loadCampaignCenter(brokerageId, supabase)
  let approved = 0, needsAttention = 0
  for (const it of data.items.filter((i) => i.play === play)) {
    const r = await approveCampaignItem(brokerageId, it.channel, it.id, approverUserId, supabase)
    if (r.ok) approved += 1
    else needsAttention += 1
  }
  return { approved, needsAttention }
}
