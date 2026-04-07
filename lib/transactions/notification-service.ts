import { createServiceClient } from "@/lib/supabase/service"
import { dispatchSms } from "@/lib/providers/dispatch"

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

type NotificationChannel = "in_app" | "email" | "sms" | "push"

export class NotificationService {
  private supabase = createServiceClient()

  /**
   * Send notifications via all enabled channels: in-app, email, SMS (if phone + consent), push (if global setting enabled)
   * Logs every send attempt to notification_log regardless of success/failure
   */
  async sendMultiChannelNotification(params: NotificationParams): Promise<void> {
    // Check global push setting
    const { data: settings } = await this.supabase
      .from("global_settings")
      .select("push_notifications_enabled, sms_notifications_enabled")
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()

    const pushEnabled = settings?.push_notifications_enabled ?? false
    const smsEnabled  = settings?.sms_notifications_enabled ?? true

    // Get recipient profiles for SMS eligibility (phone + consent)
    const { data: profiles } = await this.supabase
      .from("users")
      .select("id, email, full_name, phone, communication_preferences")
      .in("id", params.recipientIds)

    // Send in-app — log every attempt
    try {
      await this.sendInAppNotification(params)
      await this.logNotification(params, "in_app", true)
    } catch (err) {
      await this.logNotification(params, "in_app", false, err instanceof Error ? err.message : "Unknown error")
    }

    // Send email — log every attempt
    try {
      await this.sendEmailNotification(params, profiles ?? [])
      await this.logNotification(params, "email", true)
    } catch (err) {
      await this.logNotification(params, "email", false, err instanceof Error ? err.message : "Unknown error")
    }

    // Send SMS if enabled — uses existing provider path via dispatchSms
    // Log every send attempt regardless of success/failure
    if (smsEnabled && profiles) {
      for (const profile of profiles) {
        const hasPhone   = !!profile.phone
        const prefs      = (profile.communication_preferences ?? {}) as Record<string, any>
        const hasConsent = prefs.sms_consent === true || prefs.sms_opt_in === true

        if (hasPhone && hasConsent) {
          try {
            const result = await this.sendSmsNotification({
              ...params,
              recipientIds: [profile.id],
              phone: profile.phone!,
            })
            await this.logNotification(
              { ...params, recipientIds: [profile.id] },
              "sms",
              result.success,
              result.error
            )
          } catch (err) {
            await this.logNotification(
              { ...params, recipientIds: [profile.id] },
              "sms",
              false,
              err instanceof Error ? err.message : "Unknown error"
            )
          }
        }
      }
    }

    // Send push if global setting enabled — log every attempt
    if (pushEnabled) {
      try {
        await this.sendPushNotification(params)
        await this.logNotification(params, "push", true)
      } catch (err) {
        await this.logNotification(params, "push", false, err instanceof Error ? err.message : "Unknown error")
      }
    }
  }

  /**
   * Legacy dual notification method (in-app + email only) — kept for backwards compatibility
   */
  async sendDualNotification(params: NotificationParams): Promise<void> {
    await Promise.all([
      this.sendInAppNotification(params),
      this.sendEmailNotification(params)
    ])
    await this.logNotification(params, "in_app", true)
    await this.logNotification(params, "email", true)
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

  private async sendEmailNotification(
    params: NotificationParams,
    profiles?: Array<{ id: string; email: string; full_name: string | null }>
  ): Promise<void> {
    // Get recipient email addresses if not provided
    let recipientProfiles = profiles
    if (!recipientProfiles) {
      const { data } = await this.supabase
        .from("users")
        .select("id, email, full_name")
        .in("id", params.recipientIds)
      recipientProfiles = data ?? []
    }

    if (!recipientProfiles.length) return

    // Queue emails for each recipient
    for (const profile of recipientProfiles) {
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

  /**
   * Send SMS via existing provider path (dispatchSms -> Twilio)
   * Returns result for logging success/failure
   */
  private async sendSmsNotification(params: NotificationParams & { phone: string }): Promise<{ success: boolean; error?: string }> {
    const smsMessage = `${params.title}\n${params.message}`

    // SMS sent through existing provider path: dispatchSms -> lib/providers/messaging -> Twilio
    const result = await dispatchSms({
      brokerageId: params.brokerageId,
      to: params.phone,
      message: smsMessage.slice(0, 1600), // SMS segment limit
      systemSource: "transaction_notification",
      metadata: {
        transaction_id: params.transactionId,
        event_type: params.eventType,
        ...params.metadata,
      },
    })

    return { success: result.success, error: result.error }
  }

  private async sendPushNotification(params: NotificationParams): Promise<void> {
    // Push notifications via existing push_notification_queue table
    // Only sends if push_notifications_enabled is true (checked by caller)
    const pushPayloads = params.recipientIds.map(userId => ({
      user_id: userId,
      brokerage_id: params.brokerageId,
      title: params.title,
      body: params.message,
      data: {
        transaction_id: params.transactionId,
        event_type: params.eventType,
        ...params.metadata,
      },
      status: "pending",
      created_at: new Date().toISOString(),
    }))

    await (async () => {
      try {
        await this.supabase.from("push_notification_queue").insert(pushPayloads)
      } catch (err: unknown) {
        // Table may not exist yet — fail silently
      }
    })()
  }

  /**
   * Log every notification send attempt to notification_log for audit and analytics
   * Uses existing notification_log table (brokerage_id, delivery_channel, status, response)
   */
  private async logNotification(
    params: NotificationParams,
    channel: NotificationChannel,
    success: boolean,
    errorMessage?: string
  ): Promise<void> {
    // notification_log schema: brokerage_id, delivery_channel, status, response, created_at
    const logEntries = params.recipientIds.map(() => ({
      brokerage_id: params.brokerageId,
      delivery_channel: channel,
      status: success ? "sent" : "failed",
      response: {
        transaction_id: params.transactionId,
        event_type: params.eventType,
        title: params.title,
        message: params.message,
        priority: params.priority || "medium",
        error_message: errorMessage ?? null,
        metadata: params.metadata ?? null,
      },
      created_at: new Date().toISOString(),
    }))

    await (async () => {
      try {
        await this.supabase.from("notification_log").insert(logEntries)
      } catch (err: unknown) {
        // Log failure silently to avoid blocking notifications
      }
    })()
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

    await this.sendMultiChannelNotification({
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

    await this.sendMultiChannelNotification({
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

    await this.sendMultiChannelNotification({
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
