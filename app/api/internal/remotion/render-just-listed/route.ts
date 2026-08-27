/**
 * app/api/internal/remotion/render-just-listed/route.ts
 *
 * The Remotion + ElevenLabs + (optional) D-ID hybrid render endpoint.
 *
 * Called by the Wave 14 cron when a listing_promo_videos row is in
 * 'remotion_pending'. End-to-end orchestration:
 *
 *   1. Load the row + listing + agent_voice_profiles + listing_media images.
 *   2. REUSE the narration the reactor already drafted, gated and persisted on
 *      the staged ai_video_projects row (one model draft per promo, §5) —
 *      re-fitted to the composition budget and RE-GATED here so the compliance
 *      verdict is about the exact text spoken. Fallback only (no staged row,
 *      or it no longer clears): draft fresh via the AI Gateway (banned:
 *      invented facts, protected-class refs, rate/valuation guarantees).
 *   3. Pre-flight evaluateOutbound (broadcast shape — Brand voice + Fair
 *      Housing state-specific + Them-First). Re-prompt once on violation
 *      (fallback-draft path; the reuse path gates the staged text directly).
 *   4. ElevenLabs TTS — synthesize the narration in the agent's cloned voice;
 *      upload mp3 to Supabase Storage (listing-media bucket).
 *   5. Remotion bundle + renderMedia — produces a 25s 1080×1920 MP4 with
 *      brokerage brand + property images + the voiceover audio track.
 *      Upload to Supabase Storage as the canonical artifact.
 *   6. UPDATE the staged ai_video_projects row (or insert one when none was
 *      staged) with video_url + compliance_status='passed'.
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
// Was `import { put } from "@vercel/blob"`. Survivor:
// lib/remotion/media-host.ts#hostRenderedMedia — Supabase `video-assets`, which
// this route was already using for its thumbnail pass.
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import { createServiceClient } from "@/lib/supabase/service"
import { synthesizeSpeech, synthesizeSpeechWithTimestamps, type CharacterAlignment } from "@/lib/voice/elevenlabs-tts"
import { buildCaptionPlan } from "@/lib/video/caption-plan"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { runWithComplianceRedraft } from "@/lib/kernel/compliance-redraft"
import { dispatchVideo } from "@/lib/providers/dispatch"
import { KernelEvent } from "@/lib/kernel/events"
import { generateTextRouted } from "@/lib/ai/models"
import { getBundle } from "@/lib/remotion/bundle-cache"
import { selectComposition, renderMedia } from "@remotion/renderer"
import { mintVideoQr, type VideoQrKind } from "@/lib/video/video-qr"
import {
  compositionForPromoEvent,
  buildPromoProps,
  computeDaysOnMarket,
  promoNarrationBudget,
  promoEventLabel,
} from "@/lib/video/promo-composition"
import {
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
  /** USD-formatted sold price (listings.sold_price) — "" when not sold/known.
   *  Drives the JustSoldReelSquare price strip for just_sold promos. */
  soldPrice:     string
  /** Days on market (created_at → sold_date) — null when not computable. */
  daysOnMarket:  number | null
  /** Open-house headline date — "" when the render path has no schedule.
   *  The render path loads no open-house event, so this stays "" today and
   *  open_house promos fall back to the legacy reel (honest, no broken render). */
  openHouseDate: string
  /** Open-house time window — "" when unknown (see openHouseDate). */
  openHouseTime: string
}

interface BrandContext {
  primaryColor: string
  accentColor:  string
  logoUrl?:     string
  agentName?:   string
  agentPhone?:  string
  showEhoMark:  boolean
  /** Brokerage trade name — the square event compositions' disclosure line. */
  brokerageName?: string
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

  // promo.agent_id is agents-class since m366. The voice-profile lookup wants
  // exactly that; the brand card (users.first_name/phone), the compliance actor,
  // the QR mint and the render registry's agent_user_id all want the OWNER'S
  // USERS id. Resolve once. Null means the agents row is gone — the reel is
  // failed rather than rendered under the wrong identity.
  const { resolveUserIdForAgentRecord } = await import("@/lib/kernel/agent-identity")
  const promoAgentUserId = await resolveUserIdForAgentRecord(svc, promo.agent_id)
  if (!promoAgentUserId) {
    await svc.from("listing_promo_videos")
      .update({ status: "failed", error_message: `no users row behind agents.id=${promo.agent_id}` })
      .eq("id", promo.id)
    return NextResponse.json({ skipped: "promo agent has no users row — cannot attribute the reel" }, { status: 200 })
  }

