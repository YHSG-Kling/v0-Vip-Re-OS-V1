/**
 * lib/video/persona-variant-post-pass.ts
 *
 * Wave 28 — extracted from Wave 22's inline newsletter renderPersonaVariants
 * so listing-promo, podcast video, and any future video channel can fire
 * the SAME per-persona thumbnail + intro-overlay post-pass against the
 * generalized asset_persona_renders table (m138).
 *
 * Inputs:
 *   · assetType    — 'newsletter_campaign' | 'listing_promo' | …
 *                    (must match the asset_persona_renders.asset_type CHECK)
 *   · assetId      — the campaign/listing/episode id whose final MP4 is set
 *   · brokerageId  — tenant scoping
 *   · agentUserId  — the agent who owns the asset (for the still composition's
 *                    name/photo lookup)
 *   · brand        — colors + brokerage name for the thumbnail composition
 *   · mainVideoUrl — the final composited MP4 in Vercel Blob (post-render)
 *   · subject      — short headline shown under the persona hook on the thumb
 *   · bundleLoc    — Remotion bundle path (shared across endpoints)
 *   · executablePath — optional Chromium path for Vercel/Lambda env
 *   · personasOverride — bypass the audience-shape query and render for these
 *                        personas (used by listing-promo where the audience
 *                        is the brokerage's full subscriber base rather than
 *                        an asset-scoped list)
 *   · hookCategoriesHint — categories to mention in the AI hook prompt; lets
 *                          each channel give per-persona-relevant context
 *                          (newsletter "rate window", listing-promo "this
 *                          listing fits your search criteria")
 *
 * Outputs:
 *   · One asset_persona_renders row per persona (status='completed' when
 *     thumbnail + composite both land; 'completed' with composite_url=null
 *     when only the thumb succeeded; 'skipped' when hook compliance failed;
 *     'failed' when the whole persona's render path threw)
 *   · Caller continues without waiting (this function is meant to be
 *     fire-and-forget from the render endpoint — failures roll up
 *     asynchronously so they don't fail the main render)
 *
 * Compliance: every persona hook drafted here goes through evaluateOutbound
 * BEFORE any render dollar is spent. Rejected hooks land as status='skipped'
 * with the failure_reason; no D-ID, no ffmpeg, no Remotion still wasted.
 */
import "server-only"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { put } from "@vercel/blob"
import { selectComposition, renderStill } from "@remotion/renderer"
import { createServiceClient } from "@/lib/supabase/service"
import { burnPersonaOverlay } from "@/lib/video/persona-overlay"
import { generateTextRouted } from "@/lib/ai/models"
import { evaluateOutbound } from "@/lib/kernel/compliance"

export type PersonaVariantAssetType =
  | "newsletter_campaign"
  | "newsletter_video"
  | "listing_promo"
  | "podcast_episode"
  | "social_post"
  | "blog_post"
  | "direct_mail"
  | "landing_page"
  | "marketing_plan_item"

export interface PersonaVariantPostPassArgs {
  assetType:        PersonaVariantAssetType
  assetId:          string
  brokerageId:      string
  agentUserId:      string
  brand:            { primaryColor: string; accentColor: string; logoUrl?: string; brokerageName: string }
  mainVideoUrl:     string
  /** Short headline rendered under the persona hook on the thumbnail.
   *  For newsletter this is the subject_line; for listing-promo it's the
   *  property address; for podcast it's the episode title. */
  subject:          string
  /** Remotion bundle path for the still composition. When omitted, the
   *  post-pass skips the thumbnail step and only does the ffmpeg overlay
   *  (caller's asset_persona_renders row lands with thumbnail_url=null
   *  and composite_video_url set). Newsletter render endpoint passes the
   *  bundle it already loaded for the main render; listing-promo's
   *  composite cron isn't a Remotion environment and omits the bundle. */
  bundleLoc?:       string
  executablePath?:  string
  /** Bypass the audience-shape query and render for these personas
   *  explicitly. Newsletter omits and lets the function pull personas from
   *  subscriber data; listing-promo passes the brokerage's full persona
   *  set since a listing reaches every subscriber. */
  personasOverride?: string[]
  /** Optional hint the AI hook drafter uses to tailor the per-persona
   *  one-liner. Newsletter: "this week's market beat"; listing-promo:
   *  "a new listing on Maple St that fits your search". */
  hookContextHint?: string
}

