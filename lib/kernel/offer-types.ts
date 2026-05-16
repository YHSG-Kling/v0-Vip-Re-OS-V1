/**
 * Pure type-only file. Client components must import OfferRow / KernelOfferResult
 * from here (not from lib/kernel/offers.ts) because the latter has top-level
 * side-effect imports (createServiceClient, etc.) that pull in server-only
 * modules through the AI chain. Mirrors the live `offers` table schema.
 */

export interface KernelOfferResult<T = unknown> {
  success: boolean
  error?:  string
  data?:   T
}

export interface OfferRow {
  id:                          string
  listing_id:                  string | null
  contact_id:                  string | null
  agent_id:                    string | null
  brokerage_id:                string | null
  offer_number:                string | null
  offer_price:                 number
  earnest_money:               number | null
  down_payment_percent:        number | null
  down_payment_amount:         number | null
  financing_type:              string | null
  closing_date:                string | null
  contingencies:               string[] | null
  buyer_notes:                 string | null
  notes:                       string | null
  status:                      string
  offer_type:                  string | null
  parent_offer_id:             string | null
  current_round:               number | null
  is_winning_offer:            boolean | null
  submitted_at:                string | null
  responded_at:                string | null
  response_deadline:           string | null
  seller_viewed_at:            string | null
  seller_net_estimate:         number | null
  ai_recommendation:           string | null
  ai_analysis:                 Record<string, unknown> | null
  ai_extraction_status:        string | null
  ai_extracted_data:           Record<string, unknown> | null
  offer_document_url:          string | null
  offer_document_name:         string | null
  esign_status:                string | null
  esign_sent_at:               string | null
  esign_completed_at:          string | null
  buyer_signed_at:             string | null
  esign_provider:              string | null
  transaction_id:              string | null
  property_address:            string | null
  strategy_recommendation_id:  string | null
  form_source:                 string | null
  escalation_clause:           boolean | null
  escalation_cap:              number | null
  appraisal_gap:               number | null
  closing_cost_contribution:   number | null
  due_diligence_fee:           number | null
  possession_terms:            string | null
  appraisal_contingency_days:  number | null
  financing_contingency_days:  number | null
  inspection_period_days:      number | null
  created_at:                  string
  updated_at:                  string | null
}
