import { Phone, ShieldCheck } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { DialBatchClient } from "./dial-batch-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

/**
 * VOICE ISA DIAL-BATCH GATE — the AI ISA's governed outbound calling. The ISA proposes a
 * batch of CONSENTED high-propensity contacts to call; a human approves; consent is
 * RE-CHECKED at approval before any dial. Voice is contacts-only (explicit TCPA consent +
 * ISA re-engage permission) so the rule is unambiguous.
 */
export default async function VoiceDialBatchesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  if (!isAdminOrBroker({ user_type: profile.user_type ?? "" })) {
    return <div className="p-6 text-red-600">Forbidden</div>
  }

  const svc = createServiceClient()
  // THE APPROVAL RECORD. approved_by / approved_at are stamped on BOTH terminal
  // paths — approve (lib/ai-isa/voice-dial-batch.ts:251) and reject
  // (app/actions/voice-dial-batch.ts:67) — and call_results is written with the
  // per-contact outcome of every dial (:272). None of the three was ever
  // selected, so the page that advertises consent gating could not name the human
  // who cleared the batch, or say what the calls actually did.
  const { data: batches, error: batchErr } = await svc
    .from("ai_isa_call_batches")
    .select("id, status, script, target_contacts, proposed_count, dialed_count, proposed_at, completed_at, approved_by, approved_at, call_results")
    .eq("brokerage_id", profile.brokerage_id)
    .order("proposed_at", { ascending: false })
    .limit(50)
  // §3 — a refused read must not render as "no dial batches yet" on a
  // TCPA-adjacent surface.
  if (batchErr) {
    return <div className="p-6 text-red-600">Dial batches could not be read: {batchErr.message}</div>
  }

  // WHO APPROVED / REJECTED. `ai_isa_call_batches.approved_by` FKs users(id)
  // (scripts/schema-fk-map.ts:170) — a USERS-class id, not an agents id (the same
  // row's proposed_by_agent_id is the agents-class one). Batched `.in()`,
  // anchored to this brokerage: an id that does not resolve inside the tenant is
  // reported as unresolved, never silently blanked into "auto-approved".
  const approverIds = Array.from(new Set(
    ((batches ?? []) as any[]).map((b) => b.approved_by).filter((v): v is string => !!v),
  ))
  const approverNames = new Map<string, string>()
  if (approverIds.length > 0) {
    const { data: approvers, error: approverErr } = await svc
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", approverIds)
      .eq("brokerage_id", profile.brokerage_id)
    if (approverErr) console.error("[voice-dial-batches] approver lookup failed:", approverErr.message)
    for (const u of (approvers ?? []) as any[]) {
      const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
      approverNames.set(u.id, full || u.email || "Teammate")
    }
  }

  /** call_results as written at lib/ai-isa/voice-dial-batch.ts:272:
   *  { attempted, placed, dropped_for_consent, outcomes: [{contactId, placed, voiceCallId, error}] }
   *  Anything absent or shaped otherwise is reported as NOT RECORDED — this is a
   *  TCPA-adjacent record and a guessed outcome is worse than a blank one. */
  function readCallResults(raw: unknown, targets: Array<{ contact_id?: string; name?: string }>) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    const nameByContact = new Map(targets.map((t) => [t.contact_id ?? "", t.name ?? ""]))
    const rawOutcomes = Array.isArray(o.outcomes) ? o.outcomes : []
    return {
      attempted:  typeof o.attempted === "number" ? o.attempted : null,
      placed:     typeof o.placed === "number" ? o.placed : null,
      droppedForConsent: typeof o.dropped_for_consent === "number" ? o.dropped_for_consent : null,
      outcomes: rawOutcomes.map((x: any) => ({
        contactId: typeof x?.contactId === "string" ? x.contactId : null,
        name: (typeof x?.contactId === "string" ? nameByContact.get(x.contactId) : "") || null,
        placed: x?.placed === true,
        error: typeof x?.error === "string" && x.error.trim() ? x.error.trim() : null,
      })),
    }
  }

  const rows = (batches ?? []).map((b: any) => {
    const targets = (b.target_contacts ?? []) as Array<{ contact_id?: string; name: string; propensity_score: number }>
    return {
      id: b.id, status: b.status, script: b.script,
      proposedCount: b.proposed_count ?? 0, dialedCount: b.dialed_count,
      proposedAt: b.proposed_at, completedAt: b.completed_at,
      targets,
      approvedByUserId: (b.approved_by ?? null) as string | null,
      approverName: b.approved_by ? (approverNames.get(b.approved_by) ?? null) : null,
      approvedAt: (b.approved_at ?? null) as string | null,
      callResults: readCallResults(b.call_results, targets),
    }
  })

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Phone className="h-6 w-6 text-indigo-600" /> AI ISA Dial Batches
        </h1>
        <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
          <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
          Only TCPA-consented, ISA-reengage-permitted contacts are dialed — and consent is re-checked the
          moment you approve, so a contact who opts out in the meantime is silently dropped.
        </p>
      </div>
      <DialBatchClient initialBatches={rows} />
    </div>
  )
}
