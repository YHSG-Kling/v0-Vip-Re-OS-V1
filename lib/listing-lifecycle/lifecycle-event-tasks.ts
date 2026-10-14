/**
 * lib/listing-lifecycle/lifecycle-event-tasks.ts — THE listing/transaction
 * lifecycle EVENT reactions, callable with no session (lane 86F, wave 86).
 *
 * WHAT THEY ARE. The orchestrator's EVENT_HANDLERS (lib/orchestrator/internal.ts)
 * answer listing.price_reduction / listing.offer_received /
 * transaction.contingency_cleared / transaction.close_approaching /
 * transaction.closing_soon / transaction.closed by seeding the listing agent's
 * task list, scheduling the closing gift, or queueing the post-close review asks.
 *
 * THE DEFECT. Those invokers reached app/actions/listing-lifecycle.ts's "use
 * server" wrappers, which delegated to lib/application/listing-lifecycle.ts's
 * handle*Service functions — each of which built the COOKIE client as its first
 * line. The orchestrator is dispatched from emitEventFromCron and from
 * logEventAndTrigger's registered dispatcher (webhooks: dotloop; zapier until wave 87) with no
 * cookie, so the listings read came back empty under RLS and every reaction
 * answered "Listing has no agent/brokerage — tasks not created" — a correct
 * listing reported as a broken one. scheduleClosingGift went further: its
 * callerBrokerageId() read auth.getUser() and refused "Not authenticated" on
 * every dispatch. Hidden from the census by its stated blind spot (a cross-file
 * callee is not followed), which is why scripts/sessionless-use-server-census.ts
 * now pins these cores in its HUB section.
 *
 * THE SHAPE (template lib/transactions/dotloop-document-sync.ts): server-only,
 * client-injected, and the tenant is the EVENT ROW's brokerage_id — a
 * lifecycle_events row this system wrote with a verified tenant. Every read and
 * write carries `.eq("brokerage_id", brokerageId)`; a listing or contact the
 * payload names outside that tenant is refused, never acted on. Bodies moved
 * UNCHANGED in what they write, with two tenant stamps they lacked:
 * review_requests.brokerage_id and closing_gifts.brokerage_id (both live
 * columns, scripts/schema-snapshot.ts) — an unstamped row is invisible to every
 * tenant-scoped reader (sendReviewRequest refuses an untenanted request outright).
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"

export type LifecycleTaskResult = { success: boolean; inserted?: number; error?: string }

/** The listing's own agent is the honest assignee (tasks.assigned_to_agent_id FKs
 *  agents(id); listings.agent_id is agents-class). Tenant-pinned. */
async function listingTaskContext(
  svc: any,
  brokerageId: string,
  listingId: string | null | undefined,
): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
  if (!listingId) return { ok: false, error: "No listing_id on the event payload — no listing to seed tasks for" }
  const { data, error } = await svc
    .from("listings")
    .select("id, agent_id")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  // A refused read is not "this listing has no agent" (§3).
  if (error) return { ok: false, error: `Listing read refused: ${error.message}` }
  if (!data) return { ok: false, error: `Listing ${listingId} is not in brokerage ${brokerageId}` }
  if (!data.agent_id) return { ok: false, error: `Listing ${listingId} has no agent — tasks not created` }
  return { ok: true, agentId: data.agent_id as string }
}

/** THE WRITER OWNS THE TENANT STAMP, and COUNTS what landed. */
async function insertListingTasks(
  svc: any,
  brokerageId: string,
  rows: Record<string, unknown>[],
): Promise<LifecycleTaskResult> {
  let inserted = 0
  const failures: string[] = []
  for (const row of rows) {
    const { data, error } = await svc.from("tasks").insert({ ...row, brokerage_id: brokerageId }).select("id").maybeSingle()
    if (error || !data) {
      failures.push(`${String(row.title ?? "task")}: ${error?.message ?? "no row returned"}`)
    } else {
      inserted += 1
    }
  }
  if (failures.length > 0) {
    return { success: false, inserted, error: `${failures.length} of ${rows.length} tasks were refused — ${failures.join("; ")}` }
  }
  return { success: true, inserted }
}

