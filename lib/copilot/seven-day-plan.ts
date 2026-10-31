/**
 * lib/copilot/seven-day-plan.ts — THE seven-touch nurture plan writer, callable
 * with no session (lane 86F, wave 86).
 *
 * WHERE IT HANGS. lib/orchestrator/internal.ts EVENT_HANDLERS maps lead.created
 * here. The switch's LOCAL handleLeadCreated is the wiring in force for that type
 * (see that file's header — running both would hand one new lead two different
 * first touches), so this is RECORDED, not dispatched; it moved so the one entry
 * that names it reaches a body that CAN run unattended, instead of
 * app/actions/copilot.ts::generate7DayPlan — a "use server" export (a public
 * endpoint taking contact_id and user_id from the browser) on the COOKIE client,
 * whose agents lookup reads nothing from a cron.
 *
 * THE SHAPE (template lib/transactions/dotloop-document-sync.ts): server-only,
 * client-injected, the tenant is the EVENT row's brokerage_id. The contact must
 * be in it — a leads.id is NOT a contacts.id and tasks.contact_id FKs contacts,
 * so a lead id is refused here rather than FK-rejected seven times; the assignee
 * is the payload user's agents row IN the tenant (users.id and agents.id are
 * disjoint, §3). Leads belong to the brokerage (§5): this writes nothing for a
 * lead, only for a CONTACT an agent already holds. The insert and the contact
 * mark are both counted.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"

export type SevenDayPlanResult = { success: true; tasksCreated: number } | { success: false; error: string }

export async function writeSevenDayNurturePlan(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
  actorUserId: string | null | undefined,
): Promise<SevenDayPlanResult> {
  if (!brokerageId) return { success: false, error: "No brokerageId — a nurture plan is never written untenanted" }
  const contactId = payload?.contact_id
  const userId = payload?.user_id ?? actorUserId ?? null
  if (!contactId) return { success: false, error: "No contact_id on the event — a nurture plan needs a CONTACT (a lead is the brokerage's, §5)" }
  if (!userId) return { success: false, error: "No user on the event — nobody to assign the nurture plan to" }

  const { data: contact, error: cErr } = await svc
    .from("contacts").select("id").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  if (cErr) return { success: false, error: `Contact read refused: ${cErr.message}` }
  if (!contact) return { success: false, error: `Contact ${contactId} is not in brokerage ${brokerageId} — nurture plan not created` }

  const { data: agents, error: aErr } = await svc
    .from("agents").select("id").eq("user_id", userId).eq("brokerage_id", brokerageId).limit(1)
  if (aErr) return { success: false, error: `Agent lookup refused: ${aErr.message}` }
  const agentId = ((agents ?? [])[0]?.id as string | undefined) ?? null
  if (!agentId) return { success: false, error: "No agent profile for this user in this brokerage — nurture plan not created" }

  const name = payload?.contact_name || "new contact"
  const tasks = [
    { day: 0, title: `Welcome call to ${name}`, priority: "urgent" },
    { day: 1, title: "Send personalized property recommendations", priority: "high" },
    { day: 2, title: "Follow up on property interest", priority: "high" },
    { day: 3, title: "Send market update", priority: "medium" },
    { day: 4, title: "Check in - any questions?", priority: "medium" },
    { day: 5, title: "Share neighborhood guide", priority: "medium" },
    { day: 6, title: "Schedule next steps call", priority: "high" },
  ]
  const { data: created, error: taskErr } = await svc
    .from("tasks")
    .insert(tasks.map((t) => ({
      brokerage_id: brokerageId,
      contact_id: contactId,
      assigned_to_agent_id: agentId,
      title: t.title,
      due_date: new Date(Date.now() + t.day * 24 * 60 * 60 * 1000).toISOString(),
      priority: t.priority,
      auto_generated: true,
      source: "lead_nurture",
    })))
    .select("id")
  if (taskErr) return { success: false, error: `Nurture plan not created: ${taskErr.message}` }

  const { data: marked, error: statusErr } = await svc
    .from("contacts")
    .update({ nurture_status: "7_day_plan_active" })
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (statusErr) return { success: false, error: `Tasks created, but the contact was not marked: ${statusErr.message}` }
  if (!marked?.length) return { success: false, error: "Tasks created, but no contact matched the nurture mark in this brokerage" }

  // The number of rows that actually landed — never the template length.
  return { success: true, tasksCreated: created?.length ?? 0 }
}
