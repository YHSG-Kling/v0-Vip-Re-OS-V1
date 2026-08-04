import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { determinePortalView, getPortalJourneyMilestones } from "@/lib/kernel/portal"
import type { PortalJourneyMilestone } from "@/lib/kernel/portal"
import {
  BUYER_MILESTONE_LABELS,
  SELLER_MILESTONE_LABELS,
  MILESTONE_RESPONSIBLE_PARTY,
  MILESTONE_EXPLANATIONS,
  MILESTONE_LESSON_MAP,
} from "@/lib/portal/resolve-education-context"
import { generationalCohortFromAge, cohortFraming, ageFromBirthday } from "@/lib/kernel/education"
import { getPersonaJourneyStages, calculateJourneyProgress } from "@/lib/portal"
import { getTaskCompletions, getStageProgress } from "@/app/actions/journey-tasks"
import { getClientJourneyPreferences } from "@/app/actions/multi-persona"
import JourneyClient from "./journey-client"
import JourneyChecklist, { type ChecklistStage } from "./journey-checklist"

// Which getTaskFormFields() form a persona task gets. The mapping is decided ONCE,
// here on the server, so the form shape the client renders and the task_type the
// server records can never disagree. getTaskFormFields' `default` branch is a real
// branch — a notes+confirm form — so an unmapped task is still completable rather
// than being a button that does nothing.
function resolveTaskType(stageId: string, taskId: string, title: string): string {
  const hay = `${stageId} ${taskId} ${title}`.toLowerCase()
  if (/pre-?approval|pre_approval|lender|loan application|mortgage application/.test(hay)) return "pre_approval"
  if (/investment|cap rate|cash flow|brrrr/.test(hay)) return "investment_criteria"
  if (/budget|afford|down payment|monthly payment|savings/.test(hay)) return "budget_setup"
  if (/criteria|must-have|must have|wish list|search/.test(hay)) return "criteria_setup"
  if (/showing|tour|open house|walkthrough|visit/.test(hay)) return "showing_feedback"
  if (/document|paperwork|pay stub|tax return|bank statement|upload/.test(hay)) return "document_upload"
  return "default"
}

// The client journey timeline shape is owned by the kernel (it decides visibility by
// the agent-controlled is_client_visible flag). The page consumes PortalJourneyMilestone.
export type TransactionMilestone = PortalJourneyMilestone

export interface TransactionData {
  id: string
  property_address: string | null
  status: string
  list_price: number | null
  offer_price: number | null
  purchase_price: number | null
  close_date: string | null
  contract_date: string | null
  deal_type: string | null
}

