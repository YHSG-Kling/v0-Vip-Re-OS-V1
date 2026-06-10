import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

const VALID_STATUSES = ["prospect", "contacted", "interviewing", "offer_extended", "joined", "declined"]

export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })

    const { data: profile } = await supabase
      .from("users")
      .select("user_type, role, brokerage_id")
      .eq("id", user.id)
      .maybeSingle()

    const resolvedType = profile?.user_type ?? profile?.role ?? ""
    if (!["broker", "admin", "superadmin"].includes(resolvedType)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { recruitId, toStatus, note } = await req.json()

    if (!recruitId || !toStatus) {
      return NextResponse.json({ error: "recruitId and toStatus required" }, { status: 400 })
    }
    if (!VALID_STATUSES.includes(toStatus)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    }

    const service = createServiceClient()

    // Verify recruit belongs to this brokerage
    const { data: recruit } = await service
      .from("recruits")
      .select("id, first_name, last_name, email, brokerage_id, status")
      .eq("id", recruitId)
      .eq("brokerage_id", profile!.brokerage_id!)
      .maybeSingle()

    if (!recruit) {
      return NextResponse.json({ error: "Recruit not found" }, { status: 404 })
    }

    // Build update payload
    const updatePayload: Record<string, unknown> = {
      status: toStatus,
      last_contact_date: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    if (note) {
      // Append note with timestamp prefix to existing notes
      const { data: existing } = await service
        .from("recruits")
        .select("notes")
        .eq("id", recruitId)
        .maybeSingle()
      const ts = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      const prefix = `[${ts}] ${note}`
      updatePayload.notes = existing?.notes ? `${existing.notes}\n\n${prefix}` : prefix
    }

    const { error: updateError } = await service
      .from("recruits")
      .update(updatePayload)
      .eq("id", recruitId)

    if (updateError) throw updateError

    // Activity log entry
    await service.from("activities").insert({
      activity_type: "recruiting.stage_advance",
      agent_user_id: user.id,
      brokerage_id: profile!.brokerage_id,
      title: `Recruit stage: ${recruit.first_name} ${recruit.last_name} → ${toStatus}`,
      notes: note ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).then(() => {}, () => {})

    // RECRUITING MANAGER — propose the next stage-appropriate outreach into the gate
    // (skips terminal stages + de-dupes a pending proposal). Best-effort.
    try {
      const { produceRecruitOutreach } = await import("@/lib/agents/recruit-outreach-producer")
      await produceRecruitOutreach(profile!.brokerage_id!, recruitId, service)
    } catch (err) {
      console.error("[recruiting/advance-stage] outreach proposal failed:", err)
    }

    return NextResponse.json({ success: true, recruitId, toStatus })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
