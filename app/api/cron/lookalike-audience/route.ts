import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction, recordCronStartAction, recordCronSuccessAction, recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runLookalikeAudience } from "@/lib/kernel/lookalike-audience"

export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth
  const ctx = await createCronRunContextAction({ cron_name: "lookalike-audience", cron_path: "/app/api/cron/lookalike-audience/route.ts" })
  if (!ctx.success || !ctx.data) return NextResponse.json({ error: "ctx" }, { status: 500 })
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})
  const supabase = createServiceClient()
  const errors: string[] = []
  const agg: Record<string, number> = {}
  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runLookalikeAudience(b.id, {}, supabase) as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(r)) if (typeof v === "number") agg[k] = (agg[k] ?? 0) + v
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({ context_id: contextId, records_processed: agg["seedCount"] ?? 0, metadata: { ...agg, errors: errors.slice(0, 10) } }).catch(() => {})
    return NextResponse.json({ ok: true, ...agg })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
