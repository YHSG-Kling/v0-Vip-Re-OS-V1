// app/api/cron/actor-health/route.ts
// "Constant checker" for Apify actor resilience. Probes every candidate actor in
// the ACTOR_REGISTRY (Apify GET /v2/acts/{id}) and records alive/dead in
// scraper_actor_health, so platform admins can see when an actor has been
// removed and the registry needs a new fallback. The lead-scraping cron's
// runApifyTask already auto-switches across candidates at runtime; this gives
// proactive visibility (and surfaces tasks whose entire candidate set is down).

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyCronAuth } from "@/lib/cron-auth"
import { ACTOR_REGISTRY, checkActorExists, type ApifyTask } from "@/lib/external/apify-actors"

export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const supabase = createServiceClient()
  const results: Array<{ task: string; actor_id: string; alive: boolean }> = []
  const deadTasks: string[] = []

  for (const task of Object.keys(ACTOR_REGISTRY) as ApifyTask[]) {
    let anyAlive = false
    for (const actorId of ACTOR_REGISTRY[task]) {
      const alive = await checkActorExists(actorId)
      if (alive) anyAlive = true
      results.push({ task, actor_id: actorId, alive })
      await supabase
        .from("scraper_actor_health")
        .upsert(
          {
            task,
            actor_id: actorId,
            alive,
            last_checked: new Date().toISOString(),
            last_error: alive ? null : "actor not found / unreachable",
          },
          { onConflict: "task,actor_id" },
        )
    }
    // A task with NO live candidate needs a registry update — surface it loudly.
    if (!anyAlive) {
      deadTasks.push(task)
      console.error(`[actor-health] NO live actor for task "${task}" — add a new fallback to ACTOR_REGISTRY`)
    }
  }

  return NextResponse.json({
    checked: results.length,
    alive: results.filter((r) => r.alive).length,
    dead: results.filter((r) => !r.alive).length,
    tasks_with_no_live_actor: deadTasks,
  })
}
