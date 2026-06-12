/**
 * app/api/internal/remotion/render-just-listed/route.ts
 *
 * The Remotion + ElevenLabs + (optional) D-ID hybrid render endpoint.
 *
 * Called by the Wave 14 cron when a listing_promo_videos row is in
 * 'remotion_pending'. End-to-end orchestration:
 *
 *   1. Load the row + listing + agent_voice_profiles + listing_media images.
 *   2. Draft the narration script via the AI Gateway (banned: invented
 *      facts, protected-class refs, rate/valuation guarantees).
 *   3. Pre-flight evaluateOutbound (broadcast shape — Brand voice + Fair
 *      Housing state-specific + Them-First). Re-prompt once on violation.
 *   4. ElevenLabs TTS — synthesize the narration in the agent's cloned voice;
 *      upload mp3 to Supabase Storage (listing-media bucket).
 *   5. Remotion bundle + renderMedia — produces a 25s 1080×1920 MP4 with
 *      brokerage brand + property images + the voiceover audio track.
 *      Upload to Supabase Storage as the canonical artifact.
 *   6. Create ai_video_projects row with video_url + compliance_status='passed'.
 *   7. HYBRID OPTION: submit two short D-ID renders (intro hook "Hi I'm Jane
 *      — just listed at 123 Main" + outro CTA "DM me to tour") via the same
 *      dispatchVideo egress. The poll-did-videos cron picks them up. The
 *      Wave 14 listing-promo-hybrid-composite cron stitches them onto the
 *      Remotion middle once both lands (via concatIntroOutro / ffmpeg —
 *      lib/video/composite-attribution.ts, already shipped).
 *   8. Update listing_promo_videos: status='rendering', video_project_id set,
 *      and persist the hybrid talk_ids so the composite cron knows which
 *      D-ID jobs to wait on.
 *
 * Auth: same CRON_SECRET pattern — this is an internal endpoint invoked by
 * the listing-promo-render cron, never by a user.
 *
 * Chromium: requires @sparticuz/chromium-min on Vercel. vercel.json
 * includes the binary via functions.includeFiles. maxDuration=300s gives
 * us headroom for the 60-90s Remotion render + ElevenLabs round-trip.
 */
import "server-only"
import { NextResponse, type NextRequest } from "next/server"
import { put } from "@vercel/blob"
import { createServiceClient } from "@/lib/supabase/service"
import { synthesizeSpeech } from "@/lib/voice/elevenlabs-tts"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { runWithComplianceRedraft } from "@/lib/kernel/compliance-redraft"
import { dispatchVideo } from "@/lib/providers/dispatch"
import { KernelEvent } from "@/lib/kernel/events"
import { generateTextRouted } from "@/lib/ai/models"
import { getBundle } from "@/lib/remotion/bundle-cache"
import { selectComposition, renderMedia } from "@remotion/renderer"
import { mintVideoQr, type VideoQrKind } from "@/lib/video/video-qr"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface ReqBody {
  listing_promo_video_id: string
  /** When true, also submit D-ID intro hook + outro CTA renders. The
   *  composite cron stitches them onto the Remotion middle once both land.
   *  Default true — the user-greenlit Wave 14 ships the hybrid by default. */
  hybrid?: boolean
}

interface PromoRow {
  id:             string
  brokerage_id:   string
  listing_id:     string
  agent_id:       string
  event_type:     string
  status:         string
}

interface ListingFacts {
  id:            string
  brokerage_id:  string
  address:       string
  city_state:    string
  price:         string
  bedrooms:      string
  bathrooms:     string
  sqft:          string
  property_type: string
  images:        string[]
}

interface BrandContext {
  primaryColor: string
  accentColor:  string
  logoUrl?:     string
  agentName?:   string
  agentPhone?:  string
  showEhoMark:  boolean
}

