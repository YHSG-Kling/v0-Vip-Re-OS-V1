# app/components/ Folder Structure

This document shows the complete component folder structure after migration.

## Root Level Components (22 files)
```
app/components/
├── ApprovalsBanner.tsx
├── ChatWidget.tsx
├── ContactDetail.tsx
├── ContactDetailModal.tsx
├── ContactForm.tsx
├── ContactsList.tsx
├── ContentGeneratorHub.tsx
├── DealTeamSection.tsx
├── JourneyCardsRenderer.tsx
├── PersonaTools.tsx
├── ProspectQuestionnaire.tsx
├── Sidebar.tsx
├── ThemFirstChatAssistant.tsx
├── TransparencyFeed.tsx
├── VideosDashboard.tsx
├── VoiceAssistant.tsx
├── description-approval-card.tsx
├── email-campaign-panel.tsx
├── marketing-package-dashboard.tsx
├── providers.tsx
├── theme-provider.tsx
└── video-generation-panel.tsx
```

## Component Folders

### /ui (58 files)
Shadcn/ui components + custom UI primitives
```
app/components/ui/
├── CommandBar.tsx
├── Toast.tsx
├── accordion.tsx
├── alert-dialog.tsx
├── alert.tsx
├── aspect-ratio.tsx
├── avatar.tsx
├── badge.tsx
├── breadcrumb.tsx
├── button-group.tsx
├── button.tsx
├── calendar.tsx
├── card.tsx
├── carousel.tsx
├── chart.tsx
├── checkbox.tsx
├── collapsible.tsx
├── command.tsx
├── context-menu.tsx
├── dialog.tsx
├── drawer.tsx
├── dropdown-menu.tsx
├── empty.tsx
├── field.tsx
├── form.tsx
├── hover-card.tsx
├── input-group.tsx
├── input-otp.tsx
├── input.tsx
├── item.tsx
├── kbd.tsx
├── label.tsx
├── menubar.tsx
├── navigation-menu.tsx
├── pagination.tsx
├── popover.tsx
├── progress.tsx
├── radio-group.tsx
├── resizable.tsx
├── scroll-area.tsx
├── select.tsx
├── separator.tsx
├── sheet.tsx
├── sidebar.tsx
├── skeleton.tsx
├── slider.tsx
├── sonner.tsx
├── spinner.tsx
├── switch.tsx
├── table.tsx
├── tabs.tsx
├── textarea.tsx
├── toast.tsx
├── toaster.tsx
├── toggle-group.tsx
├── toggle.tsx
├── tooltip.tsx
├── use-mobile.tsx
└── use-toast.ts
```

### /portal (27 files)
Client portal components for buyers and sellers
```
app/components/portal/
├── BuyerPropertiesDashboard.tsx
├── ClientDocumentsWidget.tsx
├── ClientMessagingWidget.tsx
├── CollaborativeSearchDashboard.tsx
├── DocumentUploadDialog.tsx
├── HelpPageContent.tsx
├── NetSheetCalculator.tsx
├── OfferStatusWidget.tsx
├── PersonaDashboardTabs.tsx
├── PersonaFeatureCards.tsx
├── PersonaPropertiesDashboard.tsx
├── PersonaQuickActions.tsx
├── PersonaWelcomeHero.tsx
├── PersonaWidgetGrid.tsx
├── PersonalizedJourneyDashboard.tsx
├── PortalAIAssistant.tsx
├── PortalCalendarDashboard.tsx
├── PortalNav.tsx
├── PortalPropertiesView.tsx
├── PortalSettingsPage.tsx
├── PortalSocialHub.tsx
├── PortalUserMenu.tsx
├── PropertyDetailsView.tsx
├── SellerListingDashboard.tsx
├── ShowingsManager.tsx
├── SmartPropertyInsights.tsx
├── TaskCompletionDialog.tsx
└── UnifiedPortalDashboard.tsx
```

### /AI (9 files)
AI-powered tools and assistants
```
app/components/AI/
├── AIToolModal.tsx
├── CMAGenerator.tsx
├── ComplianceCheckedTextArea.tsx
├── FloatingAIAssistant.tsx
├── InsiderEditGenerator.tsx
├── SmartEngineAssistant.tsx
├── SmartGuide.tsx
├── VideoGenerator.tsx
└── VoiceCommandButton.tsx
```

### /listing (1 file)
Listing detail components
```
app/components/listing/
└── ListingDetailTabs.tsx
```

### /marketing (1 file)
Marketing and content creation tools
```
app/components/marketing/
└── PodcastStudio.tsx
```

### Additional Folders to Copy
The following folders need to be copied but weren't found in the initial scan:
- /ai (lowercase - may have additional AI components)
- /chat (chat interfaces)
- /compliance (compliance checking tools)
- /dashboard (dashboard widgets)
- /intelligence (lead intelligence components)
- /coordinator (transaction coordinator tools)
- /content-studio (content creation tools)
- /lender (lender portal components)
- /mobile (mobile-optimized components)
- /vendor (vendor management)
- /video (video recording/editing)

## Total Component Count
- Root level: 22 files
- /ui: 58 files
- /portal: 27 files
- /AI: 9 files
- /listing: 1 file
- /marketing: 1 file
- **Total so far: 118 files**

## Import Paths
After migration, import from:
```typescript
// Old way (Vite)
import { Button } from '@/components/ui/button'
import Sidebar from '@/components/Sidebar'

// New way (Next.js app directory)
import { Button } from '@/app/components/ui/button'
import Sidebar from '@/app/components/Sidebar'

// Or use the barrel export
import { Button, Sidebar } from '@/app/components'
```

## Next Steps
1. Run: `node scripts/copy-components.mjs` to copy remaining folders
2. Update all import paths throughout the codebase
3. Add "use client" directive to interactive components
4. Test each component in Next.js environment
5. Update the barrel export in `app/components/index.ts`