const dueIn = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()

async function seedListingTasks(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
  tasks: Array<{ title: string; dueDays: number; priority: string }>,
  extra: Record<string, unknown> = {},
): Promise<LifecycleTaskResult> {
  if (!brokerageId) return { success: false, error: "No brokerageId — lifecycle tasks are never written untenanted" }
  const ctx = await listingTaskContext(svc, brokerageId, payload?.listing_id)
  if (!ctx.ok) return { success: false, error: ctx.error }
  return insertListingTasks(svc, brokerageId, tasks.map((t) => ({
    assigned_to_agent_id: ctx.agentId,
    listing_id: payload.listing_id,
    title: t.title,
    due_date: dueIn(t.dueDays),
    priority: t.priority,
    auto_generated: true,
    ...extra,
  })))
}

/** listing.appointment_set — recorded in EVENT_HANDLERS; the switch's local handler is in force. */
export function appointmentBookedTasks(svc: any, brokerageId: string, payload: Record<string, any>) {
  return seedListingTasks(svc, brokerageId, payload, [
    { title: "Prepare CMA for consultation", dueDays: 1, priority: "high" },
    { title: "Research comparable sales", dueDays: 1, priority: "high" },
    { title: "Review property info", dueDays: 0, priority: "urgent" },
  ], { contact_id: payload?.contact_id ?? null })
}

/** listing.signed — recorded in EVENT_HANDLERS; the switch's local handler is in force. */
export function agreementSignedTasks(svc: any, brokerageId: string, payload: Record<string, any>) {
  return seedListingTasks(svc, brokerageId, payload, [
    { title: "Order professional photography", dueDays: 1, priority: "high" },
    { title: "Write compelling listing description", dueDays: 2, priority: "high" },
    { title: "Set up lockbox", dueDays: 3, priority: "high" },
    { title: "Input listing into MLS", dueDays: 3, priority: "high" },
    { title: "Create marketing materials", dueDays: 2, priority: "high" },
  ])
}

/** listing.live — recorded in EVENT_HANDLERS; the switch's local handler is in force. */
export function listingLiveTasks(svc: any, brokerageId: string, payload: Record<string, any>) {
  return seedListingTasks(svc, brokerageId, payload, [
    { title: "Share on social media", dueDays: 0, priority: "urgent" },
    { title: "Send to sphere of influence", dueDays: 1, priority: "high" },
    { title: "Schedule first open house", dueDays: 3, priority: "high" },
    { title: "Create video tour", dueDays: 2, priority: "high" },
  ])
}

/** listing.price_reduction — DISPATCHED. */
export function priceReductionTasks(svc: any, brokerageId: string, payload: Record<string, any>) {
  return seedListingTasks(svc, brokerageId, payload, [
    { title: "Update all marketing with new price", dueDays: 0, priority: "urgent" },
  ])
}

/** listing.offer_received — DISPATCHED. */
export function offerReceivedTasks(svc: any, brokerageId: string, payload: Record<string, any>) {
  const amount = Number(payload?.offer_amount) || 0
  return seedListingTasks(svc, brokerageId, payload, [
    { title: `Review offer from ${payload?.buyer_name || "buyer"} - $${amount.toLocaleString()}`, dueDays: 0, priority: "urgent" },
  ])
}

/** transaction.contingency_cleared — DISPATCHED. */
export function contingencyClearedTasks(svc: any, brokerageId: string, payload: Record<string, any>) {
  return seedListingTasks(svc, brokerageId, payload, [
    { title: `${payload?.contingency_type ?? "A"} contingency cleared - update transaction status`, dueDays: 0, priority: "high" },
  ])
}

