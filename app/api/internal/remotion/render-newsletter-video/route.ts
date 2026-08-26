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
// Was `import { put } from "@vercel/blob"`. Survivor:
// lib/remotion/media-host.ts#hostRenderedMedia — Supabase `video-assets`, the
// bucket the Remotion workers and public players already fetch renders from.
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveUserIdForAgentRecord } from "@/lib/kernel/agent-identity"
import { synthesizeSpeech } from "@/lib/voice/elevenlabs-tts"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { runWithComplianceRedraft } from "@/lib/kernel/compliance-redraft"
import { generateTextRouted } from "@/lib/ai/models"
import { pickTopics, renderTopicsForPrompt } from "@/lib/content-intel/topic-bank"
import { logTopicUses } from "@/lib/content-intel/performance-aggregator"
import { getBundle } from "@/lib/remotion/bundle-cache"
import { selectComposition, renderMedia } from "@remotion/renderer"
import { runPersonaVariantPostPass } from "@/lib/video/persona-variant-post-pass"
import { mintVideoQr } from "@/lib/video/video-qr"
import { compositionSeconds, geometryFor } from "@/lib/remotion/composition-geometry"
import {
  narrationBudget,
  narrationLengthDirective,
  narrationMaxTokens,
  fitNarrationToBudget,
} from "@/lib/video/script-structure"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface ReqBody { newsletter_campaign_id: string }

/** The composition this route renders. One spelling (§6) — it was written out
 *  four times, and the narration cap has to name the SAME one the render does. */