export async function POST(req: NextRequest) {
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  if (process.env.CRON_SECRET && headerSecret !== process.env.CRON_SECRET) {
    return unauthorized()
  }

  let body: ReqBody
  try { body = (await req.json()) as ReqBody } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }) }
  if (!body.listing_promo_video_id) return NextResponse.json({ error: "listing_promo_video_id required" }, { status: 400 })
  const hybrid = body.hybrid ?? true

  const svc = createServiceClient()

  // 1. Load the row + claim it (idempotency — flip remotion_pending → rendering
  //    in a single update so a concurrent invocation can't double-render).
  const claim = await svc.from("listing_promo_videos")
    .update({ status: "rendering" })
    .eq("id", body.listing_promo_video_id)
    .eq("status", "remotion_pending")
    .select("id, brokerage_id, listing_id, agent_id, event_type, status")
    .maybeSingle()
  const promo = claim.data as PromoRow | null
  if (!promo) {
    return NextResponse.json({ skipped: "row not in remotion_pending or not found" }, { status: 200 })
  }

  try {
    // 2. Gather facts + brand context.
    const facts = await loadListingFacts(svc, promo.listing_id)
    const brand = await loadBrandContext(svc, promo.brokerage_id, promo.agent_id)

    // 3. Draft + pre-flight compliance (broadcast shape).
    const script = await draftAndClearScript({
      svc,
      brokerageId: promo.brokerage_id,
      agentUserId: promo.agent_id,
      facts,
      eventType:   promo.event_type,
    })

    // 4. ElevenLabs voiceover → Supabase storage URL.
    const voiceoverUrl = await renderVoiceover({
      svc,
      brokerageId: promo.brokerage_id,
      agentUserId: promo.agent_id,
      promoId:     promo.id,
      script,
    })

    // 4b. Mint (or reuse) the tracked outro QR for this listing × event.
    //     Never throws — a null mint means the reel renders without a QR.
    //     just_listed/just_sold → listing_detail; open_house → book_meeting.
    const qr = await mintVideoQr({
      brokerageId: promo.brokerage_id,
      agentUserId: promo.agent_id,
      kind:        videoQrKindForEvent(promo.event_type),
      listingId:   promo.listing_id,
    }, svc)

    // 5. Remotion render → Supabase storage URL.
    const reelUrl = await renderRemotionReel({
      promoId: promo.id,
      facts,
      brand,
      voiceoverUrl,
      eventType: promo.event_type,
      qrCodeDataUrl: qr?.qrCodeDataUrl ?? null,
      qrCaption:     qrCaptionForEvent(promo.event_type),
    })

    // 6. Create ai_video_projects row + emit canonical event.
    const { data: project } = await svc.from("ai_video_projects").insert({
      brokerage_id:    promo.brokerage_id,
      agent_id:        promo.agent_id,
      listing_id:      promo.listing_id,
      title:           `${eventLabel(promo.event_type)} — ${facts.address}`,
      script_content:  script,
      video_type:      "listing_promo",
      status:          hybrid ? "generating" : "completed",
      usage_intent:    "public_marketing",
      audience_type:   "customer_facing",
      duration_seconds: 25,
      video_url:       reelUrl,
      compliance_status: "passed",
      compliance_evaluated_at: new Date().toISOString(),
      video_metadata: {
        promo_event_type: promo.event_type,
        promo_ledger_id:  promo.id,
        listing_id:       promo.listing_id,
        voiceover_url:    voiceoverUrl,
        remotion_only:    !hybrid,
      },
    }).select("id").single()

    await svc.from("listing_promo_videos").update({
      video_project_id: project!.id,
    }).eq("id", promo.id)

    await svc.from("lifecycle_events").insert({
      brokerage_id:  promo.brokerage_id,
      actor_user_id: promo.agent_id,
      event_type:    hybrid ? KernelEvent.VIDEO_GENERATION_REQUESTED : KernelEvent.VIDEO_GENERATION_COMPLETED,
      metadata: {
        ai_video_project_id: project!.id,
        promo_ledger_id:     promo.id,
        listing_id:          promo.listing_id,
        hybrid,
      },
      entity_id:   project!.id,
      entity_type: "ai_video_project",
      source:      "system",
      processed:   false,
    })

    // 7. HYBRID — submit D-ID intro + outro renders to the same egress. The
    //    poll-did-videos cron lands them in our storage; the hybrid composite
    //    cron stitches them around the Remotion middle.
    if (hybrid) {
      const introResult = await dispatchVideo({
        brokerageId:    promo.brokerage_id,
        userId:         promo.agent_id,
        templateId:     buildHybridHookScript("intro", facts, brand.agentName ?? ""),
        recipientEmail: "system@internal",
        systemSource:   `listing_promo_hybrid.intro`,
        metadata: { ai_video_project_id: project!.id, hook_position: "intro" },
      })
      const outroResult = await dispatchVideo({
        brokerageId:    promo.brokerage_id,
        userId:         promo.agent_id,
        templateId:     buildHybridHookScript("outro", facts, brand.agentName ?? ""),
        recipientEmail: "system@internal",
        systemSource:   `listing_promo_hybrid.outro`,
        metadata: { ai_video_project_id: project!.id, hook_position: "outro" },
      })
      await svc.from("ai_video_projects").update({
        video_metadata: {
          promo_event_type: promo.event_type,
          promo_ledger_id:  promo.id,
          listing_id:       promo.listing_id,
          voiceover_url:    voiceoverUrl,
          remotion_only:    false,
          hybrid_intro_job_id: introResult.messageId ?? null,
          hybrid_outro_job_id: outroResult.messageId ?? null,
          hybrid_pending:      true,
        },
      }).eq("id", project!.id)
    }

    return NextResponse.json({
      ok:              true,
      promo_id:        promo.id,
      ai_video_project_id: project!.id,
      remotion_url:    reelUrl,
      voiceover_url:   voiceoverUrl,
      hybrid_pending:  hybrid,
    })
  } catch (err) {
    const msg = (err as Error).message
    await svc.from("listing_promo_videos").update({
      status:        "failed",
      error_message: msg.slice(0, 800),
    }).eq("id", promo.id)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadListingFacts(svc: ReturnType<typeof createServiceClient>, listingId: string): Promise<ListingFacts> {
  const { data: l } = await svc.from("listings")
    .select("id, brokerage_id, address, city, state, list_price, bedrooms, bathrooms, sqft, property_type")
    .eq("id", listingId)
    .maybeSingle()
  if (!l) throw new Error("listing not found")
  const lr = l as { id: string; brokerage_id: string; address: string | null; city: string | null; state: string | null; list_price: number | null; bedrooms: number | null; bathrooms: number | null; sqft: number | null; property_type: string | null }
  const { data: media } = await svc.from("listing_media")
    .select("file_url, sort_order, is_primary, media_type")
    .eq("listing_id", listingId)
    .eq("media_type", "image")
    .order("sort_order", { ascending: true })
    .limit(8)
  const usd = (n: number | null) =>
    n != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n) : ""
  return {
    id:            lr.id,
    brokerage_id:  lr.brokerage_id,
    address:       lr.address ?? "",
    city_state:    [lr.city, lr.state].filter(Boolean).join(", "),
    price:         usd(lr.list_price),
    bedrooms:      lr.bedrooms != null ? String(lr.bedrooms) : "",
    bathrooms:     lr.bathrooms != null ? String(lr.bathrooms) : "",
    sqft:          lr.sqft != null ? lr.sqft.toLocaleString("en-US") : "",
    property_type: lr.property_type ?? "",
    images:        (media ?? []).map((m: { file_url: string }) => m.file_url).filter(Boolean),
  }
}

