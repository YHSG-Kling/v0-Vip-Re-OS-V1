/**
 * SYSTEM 6.1 - Voice Authority Matrix
 * Defines which roles can execute which voice commands
 */

export const VOICE_AUTHORITY_MATRIX = {
  // CMA & Presentation Commands
  generate_cma: ['agent', 'team_leader'],
  generate_net_sheet: ['agent', 'team_leader'],
  generate_presentation: ['agent', 'team_leader'],

  // Listing Readiness Commands
  schedule_appointment: ['agent'],
  schedule_media: ['agent'],
  approve_media: ['agent', 'team_leader'],
  prepare_coming_soon: ['agent', 'team_leader'],
  activate_coming_soon: ['agent', 'team_leader'],

  // Market Exposure Commands
  submit_to_mls: ['agent', 'team_leader'],
  activate_mls: ['admin'],
  schedule_open_house: ['agent'],
  approve_open_house_marketing: ['agent', 'team_leader'],

  // Buyer Commands
  configure_buyer_search: ['agent'],
  lender_confirm_financials: ['vendor'], // Lender only
  admin_override_financial_gate: ['admin', 'broker'],
  query_buyer_stage: ['agent', 'team_leader', 'admin', 'broker'],

  // Showing Commands
  schedule_showing: ['agent', 'buyer_agent'],
  cancel_showing: ['agent'],
  reschedule_showing: ['agent'],

  // Communication Commands
  send_agreement: ['agent', 'team_leader'],
  send_listing_to_contact: ['agent'],

  // Query Commands (read-only)
  query_listing_status: ['agent', 'team_leader', 'admin', 'broker'],
  query_showing_schedule: ['agent', 'team_leader'],
  query_mls_readiness: ['agent', 'team_leader', 'admin'],
  query_agreement_status: ['agent', 'team_leader', 'transaction_coordinator'],
  query_media_approval_status: ['agent', 'team_leader'],

  // Vendor Assignment
  assign_vendor: ['agent', 'team_leader'],

  // Transaction Coordination
  query_deal_health: ['agent', 'team_leader', 'transaction_coordinator'],
  query_pending_documents: ['agent', 'team_leader', 'transaction_coordinator']
} as const

export type VoiceCommandType = keyof typeof VOICE_AUTHORITY_MATRIX
export type AllowedRole = typeof VOICE_AUTHORITY_MATRIX[VoiceCommandType][number]
