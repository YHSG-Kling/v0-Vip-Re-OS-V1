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
import { buildExpressAvatarRequest, classifyDidError } from "@/lib/did/contract"

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

    // ─── CONSENT GATE ───────────────────────────────────────────────────────
    // A video source is a V3 Instant Avatar, and D-ID REQUIRES a verified
    // consent statement for those: a random passcode read aloud on camera,
    // checked by transcription, face recognition against this very footage, and
    // voice verification. We had none of it — this route posted a source_url
    // with no consent_id, so every video twin was submitted without the one
    // thing the endpoint exists to require.
    //
    // Refused here rather than submitted-and-rejected: the agent gets a clear
    // next step instead of a job that fails minutes later inside a cron, and no
    // provider quota is spent on a submission that cannot succeed.
    const { resolveConsentIdForAvatar, consentRequiredFor } = await import("@/lib/did/consent")
    let consentId: string | null = null
    if (consentRequiredFor(source_type)) {
      consentId = await resolveConsentIdForAvatar(supabase, agentRow.id, source_type)
      if (!consentId) {
        return NextResponse.json({
          error:
            "Before we can build a video twin, you need to record a short consent statement — " +
            "you'll read three words on camera so D-ID can verify it's really you.",
          kind: "ConsentRequired",
          needs_consent: true,
          needs_human_action: true,
          retryable: false,
        }, { status: 428 })
      }
    }

    // The avatar's NAME in the D-ID account. Operational rather than technical:
    // without it a brokerage's avatars are all untitled and indistinguishable
    // when something needs provider-side support.
    let agentDisplayName: string | null = null
    {
      const { data: u } = await supabase
        .from("users").select("first_name, last_name").eq("id", auth.userId).maybeSingle()
      const full = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim()
      agentDisplayName = full || null
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

    // ─── Submit to D-ID /scenes/avatars ───────────────────────────────────────
    // D-ID creates a reusable avatar from the source video. The response is
    // immediate; the avatar is not usable until status === "done".
    //
    // THE PATH. This posted to `/avatars`, which is not an endpoint D-ID
    // documents — the Express / Instant avatar family lives under
    // `/scenes/avatars` and returns `{id:"avt_…", object:"scene_avatar",
    // status:"validating"}`. So every avatar an agent recorded at onboarding
    // was submitted to a URL that answers 404, and the poll cron's
    // `if (!statusRes.ok) continue` then swallowed the 404 on every tick — the
    // row sat at 'pending' forever with no error anyone could see. Two silent
    // failures stacked: a wrong path, and a poll that cannot tell "not ready"
    // from "not there".
    const didRes = await fetch(`${DID_API_BASE}/scenes/avatars`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      // THE COMPLETE CONTRACT. This used to send source_url alone. The
      // published POST /scenes/avatars body also takes name, consent_id,
      // webhook, user_data and is_greenscreen — so every avatar was untitled
      // in the D-ID account (a brokerage with fifty agents got fifty untitled
      // avatars with no way to tell whose was whose during support), and
      // nothing correlated the job back to our row except an id we happened to
      // store on a separate write. user_data is the field D-ID designed for
      // exactly that: it is echoed on the job AND on the webhook.
      body: JSON.stringify(buildExpressAvatarRequest({
        sourceUrl: source_url,
        assetId: twin_id ?? null,
        agentName: agentDisplayName,
        label,
        consentId,
        isGreenscreen: body?.is_greenscreen === true,
      })),
    })

    const didData = await didRes.json().catch(() => ({}))

    if (!didRes.ok) {
      // Structured, per the published error contract: {kind, description}
      // across 400 (BadRequestError | InvalidFileSizeError | InvalidFaceError),
      // 401, 402, 403 and 451 (moderation / celebrity recognition). We used to
      // read only `description` and drop `kind`, so "no face in that video",
      // "out of credits" and "flagged as a public figure" all reached the agent
      // as the same shrug — three different problems, only one of which the
      // agent can act on, and none of which is worth retrying.
      const failure = classifyDidError(didRes.status, didData)
      console.error("[create-avatar] D-ID refused:", failure.operatorMessage)
      return NextResponse.json(
        {
          error: failure.userMessage,
          kind: failure.kind,
          needs_human_action: failure.needsHumanAction,
          retryable: failure.retryable,
        },
        { status: failure.retryable ? 503 : 422 },
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
