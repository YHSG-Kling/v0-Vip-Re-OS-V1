import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token")
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 })
  }

  try {
    const supabase = await createClient()

    // Multi-tenant safe: find brokerage by ical_token inside additional_settings jsonb
    // Primary attempt: use @> (jsonb containment) which is index-friendly
    const { data: settingsRows } = await supabase
      .from("global_settings")
      .select("brokerage_id, additional_settings")
      .contains("additional_settings", { ical_token: token })
      .limit(1)

    let brokerageId: string | null = null

    if (settingsRows && settingsRows.length > 0) {
      brokerageId = settingsRows[0].brokerage_id
    } else {
      // Fallback: fetch all and check in-app (handles edge cases where contains() unsupported)
      const { data: allSettings } = await supabase
        .from("global_settings")
        .select("brokerage_id, additional_settings")

      for (const row of allSettings ?? []) {
        const settings = row.additional_settings as Record<string, unknown> | null
        if (settings?.ical_token === token) {
          brokerageId = row.brokerage_id
          break
        }
      }
    }

    if (!brokerageId) {
      return NextResponse.json({ error: "Invalid token" }, { status: 403 })
    }

    // Fetch calendar_events for this brokerage
    const { data: events, error } = await supabase
      .from("calendar_events")
      .select("id, event_type, entity_type, entity_id, start_at, end_at")
      .eq("brokerage_id", brokerageId)
      .order("start_at", { ascending: true })

    if (error || !events) {
      return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 })
    }

    // Build iCal format (RFC 5545)
    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//VIP Real Estate OS//Calendar//EN",
      "CALSCALE:GREGORIAN",
    ]

    for (const event of events) {
      const toIcalDate = (iso: string): string =>
        new Date(iso).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"

      const startDate = toIcalDate(event.start_at)
      const endDate = event.end_at ? toIcalDate(event.end_at) : startDate

      lines.push(
        "BEGIN:VEVENT",
        `UID:${event.id}@vip-os`,
        `DTSTAMP:${startDate}`,
        `DTSTART:${startDate}`,
        `DTEND:${endDate}`,
        `SUMMARY:${event.event_type}`,
        `DESCRIPTION:${event.entity_type}/${event.entity_id}`,
        "END:VEVENT",
      )
    }

    lines.push("END:VCALENDAR")

    const ical = lines.join("\r\n") + "\r\n"

    return new NextResponse(ical, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": "attachment; filename=calendar.ics",
      },
    })
  } catch (err) {
    console.error("[ical export] error:", err)
    return NextResponse.json(
      {
        error: "Export failed",
        details: err instanceof Error ? err.message : "Unknown",
      },
      { status: 500 },
    )
  }
}
