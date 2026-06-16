/**
 * lib/workflow/channel-registry.ts
 *
 * Universal Channel Registry for Workflow OS.
 *
 * Every channel (email, sms, ai_image, video, voice_drop, social_post, etc.)
 * is a ChannelAdapter registered here. The step-executor calls
 * `registry.dispatch(channel, ctx)` — no more giant switch statement.
 *
 * Adapters are registered lazily at module load via `register()`.
 * The registry is a singleton; imports happen once per worker process.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

// ─── Step context ─────────────────────────────────────────────────────────────

export interface StepContext {
  /** Enrollment this step belongs to */
  enrollmentId: string
  /** Raw DB row from campaign_sequence_steps */
  step: StepRow
  /** Resolved contact record (null for non-contact enrollments) */
  contact: ContactRow | null
  /** Which table the recipient came from — "lead" enrollments load the leads row into `contact`
   *  (shape-compatible) and restrict to the approved pre-consent channels. Defaults to "contact". */
  entity?: "contact" | "lead"
  brokerageId: string
  /** Auth user ID of the agent who created the sequence */
  agentUserId: string | null
  /** agents.id of the assigned agent for this contact */
  agentId: string | null
  /** Fully-resolved variable map ({{contact.x}}, {{step1.image_url}}, etc.) */
  resolvedVars: Record<string, string>
  /** step_outputs from previous steps in this enrollment */
  previousOutputs: Record<string, Record<string, unknown>>
  /** Supabase service-role client (already instantiated by executor) */
  supabase: SupabaseClient
}

export interface ContactRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  mailing_address: string | null
  city: string | null
  state: string | null
  zip: string | null
  agent_id: string | null
  [key: string]: unknown
}

export interface StepRow {
  id: string
  sequence_id: string
  step_number: number
  step_name: string
  channel: string
  delay_days: number
  delay_hours: number
  subject: string | null
  body: string | null
  send_time: string | null
  is_active: boolean
  video_template_id: string | null
  direct_mail_template_id: string | null
  personalization_tokens: Record<string, unknown> | null
  // New Sprint A columns
  output_variable_name: string | null
  step_outputs_schema: Record<string, unknown> | null
  qr_attached: boolean
  qr_target_url_pattern: string | null
  qr_label: string | null
  image_prompt: string | null
  image_style: string | null
  image_aspect_ratio: string | null
  video_script: string | null
  video_voice_only: boolean
  video_avatar_enabled: boolean
  video_background_url: string | null
  video_broll_urls: string[] | null
  video_intro_url: string | null
  video_outro_url: string | null
  video_logo_url: string | null
  voice_drop_script: string | null
  voice_drop_voice_id: string | null
  newsletter_template_id: string | null
  newsletter_section_ids: string[] | null
  social_platform: string | null
  social_caption_prompt: string | null
  social_image_source: string | null
  task_assignee_type: string | null
  task_assignee_id: string | null
  task_title: string | null
  task_due_offset_days: number
  task_notes_prompt: string | null
  document_template_id: string | null
  document_type: string | null
  document_state: string | null
  showing_property_id: string | null
  showing_duration_minutes: number
  showing_notes: string | null
  tour_property_ids: string[] | null
  tour_date_offset_days: number
  tour_start_address: string | null
  ad_platform: string | null
  ad_objective: string | null
  ad_budget_cents: number | null
  ad_audience_prompt: string | null
  listing_page_template_id: string | null
  listing_page_slug: string | null
  avm_data_source: string | null
  avm_include_investor_adj: boolean
  avm_report_type: string | null
  direct_mail_piece_type: string | null
  [key: string]: unknown
}

// ─── Step result ──────────────────────────────────────────────────────────────

export type StepStatus =
  | "sent"
  | "skipped"
  | "authority_blocked"
  | "no_next_step"
  | "completed"
  | "error"
  | "failed"

export interface StepResult {
  status: StepStatus
  /** Provider routing key (e.g. "sendgrid", "twilio", "vapi", "d-id") */
  providerKey: string
  messageId?: string
  error?: string
  /**
   * Output values written into enrollment.step_outputs[output_variable_name].
   * Downstream steps can reference them as {{step_N.key}}.
   */
  output?: Record<string, unknown>
}

// ─── Channel adapter interface ────────────────────────────────────────────────

export interface ChannelAdapter {
  /** Canonical channel key — must match campaign_sequence_steps.channel values */
  readonly channel: string
  /**
   * Execute the step. The adapter must NOT advance the enrollment —
   * that is always the executor's responsibility after dispatch.
   */
  execute(ctx: StepContext): Promise<StepResult>
}

// ─── Registry ─────────────────────────────────────────────────────────────────

class WorkflowChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>()

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter)
  }

  has(channel: string): boolean {
    return this.adapters.has(channel)
  }

  async dispatch(channel: string, ctx: StepContext): Promise<StepResult> {
    const adapter = this.adapters.get(channel)
    if (!adapter) {
      return {
        status: "error",
        providerKey: channel,
        error: `No adapter registered for channel: ${channel}`,
      }
    }
    try {
      return await adapter.execute(ctx)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: "error",
        providerKey: channel,
        error: `[${channel}] Unhandled adapter error: ${msg}`,
      }
    }
  }

  registeredChannels(): string[] {
    return Array.from(this.adapters.keys())
  }
}

export const registry = new WorkflowChannelRegistry()
