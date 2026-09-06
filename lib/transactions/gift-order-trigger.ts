import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

/**
 * Gift Order Trigger
 * Monitors for conditional approval milestone and triggers gift ordering workflow
 */
export async function checkAndTriggerGiftOrder(params: {
  transactionId: string
  brokerageId: string
  milestoneId: string
  milestoneName: string
  userId: string
}) {
  const supabase = createServiceClient()

  // Only trigger on conditional approval or clear to close received
  const giftTriggerMilestones = [
    'conditional_approval_received',
    'clear_to_close_received'
  ]

  if (!giftTriggerMilestones.includes(params.milestoneName)) {
    return { triggered: false }
  }

  // Check if gift already ordered
  const { data: existingGift } = await supabase
    .from("transaction_milestones")
    .select("id, status")
    .eq("transaction_id", params.transactionId)
    .eq("milestone_name", "gift_ordered")
    .maybeSingle()

  if (existingGift && existingGift.status === 'completed') {
    return { triggered: false, reason: 'Gift already ordered' }
  }

  // Create or update gift_ordered milestone
  if (existingGift) {
    await supabase
      .from("transaction_milestones")
      .update({ status: 'pending' })
      .eq("id", existingGift.id)
  } else {
    await supabase
      .from("transaction_milestones")
      .insert({
        transaction_id: params.transactionId,
        brokerage_id: params.brokerageId,
        milestone_name: 'gift_ordered',
        milestone_type: 'gift_ordered',   // canonical identity (internal milestone)
        is_client_visible: false,
        status: 'pending',
        target_date: null
      })
  }

  // Create TC activity — Agent task (correct location, no changes) — activity_type: tc.gift.order
  const { data: transaction } = await supabase
    .from("transactions")
    .select("agent_id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .single()

  // THIS ROW IS THE TC TASK — nothing else asks anyone to order the gift.
  const { error: giftTaskActivityError } = await supabase.from("activities").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    // transactions.agent_id IS an agents.id; params.userId is a users.id (it is
    // written to user_id below), so the old fallback was the wrong class.
    agent_id: transaction?.agent_id || (await resolveAgentId(supabase, params.userId)),
    activity_type: 'tc.gift.order',
    title: 'Order Closing Gift',
    description: 'Financing conditional approval received. Order and coordinate closing gift for client.',
    priority: 'medium',
    scheduled_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    status: 'pending',
    metadata: { assigned_to: params.userId }, // TC who completed milestone
  })
  if (giftTaskActivityError) {
    console.error("[gift-order-trigger] tc.gift.order activity REJECTED — no one was asked to order the closing gift:", giftTaskActivityError.message)
  }

  // Log lifecycle event via kernel
  await transitionLifecycle({
    brokerageId: params.brokerageId,
    entityType:  "transaction",
    entityId:    params.transactionId,
    fromState:   "active",
    toState:     "gift_order_triggered",
    actorUserId: params.userId,
    actorRole:   "tc",
    eventType:   "gift.order_triggered",
    metadata:    { trigger_milestone: params.milestoneName, gift_milestone_status: "pending" },
  })

  // Notify TC
  // Real notifications shape (type/body/entity_*; no notification_type/message/link
  // columns — the phantom insert failed silently and the TC was never notified).
  await supabase.from("notifications").insert({
    user_id: params.userId,
    type: 'task_assigned',
    title: 'Order Closing Gift',
    body: 'Financing conditional approval received. Please order closing gift for client.',
    entity_type: 'transaction',
    entity_id: params.transactionId,
    brokerage_id: params.brokerageId
  })

  return { triggered: true }
}
