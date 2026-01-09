const WORKFLOWS = {
  WF_AI_TOOL_EXECUTION: 'wf-ai-tool-execution',
  WF_CHECK_FAIR_HOUSING_COMPLIANCE: 'wf-check-fair-housing-compliance',
  WF_PROCESS_VOICE_COMMAND: 'wf-process-voice-command',
  WF_CALCULATE_LISTING_METRICS: 'wf-calculate-listing-metrics',
  TRIGGER_CMA_PACKAGE: 'trigger-cma-package',
  TRIGGER_PROPERTY_ENRICHMENT: 'trigger-property-enrichment',
  SEND_MESSAGE: 'send-message',
  GRANT_PORTAL_ACCESS: 'trigger-portal-access',
  TRIGGER_COMPLIANCE_CHECKLIST: 'trigger-compliance-checklist',
  TRIGGER_AUDIT_ARCHIVAL: 'trigger-audit-archival',
  TRIGGER_REVIEW_CAMPAIGN: 'trigger-review-campaign',
  LOG_NEGOTIATION_DECISION: 'log-negotiation-decision',
  SAVE_NETSHEET_SCENARIO: 'wf-seller-save-net-sheet',
  SAVE_MAP_TERRITORY: 'wf-map-save-territory',
  GENERATE_COPILOT_PLAN: 'wf-generate-7day-copilot-plan',
  UPDATE_PLAYBOOK_PROGRESS: 'update-playbook-progress',
  TRIGGER_CLIENT_ACTION: 'trigger-client-action',
  WF_RETRY_FAILED_WORKFLOW: 'wf-retry-failed-workflow'
};

