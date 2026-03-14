# WIRING + SURFACING VERIFICATION REPORT
## VIP Agents AI Real Estate OS

Generated: 2026-03-13

---

## EXECUTIVE SUMMARY

This report verifies **actual product surfacing and end-to-end accessibility** for all major systems, features, workflows, and AI capabilities. This is NOT an inventory - it documents what users can actually discover and use from the current UI.

**Overall Status:**
- **213 total pages** exist in app/
- **12 roles** with distinct navigation configs
- **126+ portal pages/components** for client-facing features
- **Key finding:** Many powerful backend systems have limited or no UI entry points

---

## A. SYSTEMS CLEARLY SURFACED AND WORKING

### Dashboard Systems (Production-Ready, Fully Wired)

| System | Entry Point | Roles | Route | Wiring | Status |
|--------|-------------|-------|-------|--------|--------|
| Agent Dashboard | Sidebar "Dashboard" | agent, team_lead | /dashboard/agent | Real Supabase data | SURFACED |
| Broker Dashboard | Sidebar "Broker Dashboard" | broker | /dashboard/brokerage | Real Supabase data | SURFACED |
| Admin Dashboard | Sidebar "Admin Dashboard" | admin | /dashboard/admin | Real Supabase data | SURFACED |
| ISA Dashboard | Sidebar "ISA Dashboard" | isa | /dashboard/isa | Real Supabase data | SURFACED |
| Team Dashboard | Sidebar "Team Dashboard" | team_lead | /dashboard/team | Real Supabase data | SURFACED |

### CRM / Contacts (Production-Ready, Fully Wired)

| System | Entry Point | Roles | Route | Wiring | Status |
|--------|-------------|-------|-------|--------|--------|
| CRM Main | Sidebar "My Contacts" / "CRM" | agent, team_lead, broker | /crm | Real Supabase: contacts table | SURFACED |
| Contact Detail | Table row click | all | /contacts/[id] | Real Supabase data | SURFACED |
| Leads (Buyers) | Sidebar "My Leads" | agent | /dashboard/buyers | Real Supabase: contacts filtered | SURFACED |

### Listings (Production-Ready, Fully Wired)

| System | Entry Point | Roles | Route | Wiring | Status |
|--------|-------------|-------|-------|--------|--------|
| My Listings | Sidebar "My Listings" | agent | /dashboard/listings | Real Supabase: listings table | SURFACED |
| Listing Detail | Card/row click | agent | /listings/[id] | Real data | SURFACED |
| New Listing | "New Listing" button | agent | /listings/new | Form + Supabase insert | SURFACED |

### Transactions (Production-Ready, Fully Wired)

| System | Entry Point | Roles | Route | Wiring | Status |
|--------|-------------|-------|-------|--------|--------|
| Transactions List | Sidebar "Transactions" | agent, broker, tc | /dashboard/transactions | Real Supabase: transactions table | SURFACED |
| Transaction Detail | Row click | all | /dashboard/transactions/[id] | Real data | SURFACED |

### Settings (Production-Ready, Fully Wired)

| System | Entry Point | Roles | Route | Wiring | Status |
|--------|-------------|-------|-------|--------|--------|
| Settings Hub | Sidebar "Settings" | admin, broker, superadmin | /settings | Links to subsections | SURFACED |
| General Settings | Settings card | admin, broker | /settings/general | Real Supabase | SURFACED |
| Branding Settings | Settings card | admin, broker | /settings/branding | Real Supabase | SURFACED |
| Commission Settings | Settings card | admin, broker | /settings/commission | Real Supabase | SURFACED |
| Email Templates | Settings card | admin, broker | /settings/email-templates | Real Supabase | SURFACED |
| Notifications | Settings card | admin, broker | /settings/notifications | Real Supabase | SURFACED |
| Integrations | Settings card | admin, broker | /settings/integrations | Real Supabase | SURFACED |

### Admin Tools (Production-Ready, Fully Wired)

| System | Entry Point | Roles | Route | Wiring | Status |
|--------|-------------|-------|-------|--------|--------|
| System Health | Sidebar "System Health" | admin, superadmin | /admin/system-health | Real service_health_checks | SURFACED |
| Audit Trail | Sidebar "Audit Trail" | admin, superadmin | /admin/audit-trail | Real unified_audit_events | SURFACED |
| Agent Onboarding | Sidebar "Agent Onboarding" | admin | /dashboard/admin/onboarding | Real Supabase | SURFACED |
| Forms Manager | Sidebar "Forms Manager" | admin | /dashboard/admin/forms | Real Supabase | SURFACED |
| Knowledge Base | Sidebar "Knowledge Base" | admin | /dashboard/admin/knowledge | Real Supabase | SURFACED |

---

## B. SYSTEMS BUILT BUT NOT SURFACED (Backend-Only or Hidden)

