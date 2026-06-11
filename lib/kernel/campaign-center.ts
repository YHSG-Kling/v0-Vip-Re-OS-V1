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

export type CampaignChannel = "social" | "email" | "newsletter" | "blog" | "direct_mail" | "ad" | "neighbor_farm" | "open_house"

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

  const [social, email, nl, blog, dm, ads, farms, ohs] = await Promise.all([
    supabase.from("social_posts").select("id, post_type, post_brief, approval_status, created_at").eq("brokerage_id", brokerageId).eq("approval_status", "pending").limit(200),
    supabase.from("email_campaigns").select("id, campaign_name, approval_status, created_at").eq("brokerage_id", brokerageId).eq("approval_status", "pending").limit(200),
    supabase.from("newsletter_campaigns").select("id, campaign_name, approval_status, created_at").eq("brokerage_id", brokerageId).eq("approval_status", "pending_review").limit(200),
    supabase.from("blog_posts").select("id, title, publish_status, created_at").eq("brokerage_id", brokerageId).eq("publish_status", "pending_review").limit(200),
    supabase.from("direct_mail_campaigns").select("id, campaign_name, approval_status, created_at").eq("brokerage_id", brokerageId).eq("approval_status", "pending").limit(200),
    supabase.from("ad_campaigns").select("id, campaign_name, status, created_at, targeting_config").eq("brokerage_id", brokerageId).eq("status", "draft").limit(200),
    supabase.from("neighbor_notification_campaigns").select("id, status, created_at, listing_id").eq("brokerage_id", brokerageId).eq("status", "awaiting_seller_permission").limit(200),
    supabase.from("open_houses").select("id, title, status, created_at").eq("brokerage_id", brokerageId).eq("status", "draft").limit(200),
  ])

  for (const s of (social.data ?? []) as any[]) items.push({ channel: "social", id: s.id, title: `Social: ${String(s.post_type ?? "post").replace(/_/g, " ")}`, play: playTagOf(s.post_brief), status: s.approval_status, createdAt: s.created_at })
  for (const e of (email.data ?? []) as any[]) items.push({ channel: "email", id: e.id, title: e.campaign_name, play: playTagOf(e.campaign_name), status: e.approval_status, createdAt: e.created_at })
  for (const n of (nl.data ?? []) as any[]) items.push({ channel: "newsletter", id: n.id, title: n.campaign_name, play: playTagOf(n.campaign_name), status: n.approval_status, createdAt: n.created_at })
  for (const b of (blog.data ?? []) as any[]) items.push({ channel: "blog", id: b.id, title: b.title, play: playTagOf(b.title), status: b.publish_status, createdAt: b.created_at })
  for (const d of (dm.data ?? []) as any[]) items.push({ channel: "direct_mail", id: d.id, title: d.campaign_name, play: playTagOf(d.campaign_name), status: d.approval_status, createdAt: d.created_at })
  for (const a of (ads.data ?? []) as any[]) items.push({ channel: "ad", id: a.id, title: a.campaign_name, play: playTagOf(a.campaign_name) ?? playTagOf((a.targeting_config?.play ?? "")), status: a.status, createdAt: a.created_at })
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