async function loadBrandContext(svc: ReturnType<typeof createServiceClient>, brokerageId: string, agentUserId: string): Promise<BrandContext> {
  const { data: b } = await svc.from("brokerages")
    .select("name, logo_url, brand_primary_color, brand_accent_color")
    .eq("id", brokerageId)
    .maybeSingle()
  const br = b as { name: string | null; logo_url: string | null; brand_primary_color: string | null; brand_accent_color: string | null } | null
  const { data: u } = await svc.from("users")
    .select("first_name, last_name, phone")
    .eq("id", agentUserId)
    .maybeSingle()
  const ur = u as { first_name: string | null; last_name: string | null; phone: string | null } | null
  return {
    primaryColor: br?.brand_primary_color ?? "#0F172A",
    accentColor:  br?.brand_accent_color  ?? "#F59E0B",
    logoUrl:      br?.logo_url            ?? undefined,
    agentName:    [ur?.first_name, ur?.last_name].filter(Boolean).join(" ") || undefined,
    agentPhone:   ur?.phone ?? undefined,
    showEhoMark:  true,
  }
}

async function draftAndClearScript(args: {
  svc: ReturnType<typeof createServiceClient>
  brokerageId: string
  agentUserId: string
  facts: ListingFacts
  eventType: string
}): Promise<string> {
  const draft = async (violations: string[]) => {
    const violationLine = violations.length > 0
      ? `\n\nYour previous draft failed compliance. Resolve these violations:\n- ${violations.join("\n- ")}\n`
      : ""
    const prompt = `Write a 60-80 word voiceover script for a real-estate ${eventLabel(args.eventType)} reel.
Use ONLY these facts — do not invent:
- Address: ${args.facts.address || "(omitted)"}
- Location: ${args.facts.city_state || "(omitted)"}
- Price: ${args.facts.price || "(omitted)"}
- Bedrooms: ${args.facts.bedrooms || "(omitted)"}
- Bathrooms: ${args.facts.bathrooms || "(omitted)"}
- Sq ft: ${args.facts.sqft || "(omitted)"}
- Property type: ${args.facts.property_type || "(omitted)"}

Style: first-person, energetic but professional. Lead with the hook, hit 2-3 facts, close with "DM me to tour."
Banned: protected-class refs (race, religion, family status, national origin, gender, sexual orientation, disability, source of income); phrases like "perfect for families" or "ideal starter home"; rate/valuation/appreciation guarantees; exclamation marks.
Return ONLY the script text the avatar will speak — no scene directions.${violationLine}`
    const { text } = await generateTextRouted({
      feature:     "listing_promo_voiceover_script",
      prompt,
      maxTokens:   220,
      temperature: 0.5,
    })
    return text.trim()
  }
  const result = await runWithComplianceRedraft({
    draft: ({ violations }) => draft(violations),
    gate:  async (script) => {
      const r = await evaluateOutbound({
        actorContext: { brokerageId: args.brokerageId, userId: args.agentUserId, role: "system" },
        journeyType:  "seller",
        persona:      "other",
        messageType:  "social",
        content:      script,
      })
      return { allowed: r.allowed, violations: r.violations }
    },
  })
  if (!result.ok) throw new Error(`compliance failed after redraft: ${result.violations.join("; ")}`)
  return result.script
}

