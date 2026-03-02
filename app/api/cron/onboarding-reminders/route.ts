import { NextResponse } from "next/server"
import { findStuckAgentsAndNotify } from "@/lib/kernel/onboarding-reminders"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await findStuckAgentsAndNotify()
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    console.error("[cron/onboarding-reminders] Failed:", err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
