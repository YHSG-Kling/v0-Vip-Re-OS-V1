import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
// TOMBSTONE (dead-import tranche): `processKernelEvent` was imported here and
// never called. Survivor: lib/kernel/event-fanout.ts:67, which is what
// `fanOutKernelEvent` — the CANONICAL fan-out this route uses at :294 — calls.
// Going direct would have skipped the seller-portal resolution and the sequence
// auto-enrolment that the fan-out adds on top of processKernelEvent.
import { KernelEvent } from "@/lib/kernel/events"
import { aiAnalyzeShowingFeedback } from "@/app/actions/ai-showing-management"
import { generateAIResponse } from "@/lib/ai"

const OFFER_INTEREST_SCORE: Record<string, number> = {
  very_likely: 90,
  possible:    55,
  unlikely:    20,
  no:           5,
}

/**
 * BOUNDARY NORMALIZER for the showing verdict (§6, m568). The one vocabulary for
 * "what did the buyer think of the house" is love_it | like_it | maybe | no —
 * the same CHECK showings.buyer_interest_level and tour_stops.buyer_interest_level
 * carry. overall_impression historically spoke a private dialect
 * (loved_it | liked_it | neutral | not_interested); m568 retires it. The form now
 * submits the canonical tokens, but a tab opened BEFORE this deploy can still
 * submit the old spelling — map it here rather than refuse a real buyer verdict.
 * Unknown tokens become null (the CHECK would refuse them anyway; a null
 * impression is "not answered", not a 500).
 *
 * SEQUENCE: this code assumes m568 is APPLIED (the live CHECK admits only the
 * new tokens). Deploying it against the pre-m568 CHECK would have every
 * submission refused with 23514 — apply m568 first, then deploy.
 */
