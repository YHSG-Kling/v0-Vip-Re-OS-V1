# Airtable to Supabase Migration Guide

This document describes the complete migration from Airtable + n8n to Supabase + Server Actions.

## Overview

The migration includes:
1. **Database**: Airtable → Supabase PostgreSQL (40+ tables)
2. **Services**: airtableService → supabaseService (80+ CRUD methods)
3. **Workflows**: n8n simulations → Real Server Actions with AI
4. **API Routes**: Updated to use supabaseService
5. **Components**: Updated to use workflowService

## Database Schema

### Created Tables (40+)

All tables have been created in `scripts/001_create_supabase_schema.sql`:

- **Core**: contacts, users, agents
- **Transactions**: transactions, listings, vendors
- **Journey**: journey_states, journey_blueprints, journey_tools
- **Transparency**: transparency_updates, transparency_videos
- **Plans**: copilot_plans, plan_tasks
- **Video**: video_engagement, video_engagement_events, video_assets
- **Credit**: credit_status, credit_partner_referrals
- **Interaction**: interaction_history, property_interests
- **Compliance**: compliance_flags
- **Financial**: commissions, business_expenses, marketing_stats
- **AI**: ai_tool_usage, saved_ai_outputs, smart_assistant_suggestions
- **Content**: scripts, content_ideas, keywords, long_form_videos
- **Marketing**: newsletter_campaigns, direct_mail_campaigns
- **Deal Management**: deal_team_members, ai_isa_activities, transaction_milestones
- **Documents**: client_documents
- **Listing Analytics**: listing_metrics, listing_engagement
- **Admin**: automation_errors, user_activity, portal_users

### Key Features

- UUID primary keys
- Proper foreign key relationships
- Timestamp columns (created_at, updated_at, deleted_at)
- JSONB fields for flexible metadata
- Indexes on commonly queried fields

## Services Migration

### supabaseService (services/supabaseService.ts)

Replaces `airtableService` with 80+ methods including:

**Contacts**: getContacts, getContactById, createContact, updateContact, deleteContact
**Transactions**: getTransactions, createTransaction, updateTransaction
**Listings**: getListings, createListing, updateListing
**Users/Agents**: getUsers, getAgents, createUser, updateUser
**Vendors**: getVendors, createVendor
**Copilot**: getCopilotPlans, createCopilotPlan, getPlanTasks, updatePlanTask
**Video**: getVideoEngagement, logVideoEngagement, getVideoAssets, createVideoAsset
**Credit**: getCreditStatus, updateCreditStatus, getCreditReferrals, createCreditReferral
**Journey**: getJourneyStateByUserId, createJourneyState, updateJourneyState, getBlueprintByPersonaStage
**Transparency**: getUpdatesByContactId, getTransparencyVideos
**Scripts**: getScripts, createScript, updateScript, deleteScript
**Content**: getContentIdeas, getKeywords, getLongFormVideos
**Marketing**: getNewsletterCampaigns, createNewsletterCampaign, getDirectMailCampaigns, createDirectMailCampaign
**Compliance**: getComplianceFlags, updateComplianceFlag
**Financial**: getCommissions, getBusinessExpenses, createBusinessExpense, getMarketingStats
**AI Tools**: logAIToolUsage, saveAIOutput, getSuggestions, updateSuggestionStatus
**Deal Team**: getDealTeamMembers, getAIISAActivities
**Documents**: getClientDocuments, getTransactionMilestones
**Listing Analytics**: getListingMetrics, getListingEngagement
**Admin**: getAutomationErrors, updateAutomationError, logUserActivity
**Generic**: createRecord, updateRecord, getRecordsByField

### workflowService (services/workflowService.ts)

Replaces `n8nService` with real Server Actions:

**AI Workflows**:
- executeAITool: Generate content using AI SDK
- checkFairHousingCompliance: AI-powered compliance checking

**Lead Management**:
- generateCopilotPlan: AI-generated 7-day action plans
- startSmartDrip: Drip campaign management

**Communication**:
- sendMessage: Multi-channel messaging

**Listings**:
- calculateListingMetrics: Real-time analytics
- triggerCMAPackage: AI-powered market analysis

**Transactions**:
- grantPortalAccess: Portal user management
- triggerComplianceChecklist: Automated checklists

**Content & Marketing**:
- generateScriptContent: AI script generation
- sendNewsletterCampaign: Campaign management

**Utilities**:
- retryFailedWorkflow: Error handling and retry logic
- logUserActivity: Activity tracking