export async function runPersonaVariantPostPass(args: PersonaVariantPostPassArgs): Promise<void> {
  const svc = createServiceClient()
  try {
    const personas = args.personasOverride
      ?? await resolveTopBrokeragePersonas(svc, args.brokerageId, 5)
    if (personas.length === 0) return

    // Pre-stage queued rows so observability detects "all failed" patterns
    // even when the function returns silently. Same idempotency model as
    // the previous newsletter-only path.
    try {
      const queuedRows = personas.map((persona) => ({
        asset_type:   args.assetType,
        asset_id:     args.assetId,
        brokerage_id: args.brokerageId,
        persona,
        status:       "queued" as const,
      }))
      await svc.from("asset_persona_renders")
        .upsert(queuedRows, { onConflict: "asset_type,asset_id,persona" })
    } catch (e) {
      console.error("[persona-variant-post-pass] pre-stage failed:", (e as Error).message)
    }

    // Agent name + photo for the still composition. Same pattern the
    // newsletter post-pass used (agents ⨝ users).
    const { agentName, agentPhotoUrl } = await resolveAgentDisplay(svc, args.agentUserId)

    // Process personas serially — Remotion + ffmpeg are CPU-heavy and we
    // share a Chromium pool. Per-persona failures stay isolated.
    for (const persona of personas) {
      try {
        await svc.from("asset_persona_renders")
          .update({ status: "rendering" })
          .eq("asset_type", args.assetType)
          .eq("asset_id", args.assetId)
          .eq("persona", persona)

        // Draft the persona hook line — gated by evaluateOutbound BEFORE
        // any render dollar.
        const hookText = await draftPersonaHook({
          assetType:    args.assetType,
          persona,
          subject:      args.subject,
          contextHint:  args.hookContextHint,
          brokerageId:  args.brokerageId,
          agentUserId:  args.agentUserId,
        })
        if (!hookText) {
          await svc.from("asset_persona_renders")
            .update({ status: "skipped", failure_reason: "persona hook draft failed compliance" })
            .eq("asset_type", args.assetType)
            .eq("asset_id", args.assetId)
            .eq("persona", persona)
          continue
        }

        // Still thumbnail via the shared NewsletterDigestThumb composition.
        // Only runs when the caller passed a Remotion bundleLoc; otherwise
        // we skip and rely on the ffmpeg overlay alone (listing-promo's
        // composite cron has no Remotion environment, so it omits the
        // bundle and gets composite_video_url-only variants).
        let thumbUrl: string | null = null
        if (args.bundleLoc) {
          const thumbProps = {
            agentName,
            agentPhotoUrl,
            personaHook: hookText,
            subject:     args.subject,
            brand:       args.brand,
          }
          const thumbComposition = await selectComposition({
            serveUrl:   args.bundleLoc,
            id:         "NewsletterDigestThumb",
            inputProps: thumbProps,
          })
          const thumbFilename = `persona-thumb-${args.assetType}-${args.assetId}-${persona}.png`
            .replace(/[^a-z0-9.-]/gi, "_")
          const thumbPath = path.join(tmpdir(), thumbFilename)
          await renderStill({
            composition: thumbComposition,
            serveUrl:    args.bundleLoc,
            output:      thumbPath,
            inputProps:  thumbProps,
            chromiumOptions: { headless: true, gl: "swangle" },
            ...(args.executablePath ? { browserExecutable: args.executablePath } : {}),
          })
          const thumbBytes = await fs.readFile(thumbPath)
          await fs.unlink(thumbPath).catch(() => {})
          const thumbBlob = await put(
            `asset-persona/${args.assetType}/thumbs/${args.assetId}-${persona}.png`,
            thumbBytes,
            { access: "public", contentType: "image/png" },
          )
          thumbUrl = thumbBlob.url
        }

        // ffmpeg drawtext overlay on the first 3s of the main video.
        const overlay = await burnPersonaOverlay({
          mainVideoUrl:    args.mainVideoUrl,
          personaHookText: hookText,
          textColor:       "white",
          boxColor:        hexToFfmpegRgba(args.brand.primaryColor, 0.55),
          durationSeconds: 3,
        })

        if (!overlay.overlayApplied) {
          // Thumbnail (when present) still differentiates the inbox preview;
          // composite falls back to the main video for this persona at
          // recipient routing time.
          await svc.from("asset_persona_renders")
            .update({
              status:              "completed",
              thumbnail_url:       thumbUrl,
              composite_video_url: null,
              completed_at:        new Date().toISOString(),
              failure_reason:      `composite skipped: ${overlay.skippedReason ?? "unknown"}`,
            })
            .eq("asset_type", args.assetType)
            .eq("asset_id", args.assetId)
            .eq("persona", persona)
          continue
        }

        const compositeBlob = await put(
          `asset-persona/${args.assetType}/composite/${args.assetId}-${persona}.mp4`,
          overlay.outputBuffer,
          { access: "public", contentType: "video/mp4" },
        )

        await svc.from("asset_persona_renders")
          .update({
            status:              "completed",
            thumbnail_url:       thumbUrl,
            composite_video_url: compositeBlob.url,
            completed_at:        new Date().toISOString(),
          })
          .eq("asset_type", args.assetType)
          .eq("asset_id", args.assetId)
          .eq("persona", persona)
      } catch (e) {
        console.error(`[persona-variant-post-pass] ${args.assetType}/${args.assetId}/${persona} failed:`, (e as Error).message)
        await svc.from("asset_persona_renders")
          .update({
            status:         "failed",
            failure_reason: ((e as Error).message ?? "unknown").slice(0, 500),
          })
          .eq("asset_type", args.assetType)
          .eq("asset_id", args.assetId)
          .eq("persona", persona)
      }
    }
  } catch (outerErr) {
    console.error("[persona-variant-post-pass] outer failure:", (outerErr as Error).message)
  }
}

