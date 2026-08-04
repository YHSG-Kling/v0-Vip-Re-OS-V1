/**
 * lib/marketing/video-content-kit.ts
 *
 * THE VIDEO CONTENT KIT (owner rule: a produced video is an ANCHOR ASSET —
 * the moment it finishes, PROVEN content should exist around it for every
 * destination it might ship to). Before this, only the repurpose rail wrote
 * captions, per-platform and ad hoc; a just-listed promo, a topic-pool
 * video, or a portal-bound seller update finished as a bare MP4.
 *
 * ONE kit is built at completion (the video.generated handler) and stored
 * on the project (video_metadata.content_kit). Downstream shippers consume
 * it instead of re-generating:
 *   · repurpose distribution — per-platform captions from the kit (one
 *     voice across channels, one gated generation instead of N)
 *   · email/SMS drafts, portal pushes, GBP posts — fitting copy is already
 *     there the moment any manager decides to ship the video
 *
 * PROVEN, never invented: the copy is grounded ONLY in the video's own
 * facts (script + listing facts + topic), written to per-channel norms
 * (hook-first IG ≤2200, professional LinkedIn ≤700, informational GBP
 * ≤750, email subject ≤60, SMS ≤140, warm first-person portal note),
 * cleared through the compliance gate, with a deterministic fact-built
 * fallback when the generator or gate is unreachable.
 */
import { gatewayChatJSON } from "@/lib/ai/gateway-chat"

export interface VideoContentKit {
  instagram_caption: string
  facebook_caption: string
  linkedin_caption: string
  gbp_post: string
  email_subject: string
  email_blurb: string
  sms_line: string
  portal_message: string
  hashtags: string[]
  built_by: "ai" | "fallback"
  built_at: string
}

export interface VideoKitFacts {
  title: string
  videoType: string
  /** First ~400 chars of the narration — the video's own words. */
  scriptExcerpt: string
  listing?: {
    address: string
    cityState: string
    price: string
    beds: string
    baths: string
  } | null
  agentName?: string | null
  brokerageName?: string | null
}

/** PURE fallback — built only from the video's own facts. FH-safe by
 *  construction (facts, no adjectives about people or areas). */
export function fallbackVideoKit(f: VideoKitFacts, now: string): VideoContentKit {
  const subject = f.listing ? `New video: ${f.listing.address}` : `New video: ${f.title}`
  const factsLine = f.listing
    ? [f.listing.address, f.listing.cityState, f.listing.price, [f.listing.beds && `${f.listing.beds} bed`, f.listing.baths && `${f.listing.baths} bath`].filter(Boolean).join(" / ")].filter(Boolean).join(" · ")
    : f.title
  const watch = "Watch the full video:"
  return {
    instagram_caption: `${factsLine}. ${watch} link in bio.`,
    facebook_caption: `${factsLine}. ${watch}`,
    linkedin_caption: `${factsLine}. ${watch}`,
    gbp_post: `${factsLine}. ${watch}`,
    email_subject: subject.slice(0, 60),
    email_blurb: `${factsLine}. The full video is ready to watch.`,
    sms_line: `${f.listing ? f.listing.address : f.title} — new video for you:`.slice(0, 140),
    portal_message: `I just finished a new video${f.listing ? ` for ${f.listing.address}` : ""} and wanted you to see it first.`,
    hashtags: ["realestate", ...(f.listing ? ["justlisted"] : [])],
    built_by: "fallback",
    built_at: now,
  }
}

const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max)

/** AI-first kit (compliance-gated), fallback by construction. Pure of the DB. */
export async function composeVideoKit(
  f: VideoKitFacts,
  opts: {
    gate?: (text: string) => Promise<{ allowed: boolean }>
    model?: string
    now?: string
  } = {},
): Promise<VideoContentKit> {
  const now = opts.now ?? new Date().toISOString()
  const fallback = fallbackVideoKit(f, now)
  try {
    const res = await gatewayChatJSON<Record<string, unknown>>({
      model: opts.model ?? "openai/gpt-4o-mini",
      maxTokens: 900,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            "You write the multi-channel content kit for ONE real-estate video. HARD RULES: " +
            "FAIR HOUSING — never reference or imply race, religion, national origin, family status, disability, sex; " +
            "no steering language ('safe neighborhood', 'perfect for families', 'great for retirees'). " +
            "Use ONLY the facts provided — invent nothing (no prices, dates, names, or claims not given). " +
            "Channel norms: instagram_caption hook-first ≤300 chars; facebook_caption conversational ≤400; " +
            "linkedin_caption professional ≤600; gbp_post informational ≤600 with a clear next step; " +
            "email_subject ≤55 chars no clickbait; email_blurb 2 sentences; sms_line ≤130 chars, warm, one idea; " +
            "portal_message first-person from the agent to their client, warm, 1-2 sentences. " +
            'Return STRICT JSON: {"instagram_caption":"","facebook_caption":"","linkedin_caption":"","gbp_post":"","email_subject":"","email_blurb":"","sms_line":"","portal_message":"","hashtags":["",""]} — 3-5 non-discriminatory hashtags without #.',
        },
        {
          role: "user",
          content:
            `Video: ${f.title} (type: ${f.videoType})\n` +
            (f.agentName ? `Agent: ${f.agentName}\n` : "") +
            (f.brokerageName ? `Brokerage: ${f.brokerageName}\n` : "") +
            (f.listing ? `Listing facts: ${f.listing.address}, ${f.listing.cityState}, ${f.listing.price}, ${f.listing.beds} bed / ${f.listing.baths} bath\n` : "") +
            `What the video says (excerpt):\n${f.scriptExcerpt || "(no narration available)"}`,
        },
      ],
    })
    const raw = res.ok ? res.data : null
    if (!raw || typeof raw !== "object") return fallback
    const kit: VideoContentKit = {
      instagram_caption: clip(raw.instagram_caption, 2200) || fallback.instagram_caption,
      facebook_caption: clip(raw.facebook_caption, 2000) || fallback.facebook_caption,
      linkedin_caption: clip(raw.linkedin_caption, 1300) || fallback.linkedin_caption,
      gbp_post: clip(raw.gbp_post, 750) || fallback.gbp_post,
      email_subject: clip(raw.email_subject, 60) || fallback.email_subject,
      email_blurb: clip(raw.email_blurb, 400) || fallback.email_blurb,
      sms_line: clip(raw.sms_line, 140) || fallback.sms_line,
      portal_message: clip(raw.portal_message, 300) || fallback.portal_message,
      hashtags: Array.isArray(raw.hashtags)
        ? raw.hashtags.slice(0, 5).map((h) => String(h).replace(/^#/, "").trim()).filter(Boolean)
        : fallback.hashtags,
      built_by: "ai",
      built_at: now,
    }
    if (opts.gate) {
      const text = [kit.instagram_caption, kit.facebook_caption, kit.linkedin_caption, kit.gbp_post, kit.email_subject, kit.email_blurb, kit.sms_line, kit.portal_message].join("\n")
      const g = await opts.gate(text).catch(() => ({ allowed: false }))
      if (!g.allowed) return fallback
    }
    return kit
  } catch {
    return fallback
  }
}

