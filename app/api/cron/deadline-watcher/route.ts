import { NextResponse } from "next/server"
import { checkUpcomingDeadlines } from "@/lib/kernel"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await checkUpcomingDeadlines()
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    console.error("[cron/deadline-watcher] Failed:", err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
