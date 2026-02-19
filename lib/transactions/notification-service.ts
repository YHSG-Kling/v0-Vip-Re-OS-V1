import { createServiceClient } from "@/lib/supabase/service"

interface NotificationParams {
  transactionId: string
  brokerageId: string
  recipientIds: string[]
  eventType: string
  title: string
  message: string
  priority?: "low" | "medium" | "high" | "urgent"
  metadata?: Record<string, any>
}

export class NotificationService {
  private supabase = createServiceClient()

  async sendDualNotification(params: NotificationParams): Promise<void> {
    await Promise.all([
      this.sendInAppNotification(params),
      this.sendEmailNotification(params)
    ])
  }

  private async sendInAppNotification(params: NotificationParams): Promise<void> {
    const notifications = params.recipientIds.map(userId => ({
      user_id: userId,
      brokerage_id: params.brokerageId,
      transaction_id: params.transactionId,
      notification_type: params.eventType,
      title: params.title,
      message: params.message,
      priority: params.priority || "medium",
      read: false,
      metadata: params.metadata,
      created_at: new Date().toISOString()
    }))

    await this.supabase.from("notifications").insert(notifications)
  }

  private async sendEmailNotification(params: NotificationParams): Promise<void> {
    // Get recipient email addresses
    const { data: profiles } = await this.supabase
      .from("profiles")
      .select("id, email, full_name")
      .in("id", params.recipientIds)

    if (!profiles) return

    // Queue emails for each recipient
    for (const profile of profiles) {
      await this.supabase.from("email_queue").insert({
        to_email: profile.email,
        to_name: profile.full_name,
        subject: params.title,
        body: this.formatEmailBody(params.message, params.metadata),
        template: "transaction_notification",
        brokerage_id: params.brokerageId,
        metadata: {
          transaction_id: params.transactionId,
          event_type: params.eventType,
          ...params.metadata
        },
        status: "pending",
        created_at: new Date().toISOString()
      })
    }
  }

  private formatEmailBody(message: string, metadata?: Record<string, any>): string {
    let body = message

    if (metadata?.transaction_address) {
      body = `Property: ${metadata.transaction_address}\n\n${body}`
    }

    if (metadata?.action_required) {
      body += `\n\nAction Required: ${metadata.action_required}`
    }

    if (metadata?.deadline) {
      body += `\n\nDeadline: ${metadata.deadline}`
    }

    return body
  }

  async notifyStageChange(params: {
    transactionId: string
    brokerageId: string
    agentId: string
    tcId?: string
    newStage: string
    propertyAddress: string
  }): Promise<void> {
    const recipients = [params.agentId]
    if (params.tcId) recipients.push(params.tcId)

    await this.sendDualNotification({
      transactionId: params.transactionId,
      brokerageId: params.brokerageId,
      recipientIds: recipients,
      eventType: "transaction.stage.changed",
      title: `Transaction Stage Updated: ${params.newStage}`,
      message: `Transaction for ${params.propertyAddress} has moved to ${params.newStage}`,
      priority: "medium",
      metadata: { transaction_address: params.propertyAddress, new_stage: params.newStage }
    })
  }

  async notifyMilestoneOverdue(params: {
    transactionId: string
    brokerageId: string
    agentId: string
    tcId?: string
    brokerId?: string
    milestoneName: string
    propertyAddress: string
    isCritical: boolean
  }): Promise<void> {
    const recipients = [params.agentId]
    if (params.tcId) recipients.push(params.tcId)
    if (params.isCritical && params.brokerId) recipients.push(params.brokerId)

    await this.sendDualNotification({
      transactionId: params.transactionId,
      brokerageId: params.brokerageId,
      recipientIds: recipients,
      eventType: "transaction.milestone.overdue",
      title: `${params.isCritical ? "CRITICAL " : ""}Milestone Overdue`,
      message: `Milestone "${params.milestoneName}" is overdue for ${params.propertyAddress}`,
      priority: params.isCritical ? "urgent" : "high",
      metadata: { 
        transaction_address: params.propertyAddress,
        milestone_name: params.milestoneName,
        is_critical: params.isCritical
      }
    })
  }

  async notifyMilestoneWarning(params: {
    transactionId: string
    brokerageId: string
    agentId: string
    tcId?: string
    milestoneName: string
    propertyAddress: string
    dueDate: string
    hoursUntilDue: number
  }): Promise<void> {
    const recipients = [params.agentId]
    if (params.tcId) recipients.push(params.tcId)

    await this.sendDualNotification({
      transactionId: params.transactionId,
      brokerageId: params.brokerageId,
      recipientIds: recipients,
      eventType: "transaction.milestone.warning",
      title: "Milestone Due Soon",
      message: `Milestone "${params.milestoneName}" is due in ${params.hoursUntilDue} hours for ${params.propertyAddress}`,
      priority: "high",
      metadata: { 
        transaction_address: params.propertyAddress,
        milestone_name: params.milestoneName,
        due_date: params.dueDate
      }
    })
  }
}