  // THE STAGED PROJECT ROW, written by the reactor at script time
  // (lib/video/listing-promo-reactor.ts step 4c) with the gated, budget-fitted
  // narration on script_content. Found via video_metadata.promo_ledger_id —
  // the ledger carries no script column live. Absent → older row or a refused
  // staging insert → the draft fallback below runs (pre-fix behavior).
  let stagedProject: { id: string; script_content: string | null } | null = null
  {
    const { data: stagedRows } = await svc.from("ai_video_projects")
      .select("id, script_content")
      .contains("video_metadata", { promo_ledger_id: promo.id, narration_precleared: true })
      .order("created_at", { ascending: false })
      .limit(1)
    stagedProject = (stagedRows?.[0] as { id: string; script_content: string | null } | undefined) ?? null
  }

  try {
    // 2. Gather facts + brand context.
    const facts = await loadListingFacts(svc, promo.listing_id)
    const brand = await loadBrandContext(svc, promo.brokerage_id, promoAgentUserId)

    // 3. REUSE the reactor's gated script (one draft per promo, §5); draft
    //    fresh only when no staged script exists or it no longer clears the
    //    render-time gate.
    const { script, reused: scriptReused } = await draftAndClearScript({
      svc,
      brokerageId: promo.brokerage_id,
      agentUserId: promoAgentUserId,
      facts,
      eventType:   promo.event_type,
      stagedScript: stagedProject?.script_content ?? null,
    })

    // 4. ElevenLabs voiceover → Supabase storage URL. The timestamped path also
    //    returns per-character alignment (when available) so captions are
    //    word-accurate; null alignment → the caption plan even-distributes.
    const { url: voiceoverUrl, alignment: voiceoverAlignment } = await renderVoiceover({
      svc,
      brokerageId:   promo.brokerage_id,
      // agent_voice_profiles.agent_id is agents-class — the same class the promo
      // row now carries, so the clone is asked for under the key it is filed by.
      agentRecordId: promo.agent_id,
      promoId:       promo.id,
      script,
    })

    // 4b. Mint (or reuse) the tracked outro QR for this listing × event.
    //     Never throws — a null mint means the reel renders without a QR.
    //     just_listed/just_sold → listing_detail; open_house → book_meeting.
    const qr = await mintVideoQr({
      brokerageId: promo.brokerage_id,
      agentUserId: promoAgentUserId,
      kind:        videoQrKindForEvent(promo.event_type),
      listingId:   promo.listing_id,
    }, svc)

    // 5. Remotion render → Supabase storage URL. The render path routes the
    //    composition choice through compositionForPromoEvent + buildPromoProps
    //    (the DRIFT FIX) and reports back which composition actually rendered.
    const reel = await renderRemotionReel({
      promoId: promo.id,
      brokerageId: promo.brokerage_id,
      agentUserId: promoAgentUserId,
      facts,
      brand,
      voiceoverUrl,
      eventType: promo.event_type,
      qrCodeDataUrl: qr?.qrCodeDataUrl ?? null,
      qrCaption:     qrCaptionForEvent(promo.event_type),
      script,
      voiceoverAlignment,
    })
    const reelUrl = reel.url

    // 6. Land the render on the promo's ai_video_projects row. When the reactor
    //    staged one (script persistence, step 4c), UPDATE it — one project row
    //    per promo, whose script_content is exactly what the voiceover spoke.
    //    Only when no staged row exists is a fresh row inserted (older ledger
    //    rows, or a refused staging insert).
    const projectFields = {
      title:           `${promoEventLabel(promo.event_type)} — ${facts.address}`,
      script_content:  script,
      video_type:      "listing_promo",
      status:          hybrid ? "generating" : "completed",
      usage_intent:    "public_marketing",
      audience_type:   "customer_facing",
      duration_seconds: reel.durationSeconds,
      video_url:       reelUrl,
      compliance_status: "passed",
      compliance_evaluated_at: new Date().toISOString(),
      video_metadata: {
        promo_event_type: promo.event_type,
        promo_ledger_id:  promo.id,
        listing_id:       promo.listing_id,
        voiceover_url:    voiceoverUrl,
        remotion_only:    !hybrid,
        composition_id:   reel.compositionId,
        composition_fell_back: reel.fellBack,
        composition_fallback_reason: reel.fallbackReason,
        // ONE DRAFT PER PROMO (§5) — true when the reactor's gated script was
        // spoken verbatim (zero render-time model calls); false when the
        // fallback re-draft ran.
        narration_reused: scriptReused,
        // SOUND-OFF CAPTIONS — the per-character alignment the captions were
        // built from (null when the timestamped TTS path was unavailable and the
        // even-distribution estimate was used). Stored on the EXISTING ledger
        // JSON so re-renders / audits can rebuild word-accurate captions; honest
        // about whether timing is real ("alignment") or estimated.
        caption_timing_source: voiceoverAlignment ? "alignment" : "even",
        voiceover_alignment:   voiceoverAlignment,
      },
    }
    let projectId: string
    if (stagedProject) {
      const { error: updErr } = await svc.from("ai_video_projects")
        .update(projectFields)
        .eq("id", stagedProject.id)
      if (updErr) throw new Error(`staged project update refused: ${updErr.message}`)
      projectId = stagedProject.id
    } else {
      const { data: project, error: insErr } = await svc.from("ai_video_projects").insert({
        brokerage_id: promo.brokerage_id,
        agent_id:     promo.agent_id,
        listing_id:   promo.listing_id,
        ...projectFields,
      }).select("id").single()
      if (insErr || !project) throw new Error(`project insert refused: ${insErr?.message ?? "no row returned"}`)
      projectId = project.id
    }

    await svc.from("listing_promo_videos").update({
      video_project_id: projectId,
    }).eq("id", promo.id)

    await svc.from("lifecycle_events").insert({
      brokerage_id:  promo.brokerage_id,
      actor_user_id: promoAgentUserId,  // FK users(id) — the resolved owner
      event_type:    hybrid ? KernelEvent.VIDEO_GENERATION_REQUESTED : KernelEvent.VIDEO_GENERATION_COMPLETED,
      metadata: {
        ai_video_project_id: projectId,
        promo_ledger_id:     promo.id,
        listing_id:          promo.listing_id,
        hybrid,
      },
      entity_id:   projectId,
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
        userId:         promoAgentUserId,
        templateId:     buildHybridHookScript("intro", facts, brand.agentName ?? ""),
        recipientEmail: "system@internal",
        systemSource:   `listing_promo_hybrid.intro`,
        metadata: { ai_video_project_id: projectId, hook_position: "intro" },
      })
      const outroResult = await dispatchVideo({
        brokerageId:    promo.brokerage_id,
        userId:         promoAgentUserId,
        templateId:     buildHybridHookScript("outro", facts, brand.agentName ?? ""),
        recipientEmail: "system@internal",
        systemSource:   `listing_promo_hybrid.outro`,
        metadata: { ai_video_project_id: projectId, hook_position: "outro" },
      })
      await svc.from("ai_video_projects").update({
        video_metadata: {
          promo_event_type: promo.event_type,
          promo_ledger_id:  promo.id,
          listing_id:       promo.listing_id,
          voiceover_url:    voiceoverUrl,
          remotion_only:    false,
          narration_reused: scriptReused,
          hybrid_intro_job_id: introResult.messageId ?? null,
          hybrid_outro_job_id: outroResult.messageId ?? null,
          hybrid_pending:      true,
        },
      }).eq("id", projectId)
    }

