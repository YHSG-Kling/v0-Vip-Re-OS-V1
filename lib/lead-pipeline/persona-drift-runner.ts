// lib/lead-pipeline/persona-drift-runner.ts
//
// Live side of PERSONA-DRIFT (Data Steward): find contacts/leads whose enrichment has aged past the
// freshness window and RE-QUEUE them into the existing lead_enrichment_queue, so the next
// persona-grounded touch is built on current facts — not an 18-month-old snapshot. Idempotent
// (never double-queues a record that already has a pending refresh). Read-mostly; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { DEFAULT_MAX_AGE_DAYS } from "./persona-drift"
import { NOT_CONVERTED_FILTER } from "@/lib/lead-pipeline/lead-lifecycle"

type Svc = ReturnType<typeof createServiceClient>

export interface PersonaDriftRunInput {
  brokerageId: string
  now?: string
  maxAgeDays?: number
  limit?: number
}

export interface PersonaDriftRunResult {
  scanned: number
  requeuedContacts: number
  requeuedLeads: number
}

async function requeueOne(svc: Svc, brokerageId: string, key: "contact_id" | "lead_id", id: string): Promise<boolean> {
  // Idempotent: skip if this record already has a pending/processing refresh queued.
  const { data: existing } = await svc
    .from("lead_enrichment_queue")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq(key, id)
    .in("status", ["pending", "processing"])
    .limit(1)
    .maybeSingle()
  if (existing) return false
  const { error } = await svc.from("lead_enrichment_queue").insert({
    brokerage_id: brokerageId,
    [key]: id,
    status: "pending",
    enrichment_type: "skip_trace", // the operation (re-run PeopleData skip trace); constrained enum
    trigger_type: "persona_drift", // WHY it was queued (free-text)
    retry_count: 0,
    max_retries: 3,
    queued_at: new Date().toISOString(),
  })
  return !error
}

export async function runPersonaDriftRefresh(input: PersonaDriftRunInput, client?: Svc): Promise<PersonaDriftRunResult> {
  const svc = client ?? createServiceClient()
  const now = input.now ?? new Date().toISOString()
  const maxAge = input.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const cutoff = new Date(new Date(now).getTime() - maxAge * 86_400_000).toISOString()
  const limit = input.limit ?? 100
  const out: PersonaDriftRunResult = { scanned: 0, requeuedContacts: 0, requeuedLeads: 0 }

  // Stale-enriched CONTACTS (enriched once, but the facts have aged past the window).
  const { data: contacts } = await svc
    .from("contacts")
    .select("id, last_enriched_at")
    .eq("brokerage_id", input.brokerageId)
    .not("last_enriched_at", "is", null)
    .lt("last_enriched_at", cutoff)
    .neq("status", "archived")
    .limit(limit)
  for (const c of (contacts ?? []) as any[]) {
    out.scanned++
    if (await requeueOne(svc, input.brokerageId, "contact_id", c.id)) out.requeuedContacts++
  }

  // Stale-enriched LEADS (pre-conversion).
  const { data: leads } = await svc
    .from("leads")
    .select("id, last_enriched_at")
    .eq("brokerage_id", input.brokerageId)
    .not("last_enriched_at", "is", null)
    .lt("last_enriched_at", cutoff)
    .or(NOT_CONVERTED_FILTER)
    .limit(limit)
  for (const l of (leads ?? []) as any[]) {
    out.scanned++
    if (await requeueOne(svc, input.brokerageId, "lead_id", l.id)) out.requeuedLeads++
  }

  return out
}
