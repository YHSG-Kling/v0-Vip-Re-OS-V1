/**
 * app/api/internal/remotion/render-newsletter-video/route.ts
 *
 * Wave 15 — Newsletter campaign video render endpoint. Produces ONE video
 * per newsletter_campaigns row; the same video URL embeds in every
 * recipient's email body, so cost is $0.30 ÷ N (not × N).
 *
 * POST { newsletter_campaign_id: string }
 *
 * Orchestration mirrors the listing-promo render endpoint (Wave 14):
 *   1. Claim newsletter_video_renders row (queued → rendering, atomic).
 *   2. Load campaign + brokerage brand context.
 *   3. AI Gateway drafts a 20-30 word narration (the visual carries the
 *      structural content; the voiceover is the framing line).
 *   4. Pre-flight evaluateOutbound — broadcast shape (Brand voice + Fair
 *      Housing state-specific + Them-First). One redraft on violation.
 *   5. ElevenLabs TTS → Supabase Blob.
 *   6. Remotion renderMedia (NewsletterDigestVideo composition) → Supabase Blob.
 *   7. ai_video_projects row with compliance_status='passed', video_type
 *      'market_update' (canonical existing taxonomy value).
 *   8. Ledger update: status='completed', video_url + voiceover_url stamped.
 *      The publish-newsletters cron picks up the URL via the campaign join
 *      and embeds it in the assembled body (Wave 4 assembler stays
 *      unchanged — we add the embed at the cron layer).
 *
 * Auth: CRON_SECRET (internal endpoint).
 */