    return NextResponse.json({
      ok:              true,
      promo_id:        promo.id,
      ai_video_project_id: projectId,
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
    // BOTH ledgers. The staged project row (script persistence) would otherwise
    // sit at 'queued' claiming to be in flight while the promo ledger says
    // failed — two tables disagreeing about the same render.
    if (stagedProject) {
      await svc.from("ai_video_projects").update({
        status:        "failed",
        error_message: `Render failed: ${msg}`.slice(0, 800),
      }).eq("id", stagedProject.id)
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadListingFacts(svc: ReturnType<typeof createServiceClient>, listingId: string): Promise<ListingFacts> {
  const { data: l } = await svc.from("listings")
    .select("id, brokerage_id, address, city, state, list_price, bedrooms, bathrooms, sqft, property_type, sold_price, sold_date, created_at")
    .eq("id", listingId)
    .maybeSingle()
  if (!l) throw new Error("listing not found")
  const lr = l as { id: string; brokerage_id: string; address: string | null; city: string | null; state: string | null; list_price: number | null; bedrooms: number | null; bathrooms: number | null; sqft: number | null; property_type: string | null; sold_price: number | null; sold_date: string | null; created_at: string | null }
  const { data: media } = await svc.from("listing_media")
    .select("file_url, sort_order, is_primary, media_type")
    .eq("listing_id", listingId)
    .eq("media_type", "photo")  // listing_media says 'photo'; 'image' matched nothing, so the just-listed video had no stills
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
    soldPrice:     usd(lr.sold_price),
    daysOnMarket:  computeDaysOnMarket(lr.created_at, lr.sold_date),
    // The render path has no open-house schedule source (eventContext is not
    // threaded here), so these stay empty and open_house promos fall back to
    // the legacy reel — honest, never a broken event headline.
    openHouseDate: "",
    openHouseTime: "",
  }
}

async function loadBrandContext(svc: ReturnType<typeof createServiceClient>, brokerageId: string, agentUserId: string): Promise<BrandContext> {
  const { data: b } = await svc.from("brokerages")
    .select("name, logo_url, brand_primary_color:primary_color")
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
    brokerageName: br?.name ?? undefined,
  }
}

async function draftAndClearScript(args: {
  svc: ReturnType<typeof createServiceClient>
  brokerageId: string
  agentUserId: string
  facts: ListingFacts
  eventType: string
  /** The reactor's persisted, gated, budget-fitted script (staged
   *  ai_video_projects.script_content). When it clears the render-time gate it
   *  is REUSED verbatim — one model draft per promo (§5). Null/empty → draft. */
  stagedScript?: string | null
}): Promise<{ script: string; reused: boolean }> {
  // THE CAP, DERIVED FROM THE COMPOSITION THIS EVENT WILL RENDER ON.
  // renderRemotionReel routes the event through compositionForPromoEvent and
  // buildPromoProps, which hand the mp3 to input_props.voiceoverUrl — an <Audio>
  // INSIDE the composition, against a FIXED durationInFrames. The m313 tpad
  // rescues only the other key (input_props.voiceover_url), which this path
  // never writes, so an overrun here is simply CUT. The prompt used to ask for
  // "60-80 words" ≈ 24-32 spoken seconds for EVERY event, against compositions
  // running 25s (JustListedReel) and 12s (the three square event cuts) — so the
  // square cuts lost more than half of every script, silently.
  const budget = promoNarrationBudget(args.eventType)

  // ── REUSE BEFORE RE-DRAFT (§5). The reactor already bought and gated this
  // script. Re-fit it to the budget (the geometry may have moved between
  // staging and render) and RE-GATE the exact text that will be spoken —
  // evaluateOutbound is rule-based, so the reuse path makes ZERO model calls
  // where the re-draft booked one ai_tool_usage row per promo. A staged script
  // that no longer clears the gate (brand rules changed since staging) falls
  // through to a fresh draft rather than being spoken anyway — the gate runs
  // on what is SPOKEN, never on a stale clearance.
  const preset = (args.stagedScript ?? "").trim()
  if (preset) {
    const fit = fitNarrationToBudget(preset, budget)
    if (fit.note) console.warn(`[render-just-listed] ${args.eventType} staged script — ${fit.note}`)
    if (fit.script) {
      const r = await evaluateOutbound({
        actorContext: { brokerageId: args.brokerageId, userId: args.agentUserId, role: "system" },
        journeyType:  "seller",
        persona:      "other",
        messageType:  "social",
        content:      fit.script,
      })
      if (r.allowed) return { script: fit.script, reused: true }
      console.warn(
        `[render-just-listed] ${args.eventType} staged script failed the render-time gate ` +
        `(${r.violations.join("; ")}) — drafting fresh (second billed call)`,
      )
    }
  }

  const draft = async (violations: string[]) => {
    const violationLine = violations.length > 0
      ? `\n\nYour previous draft failed compliance. Resolve these violations:\n- ${violations.join("\n- ")}\n`
      : ""
    const prompt = `Write a voiceover script for a real-estate ${eventLabel(args.eventType)} reel.
Use ONLY these facts — do not invent:
- Address: ${args.facts.address || "(omitted)"}
- Location: ${args.facts.city_state || "(omitted)"}
- Price: ${args.facts.price || "(omitted)"}
- Bedrooms: ${args.facts.bedrooms || "(omitted)"}
- Bathrooms: ${args.facts.bathrooms || "(omitted)"}
- Sq ft: ${args.facts.sqft || "(omitted)"}
- Property type: ${args.facts.property_type || "(omitted)"}

Style: first-person, energetic but professional. Lead with the hook, hit the strongest 1-2 facts, close with "DM me to tour."
Banned: protected-class refs (race, religion, family status, national origin, gender, sexual orientation, disability, source of income); phrases like "perfect for families" or "ideal starter home"; rate/valuation/appreciation guarantees; exclamation marks.
${narrationLengthDirective(budget)}
Return ONLY the script text the avatar will speak — no scene directions.${violationLine}`
    const { text } = await generateTextRouted({
      brokerageId: args.brokerageId,
      userId: args.agentUserId,
      feature:     "listing_promo_voiceover_script",
      prompt,
      maxTokens:   narrationMaxTokens(budget),
      temperature: 0.5,
    })
    // VERIFY, don't trust — a word ceiling in a prompt is a request, not a
    // guarantee. Trim at a sentence boundary and SAY SO; the defect being fixed
    // is not that scripts are long, it is that nothing ever looked.
    const fit = fitNarrationToBudget(text.trim(), budget)
    if (fit.note) console.warn(`[render-just-listed] ${args.eventType} — ${fit.note}`)
    return fit.script
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
  return { script: result.script, reused: false }
}

async function renderVoiceover(args: {
  svc: ReturnType<typeof createServiceClient>
  brokerageId: string
  /** agents.id — agent_voice_profiles.agent_id FKs agents, not users. */
  agentRecordId: string
  promoId: string
  script: string
}): Promise<{ url: string; alignment: CharacterAlignment | null }> {
  const { data: profile } = await args.svc.from("agent_voice_profiles")
    .select("elevenlabs_voice_id")
    .eq("agent_id", args.agentRecordId)
    .maybeSingle()
  const voiceId = (profile as { elevenlabs_voice_id?: string } | null)?.elevenlabs_voice_id ?? null
  if (!voiceId) throw new Error("agent has no elevenlabs_voice_id — Settings → Voice & Avatar")

  // SOUND-OFF CAPTIONS — prefer the timestamped TTS path so captions can be
  // placed WORD-ACCURATELY. It returns the SAME mp3 buffer contract plus the
  // per-character alignment. Any failure falls back to the default buffered path
  // (no alignment → the caption plan even-distributes honestly), so captions
  // NEVER block the render.
  let audioBuffer: Buffer | null = null
  let alignment: CharacterAlignment | null = null
  const stamped = await synthesizeSpeechWithTimestamps({ text: args.script, voiceId, brokerageId: args.brokerageId })
  if (stamped.success && stamped.audioBuffer) {
    audioBuffer = stamped.audioBuffer
    alignment = stamped.alignment ?? null
  } else {
    const tts = await synthesizeSpeech({ text: args.script, voiceId, brokerageId: args.brokerageId })
    if (!tts.success || !tts.audioBuffer) throw new Error(`ElevenLabs TTS failed: ${stamped.error ?? tts.error}`)
    audioBuffer = tts.audioBuffer
  }

  // Was @vercel/blob's put(). Survivor: lib/remotion/media-host.ts#hostRenderedMedia
  // (owner ruling — all file storage lives in Supabase buckets). `video-assets`
  // is its default and the right bucket: this MP3 is fetched by URL by the
  // Remotion render worker, which holds no session.
  const url = await hostRenderedMedia(
    args.svc,
    `listing-promo/voiceover/${args.promoId}.mp3`,
    audioBuffer,
    "audio/mpeg",
  )
  return { url, alignment }
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
  brokerageId: string
  agentUserId: string | null
  facts: ListingFacts
  brand: BrandContext
  voiceoverUrl: string
  eventType: string
  qrCodeDataUrl: string | null
  qrCaption: string
  /** The VO script — used as the caption fallback (even-distribution estimate). */
  script: string
  /** Per-character alignment from the timestamped TTS path (null → estimate). */
  voiceoverAlignment: CharacterAlignment | null
}): Promise<{ url: string; compositionId: string; durationSeconds: number; fellBack: boolean; fallbackReason: string | null }> {
  // Bundle Remotion compositions once per cold start. The bundler reads
  // remotion/index.ts which registers RemotionRoot.
  const entryPoint = path.join(process.cwd(), "remotion", "index.ts")
  const bundleLocation = await getBundle(entryPoint)

  // DRIFT FIX — route the composition choice through the Video Director's
  // SituationKind taxonomy instead of hardcoding "JustListedReel" for every
  // event_type. compositionForPromoEvent picks the desired composition;
  // buildPromoProps assembles its REQUIRED props from the loaded facts and,
  // where those facts are missing (e.g. no open-house schedule, no sold
  // price), falls back to the legacy JustListedReel — honest, no broken render.
  const choice = compositionForPromoEvent(args.eventType)
  const built  = buildPromoProps({
    choice,
    facts: {
      address:       args.facts.address,
      city_state:    args.facts.city_state,
      price:         args.facts.price,
      bedrooms:      args.facts.bedrooms,
      bathrooms:     args.facts.bathrooms,
      sqft:          args.facts.sqft,
      property_type: args.facts.property_type,
      images:        args.facts.images,
      soldPrice:     args.facts.soldPrice,
      daysOnMarket:  args.facts.daysOnMarket,
      openHouseDate: args.facts.openHouseDate,
      openHouseTime: args.facts.openHouseTime,
    },
    brand:         args.brand,
    voiceoverUrl:  args.voiceoverUrl,
    qrCodeDataUrl: args.qrCodeDataUrl,
    qrCaption:     args.qrCaption,
    hook:          eventLabel(args.eventType),
  })
  const compositionId = built.compositionId
  const inputProps    = built.inputProps
  if (built.fellBack) {
    console.warn(`[render-just-listed] ${args.eventType}: ${built.fallbackReason}`)
  }

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id:       compositionId,
    inputProps,
  })

