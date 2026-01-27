# Component Migration Guide: Vite → Next.js App Directory

## Migration Status

**Target Structure**: `app/components/`
**Source**: `components/` (root level)

## Completed Migrations

The following components have been successfully moved to `app/components/`:

### ✅ Core Components (Root Level)
- `Sidebar.tsx` - Navigation sidebar (updated for Next.js routing)
- `ApprovalsBanner.tsx` - Approval notifications banner
- `ChatWidget.tsx` - Main chat widget
- `ContactDetail.tsx` - Contact detail view
- `ContactForm.tsx` - Contact creation/edit form
- `ContactsList.tsx` - Contact list view

## Complete Directory Structure

\`\`\`
app/components/
├── index.ts                          # Central export file
├── MIGRATION_GUIDE.md               # This file
│
├── Core Components (Root Level)
├── Sidebar.tsx
├── ApprovalsBanner.tsx
├── ChatWidget.tsx
├── ContactDetail.tsx
├── ContactDetailModal.tsx
├── ContactEditForm.tsx
├── ContactForm.tsx
├── ContactsList.tsx
├── ContentGeneratorHub.tsx
├── DealTeamSection.tsx
├── JourneyCardsRenderer.tsx
├── PersonaTools.tsx
├── ProspectQuestionnaire.tsx
├── ThemFirstChatAssistant.tsx
├── TransparencyFeed.tsx
├── VideosDashboard.tsx
├── VoiceAssistant.tsx
├── description-approval-card.tsx
├── email-campaign-panel.tsx
├── marketing-package-dashboard.tsx
├── video-generation-panel.tsx
├── providers.tsx
├── theme-provider.tsx
│
├── ai/                              # AI-related components
│   ├── AIAssistantPanel.tsx
│   ├── AIInsightCard.tsx
│   └── SmartSuggestion.tsx
│
├── AI/                              # AI tools (capitalized folder)
│   ├── AIToolModal.tsx
│   ├── CMAGenerator.tsx
│   ├── ComplianceCheckedTextArea.tsx
│   ├── FloatingAIAssistant.tsx
│   ├── InsiderEditGenerator.tsx
│   ├── SmartEngineAssistant.tsx
│   ├── SmartGuide.tsx
│   ├── VideoGenerator.tsx
│   └── VoiceCommandButton.tsx
│
├── chat/                            # Chat components
│   ├── ChatInterface.tsx
│   ├── ChatSessionsList.tsx
│   ├── LeadInsightsPanel.tsx
│   ├── TemplateSelector.tsx
│   └── ThemFirstCoach.tsx
│
├── compliance/                      # Compliance components
│   ├── approved-content-library.tsx
│   ├── pending-approvals-list.tsx
│   ├── submit-content-form.tsx
│   └── violations-dashboard.tsx
│
├── content-studio/                  # Content creation tools
│   └── LinkToVideoGenerator.tsx
│
├── coordinator/                     # Transaction coordinator
│   ├── deadline-tracking.tsx
│   ├── milestone-queue.tsx
│   └── transaction-list.tsx
│
├── dashboard/                       # Dashboard widgets
│   ├── DailyGameplan.tsx
│   ├── KPICards.tsx
│   ├── RiskTable.tsx
│   └── TrendChart.tsx
│
├── intelligence/                    # Lead intelligence
│   ├── BehavioralInsights.tsx
│   ├── LeadIntelligencePanel.tsx
│   ├── MotivatedSellersMap.tsx
│   └── OSINTTimeline.tsx
│
├── lender/                          # Lender components
│   ├── loan-list.tsx
│   └── loan-pipeline.tsx
│
├── listing/                         # Listing components
│   └── ListingDetailTabs.tsx
│
├── marketing/                       # Marketing tools
│   └── PodcastStudio.tsx
│
├── mobile/                          # Mobile-specific
│   └── QuickActionsFAB.tsx
│
├── portal/                          # Client portal components
│   ├── BuyerPropertiesDashboard.tsx
│   ├── ClientDocumentsWidget.tsx
│   ├── ClientMessagingWidget.tsx
│   ├── CollaborativeSearchDashboard.tsx
│   ├── DocumentUploadDialog.tsx
│   ├── HelpPageContent.tsx
│   ├── NetSheetCalculator.tsx
│   ├── OfferStatusWidget.tsx
│   ├── PersonaDashboardTabs.tsx
│   ├── PersonaFeatureCards.tsx
│   ├── PersonaPropertiesDashboard.tsx
│   ├── PersonaQuickActions.tsx
│   ├── PersonaWelcomeHero.tsx
│   ├── PersonaWidgetGrid.tsx
│   ├── PersonalizedJourneyDashboard.tsx
│   ├── PortalAIAssistant.tsx
│   ├── PortalCalendarDashboard.tsx
│   ├── PortalNav.tsx
│   ├── PortalPropertiesView.tsx
│   ├── PortalSettingsPage.tsx
│   ├── PortalSocialHub.tsx
│   ├── PortalUserMenu.tsx
│   ├── PropertyDetailsView.tsx
│   ├── SellerListingDashboard.tsx
│   ├── ShowingsManager.tsx
│   ├── SmartPropertyInsights.tsx
│   ├── TaskCompletionDialog.tsx
│   └── UnifiedPortalDashboard.tsx
│
├── ui/                              # shadcn/ui components
│   ├── CommandBar.tsx
│   ├── Toast.tsx
│   ├── accordion.tsx
│   ├── alert-dialog.tsx
│   ├── alert.tsx
│   ├── aspect-ratio.tsx
│   ├── avatar.tsx
│   ├── badge.tsx
│   ├── breadcrumb.tsx
│   ├── button-group.tsx
│   ├── button.tsx
│   ├── calendar.tsx
│   ├── card.tsx
│   ├── carousel.tsx
│   ├── chart.tsx
│   ├── checkbox.tsx
│   ├── collapsible.tsx
│   ├── command.tsx
│   ├── context-menu.tsx
│   ├── dialog.tsx
│   ├── drawer.tsx
│   ├── dropdown-menu.tsx
│   ├── empty.tsx
│   ├── field.tsx
│   ├── form.tsx
│   ├── hover-card.tsx
│   ├── input-group.tsx
│   ├── input-otp.tsx
│   ├── input.tsx
│   ├── item.tsx
│   ├── kbd.tsx
│   ├── label.tsx
│   ├── menubar.tsx
│   ├── navigation-menu.tsx
│   ├── pagination.tsx
│   ├── popover.tsx
│   ├── progress.tsx
│   ├── radio-group.tsx
│   ├── resizable.tsx
│   ├── scroll-area.tsx
│   ├── select.tsx
│   ├── separator.tsx
│   ├── sheet.tsx
│   ├── sidebar.tsx
│   ├── skeleton.tsx
│   ├── slider.tsx
│   ├── sonner.tsx
│   ├── spinner.tsx
│   ├── switch.tsx
│   ├── table.tsx
│   ├── tabs.tsx
│   ├── textarea.tsx
│   ├── toast.tsx
│   ├── toaster.tsx
│   ├── toggle-group.tsx
│   ├── toggle.tsx
│   ├── tooltip.tsx
│   └── use-mobile.tsx
│
├── vendor/                          # Vendor components
│   └── bookings-list.tsx
│
└── video/                           # Video components
    └── VideoGenerationButtons.tsx
\`\`\`

## Migration Steps for Remaining Components

To complete the migration, copy each component from `components/` to `app/components/` maintaining the folder structure:

### Individual Files to Copy:
\`\`\`bash
# Core components (already migrated: Sidebar, ApprovalsBanner, ChatWidget, ContactDetail, ContactForm, ContactsList)
ContactDetailModal.tsx
ContentGeneratorHub.tsx
DealTeamSection.tsx
JourneyCardsRenderer.tsx
PersonaTools.tsx
ProspectQuestionnaire.tsx
ThemFirstChatAssistant.tsx
TransparencyFeed.tsx
VideosDashboard.tsx
VoiceAssistant.tsx
description-approval-card.tsx
email-campaign-panel.tsx
marketing-package-dashboard.tsx
video-generation-panel.tsx
providers.tsx
theme-provider.tsx
\`\`\`

### Folders to Copy (recursively):
\`\`\`bash
AI/
ai/
chat/
compliance/
content-studio/
coordinator/
dashboard/
intelligence/
lender/
listing/
marketing/
mobile/
portal/
ui/
vendor/
video/
\`\`\`

## Next.js Migration Checklist

When copying components, ensure each file:

1. **Has "use client" directive** (if using React hooks):
   \`\`\`typescript
   "use client"
   
   import React, { useState } from 'react'
   \`\`\`

2. **Uses Next.js routing**:
   \`\`\`typescript
   // Old (React Router)
   import { useNavigate } from 'react-router-dom'
   const navigate = useNavigate()
   navigate('/dashboard')
   
   // New (Next.js)
   import { useRouter } from 'next/navigation'
   const router = useRouter()
   router.push('/dashboard')
   \`\`\`

3. **Uses Next.js Link component**:
   \`\`\`typescript
   // Old
   import { Link } from 'react-router-dom'
   
   // New
   import Link from 'next/link'
   \`\`\`

4. **Updates import paths**:
   \`\`\`typescript
   // Old
   import { Button } from '@/components/ui/button'
   
   // New (if needed)
   import { Button } from '@/app/components/ui/button'
   // OR keep as is if using @ alias pointing to root
   \`\`\`

5. **Has proper TypeScript types**:
   \`\`\`typescript
   interface ComponentProps {
     data: string
     onAction: () => void
   }
   
   export function Component({ data, onAction }: ComponentProps) {
     // ...
   }
   \`\`\`

## Import Paths

After migration, import components using:

\`\`\`typescript
// Individual imports
import { Sidebar } from '@/app/components/Sidebar'
import { ApprovalsBanner } from '@/app/components/ApprovalsBanner'
import { Button } from '@/app/components/ui/button'

// From index (if using barrel exports)
import { Sidebar, ApprovalsBanner, ChatWidget } from '@/app/components'
\`\`\`

## Notes

- The `ui/` folder contains shadcn/ui components and should be kept intact
- Portal components are client-facing and may need additional security review
- AI components may require API key configuration in Next.js environment variables
- Some components using React Router will need significant refactoring for Next.js