import "server-only"
import { NextResponse, type NextRequest } from "next/server"
import { put } from "@vercel/blob"
import { createServiceClient } from "@/lib/supabase/service"
import { synthesizeSpeech } from "@/lib/voice/elevenlabs-tts"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { generateTextRouted } from "@/lib/ai/models"
import { bundle } from "@remotion/bundler"
import { selectComposition, renderMedia } from "@remotion/renderer"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface ReqBody { newsletter_campaign_id: string }

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "")
  if (process.env.CRON_SECRET && auth !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  let body: ReqBody
  try { body = await req.json() as ReqBody } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }) }
  if (!body.newsletter_campaign_id) return NextResponse.json({ error: "newsletter_campaign_id required" }, { status: 400 })

  const svc = createServiceClient()

  // 1. Claim row.
  const claim = await svc.from("newsletter_video_renders")
    .update({ status: "rendering" })
    .eq("newsletter_campaign_id", body.newsletter_campaign_id)
    .eq("status", "queued")
    .select("id, brokerage_id, agent_id")
    .maybeSingle()
  const ledger = claim.data as { id: string; brokerage_id: string; agent_id: string } | null
  if (!ledger) return NextResponse.json({ skipped: "no row in 'queued' status for this campaign" })

  try {
    // 2. Campaign + brand.
    const { data: campaign } = await svc.from("newsletter_campaigns")
      .select("id, brokerage_id, agent_id, subject_line, campaign_name")
      .eq("id", body.newsletter_campaign_id)
      .maybeSingle()
    const camp = campaign as { id: string; brokerage_id: string; agent_id: string | null; subject_line: string | null; campaign_name: string | null } | null
    if (!camp) throw new Error("newsletter_campaign not found")

    const { data: brokerage } = await svc.from("brokerages")
      .select("name, logo_url, brand_primary_color, brand_accent_color")
      .eq("id", camp.brokerage_id)
      .maybeSingle()
    const br = brokerage as { name: string | null; logo_url: string | null; brand_primary_color: string | null; brand_accent_color: string | null } | null

    // Per-recipient section variants exist in newsletter_sections (m115); the
    // video's "section titles" use the section TYPES present on this campaign
    // (canonical taxonomy from m117). Distinct types only.
    const { data: secRows } = await svc.from("newsletter_sections")
      .select("section_type, title, order_index")
      .eq("brokerage_id", camp.brokerage_id)
      .eq("newsletter_id", camp.id) // FK targets newsletter_campaigns.id (m115)
      .order("order_index", { ascending: true })
    const sectionTitles = Array.from(new Set(
      ((secRows ?? []) as { section_type: string | null; title: string | null }[])
        .map((s) => (s.title ?? s.section_type ?? "").trim())
        .filter(Boolean)
    )).slice(0, 3)

    // Light "market beat" line — for autonomous mode the agent's marketing
    // assistant would supply this. For now, derive from the recent
    // newsletter_teasers row OR fall back to a brand-clean default.
    let marketBeat = "A quick recap of what moved in your local market this week"
    try {
      const { data: teaser } = await svc.from("newsletter_teasers")
        .select("content")
        .eq("brokerage_id", camp.brokerage_id)
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (teaser && (teaser as { content?: string }).content) {
        marketBeat = ((teaser as { content?: string }).content as string).slice(0, 110)
      }
    } catch { /* best-effort */ }

    // 3. Draft narration script (20-30 words — voiceover only, the visual
    //    carries the structural content).
    const draft = async (violations: string[]): Promise<string> => {
      const fix = violations.length > 0
        ? `\n\nResolve these violations from prior draft:\n- ${violations.join("\n- ")}`
        : ""
      const prompt = `Write a 25-35 word VOICEOVER narration for a real-estate weekly newsletter intro video.
Subject: ${camp.subject_line ?? camp.campaign_name ?? "This week's market digest"}
Market beat: ${marketBeat}
Sections in the digest: ${sectionTitles.join(", ") || "Market Update, New Listings, Local News"}

Style: first-person, warm, professional. Open with a hook. State what's inside. Close with "Open the email to read more."
Banned: protected-class refs (race, religion, family status, etc.); phrases like "perfect for families"; rate / valuation / appreciation guarantees; exclamation marks.
Return ONLY the spoken text.${fix}`
      const { text } = await generateTextRouted({
        feature:     "newsletter_video_narration",
        prompt,
        maxTokens:   150,
        temperature: 0.55,
      })
      return text.trim()
    }
    let script = await draft([])
    const c1 = await evaluateOutbound({
      actorContext: { brokerageId: camp.brokerage_id, userId: ledger.agent_id, role: "system" },
      journeyType:  "buyer", persona: "other", messageType: "email", content: script,
    })
    if (!c1.allowed) {
      script = await draft(c1.violations)
      const c2 = await evaluateOutbound({
        actorContext: { brokerageId: camp.brokerage_id, userId: ledger.agent_id, role: "system" },
        journeyType:  "buyer", persona: "other", messageType: "email", content: script,
      })
      if (!c2.allowed) throw new Error(`compliance failed after redraft: ${c2.violations.join("; ")}`)
    }

    // 4. ElevenLabs voiceover.
    const { data: profile } = await svc.from("agent_voice_profiles")
      .select("elevenlabs_voice_id")
      .eq("agent_id", ledger.agent_id)
      .maybeSingle()
    const voiceId = (profile as { elevenlabs_voice_id?: string } | null)?.elevenlabs_voice_id ?? null
    if (!voiceId) throw new Error("agent has no elevenlabs_voice_id — Settings → Voice & Avatar")

    const tts = await synthesizeSpeech({ text: script, voiceId })
    if (!tts.success || !tts.audioBuffer) throw new Error(`ElevenLabs failed: ${tts.error}`)
    const voiceBlob = await put(
      `newsletter-video/voiceover/${ledger.id}.mp3`,
      tts.audioBuffer,
      { access: "public", contentType: "audio/mpeg" },
    )

    // 5. Remotion render.
    const entryPoint = path.join(process.cwd(), "remotion", "index.ts")
    const bundleLoc = await bundle({ entryPoint })

    const inputProps = {
      subject:        camp.subject_line ?? camp.campaign_name ?? "This week's digest",
      marketBeat,
      sectionTitles:  sectionTitles.length > 0 ? sectionTitles : ["Market Update", "New Listings", "Local News"],
      brand: {
        primaryColor:  br?.brand_primary_color ?? "#0F172A",
        accentColor:   br?.brand_accent_color  ?? "#F59E0B",
        logoUrl:       br?.logo_url            ?? undefined,
        brokerageName: br?.name                ?? "Your Brokerage",
      },
      voiceoverUrl: voiceBlob.url,
    }
    const composition = await selectComposition({ serveUrl: bundleLoc, id: "NewsletterDigestVideo", inputProps })

    let executablePath: string | undefined
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      const chromium = (await import("@sparticuz/chromium-min")).default
      executablePath = await chromium.executablePath(
        process.env.CHROMIUM_PACK_URL || "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.tar"
      )
    }

    const outPath = path.join(tmpdir(), `newsletter-video-${ledger.id}.mp4`)
    await renderMedia({
      composition, serveUrl: bundleLoc, codec: "h264",
      outputLocation: outPath, inputProps, concurrency: 1,
      chromiumOptions: { headless: true, gl: "swangle" },
      ...(executablePath ? { browserExecutable: executablePath } : {}),
    })
    const bytes = await fs.readFile(outPath)
    await fs.unlink(outPath).catch(() => {})
    const blob = await put(`newsletter-video/reels/${ledger.id}.mp4`, bytes, { access: "public", contentType: "video/mp4" })

    // 6. ai_video_projects + ledger close.
    const { data: project } = await svc.from("ai_video_projects").insert({
      brokerage_id:    camp.brokerage_id,
      agent_id:        ledger.agent_id,
      title:           `Newsletter video — ${camp.subject_line ?? camp.campaign_name ?? camp.id}`,
      script_content:  script,
      video_type:      "market_update",
      status:          "completed",
      usage_intent:    "public_marketing",
      audience_type:   "customer_facing",
      duration_seconds: 20,
      video_url:       blob.url,
      compliance_status: "passed",
      compliance_evaluated_at: new Date().toISOString(),
      video_metadata: {
        newsletter_campaign_id: camp.id,
        ledger_id:              ledger.id,
        voiceover_url:          voiceBlob.url,
        kind:                   "newsletter_digest",
      },
    }).select("id").single()

    await svc.from("newsletter_video_renders").update({
      status:          "completed",
      voiceover_url:   voiceBlob.url,
      video_url:       blob.url,
      video_project_id: project!.id,
      completed_at:    new Date().toISOString(),
    }).eq("id", ledger.id)

    return NextResponse.json({
      ok: true,
      ledger_id: ledger.id,
      video_url: blob.url,
      voiceover_url: voiceBlob.url,
      ai_video_project_id: project!.id,
    })
  } catch (err) {
    const msg = (err as Error).message
    await svc.from("newsletter_video_renders").update({
      status: "failed",
      error_message: msg.slice(0, 800),
    }).eq("id", ledger.id)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
