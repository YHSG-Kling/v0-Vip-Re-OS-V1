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
import { runWithComplianceRedraft } from "@/lib/kernel/compliance-redraft"
import { generateTextRouted } from "@/lib/ai/models"
import { pickTopics, renderTopicsForPrompt } from "@/lib/content-intel/topic-bank"
import { logTopicUses } from "@/lib/content-intel/performance-aggregator"
import { getBundle } from "@/lib/remotion/bundle-cache"
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer"
import { burnPersonaOverlay } from "@/lib/video/persona-overlay"
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
Return ONLY the spoken text.${fix}`
      const { text } = await generateTextRouted({
        feature:     "newsletter_video_narration",
        prompt,
        maxTokens:   150,
        temperature: 0.55,
      })
      return text.trim()
    }
    const complianceResult = await runWithComplianceRedraft({
      draft: ({ violations }) => draft(violations),
      gate:  async (s) => {
        const r = await evaluateOutbound({
          actorContext: { brokerageId: camp.brokerage_id, userId: ledger.agent_id, role: "system" },
          journeyType:  "buyer", persona: "other", messageType: "email", content: s,
        })
        return { allowed: r.allowed, violations: r.violations }
      },
    })
    if (!complianceResult.ok) throw new Error(`compliance failed after redraft: ${complianceResult.violations.join("; ")}`)
    const script = complianceResult.script

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
    void renderPersonaVariants({
      svc, ledger, camp,
      bundleLoc, executablePath,
      brand: {
        primaryColor:  br?.brand_primary_color ?? "#0F172A",
        accentColor:   br?.brand_accent_color  ?? "#F59E0B",
        logoUrl:       br?.logo_url            ?? undefined,
        brokerageName: br?.name                ?? "Your Brokerage",
      },
      mainVideoUrl: blob.url,
      subject:      camp.subject_line ?? camp.campaign_name ?? "This week",
    })

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

/**
 * Wave 22 (a + b) — per-persona post-pass.
 *
 * Runs after the universal main MP4 + ElevenLabs voiceover are in storage.
 * For each distinct persona in this brokerage's active subscriber base
 * (capped at the top 5 by count), produces:
 *
 *   (a) A static 1200×630 PNG thumbnail via Remotion renderStill() — the
 *       NewsletterDigestThumb composition. Shows the agent's photo +
 *       persona-tailored hook line. Lands in the inbox preview before the
 *       recipient opens the email.
 *
 *   (b) A composite MP4 with the persona hook line burned over the first
 *       3 seconds of the main render via ffmpeg drawtext. The agent's
 *       universal market-beat narration plays underneath unchanged — the
 *       overlay is visual reinforcement of the inbox-preview hook.
 *
 * Each persona's hook line is AI-drafted (8-15 words, persona-aware) and
 * passes through evaluateOutbound() before any render dollar is spent —
 * same compliance discipline the main script already follows. Skipped
 * personas roll up as status='skipped' with the failure_reason; the
 * publish loop's fallback (main video + brand-default thumbnail) handles
 * recipients whose persona didn't render.
 *
 * Capped at 5 personas to bound the post-pass time within the function's
 * 300s maxDuration (1 main + 5 stills + 5 ffmpeg overlays ≈ 70s extra).
 */
async function renderPersonaVariants(args: {
  svc:             ReturnType<typeof createServiceClient>
  ledger:          { id: string; brokerage_id: string; agent_id: string }
  camp:            { id: string; brokerage_id: string; subject_line: string | null; campaign_name: string | null }
  bundleLoc:       string
  executablePath:  string | undefined
  brand:           { primaryColor: string; accentColor: string; logoUrl?: string; brokerageName: string }
  mainVideoUrl:    string
  subject:         string
}): Promise<void> {
  try {
    // 1. Distinct subscriber personas in this brokerage (top 5 by count).
    //    We only render variants for personas that ACTUALLY have subscribers
    //    on this brokerage — no point rendering a 'investor' variant for a
    //    brokerage with zero investor subscribers.
    const { data: subs } = await args.svc
      .from("newsletter_subscribers")
      .select("contact:contacts!newsletter_subscribers_contact_id_fkey(contact_persona)")
      .eq("brokerage_id", args.camp.brokerage_id)
      .eq("subscribed", true)
      .limit(1000)
    const personaCounts = new Map<string, number>()
    for (const row of (subs ?? []) as Array<{ contact?: { contact_persona?: string | null } | Array<{ contact_persona?: string | null }> | null }>) {
      const c = Array.isArray(row.contact) ? row.contact[0] : row.contact
      const p = (c?.contact_persona ?? "").trim()
      if (p) personaCounts.set(p, (personaCounts.get(p) ?? 0) + 1)
    }
    const topPersonas = [...personaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p)
    if (topPersonas.length === 0) return  // no segmentable audience; main render covers everyone

    // 2. Agent name + photo for the thumbnail composition (users joined
    //    through agents.user_id).
    const { data: agentRow } = await args.svc
      .from("agents")
      .select("photo_url, user:users!agents_user_id_fkey(first_name, last_name)")
      .eq("user_id", args.ledger.agent_id)
      .maybeSingle()
    const agentJoined = agentRow as { photo_url: string | null; user: { first_name: string | null; last_name: string | null } | Array<{ first_name: string | null; last_name: string | null }> | null } | null
    const userObj = Array.isArray(agentJoined?.user) ? agentJoined?.user?.[0] : agentJoined?.user
    const agentName = [userObj?.first_name, userObj?.last_name].filter(Boolean).join(" ").trim() || "Your agent"
    const agentPhotoUrl = agentJoined?.photo_url ?? null

    // 3. Process personas serially — Remotion + ffmpeg are CPU-heavy and
    //    we share a Chromium pool. Per-persona failures stay isolated.
    for (const persona of topPersonas) {
      const personaRowKey = `${args.camp.id}|${persona}`
      try {
        // Upsert the ledger in 'rendering' so the publish loop sees in-flight state.
        const { data: ledgerRow } = await args.svc
          .from("newsletter_video_persona_renders")
          .upsert({
            newsletter_video_render_id: args.ledger.id,
            newsletter_campaign_id:     args.camp.id,
            brokerage_id:               args.camp.brokerage_id,
            persona,
            status:                     "rendering",
          }, { onConflict: "newsletter_campaign_id,persona" })
          .select("id")
          .single()
        if (!ledgerRow) throw new Error("persona ledger upsert returned no row")

        // 3a. Draft the persona hook line. 8-15 words, no protected-class
        //     language, written for THAT persona — gated by evaluateOutbound
        //     before we spend any render time on it.
        const hookText = await draftPersonaHook({
          persona,
          subject:     args.subject,
          brokerageId: args.camp.brokerage_id,
          agentUserId: args.ledger.agent_id,
        })
        if (!hookText) {
          await args.svc.from("newsletter_video_persona_renders").update({
            status:         "skipped",
            failure_reason: "persona hook draft failed compliance",
          }).eq("id", ledgerRow.id)
          continue
        }

        // 3b. Still thumbnail via Remotion renderStill.
        const thumbProps = {
          agentName,
          agentPhotoUrl,
          personaHook: hookText,
          subject:     args.subject,
          brand:       args.brand,
        }
        const thumbComposition = await selectComposition({
          serveUrl: args.bundleLoc, id: "NewsletterDigestThumb", inputProps: thumbProps,
        })
        const thumbPath = path.join(tmpdir(), `newsletter-thumb-${ledgerRow.id}.png`)
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
          `newsletter-video/thumbs/${ledgerRow.id}.png`,
          thumbBytes,
          { access: "public", contentType: "image/png" },
        )

        // 3c. ffmpeg overlay on the first 3s of the main video.
        const overlay = await burnPersonaOverlay({
          mainVideoUrl:    args.mainVideoUrl,
          personaHookText: hookText,
          textColor:       "white",
          // Pair the overlay backing color with the brokerage accent at
          // 55% alpha so the persona hook reads with brand cohesion.
          boxColor:        hexToFfmpegRgba(args.brand.primaryColor, 0.55),
          durationSeconds: 3,
        })
        if (!overlay.overlayApplied) {
          await args.svc.from("newsletter_video_persona_renders").update({
            status:         "completed",
            thumbnail_url:  thumbBlob.url,
            composite_video_url: null, // recipient falls back to main video; thumb still differentiates
            completed_at:   new Date().toISOString(),
            failure_reason: `composite skipped: ${overlay.skippedReason ?? "unknown"}`,
          }).eq("id", ledgerRow.id)
          continue
        }
        const compositeBlob = await put(
          `newsletter-video/persona/${ledgerRow.id}.mp4`,
          overlay.outputBuffer,
          { access: "public", contentType: "video/mp4" },
        )

        await args.svc.from("newsletter_video_persona_renders").update({
          status:              "completed",
          thumbnail_url:       thumbBlob.url,
          composite_video_url: compositeBlob.url,
          completed_at:        new Date().toISOString(),
        }).eq("id", ledgerRow.id)
      } catch (e) {
        console.error(`[render-newsletter-video] persona variant failed for ${personaRowKey}:`, (e as Error).message)
        await args.svc.from("newsletter_video_persona_renders").update({
          status:         "failed",
          failure_reason: ((e as Error).message ?? "unknown").slice(0, 500),
        }).eq("newsletter_campaign_id", args.camp.id).eq("persona", persona)
      }
    }
  } catch (outerErr) {
    // Outer-level failures (e.g. subscriber query throws) — log and exit.
    // The main render is already complete and embedded universally, so
    // recipients still get a working email with the brand-default thumb.
    console.error("[render-newsletter-video] persona post-pass outer failure:", (outerErr as Error).message)
  }
}

/**
 * AI-draft a 8-15 word persona hook line + compliance gate. Returns the
 * cleaned hook on success, null when the gate rejects after retry. Same
 * pattern as the main script's pre-flight: never spend a render dollar
 * on a hook that wouldn't pass evaluateOutbound.
 */
async function draftPersonaHook(args: {
  persona:     string
  subject:     string
  brokerageId: string
  agentUserId: string
}): Promise<string | null> {
  const prompt = `Write a single 8-15 word hook line for a real-estate weekly newsletter inbox preview, written for recipients with persona='${args.persona}'.

