/**
 * RLS POLICY SETUP GUIDE - CLOSING WORKFLOW
 * 
 * These are manual policies to set up in Supabase dashboard.
 * Location: Authentication > Policies
 */

export const CLOSING_RLS_POLICIES = {
  /**
   * TABLE: public.closing_disclosure
   * 
   * POLICY: Compliance Officer can CRUD
   * Target: SELECT, INSERT, UPDATE
   * Using: (SELECT user_type FROM users WHERE id = auth.uid()) = 'compliance_officer'
   * 
   * POLICY: Broker can CRUD
   * Target: SELECT, INSERT, UPDATE
   * Using: (SELECT user_type FROM users WHERE id = auth.uid()) = 'broker'
   * 
   * POLICY: Admin can CRUD + DELETE
   * Target: SELECT, INSERT, UPDATE, DELETE
   * Using: (SELECT user_type FROM users WHERE id = auth.uid()) = 'admin'
   * 
   * POLICY: Title Agent can CREATE
   * Target: INSERT
   * Using: (SELECT user_type FROM users WHERE id = auth.uid()) = 'title_agent'
   * 
   * POLICY: Agent can READ
   * Target: SELECT
   * Using: (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
   */
  closing_disclosure: {
    complianceOfficerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'compliance_officer'",
    brokerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'broker'",
    adminCRUDDelete: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'admin'",
    titleAgentCreate: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'title_agent'",
    agentRead: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'",
  },

  /**
   * TABLE: public.closing_disclosure_agreement
   * 
   * POLICY: Compliance Officer can CRUD
   * POLICY: Broker can CRUD
   * POLICY: Admin can CRUD + DELETE
   * POLICY: Agent can CREATE/READ/UPDATE own
   * POLICY: Title Agent can READ
   */
  closing_disclosure_agreement: {
    complianceOfficerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'compliance_officer'",
    brokerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'broker'",
    adminCRUDDelete: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'admin'",
    agentOwnCRUD: "agent_id = auth.uid() OR (SELECT user_type FROM users WHERE id = auth.uid()) IN ('compliance_officer', 'broker', 'admin')",
    titleAgentRead: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'title_agent'",
  },

  /**
   * TABLE: public.document_checklist
   * 
   * POLICY: Compliance Officer can CRUD
   * POLICY: Broker can CRUD
   * POLICY: Admin can CRUD
   * POLICY: Agent can READ/UPDATE
   */
  document_checklist: {
    complianceOfficerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'compliance_officer'",
    brokerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'broker'",
    adminCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'admin'",
    agentReadUpdate: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'agent' OR (SELECT user_type FROM users WHERE id = auth.uid()) IN ('compliance_officer', 'broker', 'admin')",
  },

  /**
   * TABLE: public.closing_notifications
   * 
   * POLICY: Compliance Officer can CRUD
   * POLICY: Broker can CRUD
   * POLICY: Admin can CRUD
   */
  closing_notifications: {
    complianceOfficerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'compliance_officer'",
    brokerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'broker'",
    adminCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'admin'",
  },

  /**
   * TABLE: public.cda_comparison_results
   * 
   * POLICY: Compliance Officer can CRUD
   * POLICY: Broker can CRUD
   * POLICY: Admin can CRUD
   * POLICY: Title Agent can READ
   * POLICY: Agent can READ own
   */
  cda_comparison_results: {
    complianceOfficerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'compliance_officer'",
    brokerCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'broker'",
    adminCRUD: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'admin'",
    titleAgentRead: "(SELECT user_type FROM users WHERE id = auth.uid()) = 'title_agent'",
    agentReadOwn: "EXISTS (SELECT 1 FROM closing_disclosure_agreement WHERE id = cda_comparison_results.cda_id AND agent_id = auth.uid())",
  },
};

export function getRLSPolicyForTable(table: string): object | null {
  return CLOSING_RLS_POLICIES[table as keyof typeof CLOSING_RLS_POLICIES] || null;
}
