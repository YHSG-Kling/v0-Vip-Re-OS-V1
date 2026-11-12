/**
 * SYSTEM 6.1 - Voice Authority Matrix
 * Defines which roles can execute which voice commands
 */

export const VOICE_AUTHORITY_MATRIX = {
  // CMA & Presentation Commands
  generate_cma: ['agent', 'team_lead'],
  generate_net_sheet: ['agent', 'team_lead'],
  generate_presentation: ['agent', 'team_lead'],

  // Listing Readiness Commands
  schedule_appointment: ['agent'],
  schedule_media: ['agent'],
  approve_media: ['agent', 'team_lead'],
  prepare_coming_soon: ['agent', 'team_lead'],
  activate_coming_soon: ['agent', 'team_lead'],

  // Market Exposure Commands
  submit_to_mls: ['agent', 'team_lead'],
  activate_mls: ['admin'],
  schedule_open_house: ['agent'],
  approve_open_house_marketing: ['agent', 'team_lead'],

  // Buyer Commands
  configure_buyer_search: ['agent'],
  lender_confirm_financials: ['vendor'], // Lender only
  // OWNER RULING (wave 5): "admin or agent can override the finiancing gate".
  // 'agent' is admitted HERE at the coarse role tier only. The fine-grained rule —
  // an agent may override ONLY for a contact they are the agent of record on, while
  // the admin/broker family keeps brokerage-wide reach — is enforced downstream in
  // lib/buyer-execution/multi-party-updates.ts:resolveFinancialGateOverrideAuthority,
  // which both the server action and the lib function consult. Widening this list
  // without that downstream rule would hand every agent in a brokerage the power to
  // lift any buyer's financing gate.
  admin_override_financial_gate: ['admin', 'broker', 'agent'],
  query_buyer_stage: ['agent', 'team_lead', 'admin', 'broker'],

  // Showing Commands
  schedule_showing: ['agent', 'buyer_agent'],
  cancel_showing: ['agent'],
  reschedule_showing: ['agent'],

  // Communication Commands
  send_agreement: ['agent', 'team_lead'],
  send_listing_to_contact: ['agent'],

  // Query Commands (read-only)
  query_listing_status: ['agent', 'team_lead', 'admin', 'broker'],
  query_showing_schedule: ['agent', 'team_lead'],
  query_mls_readiness: ['agent', 'team_lead', 'admin'],
  query_agreement_status: ['agent', 'team_lead', 'tc'],
  query_media_approval_status: ['agent', 'team_lead'],

  // Vendor Assignment
  assign_vendor: ['agent', 'team_lead'],

  // Transaction Coordination
  query_deal_health: ['agent', 'team_lead', 'tc'],
  query_pending_documents: ['agent', 'team_lead', 'tc']
} as const

export type VoiceCommandType = keyof typeof VOICE_AUTHORITY_MATRIX
export type AllowedRole = typeof VOICE_AUTHORITY_MATRIX[VoiceCommandType][number]
