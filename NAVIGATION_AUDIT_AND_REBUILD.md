# Navigation Audit & Rebuild Plan

## Current Issues Identified

### 1. Duplicate Navigation Items
- **"broker-dashboard"** labeled as "Command Center" appears in ADMIN/BROKER nav
- **"agent-dashboard"** labeled as "My Command Desk" appears in AGENT nav
- Both dashboards serve as primary landing pages

### 2. Inconsistent Route Naming
- Some routes use "dashboard" suffix (agent-dashboard, broker-dashboard)
- Some routes don't (crm, transactions, documents)
- Creates confusion in App.tsx switch statement

### 3. Missing/Broken Routes
Routes in ROLE_NAVIGATION but missing switch cases in App.tsx:
- `marketing` (exists as view but not in nav)
- `tc-dashboard` (exists as component but not routed)
- `user-management` (in nav for ADMIN but rarely used)

### 4. Pages That Exist But Aren't in Navigation
Found in pages/admin/ but not in any ROLE_NAVIGATION:
- meetings.tsx
- org.tsx  
- progression.tsx
- ContactManagement.tsx

### 5. Consolidated vs Individual Pages Issue
- Some features are tabs within dashboards (e.g., compliance is in BrokerDashboard)
- Some features are standalone pages (e.g., ComplianceManager)
- Need to decide: standalone pages or dashboard tabs?

---

## Proposed Clean Navigation Structure

### ADMIN/BROKER Navigation (Command Center Focus)
**Dashboard & Overview:**
- broker-dashboard → "Command Center" (main admin dashboard)
- system-health → "System Health"
- ai-audit → "AI Oversight"

**Team Management:**
- agent-roster → "Agent Roster"
- recruiting-hub → "Recruiting Hub"
- user-management → "User Management"

**Lead & Contact Management:**
- crm → "CRM"
- lead-intelligence → "Lead Intelligence"
- lead-distribution → "Lead Router"
- lead-scraping-config → "Lead Scraping"
- segmentation → "Segmentation"

**Listing Operations:**
- listing-approvals → "Compliance Queue"
- listing-distribution → "Listing Distribution"

**Analytics & Reporting:**
- financials → "Financials"
- conversation-analytics → "Conversation Analytics"
- data-health → "Data Health"

**Compliance & Risk:**
- compliance → "Compliance"
- risk-management → "Risk Management"
- vendor-compliance → "Vendor Compliance"

**System & Settings:**
- settings → "System Settings"
- partners → "Partners"

### AGENT Navigation (Production Focus)
**Dashboard:**
- agent-dashboard → "My Dashboard"

**Core Workflow:**
- crm → "Contacts"
- transactions → "Transactions"
- calendar → "Calendar"
- inbox → "Inbox"

**Listing & Showing:**
- listing-intake → "New Listing"
- oh-manager → "Open Houses"
- showings → "Showings"
- buyer-tours → "Buyer Tours"
- feedback-log → "Feedback"

**Client Tools:**
- offer-lab → "Offer Lab"
- cma → "CMA Tool"
- closing-dashboard → "Closing"

**Marketing & Content:**
- content-studio → "Content Studio"
- social-planner → "Social Planner"
- shareable-assets → "Shareable Assets"

**AI & Intelligence:**
- ai-tools → "AI Tools"
- lead-intelligence → "Lead Intelligence"
- ai-isa → "AI ISA"
- ai-chat → "AI Assistant"
- voice-call-bridge → "Voice Bridge"

**Resources:**
- documents → "Documents"
- sphere → "Sphere/SOI"
- map-intelligence → "Market Map"
- knowledge-base → "Knowledge Base"
- events → "Events"

**Personal:**
- agent-onboarding → "My Onboarding"
- financials → "My Finances"

---

## Implementation Plan

### Phase 1: Clean Up Navigation Definitions
1. Update `services/permissionsService.ts` ROLE_NAVIGATION
2. Remove duplicate/unused routes
3. Ensure all routes have corresponding switch cases in App.tsx