function normalizeImpression(v: unknown): "love_it" | "like_it" | "maybe" | "no" | null {
  switch (v) {
    case "love_it":  case "loved_it":       return "love_it"
    case "like_it":  case "liked_it":       return "like_it"
    case "maybe":    case "neutral":        return "maybe"
    case "no":       case "not_interested": return "no"
    default:                                return null
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const body = await req.json()

    const {
      requestId,
      showingId,
      presentationRating,
      cleanlinessRating,
      priceOpinion,
      meetsBuyerNeeds,
      offerInterest,
      favoriteFeatures,
      specificConcerns,
      overallImpression,
      buyerInterestLevel,
      additionalNotes,
    } = body

    const impression = normalizeImpression(overallImpression)

    const supabase = createServiceClient()

    // 1. Verify token still valid
    const { data: fbReq } = await supabase
      .from("showing_feedback_requests")
      .select("id, showing_id, brokerage_id")
      .eq("feedback_token", token)
      .eq("id", requestId)
      .maybeSingle()

    if (!fbReq) {
      return NextResponse.json({ success: false, error: "Invalid or expired feedback token" }, { status: 404 })
    }

    // 2. Generate AI summary
    let aiSummary: string | null = null
    try {
      const summaryResponse = await generateAIResponse({
        prompt: `Summarize this showing feedback in 1-2 sentences for the listing agent. Be concise and professional.

Presentation: ${presentationRating}/5
Cleanliness: ${cleanlinessRating}/5
Price opinion: ${priceOpinion}
Meets buyer needs: ${meetsBuyerNeeds}
Offer interest: ${offerInterest}
Overall impression: ${impression ?? "not provided"}
Buyer interest level: ${buyerInterestLevel}
Liked most: ${favoriteFeatures || "not provided"}
Concerns: ${specificConcerns || "none"}
Additional notes: ${additionalNotes || "none"}`,
        metadata: {
          userId: "system",
          brokerageId: fbReq.brokerage_id,
          feature: "sentiment_analysis",
        },
      })
      aiSummary = summaryResponse.text
    } catch {
      // Non-blocking — proceed without summary
    }

    // 3. UPDATE showing_feedback with all 10 fields + ai_summary
    const { error: fbError } = await supabase
      .from("showing_feedback")
      .update({
        presentation_rating:    presentationRating,
        cleanliness_rating:     cleanlinessRating,
        price_opinion:          priceOpinion,
        meets_buyer_needs:      meetsBuyerNeeds,
        offer_interest:         offerInterest,
        buyer_favorite_features: favoriteFeatures || null,
        specific_concerns:      specificConcerns || null,
        overall_impression:     impression,
        buyer_interest_level:   buyerInterestLevel,
        additional_notes:       additionalNotes || null,
        ai_summary:             aiSummary,
        // sentiment_score: simple mapping 0-1
        sentiment_score: offerInterest === "very_likely" || buyerInterestLevel === "hot"
          ? 0.85
          : offerInterest === "no" || buyerInterestLevel === "cold"
            ? 0.15
            : 0.5,
      })
      .eq("showing_id", showingId)
      .eq("feedback_token", token)

    if (fbError) {
      return NextResponse.json({ success: false, error: fbError.message }, { status: 500 })
    }

    // 4. UPDATE showing_feedback_requests: interest_score + ai_analysis
    await supabase
      .from("showing_feedback_requests")
      .update({
        interest_score: OFFER_INTEREST_SCORE[offerInterest] ?? 50,
        ai_analysis: {
          offerInterest,
          buyerInterestLevel,
          priceOpinion,
          overallImpression: impression,
          summary: aiSummary,
        },
      })
      .eq("id", requestId)

    // 5. Call aiAnalyzeShowingFeedback (non-blocking)
    aiAnalyzeShowingFeedback(requestId).catch(() => {})

    // 5b. BUYER ACK LOOP-BACK — close the loop in the SAME portal thread the
    //     feedback ask rode (client_portal_messages, agent_to_client). Before
    //     this, the buyer's submission vanished into agent-side analytics with
    //     nothing back. Idempotent per feedback submission (metadata-deduped by
    //     feedback_request_id); AI-authored in the tenant's brand voice with a
    //     deterministic fallback; portal-native ONLY — no email/SMS.
    try {
      const { data: ackShowing } = await supabase
        .from("showings")
        .select("contact_id, agent_id, listings(address)")
        .eq("id", fbReq.showing_id)
        .maybeSingle()

      // agent_id is NOT NULL on client_portal_messages; contact_id keys the thread.
      if (ackShowing?.contact_id && ackShowing.agent_id) {
        const { data: alreadyAcked } = await supabase
          .from("client_portal_messages")
          .select("id")
          .eq("contact_id", ackShowing.contact_id)
          .contains("metadata", { kind: "showing_feedback_ack", feedback_request_id: requestId })
          .limit(1)
          .maybeSingle()

        if (!alreadyAcked) {
          const ackAddress =
            (ackShowing as { listings?: { address?: string | null } | null }).listings?.address ??
            "the home you toured"
          // Deterministic fallback — always valid, never blocks on the LLM.
          let ackBody = `Got it — thanks for the feedback on ${ackAddress}. This helps us zero in on the right home.`
          try {
            const { loadBrandVoicePrompt } = await import("@/lib/ai-isa/brand-voice-prompt")
            const voice = await loadBrandVoicePrompt({
              brokerageId: fbReq.brokerage_id,
              agentId: ackShowing.agent_id,
            })
            const ack = await generateAIResponse({
              system: voice.systemBlock,
              prompt: `A buyer just submitted showing feedback for ${ackAddress} through their client portal. Write ONE short, warm acknowledgment (1–2 sentences, plain text, no subject line, no signature, no emojis) thanking them and letting them know their feedback helps their agent zero in on the right home for them. Do not ask questions, do not request anything, do not mention ratings or scores.`,
              metadata: {
                userId: "system",
                brokerageId: fbReq.brokerage_id,
                feature: "client_communication",
              },
            })
            const text = (ack.text ?? "").trim().replace(/\s+/g, " ")
            // Guardrails: only adopt a plausibly-sized, non-empty draft.
            if (text.length >= 20 && text.length <= 400) ackBody = text
          } catch {
            // Brand-voice draft unavailable — the deterministic ack stands.
          }

          await supabase.from("client_portal_messages").insert({
            contact_id: ackShowing.contact_id,
            brokerage_id: fbReq.brokerage_id,
            agent_id: ackShowing.agent_id,
            direction: "agent_to_client",
            channel: "portal",
            body: ackBody,
            metadata: {
              kind: "showing_feedback_ack",
              showing_id: fbReq.showing_id,
              feedback_request_id: requestId,
            },
          })
        }
      }
    } catch {
      // Ack is best-effort — the feedback submission itself already succeeded.
    }

    // 6. Recalculate showing_analytics for this listing
    const { data: listing } = await supabase
      .from("showings")
      .select("listing_id")
      .eq("id", showingId)
      .single()

    if (listing?.listing_id) {
      // Aggregate from showing_feedback joined with showings for this listing
      const { data: allFeedback } = await supabase
        .from("showing_feedback")
        .select(`
          presentation_rating, cleanliness_rating, price_opinion,
          meets_buyer_needs, offer_interest, overall_impression,
          buyer_interest_level, specific_concerns, buyer_favorite_features,
          showings!inner(listing_id, scheduled_at)
        `)
        .eq("showings.listing_id", listing.listing_id)
        .not("presentation_rating", "is", null)

      if (allFeedback && allFeedback.length > 0) {
        const n = allFeedback.length

        const avg = (arr: (number | null)[]) => {
          const valid = arr.filter((v): v is number => v != null)
          return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null
        }

        const dist = (arr: (string | null)[]): Record<string, number> => {
          const out: Record<string, number> = {}
          for (const v of arr) {
            if (v) out[v] = (out[v] ?? 0) + 1
          }
          return out
        }

        const topStrings = (arr: (string | null)[], take = 5): string[] => {
          const counts = dist(arr.flatMap((v) => v ? v.split(",").map((s) => s.trim()) : []))
          return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, take).map(([k]) => k)
        }

        // Scheduled timestamps to compute avg days between
        const timestamps = allFeedback
          .map((f: any) => f.showings?.scheduled_at)
          .filter(Boolean)
          .sort()

        let avgDaysBetween: number | null = null
        if (timestamps.length >= 2) {
          const diffs: number[] = []
          for (let i = 1; i < timestamps.length; i++) {
            const ms = new Date(timestamps[i]).getTime() - new Date(timestamps[i - 1]).getTime()
            diffs.push(ms / 86400000)
          }
          avgDaysBetween = diffs.reduce((a, b) => a + b, 0) / diffs.length
        }

        // Count total showings (including without feedback)
        const { count: totalShowings } = await supabase
          .from("showings")
          .select("id", { count: "exact", head: true })
          .eq("listing_id", listing.listing_id)
          .eq("status", "completed")

        const responseRate = totalShowings ? (n / totalShowings) * 100 : null

        await supabase
          .from("showing_analytics")
          .upsert(
            {
              listing_id:                  listing.listing_id,
              brokerage_id:                fbReq.brokerage_id,
              total_showings:              totalShowings ?? n,
              avg_days_between_showings:   avgDaysBetween,
              feedback_response_rate:      responseRate,
              avg_presentation_rating:     avg(allFeedback.map((f) => f.presentation_rating)),
              avg_cleanliness_rating:      avg(allFeedback.map((f) => f.cleanliness_rating)),
              price_opinion_distribution:  dist(allFeedback.map((f) => f.price_opinion)),
              meets_needs_distribution:    dist(allFeedback.map((f) => f.meets_buyer_needs)),
              offer_interest_distribution: dist(allFeedback.map((f) => f.offer_interest)),
              top_concerns:                topStrings(allFeedback.map((f) => f.specific_concerns)),
              top_liked_features:          topStrings(allFeedback.map((f) => f.buyer_favorite_features)),
              last_calculated_at:          new Date().toISOString(),
              updated_at:                  new Date().toISOString(),
            },
            { onConflict: "listing_id" }
          )
      }

      // 7. Kernel event — canonical fan-out. Staff (listing agent via the
      //    listing_stage_machine resolver) AND the seller's portal both get
      //    "Showing feedback received". Seller is resolved from the listing.
      if (fbReq.brokerage_id) {
        const { data: fbListing } = await supabase
          .from("listings")
          .select("seller_contact_id")
          .eq("id", listing.listing_id)
          .maybeSingle()
        const { fanOutKernelEvent } = await import("@/lib/kernel/event-fanout")
        await fanOutKernelEvent({
          event:           KernelEvent.SHOWING_FEEDBACK_RECEIVED,
          brokerageId:     fbReq.brokerage_id,
          entityType:      "listing_stage_machine",
          entityId:        listing.listing_id,
          sellerContactId: fbListing?.seller_contact_id ?? undefined,
          listingId:       listing.listing_id,
        }).catch(() => {})
      }
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error("[showings/feedback] POST error:", err)
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}