const NEWSLETTER_VIDEO_COMPOSITION = "NewsletterDigestVideo"

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

  // ledger.agent_id is agents-class. The compliance actor, the QR mint, the
  // render registry and the persona post-pass all want the OWNER'S USERS id, so
  // it is resolved once here rather than at each of them. Null means the agents
  // row is gone — those users-class hand-offs are then skipped, never faked.
  const ledgerAgentUserId = await resolveUserIdForAgentRecord(svc, ledger.agent_id)

  try {
    // 2. Campaign + brand.
    const { data: campaign } = await svc.from("newsletter_campaigns")
      .select("id, brokerage_id, agent_id, subject_line, campaign_name")
      .eq("id", body.newsletter_campaign_id)
      .maybeSingle()
    const camp = campaign as { id: string; brokerage_id: string; agent_id: string | null; subject_line: string | null; campaign_name: string | null } | null
    if (!camp) throw new Error("newsletter_campaign not found")

    const { data: brokerage } = await svc.from("brokerages")
      .select("name, logo_url, brand_primary_color:primary_color")
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

    // Market beat line — the topic bank's lead candidate IS the marketBeat
    // now (Wave 16 onwards). We previously fell back to newsletter_teasers
    // when no topic ranked; with Reddit + Exa + RSS + Apify ingesting daily,
    // the bank is rarely empty. Default fallback kicks in only when every
    // source went silent — much rarer than the teasers path was solving for.
    // 3. Pull this week's value-first topics for the narration LEAD. The
    //    20-second video opens with the most timely audience-relevant
    //    insight (e.g. "rates dropped 25bps — here's what it means");
    //    the brokerage's digest sections are the supporting context.
    //
    // Wave 20.1 cohesion fix — if the campaign's sections already logged
    // seed topics in content_topic_uses, honor those exact topics so the
    // video and the email sections develop the SAME threads instead of
    // each producer independently picking and drifting apart. When the
    // sections weren't topic-seeded (older campaigns, manual content),
    // fall back to an independent pickTopics() so the video still gets
    // its own value-first lead.
    let topics = [] as Awaited<ReturnType<typeof pickTopics>>
    const { data: priorUses } = await svc.from("content_topic_uses")
      .select("topic_id")
      .eq("brokerage_id", camp.brokerage_id)
      .eq("asset_type", "newsletter_campaign")
      .eq("asset_id", camp.id)
      .limit(6)
    const sectionSeedIds = ((priorUses ?? []) as Array<{ topic_id: string }>).map((r) => r.topic_id)
    if (sectionSeedIds.length > 0) {
      const { data: seedRows } = await svc.from("content_topic_bank")
        .select("id, topic_title, value_angle, source_url, categories, engagement_score, topic_posted_at, brokerage_id")
        .in("id", sectionSeedIds)
      topics = ((seedRows ?? []) as Array<{
        id: string; topic_title: string; value_angle: string | null; source_url: string | null;
        categories: string[] | null; engagement_score: number; topic_posted_at: string | null;
        brokerage_id: string | null
      }>).map((r) => ({
        id:                 r.id,
        topic_title:        r.topic_title,
        value_angle:        r.value_angle,
        source_url:         r.source_url,
        categories:         r.categories ?? [],
        engagement_score:   r.engagement_score,
        topic_posted_at:    r.topic_posted_at,
        is_brokerage_local: r.brokerage_id !== null,
        geo_match:          false,
      })).slice(0, 3)
    }
    if (topics.length === 0) {
      topics = await pickTopics({
        brokerageId:   camp.brokerage_id,
        categoriesAny: ["buyer_advice", "finance", "market_education", "neighborhood"],
        limit:         3,
        markUsed:      false, // newsletters are sent more often than podcasts;
                              // let the same topic anchor 1-2 newsletters before
                              // moving to 'used'. The podcast cron is the
                              // canonical 'used' flipper.
      })
    }

    // marketBeat headline = the top topic's title (truncated for the visual)
    // or a brand-clean default when the bank ran dry.
    const marketBeat = topics.length > 0
      ? (topics[0].value_angle ?? topics[0].topic_title).slice(0, 110)
      : "A quick recap of what moved in your local market this week"

    // 4. Draft narration — value-first, 25-35 spoken words.
    //
    // THE CAP IS DERIVED FROM THE COMPOSITION, not from the 25-35 above.
    // NewsletterDigestVideo carries this narration as an <Audio> INSIDE the
    // composition (remotion/NewsletterDigestVideo.tsx:66) against a fixed
    // durationInFrames, and step 5 below deliberately does NOT put the mp3 in
    // input_props.voiceover_url ("the narration is already the composition's
    // audio track") — so the m313 tpad that rescues every OTHER narration is
    // switched off here BY DESIGN and an overrun is simply cut. The 25-35 is an
    // editorial target and it happens to sit under the budget; the budget is the
    // enforceable ceiling, and it moves if the composition's geometry moves.
    const narrationCap = narrationBudget(
      NEWSLETTER_VIDEO_COMPOSITION,
      compositionSeconds(geometryFor(NEWSLETTER_VIDEO_COMPOSITION) ?? { duration_frames: 0, fps: 30 }),
    )
    const draft = async (violations: string[]): Promise<string> => {
      const fix = violations.length > 0
        ? `\n\nResolve these violations from prior draft:\n- ${violations.join("\n- ")}`
        : ""
      const prompt = `Write a 25-35 word VOICEOVER narration for a real-estate weekly newsletter intro video.

THE VIDEO IS NOT A LIST OF OUR SECTIONS. It opens with a hook from the
audience's lens — what's the most timely VALUE insight the recipient
should know this week? Then a one-line bridge to "the email below."

This week's lead value topics (drawn from the content intelligence bank
— pick the strongest single thread):

${renderTopicsForPrompt(topics)}

Subject line of the newsletter email: ${camp.subject_line ?? camp.campaign_name ?? "This week's market digest"}
What's IN the email (supporting context, not the lead): ${sectionTitles.join(", ") || "Market Update, New Listings, Local News"}

Style: first-person, warm, professional. Open with the value hook. Close
with "Open the email for the full breakdown." or equivalent.
Banned: protected-class refs (race, religion, family status, etc.);
phrases like "perfect for families"; rate / valuation / appreciation
guarantees; exclamation marks.
${narrationLengthDirective(narrationCap)}
Return ONLY the spoken text.${fix}`
      const { text } = await generateTextRouted({
        brokerageId: camp.brokerage_id,
        userId: ledgerAgentUserId,
        feature:     "newsletter_video_narration",
        prompt,
        maxTokens:   narrationMaxTokens(narrationCap),
        temperature: 0.55,
      })
      // VERIFY, don't trust: a word ceiling in a prompt is a request. Trimmed at
      // a sentence boundary and logged when the model overshoots — never silent.
      const fit = fitNarrationToBudget(text.trim(), narrationCap)
      if (fit.note) console.warn(`[render-newsletter-video] ${fit.note}`)
      return fit.script
    }
    const complianceResult = await runWithComplianceRedraft({
      draft: ({ violations }) => draft(violations),
      gate:  async (s) => {
        const r = await evaluateOutbound({
          actorContext: { brokerageId: camp.brokerage_id, userId: ledgerAgentUserId ?? "", role: "system" },
          journeyType:  "buyer", persona: "other", messageType: "email", content: s,
        })
        return { allowed: r.allowed, violations: r.violations }
      },
    })
    if (!complianceResult.ok) throw new Error(`compliance failed after redraft: ${complianceResult.violations.join("; ")}`)
    const script = complianceResult.script

    // 4. ElevenLabs voiceover.
    // agent_voice_profiles.agent_id and the ledger's agent_id are now the same
    // class, so the voice clone is asked for under the key it is filed by.
    const { data: profile } = await svc.from("agent_voice_profiles")
      .select("elevenlabs_voice_id")
      .eq("agent_id", ledger.agent_id)
      .maybeSingle()
    const voiceId = (profile as { elevenlabs_voice_id?: string } | null)?.elevenlabs_voice_id ?? null
    if (!voiceId) throw new Error("agent has no elevenlabs_voice_id — Settings → Voice & Avatar")

    const tts = await synthesizeSpeech({ text: script, voiceId })
    if (!tts.success || !tts.audioBuffer) throw new Error(`ElevenLabs failed: ${tts.error}`)
    const voiceoverUrlStored = await hostRenderedMedia(
      svc,
      `newsletter-video/voiceover/${ledger.id}.mp3`,
      tts.audioBuffer,
      "audio/mpeg",
    )

    // 4c. Mint (or reuse) the tracked outro QR for this campaign. Newsletter
    //     → landing_page. Never throws; null mint = render without a QR.
    const qr = ledgerAgentUserId
      ? await mintVideoQr({
          brokerageId: camp.brokerage_id,
          agentUserId: ledgerAgentUserId,
          kind:        "newsletter",
          campaignId:  camp.id,
        }, svc)
      : null

    // 5. Remotion render.
    const entryPoint = path.join(process.cwd(), "remotion", "index.ts")
    const bundleLoc = await getBundle(entryPoint)

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
      voiceoverUrl: voiceoverUrlStored,
      qrCodeDataUrl: qr?.qrCodeDataUrl ?? null,
      qrCaption:     "Scan to read",
    }
    const composition = await selectComposition({ serveUrl: bundleLoc, id: NEWSLETTER_VIDEO_COMPOSITION, inputProps })

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

    // ONE FINISH LINE (finish-spec rule): this bespoke route previously
    // uploaded the raw cut, silently skipping the branded bookends + music +
    // Supabase-hosted delivery the registry declares for NewsletterDigestVideo.
    // Now it lands a REAL render row and hands the buffer to the coordinator
    // finalize — bookends, mood music (mixed UNDER the embedded narration),
    // storage-hosted URL, marketing-asset capture, audit trail: identical to
    // every generic-rail video. Blob fallback keeps a finish failure from
    // losing a finished render.
    let finishedUrl: string | null = null
    try {
      const { recordRenderQueued } = await import("@/lib/remotion/registry")
      const { buildRenderIntent } = await import("@/lib/remotion/render-decision")
      const { finalizeCoordinatedRender } = await import("@/lib/remotion/render-coordinator")
      const rq = await recordRenderQueued({
        brokerageId: camp.brokerage_id, compositionId: NEWSLETTER_VIDEO_COMPOSITION,
        agentUserId: ledgerAgentUserId,
        entityType: "newsletter_video", entityId: ledger.id,
        usedVoiceover: true,
        // NOTE: no voiceover_url in input_props — the narration is already the
        // composition's audio track; setting it would double the voice.
        inputProps: { kind: "newsletter_digest", music_mood: "calm" },
        scopeType: "brokerage", scopeId: camp.brokerage_id, requestedVia: "cron",
      })
      if (rq.ok && rq.renderId) {
        const intent = buildRenderIntent({
          brokerage_id: camp.brokerage_id, composition_id: NEWSLETTER_VIDEO_COMPOSITION,
          agent_user_id: ledgerAgentUserId, entity_type: "newsletter_video", entity_id: ledger.id,
          scope_type: "brokerage", scope_id: camp.brokerage_id,
          input_props: { music_mood: "calm" },
        } as Parameters<typeof buildRenderIntent>[0], "brokerage")
        const fin = await finalizeCoordinatedRender(intent, rq.renderId, bytes)
        if (fin.ok && fin.outputUrl) finishedUrl = fin.outputUrl
      }
    } catch (finishErr) {
      console.warn("[render-newsletter-video] coordinator finish failed; shipping raw cut:", (finishErr as Error).message)
    }
    const reelUrlStored = finishedUrl
      ?? await hostRenderedMedia(svc, `newsletter-video/reels/${ledger.id}.mp4`, bytes, "video/mp4")

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
      video_url:       reelUrlStored,
      compliance_status: "passed",
      compliance_evaluated_at: new Date().toISOString(),
      video_metadata: {
        newsletter_campaign_id: camp.id,
        ledger_id:              ledger.id,
        voiceover_url:          voiceoverUrlStored,
        kind:                   "newsletter_digest",
      },
    }).select("id").single()

    await svc.from("newsletter_video_renders").update({
      status:          "completed",
      voiceover_url:   voiceoverUrlStored,
      video_url:       reelUrlStored,
      video_project_id: project!.id,
      completed_at:    new Date().toISOString(),
    }).eq("id", ledger.id)

    // Wave 19 — close the performance loop. Log topics → newsletter_video
    // so the aggregator can score them by the campaign's downstream
    // open/click rate. asset_id is the ledger (newsletter_video_renders)
    // row; the aggregator resolves to newsletter_campaign_id from there.
    void logTopicUses({
      topicIds:    topics.map((t) => t.id),
      brokerageId: camp.brokerage_id,
      assetType:   "newsletter_video",
      assetId:     ledger.id,
    })

    // Wave 22 (a + b) — per-persona post-pass. The main MP4 is in storage
    // and embedded universally; now we generate a persona-themed inbox
    // thumbnail + a 3-second drawtext overlay on the first frames per
    // distinct subscriber persona. publish-newsletters reads which
    // composite to embed per recipient at send time. Failures are per-
    // persona and never roll back the main render.
    // Wave 28 — call the generalized post-pass module. Newsletter passes
    // assetType='newsletter_campaign'; the shared module resolves top
    // subscriber personas from newsletter_subscribers, drafts compliance-
    // gated hooks, renders stills + ffmpeg overlays, and upserts into
    // asset_persona_renders. publish-newsletters reads variants from the
    // same generalized table at recipient routing time.
    void runPersonaVariantPostPass({
      assetType:    "newsletter_campaign",
      assetId:      camp.id,
      brokerageId:  camp.brokerage_id,
      agentUserId:  ledgerAgentUserId ?? "",
      brand: {
        primaryColor:  br?.brand_primary_color ?? "#0F172A",
        accentColor:   br?.brand_accent_color  ?? "#F59E0B",
        logoUrl:       br?.logo_url            ?? undefined,
        brokerageName: br?.name                ?? "Your Brokerage",
      },
      mainVideoUrl:     reelUrlStored,
      subject:          camp.subject_line ?? camp.campaign_name ?? "This week",
      bundleLoc,
      executablePath,
      hookContextHint:  "weekly market beat — newsletter sections develop the same threads",
    })

    return NextResponse.json({
      ok: true,
      ledger_id: ledger.id,
      video_url: reelUrlStored,
      voiceover_url: voiceoverUrlStored,
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
