import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runReverseProspecting } from "@/lib/kernel/reverse-prospecting"

/**
 * REVERSE PROSPECTING cron — inventory becomes instant buyer demand. For each fresh
 * (coming-soon / active) listing, the Data Steward matches the brokerage's OWN buyers by
 * saved criteria, the Shopping Agent drafts a persona-aware "this just came up for you"
 * note PER matched buyer into the gate, and the AI ISA queues those buyers as call
 * candidates on the bus. Nothing sends; one note per (listing, buyer) ever.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "reverse-prospecting",
    cron_path: "/app/api/cron/reverse-prospecting/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let listings = 0, matches = 0, notesProposed = 0, isaQueued = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runReverseProspecting(b.id, {}, supabase)
        listings += r.listings; matches += r.matches
        notesProposed += r.notesProposed; isaQueued += r.isaQueued
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: notesProposed,
      metadata: { listings, matches, notesProposed, isaQueued, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, listings, matches, notesProposed, isaQueued })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