export const n8nService = {
  async triggerWorkflow(workflowId: string, data: any) {
    console.log(`[N8N] Triggering Workflow: ${workflowId}`, data);
    
    // AI Tool Execution Simulation
    if (workflowId === WORKFLOWS.WF_AI_TOOL_EXECUTION) {
      await new Promise(r => setTimeout(r, 1500));
      return { 
        success: true, 
        output: `This is a high-performance synthesized result for ${data.toolName}. Our AI cluster has analyzed the context and generated this draft.`, 
        tokensUsed: 450 
      };
    }

    // Default simulation response
    return { 
      success: true, 
      isSimulation: true, 
      transcript: "Handled voice command: 'Log lead Sarah Johnson'", 
      actionTaken: "New lead 'Sarah Johnson' initialized in CRM funnel." 
    };
  },

  async executeAITool(toolName: string, inputData: any, context: any) {
    return this.triggerWorkflow(WORKFLOWS.WF_AI_TOOL_EXECUTION, { 
      toolName, 
      inputData, 
      context 
    });
  },

  async checkFairHousingCompliance(userId: string, contentType: string, text: string) {
    // Fixed typo: WF_CHECK_FAUSING_COMPLIANCE -> WF_CHECK_FAIR_HOUSING_COMPLIANCE
    return this.triggerWorkflow(WORKFLOWS.WF_CHECK_FAIR_HOUSING_COMPLIANCE, { 
      userId, 
      contentType, 
      text 
    });
  },

  async processVoiceCommand(userId: string, audioBase64: string) {
    return this.triggerWorkflow(WORKFLOWS.WF_PROCESS_VOICE_COMMAND, { 
      userId, 
      audioBase64 
    });
  },

  async calculateListingMetrics(listingId: string) {
    return this.triggerWorkflow(WORKFLOWS.WF_CALCULATE_LISTING_METRICS, { 
      listingId 
    });
  },

  async triggerCMAPackage(leadId: string | null, address: string, beds: string, baths: string, sqft: string, upgrades: any[]) {
      return { success: true, suggestedPrice: 850000 };
  },
  
  async triggerPropertyEnrichment(leadId: string | null, propertyAddress: string) {
      return { success: true, enrichedData: { propertyType: 'Single Family', bedrooms: 4, bathrooms: 3, sqft: 2500, lotSize: '0.25', yearBuilt: 2015 } };
  },
  
  async sendMessage(contactName: string, channel: string, text: string) { return this.triggerWorkflow(WORKFLOWS.SEND_MESSAGE, { contactName, channel, text }); },
  async grantPortalAccess(email: string, role: string, dealId: string, name: string) { return this.triggerWorkflow(WORKFLOWS.GRANT_PORTAL_ACCESS, { email, role, dealId, name }); },
  async triggerComplianceChecklist(dealId: string, details: any) { return this.triggerWorkflow(WORKFLOWS.TRIGGER_COMPLIANCE_CHECKLIST, { dealId, ...details }); },
  async triggerAuditArchival(dealId: string) { return this.triggerWorkflow(WORKFLOWS.TRIGGER_AUDIT_ARCHIVAL, { dealId }); },
  async triggerReviewCampaign(dealId: string, sentiment: string) { return this.triggerWorkflow(WORKFLOWS.TRIGGER_REVIEW_CAMPAIGN, { dealId, sentiment }); },
  async logNegotiationDecision(roundId: string, decision: string) { return this.triggerWorkflow(WORKFLOWS.LOG_NEGOTIATION_DECISION, { roundId, decision }); },
  async saveNetSheetScenario(listingId: string, scenario: any) { return this.triggerWorkflow(WORKFLOWS.SAVE_NETSHEET_SCENARIO, { listingId, scenario }); },
  async saveTerritory(name: string, lat: number, lng: number) { return this.triggerWorkflow(WORKFLOWS.SAVE_MAP_TERRITORY, { name, lat, lng }); },
  async generateCopilotPlan(contactId: string, agentId: string) { return { success: true }; },
  async updatePlaybookProgress(userId: string, stepId: string, status: string) { return this.triggerWorkflow(WORKFLOWS.UPDATE_PLAYBOOK_PROGRESS, { userId, stepId, status }); },
  async triggerClientAction(type: string, user: string, payload: any) { return this.triggerWorkflow(WORKFLOWS.TRIGGER_CLIENT_ACTION, { type, user, payload }); },
  
  async retryFailedWorkflow(errorId: string, workflowId: string, contextJson: string) {
    return this.triggerWorkflow(WORKFLOWS.WF_RETRY_FAILED_WORKFLOW, { errorId, originalWorkflowId: workflowId, originalContext: contextJson });
  },

  async startSmartDrip(leadId: string, type: string, agentId: string) { return this.triggerWorkflow('start-drip', { leadId, type, agentId }); },
  async startMotivatedBuyerDrip(leadId: string, agentId: string) { return this.triggerWorkflow('start-buyer-drip', { leadId, agentId }); },
  async approveAnniversaryDraft(id: string, draft: string) { return this.triggerWorkflow('approve-anniversary', { id, draft }); },
  async startWarmTransfer(id: string, p1: string, p2: string) { return this.triggerWorkflow('warm-transfer', { id, p1, p2 }); },
  async updateReminderLogic(config: any) { return this.triggerWorkflow('update-reminders', config); },
  async scheduleWalkthrough(id: string, date: string) { return this.triggerWorkflow('schedule-walkthrough', { id, date }); },
  async triggerUtilityConcierge(id: string, zip: string) { return this.triggerWorkflow('utility-concierge', { id, zip }); },
  async triggerAvailabilityProposal(id: string) { return this.triggerWorkflow('avail-proposal', { id }); },
  async triggerBriefingGeneration(id: string) { return this.triggerWorkflow('gen-briefing', { id }); },
  async brokerTakeover(id: string) { return this.triggerWorkflow('broker-takeover', { id }); },
  async syncToGHLPlanner(data: any) { return this.triggerWorkflow('ghl-sync', data); },
  async optimizeTourRoute(data: any) { return this.triggerWorkflow('optimize-route', data); },
  async approveAndSendTour(id: string) { return this.triggerWorkflow('approve-send-tour', { id }); },
  /**
   * Renamed from componentAndRetrainAI to fix missing property error
   */
  confirmAndRetrainAI(id: string) { return this.triggerWorkflow('retrain-ai', { id }); },
  async triggerWeeklyAIReview() { return this.triggerWorkflow('weekly-ai-review', {}); },
  async verifyVendorInsurance(url: string) { return { complianceScore: 100, expiration: '2025-01-01', coverageAmount: 1000000, isCompliant: true }; },
  async triggerScriptApprovedToVideo(scriptId: string, assetId: string) { return this.triggerWorkflow('script-to-video', { scriptId, assetId }); },
  async ingestListing(address: string) { return this.triggerWorkflow('ingest-listing', { address }); },
  async submitListingForApproval(data: any) { return this.triggerWorkflow('submit-approval', data); },
  async assignPlaybook(cid: string, key: string) { return this.triggerWorkflow('assign-playbook', { cid, key }); },
  async publishFeedbackToReport(id: string) { return this.triggerWorkflow('publish-feedback', { id }); },
  async updateFeedbackLogic(config: any) { return this.triggerWorkflow('update-feedback-logic', config); },
  async triggerLaunchOpenHouseBlitz(data: any) { return this.triggerWorkflow('launch-oh-blitz', data); },
  async executePayoutBatch(ids: string[]) { return this.triggerWorkflow('payout-batch', { ids }); },
  async autoFileDocument(file: File, dealId: string, email?: string) { return this.triggerWorkflow('auto-file', { dealId, email, fileName: file.name }); },
  async sendGift(clientId: string, giftId: string) { return this.triggerWorkflow('send-gift', { clientId, giftId }); },
  async requestReview(clientId: string, platform: string) { return this.triggerWorkflow('request-review', { clientId, platform }); },
  async submitOpenHouseLead(data: any) { return this.triggerWorkflow('submit-oh-lead', data); },
  
  async submitReferral(data: any) { return this.triggerWorkflow('submit-referral', data); },
  async finalizeShowingBooking(showingId: string, slotId: string) { return this.triggerWorkflow('finalize-showing', { showingId, slotId }); },
  async saveClientPrivateNote(showingId: string, note: string) { return this.triggerWorkflow('save-private-note', { showingId, note }); },
  async triggerLenderReferral(leadId: string, name: string, email: string, budget: number, context: string) {
    return this.triggerWorkflow('trigger-lender-referral', { leadId, name, email, budget, context });
  },
  async bookSlot(slot: string, user: string) { return this.triggerWorkflow('book-slot', { slot, user }); },
  async handleObjection(text: string) { 
    return { strategy: 'Interest Rate Buffer', script: "I hear you on rates. Many clients are using our 'Buy now, Refi later' program..." };
  },
  async escalateLowConfidence(user: string, query: string, response: string, confidence: number) {
    return this.triggerWorkflow('escalate-low-confidence', { user, query, response, confidence });
  },
  async checkAvailability() {
    return [{ start: 'Tomorrow, 10:00 AM' }, { start: 'Tomorrow, 2:00 PM' }];
  },
  async sendNewsletterCampaign(id: string) { return this.triggerWorkflow('send-newsletter', { id }); },
  async sendDirectMailCampaign(id: string) { return this.triggerWorkflow('send-direct-mail', { id }); },
  async repurposeLongFormVideo(id: string) { return this.triggerWorkflow('repurpose-video', { id }); }
};