async function renderVoiceover(args: {
  svc: ReturnType<typeof createServiceClient>
  brokerageId: string
  agentUserId: string
  promoId: string
  script: string
}): Promise<string> {
  const { data: profile } = await args.svc.from("agent_voice_profiles")
    .select("elevenlabs_voice_id")
    .eq("agent_id", args.agentUserId)
    .maybeSingle()
  const voiceId = (profile as { elevenlabs_voice_id?: string } | null)?.elevenlabs_voice_id ?? null
  if (!voiceId) throw new Error("agent has no elevenlabs_voice_id — Settings → Voice & Avatar")

  const tts = await synthesizeSpeech({ text: args.script, voiceId })
  if (!tts.success || !tts.audioBuffer) throw new Error(`ElevenLabs TTS failed: ${tts.error}`)

  const blob = await put(
    `listing-promo/voiceover/${args.promoId}.mp3`,
    tts.audioBuffer,
    { access: "public", contentType: "audio/mpeg" },
  )
  return blob.url
}

/** Map a listing-promo event_type to a video-qr kind. just_sold maps to its
 *  own kind (CTA = list-with-me); open_house_* routes to the RSVP booking
 *  link; everything else is a just_listed listing-detail QR. */
function videoQrKindForEvent(eventType: string): VideoQrKind {
  if (eventType === "just_sold" || eventType === "under_contract") return "just_sold"
  if (eventType === "open_house_announce" || eventType === "open_house_reminder") return "open_house"
  return "just_listed"
}