### AI Systems (Built but NO sidebar entry)

| System | Files Exist | Entry Point | Route | Wiring | Recommendation |
|--------|-------------|-------------|-------|--------|----------------|
| AI CMA Engine | lib/cma/ai-cma-engine.ts, app/actions/ai-cma.ts | Contextual (listing page) | /dashboard/listings/[id]/cma | Wired to listing context | SURFACE: Add to listing actions |
| AI ISA Campaigns | lib/ai/isa/*, app/actions/ai-isa.ts | Sidebar (ISA role only) | /dashboard/isa/campaigns | Fully wired | SURFACE: Add to agent sidebar |
| AI Marketing Automation | lib/ai/marketing-*, app/actions/ai-marketing-automation.ts | None visible | Various | Wired actions | SURFACE NOW |
| Content Generation Engine | lib/content/*, app/actions/content-generation-engine.ts | Marketing Studio | /dashboard/marketing/studio | Wired | Visible via Marketing Studio |
| Video Studio (HeyGen) | lib/video/*, app/dashboard/videos/* | Direct URL only | /dashboard/videos/create | Fully wired to HeyGen | SURFACE NOW |
| Lead Intelligence | lib/lead-intelligence/* | Direct URL only | /dashboard/lead-intelligence | Wired | SURFACE NOW |
| Vendor Quote Workflow | lib/transactions/vendor-quote-workflow.ts | None | Backend only | Actions exist | SURFACE via transaction detail |

### Financial Systems (Wired but Hidden from most roles)

| System | Files Exist | Entry Point | Route | Wiring | Recommendation |
|--------|-------------|-------------|-------|--------|----------------|
| Brokerage P&L | app/dashboard/financials/brokerage/page.tsx | Sidebar (broker only) | /dashboard/financials/brokerage | Real data wired | SURFACED for broker |
| Agent Financials | app/dashboard/financials/agent/page.tsx | Direct URL | /dashboard/financials/agent | Real data wired | SURFACE for agents |
| Team Financials | app/dashboard/financials/team/page.tsx | Direct URL | /dashboard/financials/team | Real data wired | SURFACE for team_lead |
| Commission Engine | lib/commission/engine.ts | Backend only | None | Wired | Add UI controls |
| Payment Tracker | lib/commission/payment-tracker.ts | Backend only | None | Wired | Add dashboard widget |

### Portal Systems (Extensive but Contact-Role Only)

| System | Entry Point | Route | Wiring | Recommendation |
|--------|-------------|-------|--------|----------------|
| Client Portal Hub | Contact login | /portal/[contactId] | Fully wired | SURFACED (contact role) |
| Buyer Search | Portal nav | /portal/[contactId]/search | Real data | SURFACED |
| Seller Dashboard | Portal nav | /portal/[contactId]/listing | Real data | SURFACED |
| Client Documents | Portal nav | /portal/[contactId]/documents | Real data | SURFACED |
| Client Messages | Portal nav | /portal/[contactId]/messages | Real data | SURFACED |
| Client Calendar | Portal nav | /portal/[contactId]/calendar | Real data | SURFACED |
| Portal AI Assistant | In-portal | /api/portal/ai-assistant | Wired | SURFACED |
| Lender Portal | Direct URL | /portal/lender/[transactionId] | Wired | SURFACED (lender role) |
| Title Portal | Direct URL | /portal/title/[transactionId] | Wired | SURFACED (title_agent role) |
| Vendor Portal | Direct URL | /portal/vendor | Wired | SURFACED (vendor role) |

---

## C. SYSTEMS SURFACED BUT NOT FULLY WIRED

| System | Entry Point | Route | Issue | Recommendation |
|--------|-------------|-------|-------|----------------|
| Compliance Dashboard | Sidebar (compliance_officer) | /compliance | Loads shell only | Wire real compliance_violations data |
| Dashboard Compliance | Admin link | /dashboard/compliance | Exists | Wire real data |
| TC Coordinator | Sidebar (tc) | /transaction/dashboard | Shell page | Wire deals, checklists |
| Lender Dashboard | Sidebar (lender) | /lender/dashboard | Shell page | Wire loan pipeline data |
| Title Dashboard | Sidebar (title_agent) | /title/dashboard | Shell page | Wire title orders |

---

## D. BACKEND-ONLY SYSTEMS WITH NO MEANINGFUL UI SURFACE

These systems have full backend implementations but no user-discoverable interface:

| System | Backend Files | Actions | UI Status |
|--------|--------------|---------|-----------|
| Ad Creator/Monitor | lib/ads/ad-creator.ts, ad-monitor.ts | Yes | NO UI |
| Facebook Audience Sync | lib/ads/facebook-audience-sync.ts | Yes | NO UI |
| ROI Calculator | lib/campaigns/roi-calculator.ts | Yes | NO UI |
| Contact Capture Pipeline | lib/contact-pipeline/contact-capture.ts | Yes | NO UI |
| Deadline Monitor | lib/transactions/deadline-monitor.ts | Yes | Backend cron |
| Stage Progression | lib/transactions/stage-progression.ts | Yes | Backend auto |
| CDA Workflow | lib/transactions/cda-workflow.ts | Yes | NO UI |
| Contract Governance | lib/transactions/contract-governance.ts | Yes | NO UI |
| Gift Order Trigger | lib/transactions/gift-order-trigger.ts | Yes | NO UI |
| Milestone Service | lib/transactions/milestone-service.ts | Yes | NO UI |
| Offer Bridge | lib/transactions/offer-bridge.ts | Yes | NO UI |
| Performance Predictor | lib/content/performance-predictor.ts | Yes | NO UI |
| All 11 Waterfall Steps | lib/commission/waterfall/*.ts | Yes | Backend only |

---

## E. TOP 20 HIGHEST-VALUE TRAPPED SYSTEMS TO SURFACE NOW

Ranked by user impact and implementation completeness:

| Rank | System | Current Access | Value | Effort to Surface |
|------|--------|----------------|-------|-------------------|
| 1 | **Video Studio** | /dashboard/videos/create (URL only) | HIGH - Full HeyGen integration | LOW - Add sidebar item |
| 2 | **Marketing Studio** | /dashboard/marketing/studio (URL only) | HIGH - Content generation | LOW - Add sidebar item |
| 3 | **ISA Campaigns** | /dashboard/isa/campaigns (ISA role only) | HIGH - Automated outreach | MEDIUM - Add to agent nav |
| 4 | **AI CMA** | /dashboard/listings/[id]/cma (contextual) | HIGH - Seller pricing | LOW - Already contextual |
| 5 | **Lead Intelligence** | /dashboard/lead-intelligence (URL only) | HIGH - Lead scoring | LOW - Add sidebar item |
| 6 | **Agent Financials** | /dashboard/financials/agent (URL only) | HIGH - Agent self-service | LOW - Add sidebar item |
| 7 | **Team Financials** | /dashboard/financials/team (URL only) | MEDIUM - Team lead self-service | LOW - Add sidebar item |
| 8 | **Blog Dashboard** | /dashboard/marketing/blog (URL only) | MEDIUM - Content marketing | LOW - Add to marketing menu |
| 9 | **Podcast Studio** | /dashboard/marketing/podcast (URL only) | MEDIUM - Content marketing | LOW - Add to marketing menu |
| 10 | **SEO Dashboard** | /dashboard/marketing/seo (URL only) | MEDIUM - SEO optimization | LOW - Add to marketing menu |
| 11 | **Video Analytics** | /dashboard/videos/analytics (URL only) | MEDIUM - Performance tracking | LOW - Add to video submenu |
| 12 | **Video Library** | /dashboard/videos/library (URL only) | MEDIUM - Asset management | LOW - Add to video submenu |
| 13 | **Video Snippets** | /dashboard/videos/snippets (URL only) | MEDIUM - Short-form content | LOW - Add to video submenu |
| 14 | **Assignment Rules** | /dashboard/admin/assignment-rules (URL only) | MEDIUM - Lead routing | LOW - Add admin submenu |
| 15 | **Farm Intelligence** | /dashboard/admin/farm-intelligence (URL only) | MEDIUM - Geographic targeting | LOW - Add admin submenu |
| 16 | **SLA Monitor** | /dashboard/admin/sla-monitor (URL only) | MEDIUM - Service tracking | LOW - Add admin submenu |
| 17 | **Provider Intelligence** | /dashboard/admin/provider-intelligence (URL only) | LOW - Vendor analysis | LOW - Add admin submenu |
| 18 | **Visitor Tracking** | /dashboard/admin/visitor-tracking (URL only) | MEDIUM - Analytics | LOW - Add admin submenu |
| 19 | **Billing** | /admin/billing (URL only) | HIGH - Revenue tracking | LOW - Add admin sidebar |
| 20 | **Usage Metrics** | /admin/usage (URL only) | MEDIUM - Platform analytics | LOW - Add admin sidebar |

---

## F. FILES CONTROLLING WHY SYSTEMS ARE NOT SURFACING

### Primary Navigation Control File
```
/vercel/share/v0-project/app/config/navigation-config.ts
```

This file controls ALL sidebar, top nav, mobile nav, and command palette items for every role.

### Current Navigation Gaps by Role:

**Agent Role - Missing:**
- No "Video Studio" item
- No "Marketing Studio" item  
- No "Lead Intelligence" item
- No "My Financials" item
- No "ISA Campaigns" item (available only to ISA role)

**Broker Role - Missing:**
- No "Video Studio" item
- No "Marketing" section
- No "Lead Intelligence" item

**Admin Role - Missing:**
- No "Billing" item
- No "Usage" item
- No "Assignment Rules" item
- No "Farm Intelligence" item
- No "SLA Monitor" item
- No "Provider Intelligence" item
- No "Visitor Tracking" item

**Team Lead Role - Missing:**
- No "Team Financials" direct link
- No "Video Studio" item
- No "Marketing Studio" item

---

## G. EXACT UI SURFACES THAT SHOULD EXPOSE TRAPPED SYSTEMS

### 1. Add to Agent Sidebar (navigation-config.ts)
```typescript
// Agent role sidebarItems additions:
{ id: 'marketing', label: 'Marketing Studio', href: '/dashboard/marketing/studio', icon: 'Palette' },
{ id: 'videos', label: 'Video Studio', href: '/dashboard/videos/create', icon: 'Video' },
{ id: 'lead-intel', label: 'Lead Intelligence', href: '/dashboard/lead-intelligence', icon: 'Brain' },
{ id: 'my-financials', label: 'My Financials', href: '/dashboard/financials/agent', icon: 'DollarSign' },
```

### 2. Add to Broker Sidebar (navigation-config.ts)
```typescript
// Broker role sidebarItems additions:
{ 
  id: 'marketing',
  label: 'Marketing',
  icon: 'Megaphone',
  children: [
    { id: 'studio', label: 'Marketing Studio', href: '/dashboard/marketing/studio' },
    { id: 'blog', label: 'Blog', href: '/dashboard/marketing/blog' },
    { id: 'videos', label: 'Video Studio', href: '/dashboard/videos/create' },
    { id: 'seo', label: 'SEO', href: '/dashboard/marketing/seo' },
  ],
},
{ id: 'lead-intel', label: 'Lead Intelligence', href: '/dashboard/lead-intelligence', icon: 'Brain' },
```

### 3. Add to Admin Sidebar (navigation-config.ts)
```typescript
// Admin role sidebarItems additions:
{ id: 'billing', label: 'Billing', href: '/admin/billing', icon: 'CreditCard' },
{ id: 'usage', label: 'Usage Metrics', href: '/admin/usage', icon: 'BarChart3' },
{
  id: 'advanced',
  label: 'Advanced',
  icon: 'Wrench',
  children: [
    { id: 'assignment-rules', label: 'Assignment Rules', href: '/dashboard/admin/assignment-rules' },
    { id: 'farm-intel', label: 'Farm Intelligence', href: '/dashboard/admin/farm-intelligence' },
    { id: 'sla-monitor', label: 'SLA Monitor', href: '/dashboard/admin/sla-monitor' },
    { id: 'visitor-tracking', label: 'Visitor Tracking', href: '/dashboard/admin/visitor-tracking' },
  ],
},
```

### 4. Add to Team Lead Sidebar (navigation-config.ts)
```typescript
// Team Lead role - update financials link and add marketing:
{ id: 'financials', label: 'Team Financials', href: '/dashboard/financials/team', icon: 'DollarSign' },
{ id: 'marketing', label: 'Marketing Studio', href: '/dashboard/marketing/studio', icon: 'Palette' },
{ id: 'videos', label: 'Video Studio', href: '/dashboard/videos/create', icon: 'Video' },
```

### 5. Add Quick Actions to Dashboard Cards
The agent dashboard at `/dashboard/agent/page.tsx` has Quick Actions - add:
```tsx
<Link href="/dashboard/marketing/studio">
  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
    <Palette className="h-4 w-4 mr-2" />
    Marketing Studio
  </Button>
</Link>
<Link href="/dashboard/videos/create">
  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
    <Video className="h-4 w-4 mr-2" />
    Create AI Video
  </Button>
</Link>
```

---

## SUMMARY OF ACTION ITEMS

### Immediate (No Code Changes Needed - Just Config Updates)
1. Update `navigation-config.ts` to expose all built pages
2. Add missing sidebar items for each role as documented above

### Short-Term (Minor UI Additions)
1. Add quick action buttons to dashboard pages
2. Add contextual action buttons in listing/transaction detail pages
3. Expose ISA Campaigns to agent role (not just ISA role)

### Medium-Term (New UI Components)
1. Create unified "AI Tools" section in navigation
2. Add command palette entries for all major features
3. Create feature discovery tooltips for new users

---

## VERIFICATION METHODOLOGY

This report was generated by:
1. Reading `navigation-config.ts` to identify what's in each role's sidebar
2. Globbing all `page.tsx` files to identify all routes
3. Reading each major page to verify real data wiring (not mock/demo)
4. Cross-referencing lib/ services with their UI entry points
5. Tracing actions files to their UI consumers

**Key Finding:** The codebase has extensive production-ready backend systems that are simply not exposed in the navigation. Surfacing these requires only configuration updates - the code is already written and wired.