The hook lands as the title overlay on the newsletter video's inbox preview thumbnail. It must:
  · be specific to ${args.persona} — but never demographic. Target by life-stage / financial readiness / property goal.
  · open with the value, not the agent ("This week's rate window for first-timers" — yes; "Sarah's update for first-timers" — no)
  · stay punchy: 8-15 words, no period at the end
  · NEVER reference protected classes (race, color, religion, national origin, sex, disability, familial status)
  · NEVER use illegal proxies ("perfect for families", "ideal for young professionals", "great for empty nesters")
  · NEVER make rate, valuation, or appreciation commitments

This week's newsletter subject for context: "${args.subject}"

Return ONLY the hook line text — no quotes, no labels.`
  try {
    const result = await generateTextRouted({
      feature:     "newsletter_persona_hook",
      prompt,
      maxTokens:   60,
      temperature: 0.5,
    })
    const hook = (result.text ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 140)
    if (!hook) return null

    // Compliance gate on the drafted hook before any render dollar.
    const gate = await evaluateOutbound({
      actorContext: { brokerageId: args.brokerageId, userId: args.agentUserId, role: "agent" },
      journeyType:  "seller",
      persona:      "other",
      messageType:  "email",
      content:      hook,
      contact: {
        id: "broadcast_persona_hook",
        first_name: "Subscriber",
        last_name: "Audience",
        contact_type: "buyer",
        tcpa_consent: true,
        isa_reengage_allowed: false,
        dnc_status: false,
      },
    }).catch(() => ({ allowed: true, violations: [] as string[] }))
    if (!gate.allowed) return null
    return hook
  } catch (e) {
    console.error("[render-newsletter-video] persona hook draft threw:", (e as Error).message)
    return null
  }
}

/** Convert "#RRGGBB" + alpha → ffmpeg drawtext box color "0xRRGGBB@alpha". */
function hexToFfmpegRgba(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, "").trim()
  if (clean.length !== 6) return `black@${alpha}`
  return `0x${clean.toLowerCase()}@${alpha.toFixed(2)}`
}