function qrCaptionForEvent(eventType: string): string {
  if (eventType === "just_sold" || eventType === "under_contract") return "Scan to list with me"
  if (eventType === "open_house_announce" || eventType === "open_house_reminder") return "Scan to RSVP"
  return "Scan to tour"
}

async function renderRemotionReel(args: {
  promoId: string
  facts: ListingFacts
  brand: BrandContext
  voiceoverUrl: string
  eventType: string
  qrCodeDataUrl: string | null
  qrCaption: string
}): Promise<string> {
  // Bundle Remotion compositions once per cold start. The bundler reads
  // remotion/index.ts which registers RemotionRoot.
  const entryPoint = path.join(process.cwd(), "remotion", "index.ts")
  const bundleLocation = await getBundle(entryPoint)

  const inputProps = {
    hook:        eventLabel(args.eventType),
    address:     args.facts.address,
    cityState:   args.facts.city_state,
    price:       args.facts.price,
    bedrooms:    args.facts.bedrooms,
    bathrooms:   args.facts.bathrooms,
    sqft:        args.facts.sqft,
    imageUrls:   args.facts.images,
    brand:       args.brand,
    voiceoverUrl: args.voiceoverUrl,
    qrCodeDataUrl: args.qrCodeDataUrl,
    qrCaption:     args.qrCaption,
  }

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id:       "JustListedReel",
    inputProps,
  })

  // Resolve Chromium executable. In Vercel, @sparticuz/chromium-min provides
  // a downloadable binary the @remotion/renderer uses via puppeteer-core
  // under the hood. Locally (where the user runs npm run dev) Remotion uses
  // a bundled Chromium and the executablePath is optional.
  let executablePath: string | undefined
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const chromium = (await import("@sparticuz/chromium-min")).default
    executablePath = await chromium.executablePath(
      process.env.CHROMIUM_PACK_URL || "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.tar"
    )
  }

  const outPath = path.join(tmpdir(), `listing-promo-${args.promoId}.mp4`)
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec:    "h264",
    outputLocation: outPath,
    inputProps,
    concurrency: 1,
    chromiumOptions: { headless: true, gl: "swangle" },
    ...(executablePath ? { puppeteerInstance: undefined, browserExecutable: executablePath } : {}),
  })

  const bytes = await fs.readFile(outPath)
  await fs.unlink(outPath).catch(() => {})
  const blob = await put(
    `listing-promo/reels/${args.promoId}.mp4`,
    bytes,
    { access: "public", contentType: "video/mp4" },
  )
  return blob.url
}

function buildHybridHookScript(position: "intro" | "outro", facts: ListingFacts, agentName: string): string {
  if (position === "intro") {
    return `Hi, I'm ${agentName || "your agent"}. ${facts.address ? `Just listed at ${facts.address}.` : "I have a new listing for you."} Watch.`
  }
  return `Want to see it? DM me to schedule a tour.`
}

function eventLabel(eventType: string): string {
  switch (eventType) {
    case "just_listed":   return "Just Listed"
    case "just_sold":     return "Just Sold"
    case "price_changed": return "Price Update"
    default:              return "New Listing"
  }
}