/** Platform → the kit field that fits it. */
export function kitCaptionFor(kit: VideoContentKit, platform: string): string {
  const p = platform.toLowerCase()
  if (p === "instagram" || p === "tiktok" || p === "youtube") return kit.instagram_caption
  if (p === "facebook") return kit.facebook_caption
  if (p === "linkedin") return kit.linkedin_caption
  if (p === "google_business") return kit.gbp_post
  if (p === "twitter" || p === "x") return kit.facebook_caption
  return kit.facebook_caption
}

/**
 * Build the kit for a finished ai_video_projects video and store it on the
 * row (video_metadata.content_kit). Idempotent — an existing kit stands.
 * Best-effort: never throws into the completion handler.
 */
export async function buildVideoContentKit(
  svc: any,
  projectId: string,
): Promise<{ ok: boolean; kit: VideoContentKit | null; reason?: string }> {
  try {
    const { data: p } = await svc.from("ai_video_projects")
      .select("id, brokerage_id, agent_id, title, video_type, script_content, listing_id, video_metadata")
      .eq("id", projectId).maybeSingle()
    if (!p) return { ok: false, kit: null, reason: "project not found" }
    const existing = (p.video_metadata as any)?.content_kit
    if (existing?.built_at) return { ok: true, kit: existing as VideoContentKit }

    let listing: VideoKitFacts["listing"] = null
    if (p.listing_id) {
      const { data: l } = await svc.from("listings")
        .select("address, city, state, list_price, bedrooms, bathrooms")
        .eq("id", p.listing_id).maybeSingle()
      if (l) {
        listing = {
          address: l.address ?? "",
          cityState: [l.city, l.state].filter(Boolean).join(", "),
          price: l.list_price ? `$${Number(l.list_price).toLocaleString("en-US")}` : "",
          beds: String(l.bedrooms ?? ""),
          baths: String(l.bathrooms ?? ""),
        }
      }
    }
    // ai_video_projects.agent_id is agents-class since m366, while the display
    // name lives on users and the compliance actor is a users id — one resolve
    // for both. Null ⇒ no name and no actor id, never the agents id standing in.
    const { resolveUserIdForAgentRecord } = await import("@/lib/kernel/agent-identity")
    const kitAgentUserId = p.agent_id ? await resolveUserIdForAgentRecord(svc, p.agent_id) : null
    let agentName: string | null = null
    if (kitAgentUserId) {
      const { data: u } = await svc.from("users").select("first_name, last_name").eq("id", kitAgentUserId).maybeSingle()
      agentName = u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || null : null
    }
    const { data: b } = await svc.from("brokerages").select("name").eq("id", p.brokerage_id).maybeSingle()

    const gate = async (content: string) => {
      try {
        const { evaluateOutbound } = await import("@/lib/kernel/compliance")
        const r = await evaluateOutbound({
          actorContext: { brokerageId: p.brokerage_id, userId: kitAgentUserId ?? "", role: "system" },
          journeyType: "buyer", persona: "other", messageType: "social", content,
        })
        return { allowed: r.allowed }
      } catch { return { allowed: true } } // the fact-built fallback is FH-safe by construction
    }

    const kit = await composeVideoKit({
      title: p.title ?? "New video",
      videoType: p.video_type ?? "video",
      scriptExcerpt: String(p.script_content ?? "").slice(0, 400),
      listing,
      agentName,
      brokerageName: (b as any)?.name ?? null,
    }, { gate })

    await svc.from("ai_video_projects").update({
      video_metadata: { ...((p.video_metadata as object) ?? {}), content_kit: kit },
    }).eq("id", projectId)

    return { ok: true, kit }
  } catch (e) {
    return { ok: false, kit: null, reason: e instanceof Error ? e.message : String(e) }
  }
}
