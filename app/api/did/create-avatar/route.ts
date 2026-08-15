/**
 * POST /api/did/create-avatar
 *
 * Creates a named, persistent D-ID avatar from the agent's uploaded video clip.
 * D-ID /avatars processes the source video asynchronously — this endpoint submits
 * the job and returns immediately. poll-did-avatars cron updates status to "ready".
 *
 * Once ready, the avatar_id is used in all subsequent /clips calls instead of
 * re-uploading the source video on every render.
 *
 * Body: {
 *   source_url: string,   — public URL of the agent's uploaded video
 *   label?: string,       — display name (default: "My Avatar")
 *   set_as_default?: boolean
 * }
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { checkUsageCap } from "@/lib/usage/check-cap"
import { logMediaUsage } from "@/lib/usage/log-media-usage"

const DID_API_BASE = "https://api.d-id.com"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const didApiKey = process.env.DID_API_KEY
    if (!didApiKey) {
      return NextResponse.json(
        { error: "D-ID API key not configured. Contact your system administrator." },
        { status: 503 }
      )
    }

    const body = await request.json()
    const {
      source_url,
      label = "My Avatar",
      set_as_default = true,
      source_type = "video",
      twin_id,
    }: {
      source_url: string
      label?: string
      set_as_default?: boolean
      source_type?: "photo" | "video"
      /** When provided, updates an existing twin row (created via createTwinDraft) instead of inserting a new asset row. */
      twin_id?: string
    } = body

    if (!source_url) {
      return NextResponse.json({ error: "source_url is required" }, { status: 400 })
    }
    if (source_type !== "photo" && source_type !== "video") {
      return NextResponse.json({ error: "source_type must be 'photo' or 'video'" }, { status: 400 })
    }

    // Resolve agents.id for the current user
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("user_id", auth.userId)
      .maybeSingle()

    if (!agentRow) {
      return NextResponse.json({ error: "Agent profile not found" }, { status: 404 })
    }

    // ─── Usage cap on twin creations (skip when updating an existing twin) ──
    if (!twin_id) {
      const cap = await checkUsageCap({
        brokerageId: agentRow.brokerage_id ?? auth.brokerageId,
        metric: "avatars_created",
        addQuantity: 1,
      })
      if (!cap.allowed) {
        return NextResponse.json({ error: cap.message, capExceeded: true }, { status: 429 })
      }
    }

    // ─── Vendor budget gate — auto-pause over the monthly platform-vendor ceiling ─
    {
      const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
      const { estimatePlatformVendorCost } = await import("@/lib/vendor-governance/meter-vendor")
      const bgt = await checkVendorBudget({
        brokerageId: agentRow.brokerage_id ?? auth.brokerageId,
        addCost: estimatePlatformVendorCost("did", 1),
      })
      if (!bgt.allowed) {
        return NextResponse.json(
          { error: "Monthly usage limit reached — avatar creation paused.", budgetExceeded: true },
          { status: 402 },
        )
      }
    }

    // ─── Submit to D-ID /avatars ──────────────────────────────────────────────
    // D-ID creates a reusable avatar from the source video.
    // The response is immediate but the avatar is not ready until status === "done".
    const didRes = await fetch(`${DID_API_BASE}/avatars`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        source_url,
        // presenter_config is optional — D-ID uses defaults when omitted
      }),
    })

    const didData = await didRes.json()

    if (!didRes.ok) {
      console.error("[create-avatar] D-ID error:", didData)
      return NextResponse.json(
        { error: didData.description ?? didData.message ?? "D-ID avatar creation failed" },
        { status: 502 }
      )
    }

    const did_avatar_id: string = didData.id

    // ─── Persist on existing twin row OR create new asset ────────────────────
    let assetId: string
    if (twin_id) {
      // Update path — wizard already created the row via createTwinDraft.
      // Verify the row belongs to this agent before mutating.
      const { data: existing } = await supabase
        .from("agent_avatar_assets")
        .select("id, agent_id")
        .eq("id", twin_id)
        .maybeSingle()
      if (!existing || existing.agent_id !== agentRow.id) {
        return NextResponse.json({ error: "Twin not found" }, { status: 404 })
      }
      await supabase
        .from("agent_avatar_assets")
        .update({
          did_avatar_id,
          status: "pending",
          source_type,
          source_url,
          updated_at: new Date().toISOString(),
        })
        .eq("id", twin_id)
      assetId = twin_id
    } else {
      const { data: asset, error: insertError } = await supabase
        .from("agent_avatar_assets")
        .insert({
          agent_id: agentRow.id,
          brokerage_id: agentRow.brokerage_id ?? auth.brokerageId,
          label,
          source_type,
          source_url,
          did_avatar_id,
          status: "pending",
          is_default: set_as_default,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single()

      if (insertError || !asset) {
        console.error("[create-avatar] DB insert error:", insertError)
        return NextResponse.json({ error: insertError?.message ?? "Insert failed" }, { status: 500 })
      }
      assetId = asset.id

      // If other avatars exist, clear their is_default flag when this one is set as default
      if (set_as_default) {
        await supabase
          .from("agent_avatar_assets")
          .update({ is_default: false })
          .eq("agent_id", agentRow.id)
          .neq("id", asset.id)
      }
    }

    // ─── Log the usage event (skip when updating an existing twin) ──────────
    if (!twin_id) {
      logMediaUsage({
        brokerageId: agentRow.brokerage_id ?? auth.brokerageId,
        metric: "avatars_created",
        quantity: 1,
        agentId: agentRow.id,
        userId: auth.userId,
        sessionRef: did_avatar_id,
        feature: "twin_studio",
      }).catch(() => {})
    }

    return NextResponse.json({
      success: true,
      asset_id: assetId,
      did_avatar_id,
      status: "pending",
      message: "Twin is being processed. This usually takes 1–3 minutes.",
    })
  } catch (error: any) {
    console.error("[create-avatar] Error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
