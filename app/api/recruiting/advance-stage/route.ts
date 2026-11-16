import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { bestEffort } from "@/lib/db/best-effort"
// WAVE 153 (lane 153I): ONE stage vocabulary + the one hard transition rule (a provisioned recruit stays Joined).
// TOMBSTONE: the local VALID_STATUSES copy that stood here — survivor lib/recruiting/stale-recruit-policy.ts RECRUIT_STATUSES.
import { RECRUIT_STATUSES, recruitStageChange } from "@/lib/recruiting/stale-recruit-policy"

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
    if (!isAdminOrBroker({ user_type: resolvedType })) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { recruitId, toStatus, note } = await req.json()

    if (!recruitId || !toStatus) {
      return NextResponse.json({ error: "recruitId and toStatus required" }, { status: 400 })
    }
    if (!(RECRUIT_STATUSES as readonly string[]).includes(toStatus)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    }

    const service = createServiceClient()

    // Verify recruit belongs to this brokerage
    const { data: recruit } = await service
      .from("recruits")
      .select("id, first_name, last_name, email, brokerage_id, status, provisioned")
      .eq("id", recruitId)
      .eq("brokerage_id", profile!.brokerage_id!)
      .maybeSingle()

    if (!recruit) {
      return NextResponse.json({ error: "Recruit not found" }, { status: 404 })
    }
    const allowed = recruitStageChange({ from: recruit.status, to: toStatus, provisioned: (recruit as { provisioned?: boolean | null }).provisioned === true })
    if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: 409 })

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

    // Tenant-pinned and COUNTED (CLAUDE.md §3: an update that matches nothing resolves too).
    const { data: moved, error: updateError } = await service
      .from("recruits")
      .update(updatePayload)
      .eq("id", recruitId)
      .eq("brokerage_id", profile!.brokerage_id!)
      .select("id")

    if (updateError) throw updateError
    if (!moved || moved.length !== 1) return NextResponse.json({ error: "The recruit changed while you were saving — reload and try again." }, { status: 409 })

    // Activity log entry
    await bestEffort(
      service.from("activities").insert({
        activity_type: "recruiting.stage_advance",
        agent_user_id: user.id,
        brokerage_id: profile!.brokerage_id,
        title: `Recruit stage: ${recruit.first_name} ${recruit.last_name} → ${toStatus}`,
        notes: note ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      "the recruits row has already advanced above and its error is checked and thrown; this audit echo must not fail a stage change that has taken effect",
    )

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