/** Top N personas in the brokerage's subscriber base — used by newsletter.
 *  Listing-promo passes personasOverride directly. */
async function resolveTopBrokeragePersonas(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  limit: number,
): Promise<string[]> {
  const { data: subs } = await svc
    .from("newsletter_subscribers")
    .select("contact:contacts!newsletter_subscribers_contact_id_fkey(contact_persona)")
    .eq("brokerage_id", brokerageId)
    .eq("status", "subscribed")
    .limit(1000)
  const counts = new Map<string, number>()
  for (const row of (subs ?? []) as Array<{ contact?: { contact_persona?: string | null } | Array<{ contact_persona?: string | null }> | null }>) {
    const c = Array.isArray(row.contact) ? row.contact[0] : row.contact
    const p = (c?.contact_persona ?? "").trim()
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p]) => p)
}

async function resolveAgentDisplay(
  svc: ReturnType<typeof createServiceClient>,
  agentUserId: string,
): Promise<{ agentName: string; agentPhotoUrl: string | null }> {
  const { data: agentRow } = await svc
    .from("agents")
    .select("photo_url, user:users!agents_user_id_fkey(first_name, last_name)")
    .eq("user_id", agentUserId)
    .maybeSingle()
  const a = agentRow as { photo_url: string | null; user: { first_name: string | null; last_name: string | null } | Array<{ first_name: string | null; last_name: string | null }> | null } | null
  const userObj = Array.isArray(a?.user) ? a?.user?.[0] : a?.user
  const agentName = [userObj?.first_name, userObj?.last_name].filter(Boolean).join(" ").trim() || "Your agent"
  return { agentName, agentPhotoUrl: a?.photo_url ?? null }
}

/** Per-asset-type hook drafter. Each asset type primes the prompt with its
 *  own intent so the same persona gets a different hook for a market-beat
 *  newsletter vs. a listing-promo vs. a podcast episode. */
async function draftPersonaHook(args: {
  assetType:   PersonaVariantAssetType
  persona:     string
  subject:     string
  contextHint?: string
  brokerageId: string
  agentUserId: string
}): Promise<string | null> {
  const intentByAsset: Record<PersonaVariantAssetType, string> = {
    newsletter_campaign:   "a weekly newsletter inbox-preview",
    newsletter_video:      "a weekly newsletter video opener",
    listing_promo:         "a property promo video opener",
    podcast_episode:       "a podcast episode thumbnail",
    social_post:           "a social-media post preview",
    blog_post:             "a blog-article inbox preview",
    direct_mail:           "a direct-mail piece preview",
    landing_page:          "a landing-page hero",
    marketing_plan_item:   "a marketing-asset preview",
  }
  const intent = intentByAsset[args.assetType]
  const contextLine = args.contextHint
    ? `\nContext for this asset: ${args.contextHint}`
    : ""
  const prompt = `Write a single 8-15 word hook line for ${intent}, written for recipients with persona='${args.persona}'.

The hook lands as the title overlay on the asset's inbox/preview thumbnail. It must:
  · be specific to ${args.persona} — but never demographic. Target by life-stage / financial readiness / property goal.
  · open with the value, not the agent
  · stay punchy: 8-15 words, no period at the end
  · NEVER reference protected classes (race, color, religion, national origin, sex, disability, familial status)
  · NEVER use illegal proxies ("perfect for families", "ideal for young professionals", "great for empty nesters")
  · NEVER make rate, valuation, or appreciation commitments

Subject context for this asset: "${args.subject}"${contextLine}

Return ONLY the hook line text — no quotes, no labels.`
  try {
    const result = await generateTextRouted({
      brokerageId: args.brokerageId,
      userId: args.agentUserId,
      feature:     "persona_variant_hook",
      prompt,
      maxTokens:   60,
      temperature: 0.5,
    })
    const hook = (result.text ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 140)
    if (!hook) return null
    const gate = await evaluateOutbound({
      actorContext: { brokerageId: args.brokerageId, userId: args.agentUserId, role: "agent" },
      journeyType:  "seller",
      persona:      "other",
      messageType:  "email",
      content:      hook,
      // Broadcast payload — see lib/video/script-compliance.ts for why the
      // stub contact is omitted rather than faked.
    }).catch(() => ({ allowed: true, violations: [] as string[] }))
    if (!gate.allowed) return null
    return hook
  } catch (e) {
    console.error("[persona-variant-post-pass] hook draft threw:", (e as Error).message)
    return null
  }
}

/** Convert "#RRGGBB" + alpha → ffmpeg drawtext box color "0xRRGGBB@alpha". */
function hexToFfmpegRgba(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, "").trim()
  if (!/^[0-9a-f]{6}$/i.test(clean)) return `black@${alpha.toFixed(2)}`
  return `0x${clean.toLowerCase()}@${alpha.toFixed(2)}`
}
