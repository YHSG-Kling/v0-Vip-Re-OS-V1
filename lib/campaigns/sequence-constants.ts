/**
 * Pure types + constants for campaign sequences. Lives outside the
 * "use server" action file (which only permits async-function exports).
 */

export interface CampaignSequence {
  id: string
  name: string
  description: string | null
  sequence_type: string
  trigger_event: string | null
  trigger_conditions: Record<string, unknown> | null
  is_active: boolean
  is_ab_test: boolean
  ab_test_split_pct: number | null
  compliance_gated: boolean
  enrollments_total: number
  completions_total: number
  conversions_total: number
  created_at: string
  updated_at: string
  brokerage_id: string
  created_by: string | null
  steps?: SequenceStep[]
}

export interface SequenceStep {
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
  ab_variant: string | null
  condition_field: string | null
  condition_operator: string | null
  condition_value: string | null
  video_template_id: string | null
  direct_mail_template_id: string | null
  personalization_tokens: Record<string, unknown> | null
  sent_count: number
  open_count: number
  click_count: number
  reply_count: number
  created_at: string
}

export interface SequenceEnrollment {
  id: string
  sequence_id: string
  contact_id: string | null
  lead_id: string | null
  status: string
  current_step: number
  enrolled_at: string
  completed_at: string | null
  converted_at: string | null
  next_step_at: string | null
  ab_variant: string | null
  contact?: { first_name: string | null; last_name: string | null; email: string | null }
}

export const VALID_STEP_TYPES = new Set([
  "email",
  "sms",
  "voice_drop",
  "in_app",
  "ai_call",
  "wait",
  "condition",
  "add_to_segment",
  "remove_from_segment",
  "remove_from_campaign",
  "ai_image",
  "video",
  "direct_mail",
  "newsletter",
  "social_post",
  "ad_campaign",
  "listing_landing_page",
  "avm_cma",
  "draft_document",
  "assign_task",
  "schedule_showing",
  "schedule_tour",
] as const)

export type ChannelType = typeof VALID_STEP_TYPES extends Set<infer T> ? T : never

export const MARKETING_SEQUENCE_TYPES = [
  "listing_launch",
  "price_reduction",
  "just_sold",
  "open_house",
  "ad_campaign",
] as const

export const NURTURE_SEQUENCE_TYPES = [
  "buyer_nurture",
  "seller_nurture",
  "lead_followup",
  "post_close",
  "sphere_touchpoint",
  "credit_journey",
] as const

export type SequenceCategory = "marketing" | "nurture"

/**
 * THE `campaign_sequences.sequence_type` VOCABULARY — one definition, two
 * former copies.
 *
 * These five values are exactly the live CHECK constraint on
 * `campaign_sequences.sequence_type` (scripts/check-vocabularies.ts:407 —
 * drip / nurture / post_close / re_engagement / transaction), so a picker built
 * from this list can only offer a value the column will accept, and a validator
 * built from it can only refuse a value the column would have refused anyway.
 *
 * MERGED FROM (§1.1, both byte-identical in their values):
 *   · app/dashboard/campaigns/sequences/SequencesListClient.tsx:74 — the create
 *     dialog's picker and the card's type badge.
 *   · app/actions/workflows.ts:317 — a function-local list guarding the drip
 *     drain. It stays a local IMPORT, never a re-export: that file is
 *     `"use server"`, where every export is a public HTTP endpoint (§4).
 *
 * NOT the same list as MARKETING_SEQUENCE_TYPES / NURTURE_SEQUENCE_TYPES above:
 * those two hold values (listing_launch, buyer_nurture, …) that the live CHECK
 * does not permit, so the `.in("sequence_type", …)` filters built from them in
 * app/actions/campaign-sequences.ts:71-73 cannot match a stored row. Recorded
 * here rather than reconciled — that is a query defect in another file, not a
 * spelling choice this constant can settle.
 */
export const SEQUENCE_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "drip",          label: "Drip" },
  { value: "nurture",       label: "Nurture" },
  { value: "re_engagement", label: "Re-engagement" },
  { value: "transaction",   label: "Transaction" },
  { value: "post_close",    label: "Post-Close" },
]

/**
 * A step as the builders hold it in state.
 *
 * The per-channel fields below are the ones named explicitly for convenience;
 * the index signature carries the rest of lib/workflow/step-palette.ts's field
 * specs (gift, e-sign, showing, tour, newsletter, listing-page, condition …).
 * saveSequenceSteps uses the PALETTE as its allow-list rather than a hand-kept
 * list of columns — which is what it used to do, and why a broker could fill in
 * an ad budget or a gift occasion and have it silently dropped on save.
 */
export interface SequenceBuilderStep {
  [field: string]: unknown
  id?: string
  step_number: number
  step_name: string
  step_type: ChannelType
  delay_days: number
  delay_hours: number
  subject?: string | null
  body: string
  is_active: boolean
  output_variable_name?: string | null
  image_prompt?: string | null
  image_style?: string | null
  image_aspect_ratio?: string | null
  video_script?: string | null
  video_voice_only?: boolean
  video_background_url?: string | null
  voice_drop_script?: string | null
  voice_drop_voice_id?: string | null
  social_platform?: string | null
  social_caption_prompt?: string | null
  task_assignee_type?: string | null
  task_title?: string | null
  task_due_offset_days?: number
  document_type?: string | null
  document_state?: string | null
  avm_data_source?: string | null
  avm_report_type?: string | null
  avm_include_investor_adj?: boolean
  ad_platform?: string | null
  ad_objective?: string | null
  direct_mail_piece_type?: string | null
  qr_attached?: boolean
  qr_target_url_pattern?: string | null
}