export default async function PortalJourneyPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Get contact basic info
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, contact_type, buyer_stage, birthday, contact_persona")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Persona tone: frame each milestone's explanation in the language this
  // generation responds to (wording only — identity/visibility unchanged).
  const cohort = generationalCohortFromAge(ageFromBirthday(contact.birthday))
  const personaFraming = cohortFraming(cohort)

  // Determine portal view from kernel
  const portalView = await determinePortalView(supabase, { contactId })

  // Get active transaction for this contact
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, property_address, status, list_price:purchase_price, offer_price:purchase_price, purchase_price, close_date, contract_date, deal_type")
    .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .not("status", "in", "(cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)

  const transaction: TransactionData | null = transactions?.[0] ?? null

  // The KERNEL decides which milestones the client sees (by canonical milestone_type,
  // with the agent's per-contact overrides applied) — the page does not read or filter
  // transaction_milestones itself. Single source of truth: lib/kernel/portal.ts.
  const milestones: TransactionMilestone[] = transaction
    ? await getPortalJourneyMilestones(supabase, {
        contactId,
        transactionId: transaction.id,
      })
    : []

  // Get label map based on portal view
  const labelMap = portalView.view === "seller" ? SELLER_MILESTONE_LABELS : BUYER_MILESTONE_LABELS

  // Get contact display name
  const contactName = contact.first_name || "there"

  // ── THE CLIENT'S OWN CHECKLIST ───────────────────────────────────────────────
  // The timeline above is the AGENT's view of the deal (kernel-owned, read-only to
  // the client). This is the client's own to-do list, and until now no surface in
  // the app rendered it: PERSONA_CONFIGS[...].journeyStages, calculateJourneyProgress,
  // getTaskCompletions and getStageProgress were all complete and all unreachable.
  //
  // Both reads are gated by requireContactAccess inside the action, so a signed-in
  // client cannot fetch another contact's checklist by editing the URL — the
  // page's own contactId is not what authorizes the read.
  const persona = (contact.contact_persona as string | null) || "first_time_buyer"
  const personaStages = getPersonaJourneyStages(persona)
  const [taskCompletions, stageProgress, journeyPreferences] = await Promise.all([
    getTaskCompletions(contactId),
    getStageProgress(contactId),
    // The criteria the agent has on file for this client. The client had no way to
    // see what was recorded about them; the read is gated by requireContactAccess
    // because property_interests' RLS admits any row in the caller's brokerage,
    // which means one portal contact could otherwise read another's criteria.
    getClientJourneyPreferences(undefined, contactId),
  ])

  const prefRows: Array<{ label: string; value: string }> = []
  if (journeyPreferences) {
    const p = journeyPreferences as Record<string, any>
    const money = (n: unknown) =>
      typeof n === "number" ? `$${Math.round(n).toLocaleString()}` : null
    const priceRange = [money(p.min_price), money(p.max_price)].filter(Boolean).join(" – ")
    if (priceRange) prefRows.push({ label: "Price range", value: priceRange })
    if (p.property_type) prefRows.push({ label: "Property type", value: String(p.property_type) })
    if (p.bedrooms) prefRows.push({ label: "Bedrooms", value: `${p.bedrooms}+` })
    if (p.bathrooms) prefRows.push({ label: "Bathrooms", value: `${p.bathrooms}+` })
    if (Array.isArray(p.preferred_locations) && p.preferred_locations.length > 0)
      prefRows.push({ label: "Areas", value: p.preferred_locations.join(", ") })
    if (Array.isArray(p.must_have_features) && p.must_have_features.length > 0)
      prefRows.push({ label: "Must-haves", value: p.must_have_features.join(", ") })
  }

  const journeyProgress = calculateJourneyProgress(
    personaStages.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tasks: s.tasks.map((t) => ({ id: `${s.id}:${t.id}`, title: t.title, required: t.required })),
    })),
    taskCompletions,
    stageProgress
      ? { contact_id: contactId, current_stage_id: stageProgress.current_stage_id }
      : null,
    milestones,
  )

  const completedTaskIds = new Set(taskCompletions.map((c) => c.task_id))
  const completedAtById = new Map(taskCompletions.map((c) => [c.task_id, c.completed_at]))

  // Icons live on the persona config (LucideIcon values) and are NOT serializable
  // across the server/client boundary — the checklist gets plain data only.
  const checklistStages: ChecklistStage[] = personaStages.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    estimatedDays: s.estimatedDays,
    tasks: s.tasks.map((t) => {
      const compositeId = `${s.id}:${t.id}`
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        required: t.required,
        taskType: resolveTaskType(s.id, t.id, t.title),
        completed: completedTaskIds.has(compositeId),
        completedAt: completedAtById.get(compositeId) ?? null,
      }
    }),
  }))

  return (
    <div className="space-y-6">
      <JourneyClient
        contactId={contactId}
        contactName={contactName}
        portalView={portalView.view}
        transaction={transaction}
        milestones={milestones}
        labelMap={labelMap}
        responsiblePartyMap={MILESTONE_RESPONSIBLE_PARTY}
        explanationMap={MILESTONE_EXPLANATIONS}
        lessonMap={MILESTONE_LESSON_MAP}
        personaFraming={personaFraming}
      />
      {prefRows.length > 0 && (
        <div className="rounded-xl border p-4">
          <h3 className="font-semibold">What we're looking for</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            The criteria your agent has on file for you. Message them to change anything here.
          </p>
          <dl className="grid gap-2 sm:grid-cols-2">
            {prefRows.map((r) => (
              <div key={r.label} className="text-sm">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="font-medium">{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <JourneyChecklist
        contactId={contactId}
        transactionId={transaction?.id ?? null}
        persona={persona}
        stages={checklistStages}
        currentStageIndex={journeyProgress.currentStageIndex}
        progressPercent={journeyProgress.progressPercent}
        completedTasks={journeyProgress.completedTasks}
        totalTasks={journeyProgress.totalTasks}
        stageCursor={
          stageProgress
            ? {
                stage_name: stageProgress.stage_name,
                progress_pct: stageProgress.progress_pct,
                current_task: stageProgress.current_task,
              }
            : null
        }
      />
    </div>
  )
}