### Phase 2: Verify All Switch Cases
1. Audit App.tsx switch statement
2. Remove unused cases
3. Add missing cases for valid routes
4. Ensure all components are properly lazy-loaded

### Phase 3: Update Sidebar Component
1. Fix icon mappings in ALL_NAV_ITEMS
2. Ensure labels match navigation structure
3. Remove any hardcoded duplicates

### Phase 4: Test Each Role's Navigation
1. ADMIN - verify all admin pages work
2. BROKER - verify broker access
3. AGENT - verify agent workflow
4. TC - verify TC dashboard
5. CONTACT - verify persona dashboards

### Phase 5: Documentation
1. Create navigation map diagram
2. Document which pages are tabs vs standalone
3. Update README with navigation structure

---

## Route-to-Component Mapping (Verified)

| Route ID | Component | Status |
|----------|-----------|---------|
| agent-dashboard | AgentDashboard | ✅ Working |
| broker-dashboard | BrokerDashboard | ✅ Working |
| crm | CRM | ✅ Working |
| transactions | TransactionManager | ✅ Working |
| calendar | CalendarDashboard | ✅ Working |
| inbox | UnifiedInbox | ✅ Working |
| listing-intake | ListingIntake | ✅ Working |
| oh-manager | OpenHouseManager | ✅ Working |
| showings | ShowingsDesk | ✅ Working |
| buyer-tours | BuyerTours | ✅ Working |
| feedback-log | FeedbackDesk | ✅ Working |
| offer-lab | OfferLab | ✅ Working |
| cma | SmartCMA | ✅ Working |
| closing-dashboard | ClosingDashboard | ✅ Working |
| content-studio | ContentStudioPage | ✅ Working |
| social-planner | SocialPlannerPage | ✅ Working |
| shareable-assets | ShareableAssets | ✅ Working |
| ai-tools | AIToolsHub | ✅ Working |
| lead-intelligence | LeadIntelligenceDashboard | ✅ Working |
| lead-insights | LeadIntelligenceDashboard | ✅ Working (same component) |
| ai-isa | AIISADashboard | ✅ Working |
| ai-chat | AIChatDashboard | ✅ Working |
| voice-call-bridge | VoiceCallBridge | ✅ Working |
| documents | Documents | ✅ Working |
| sphere | SphereManager | ✅ Working |
| map-intelligence | MapIntelligence | ✅ Working |
| knowledge-base | Placeholder | ⚠️ Needs component |
| events | Events | ✅ Working |
| agent-onboarding | OnboardingDashboard | ✅ Working |
| financials | Financials/FinancialsView | ✅ Working |
| agent-roster | AgentRoster | ✅ Working |
| recruiting-hub | RecruitingHub | ✅ Working |
| listing-approvals | ListingApprovals | ✅ Working |
| listing-distribution | ListingDistribution | ✅ Working |
| compliance | ComplianceManager | ✅ Working |
| risk-management | RiskManagement | ✅ Working |
| vendor-compliance | VendorCompliance | ✅ Working |
| system-health | SystemHealth | ✅ Working |
| settings | SystemConfig | ✅ Working |
| ai-audit | AIAudit | ✅ Working |
| conversation-analytics | ConversationAnalytics | ✅ Working |
| data-health | DataHealth | ✅ Working |
| segmentation | SegmentationDesk | ✅ Working |
| lead-distribution | LeadDistribution | ✅ Working |
| lead-scraping-config | LeadScrapingConfig | ✅ Working |
| partners | PartnersManager | ✅ Working |
| user-management | UserManagement | ✅ Working |
| notifications | NotificationSettings | ✅ Working |

---

## Routes to Remove/Deprecate

- `marketing` → Use `content-studio` instead
- `social-scheduler` → Use `social-planner` instead  
- `listing-reports` → Integrated into agent-dashboard
- `intelligence` → Use `lead-intelligence` instead
- `agents` → Use `agent-roster` instead

---

## Next Steps

1. Implement Phase 1-3 immediately
2. Test with each role
3. Remove deprecated routes
4. Update this document with final structure