  // SOUND-OFF CAPTIONS (additive + best-effort). Build the caption plan against
  // the SELECTED composition's real duration/fps so cues tile its timeline.
  // Prefer the REAL ElevenLabs alignment (word-accurate); fall back to the
  // script text (even-distribution ESTIMATE). A caption failure NEVER blocks the
  // render — on any error we simply ship the reel without captions (as before).
  try {
    const plan = buildCaptionPlan(
      args.voiceoverAlignment ?? args.script,
      composition.durationInFrames,
      composition.fps,
      { maxWordsPerCue: 4 },
    )
    if (plan.cues.length > 0) {
      // captionsCues = word-accurate/estimated cues the CaptionLayer renders.
      // captionScript stays as the honest fallback if cues are ever empty.
      ;(inputProps as Record<string, unknown>).captionsCues  = plan.cues
      ;(inputProps as Record<string, unknown>).captionScript = args.script
    }
  } catch (e) {
    console.warn(`[render-just-listed] caption plan failed; rendering without captions:`, (e as Error).message)
  }

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

  // ONE FINISH LINE (finish-spec): this bespoke route previously uploaded the
  // raw cut — no music, no companion thumbnail, blob-only hosting. It now
  // lands a real render row and rides the coordinator finalize for the mood
  // music (mixed UNDER the embedded cloned-voice narration), Supabase-hosted
  // delivery, marketing-asset capture and audit. BOOKENDS STAY OFF here —
  // this lane's bookends are the hybrid D-ID hook/outro stitched later by
  // listing-promo-hybrid-composite (registry bookends would double them).
  let finishedUrl: string | null = null
  const svcFin = createServiceClient()
  try {
    const { recordRenderQueued } = await import("@/lib/remotion/registry")
    const { buildRenderIntent } = await import("@/lib/remotion/render-decision")
    const { finalizeCoordinatedRender } = await import("@/lib/remotion/render-coordinator")
    const rq = await recordRenderQueued({
      brokerageId: args.brokerageId, compositionId,
      agentUserId: args.agentUserId,
      entityType: "listing_promo", entityId: args.promoId,
      usedVoiceover: true,
      inputProps: { kind: "listing_promo", music_mood: "upbeat" },
      scopeType: "brokerage", scopeId: args.brokerageId, requestedVia: "cron",
    })
    if (rq.ok && rq.renderId) {
      const intent = buildRenderIntent({
        brokerage_id: args.brokerageId, composition_id: compositionId,
        agent_user_id: args.agentUserId, entity_type: "listing_promo", entity_id: args.promoId,
        scope_type: "brokerage", scope_id: args.brokerageId,
        input_props: { music_mood: "upbeat" },
      } as Parameters<typeof buildRenderIntent>[0], "brokerage")
      intent.applyBookends = false // hybrid D-ID bookends stitch later — never double
      const fin = await finalizeCoordinatedRender(intent, rq.renderId, bytes)
      if (fin.ok && fin.outputUrl) {
        finishedUrl = fin.outputUrl
        // COMPANION THUMBNAIL (registry declares VideoCoverThumb; the bespoke
        // route never rendered it): branded share/OG card, best-effort.
        try {
          const { renderStill } = await import("@remotion/renderer")
          const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
          const thumbComp = await selectComposition({
            serveUrl: bundleLocation, id: "VideoCoverThumb",
            inputProps: {
              kind: "listing", title: args.facts.address || eventLabel(args.eventType),
              subtitle: eventLabel(args.eventType), eyebrow: eventLabel(args.eventType).toUpperCase(),
              heroImageUrl: args.facts.images?.[0] ?? null,
              agentName: args.brand.agentName ?? args.brand.brokerageName ?? "Your Agent",
              brand: { primaryColor: args.brand.primaryColor, accentColor: args.brand.accentColor, brokerageName: args.brand.brokerageName ?? "Your Brokerage", showEhoMark: true },
            },
          })
          const thumbPath = path.join(tmpdir(), `listing-promo-${args.promoId}-thumb.png`)
          await renderStill({
            composition: thumbComp, serveUrl: bundleLocation, output: thumbPath,
            chromiumOptions: { headless: true, gl: "swangle" },
            ...(executablePath ? { browserExecutable: executablePath } : {}),
          })
          const thumbBytes = await fs.readFile(thumbPath)
          await fs.unlink(thumbPath).catch(() => {})
          const thumbUrl = await hostRenderedMedia(svcFin, `listing-promo/thumbs/${args.promoId}.png`, thumbBytes, "image/png")
          await svcFin.from("remotion_composition_renders").update({ thumbnail_url: thumbUrl }).eq("id", rq.renderId)
        } catch (te) {
          console.warn("[render-just-listed] thumbnail pass failed; video kept:", (te as Error).message)
        }
      }
    }
  } catch (finishErr) {
    console.warn("[render-just-listed] coordinator finish failed; shipping raw cut:", (finishErr as Error).message)
  }
  // Was @vercel/blob's put(). Survivor: lib/remotion/media-host.ts#hostRenderedMedia,
  // which is already the host for the thumbnail a few lines above — this branch
  // was the one asset in the function still going to a different store.
  const reelUrlFinal = finishedUrl
    ?? await hostRenderedMedia(svcFin, `listing-promo/reels/${args.promoId}.mp4`, bytes, "video/mp4")
  const durationSeconds = composition.fps > 0
    ? Math.round(composition.durationInFrames / composition.fps)
    : 25
  return {
    url:            reelUrlFinal,
    compositionId,
    durationSeconds,
    fellBack:       built.fellBack,
    fallbackReason: built.fallbackReason,
  }
}

function buildHybridHookScript(position: "intro" | "outro", facts: ListingFacts, agentName: string): string {
  if (position === "intro") {
    return `Hi, I'm ${agentName || "your agent"}. ${facts.address ? `Just listed at ${facts.address}.` : "I have a new listing for you."} Watch.`
  }
  return `Want to see it? DM me to schedule a tour.`
}

// TOMBSTONE (§6): the private `eventLabel` that stood here MOVED to
// lib/video/promo-composition.ts::promoEventLabel when the reactor started
// staging the project row (and its provisional title) at script time — two
// writers of one label needed one spelling. This alias keeps the route's many
// call sites unchanged; the survivor is the export.
const eventLabel = promoEventLabel
