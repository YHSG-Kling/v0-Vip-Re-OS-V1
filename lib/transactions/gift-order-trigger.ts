import { createServiceClient } from "@/lib/supabase/service"

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
        status: 'pending',
        milestone_date: null
      })
  }

  // Create TC activity
  const { data: transaction } = await supabase
    .from("transactions")
    .select("agent_id")
    .eq("id", params.transactionId)
    .single()

  await supabase.from("activities").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    activity_type: 'tc.gift.order',
    title: 'Order Closing Gift',
    description: 'Financing conditional approval received. Order and coordinate closing gift for client.',
    priority: 'medium',
    assigned_to: params.userId, // TC who completed milestone
    due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    status: 'pending'
  })

  // Log lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type: 'transaction',
    entity_id: params.transactionId,
    event_type: 'transaction.gift.order_triggered',
    brokerage_id: params.brokerageId,
    actor_user_id: params.userId,
    metadata: {
      trigger_milestone: params.milestoneName,
      gift_milestone_status: 'pending'
    }
  })

  // Notify TC
  await supabase.from("notifications").insert({
    user_id: params.userId,
    notification_type: 'task_assigned',
    title: 'Order Closing Gift',
    message: 'Financing conditional approval received. Please order closing gift for client.',
    link: `/transactions/${params.transactionId}`,
    brokerage_id: params.brokerageId
  })

  return { triggered: true }
}