## API Routes Updated

The following API routes now use supabaseService:

- `/api/leads/list` - List all leads
- `/api/transactions/list` - List transactions
- `/api/transactions/[id]` - Get/update transaction
- `/api/listings/list` - List listings
- `/api/listings/create` - Create listing
- `/api/vendors/list` - List vendors
- `/api/compliance/flags` - Get/update compliance flags
- `/api/scripts/list` - List scripts
- `/api/scripts/create` - Create script
- `/api/financial/commissions` - Get commissions
- `/api/financial/expenses` - Get/create expenses
- `/api/copilot/plans` - Get copilot plans (already migrated)

## Components Updated

The following components now use supabaseService and workflowService:

- `components/Dashboard/DailyGameplan.tsx` - Uses workflowService
- `components/TransparencyFeed.tsx` - Uses supabaseService
- `components/JourneyCardsRenderer.tsx` - Uses supabaseService
- `components/AI/AIToolModal.tsx` - Uses workflowService
- `components/AI/ComplianceCheckedTextArea.tsx` - Uses workflowService
- `components/PersonaTools.tsx` - Uses supabaseService

## Environment Variables Required

\`\`\`env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# AI (for workflows)
# AI Gateway is used by default, no API keys needed for OpenAI, Anthropic, etc.
\`\`\`

## Running the Migration

### 1. Set up Supabase Project

1. Create a new Supabase project at https://supabase.com
2. Copy your project URL and service role key
3. Add them to your environment variables

### 2. Run Database Schema Script

Execute the SQL script to create all tables:

\`\`\`bash
# In the v0 interface, run the script:
scripts/001_create_supabase_schema.sql
\`\`\`

Or manually in Supabase SQL Editor.

### 3. Update Environment Variables

Add Supabase credentials to your project:
- Go to the Vars section in the v0 sidebar
- Add NEXT_PUBLIC_SUPABASE_URL
- Add SUPABASE_SERVICE_ROLE_KEY

### 4. Test the Migration

1. Start your development server
2. Test key workflows:
   - Lead list fetching
   - AI tool execution
   - Compliance checking
   - Script generation
3. Verify data is being written to Supabase

## Key Differences

### Data Structure

**Airtable**: Record-based with `fields` object
\`\`\`javascript
{ id: "rec123", fields: { name: "John", email: "john@example.com" } }
\`\`\`

**Supabase**: Direct row-based
\`\`\`javascript
{ id: "uuid", name: "John", email: "john@example.com", created_at: "2024-01-01T00:00:00Z" }
\`\`\`

### Workflows

**n8n**: Simulated workflows
\`\`\`javascript
await n8nService.triggerWorkflow("wf-ai-tool", { data })
// Returns mock response
\`\`\`

**Server Actions**: Real execution
\`\`\`javascript
await workflowService.executeAITool(toolName, inputData, context)
// Actually calls AI SDK and logs to database
\`\`\`

### Relationships

**Airtable**: Array of record IDs
\`\`\`javascript
{ agent_id: ["recXYZ"] }
\`\`\`

**Supabase**: Foreign key UUIDs
\`\`\`javascript
{ agent_id: "uuid-xyz" }
\`\`\`

## Benefits of Migration

1. **Real Database**: PostgreSQL with proper relationships, indexes, and constraints
2. **Type Safety**: Full TypeScript support with proper interfaces
3. **Real Workflows**: Actual AI execution, not simulations
4. **Better Performance**: Direct database queries vs API calls
5. **Cost Effective**: Supabase free tier vs Airtable limits
6. **Scalability**: Can handle millions of records
7. **Security**: Row Level Security policies (can be added)
8. **Backup**: Built-in daily backups
9. **Real-time**: Can add real-time subscriptions
10. **Open Source**: PostgreSQL is open source

## Remaining Work

To complete the migration:

1. **Data Import**: Migrate existing Airtable data to Supabase (if any)
2. **RLS Policies**: Add Row Level Security for multi-tenant support
3. **Indexes**: Add additional indexes based on query patterns
4. **Real Integrations**: Connect real email/SMS services (Twilio, SendGrid)
5. **Error Handling**: Enhance error recovery and retry logic
6. **Testing**: Add comprehensive tests for all workflows
7. **Monitoring**: Add logging and monitoring for production
8. **Documentation**: Document all workflows and services

## Support

For questions or issues during migration:
- Check Supabase documentation: https://supabase.com/docs
- Review the AI SDK docs: https://sdk.vercel.ai
- Test workflows in development before production
