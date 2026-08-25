/**
 * Layer 8.1 Video Scripts Library API
 * 
 * CRUD operations for video_scripts_library table.
 * 
 * CRITICAL RULES:
 * - Uses public.video_scripts_library (canonical table)
 * - NEVER references public.video_scripts or public.script_templates
 * - All writes must go through kernel governance
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// ─── GET: Fetch scripts from library ─────────────────────────────────────────

export async function GET(req: Request) {
  try {
    const supabase = await createClient()
    const { searchParams } = new URL(req.url)

    // Auth check
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get user's brokerage
    const { data: userRecord } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userRecord?.brokerage_id) {
      return NextResponse.json({ error: "No brokerage found" }, { status: 403 })
    }

    // Parse filters
    const scriptType = searchParams.get("script_type")
    const approvalStatus = searchParams.get("approval_status")
    const templateBacked = searchParams.get("template_backed")
    const agentId = searchParams.get("agent_id")
    const scriptId = searchParams.get("id")

    // Single script fetch
    if (scriptId) {
      const { data: script, error } = await supabase
        .from("video_scripts_library")
        .select(`
          *,
          video_templates(id, template_name, category, default_script, duration_seconds),
          script_variations(*)
        `)
        .eq("id", scriptId)
        .eq("brokerage_id", userRecord.brokerage_id)
        .single()

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ script })
    }

    // Build query for list
    let query = supabase
      .from("video_scripts_library")
      .select(`
        *,
        video_templates(id, template_name, category),
        script_variations(id)
      `)
      .eq("brokerage_id", userRecord.brokerage_id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })

    if (scriptType) {
      query = query.eq("script_type", scriptType)
    }
    if (approvalStatus) {
      query = query.eq("approval_status", approvalStatus)
    }
    if (templateBacked === "true") {
      query = query.not("template_id", "is", null)
    } else if (templateBacked === "false") {
      query = query.is("template_id", null)
    }
    if (agentId) {
      query = query.eq("agent_id", agentId)
    }

    const { data: scripts, error } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Map variation counts
    const mappedScripts = (scripts || []).map(script => ({
      ...script,
      variation_count: script.script_variations?.length ?? 0,
      template: script.video_templates ?? null,
    }))

    return NextResponse.json({ scripts: mappedScripts })
  } catch (error: any) {
    console.error("[video-scripts] GET error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// ─── POST: Create new script in library ──────────────────────────────────────

export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const body = await req.json()

    // Auth check
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get user's brokerage
    const { data: userRecord } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userRecord?.brokerage_id) {
      return NextResponse.json({ error: "No brokerage found" }, { status: 403 })
    }

    const {
      agent_id,
      listing_id,
      contact_id,
      template_id,
      script_type,
      title,
      script_content,
      duration_target_seconds,
      brand_voice_tone,
      approval_status,
      compliance_review_notes,
      required_brand_assets,
      ai_generated,
    } = body

    // Validate required fields
    if (!script_type || !title || !script_content) {
      return NextResponse.json(
        { error: "script_type, title, and script_content are required" },
        { status: 400 }
      )
    }

    // Resolve agent ID - never use user.id for agent_id column
    const resolvedAgentId = agent_id ?? await resolveAgentId(supabase, user.id)
    if (!resolvedAgentId) {
      return NextResponse.json({ error: "Agent profile not found" }, { status: 403 })
    }

    // Insert into video_scripts_library
    const { data: script, error } = await supabase
      .from("video_scripts_library")
      .insert({
        brokerage_id: userRecord.brokerage_id,
        agent_id: resolvedAgentId,
        listing_id: listing_id ?? null,
        contact_id: contact_id ?? null,
        template_id: template_id ?? null,
        script_type,
        title,
        script_content,
        duration_target_seconds: duration_target_seconds ?? null,
        brand_voice_tone: brand_voice_tone ?? null,
        approval_status: approval_status ?? "draft",
        compliance_review_notes: compliance_review_notes ?? null,
        required_brand_assets: required_brand_assets ?? null,
        ai_generated: ai_generated ?? false,
        is_active: true,
        created_by: user.id,
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Write lifecycle event
    await supabase.from("lifecycle_events").insert({
      entity_type: "video_script",
      entity_id: script.id,
      brokerage_id: userRecord.brokerage_id,
      event_type: KernelEvent.SCRIPT_GENERATED,
      actor_user_id: user.id,
      metadata: {
        script_type,
        ai_generated: ai_generated ?? false,
        approval_status: approval_status ?? "draft",
      },
    })

    // Fire kernel event
    await processKernelEvent({
      event: KernelEvent.SCRIPT_GENERATED,
      brokerageId: userRecord.brokerage_id,
      entityType: "video_script",
      entityId: script.id,
    }).catch(err => console.error("[video-scripts] Kernel event failed:", err))

    return NextResponse.json({ script })
  } catch (error: any) {
    console.error("[video-scripts] POST error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// ─── PATCH: Update script ────────────────────────────────────────────────────

export async function PATCH(req: Request) {
  try {
    const supabase = await createClient()
    const body = await req.json()

    // Auth check
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ error: "Script id is required" }, { status: 400 })
    }

    // Get user's brokerage
    const { data: userRecord } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userRecord?.brokerage_id) {
      return NextResponse.json({ error: "No brokerage found" }, { status: 403 })
    }

    // Update script
    const { data: script, error } = await supabase
      .from("video_scripts_library")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("brokerage_id", userRecord.brokerage_id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // If approval status changed, fire appropriate event
    if (updates.approval_status) {
      const eventType = updates.approval_status === "approved"
        ? KernelEvent.SCRIPT_APPROVED
        : updates.approval_status === "rejected"
          ? KernelEvent.SCRIPT_REJECTED
          : KernelEvent.SCRIPT_GENERATED

      await supabase.from("lifecycle_events").insert({
        entity_type: "video_script",
        entity_id: id,
        brokerage_id: userRecord.brokerage_id,
        event_type: eventType,
        actor_user_id: user.id,
        metadata: {
          approval_status: updates.approval_status,
          compliance_review_notes: updates.compliance_review_notes,
        },
      })
    }

    return NextResponse.json({ script })
  } catch (error: any) {
    console.error("[video-scripts] PATCH error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// ─── DELETE: Soft delete script ──────────────────────────────────────────────

export async function DELETE(req: Request) {
  try {
    const supabase = await createClient()
    const { searchParams } = new URL(req.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "Script id is required" }, { status: 400 })
    }

    // Auth check
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get user's brokerage
    const { data: userRecord } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userRecord?.brokerage_id) {
      return NextResponse.json({ error: "No brokerage found" }, { status: 403 })
    }

    // Soft delete
    const { error } = await supabase
      .from("video_scripts_library")
      .update({ is_active: false })
      .eq("id", id)
      .eq("brokerage_id", userRecord.brokerage_id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("[video-scripts] DELETE error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