/** transaction.close_approaching — DISPATCHED. */
export function closingApproachingTasks(svc: any, brokerageId: string, payload: Record<string, any>) {
  return seedListingTasks(svc, brokerageId, payload, [
    { title: "Confirm final walkthrough scheduled", dueDays: 0, priority: "urgent" },
    { title: "Verify closing disclosure sent", dueDays: 0, priority: "urgent" },
    { title: "Confirm wire instructions with title", dueDays: 1, priority: "urgent" },
  ])
}

/**
 * transaction.closed — DISPATCHED. Queues one review ask per platform for the
 * contact (review_requests is contact-keyed, one row per platform; status is
 * CHECK-constrained). The contact must be in the event's tenant, and the row is
 * STAMPED with it — sendReviewRequest refuses a request whose brokerage_id does
 * not match the caller's, so an unstamped row could never be sent.
 */
export async function scheduleReviewRequests(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
): Promise<LifecycleTaskResult> {
  if (!brokerageId) return { success: false, error: "No brokerageId — review requests are never written untenanted" }
  const contactId = payload?.contact_id
  if (!contactId) return { success: false, error: "No contact_id on the transaction.closed payload — nobody to ask for a review" }
  const { data: contact, error: cErr } = await svc
    .from("contacts").select("id").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  if (cErr) return { success: false, error: `Contact read refused: ${cErr.message}` }
  if (!contact) return { success: false, error: `Contact ${contactId} is not in brokerage ${brokerageId}` }

  const platforms = ["google", "zillow", "facebook"]
  const failures: string[] = []
  let inserted = 0
  for (const platform of platforms) {
    const { data, error } = await svc
      .from("review_requests")
      .insert({ brokerage_id: brokerageId, contact_id: contactId, platform, status: "scheduled" })
      .select("id")
      .maybeSingle()
    if (error || !data) failures.push(`${platform}: ${error?.message ?? "no row returned"}`)
    else inserted += 1
  }
  if (failures.length > 0) {
    return { success: false, inserted, error: `${failures.length} of ${platforms.length} review requests were refused — ${failures.join("; ")}` }
  }
  return { success: true, inserted }
}

/**
 * transaction.closing_soon — DISPATCHED. One closing gift a week before the
 * listing's estimated close. closing_gifts.agent_id is carried as the listing's
 * agents.id (listings.agent_id is agents-class; not re-labelled as a user).
 */
export async function scheduleClosingGiftForListing(
  svc: any,
  brokerageId: string,
  listingId: string | null | undefined,
): Promise<LifecycleTaskResult> {
  if (!brokerageId) return { success: false, error: "No brokerageId — a closing gift is never scheduled untenanted" }
  if (!listingId) return { success: false, error: "No listingId on the transaction.closing_soon payload — scheduleClosingGift needs one (payload key: listing_id)" }
  const { data: listing, error: listingError } = await svc
    .from("listings")
    .select("estimated_close_date, seller_contact_id, agent_id")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  // A refused read is not "no close date" (§3).
  if (listingError) return { success: false, error: `Listing read refused: ${listingError.message}` }
  if (!listing) return { success: false, error: `Listing ${listingId} is not in brokerage ${brokerageId}` }
  if (!listing.estimated_close_date) {
    return { success: false, error: "Listing has no estimated close date — no gift scheduled" }
  }

  const closeDate = new Date(listing.estimated_close_date)
  const orderDate = new Date(closeDate.getTime() - 7 * 24 * 60 * 60 * 1000)
  const { data, error: giftError } = await svc.from("closing_gifts").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    contact_id: listing.seller_contact_id,
    agent_id: listing.agent_id,
    gift_description: "Closing gift basket",
    price_cents: 7500,
    order_date: orderDate.toISOString(),
    delivery_date: closeDate.toISOString(),
    status: "scheduled",
  }).select("id").maybeSingle()
  if (giftError || !data) return { success: false, error: `closing_gifts insert refused: ${giftError?.message ?? "no row returned"}` }
  return { success: true, inserted: 1 }
}
