# Backend Wiring Audit - Production Readiness

## CRITICAL: Pages Using Hardcoded Mock Data (Need Backend Wiring)

### Priority 1 - Core Agent Pages
| Page | File | Issue | Required Action |
|------|------|-------|-----------------|
| DealDesk | pages/agent/DealDesk.tsx | Hardcoded deals array | Wire to transactions.ts |
| SphereManager | pages/agent/SphereManager.tsx | Mock contacts/touchpoints | Wire to ai-sphere-management.ts |
| ClosingDashboard | pages/agent/ClosingDashboard.tsx | Mock transactions | Wire to ai-transaction-coordinator.ts |
| TransactionManager | pages/agent/TransactionManager.tsx | Some mock data | Wire to transactions.ts |
| OfferLab | pages/agent/OfferLab.tsx | Mock offers | Wire to ai-offer-creation.ts |
| MarketingStudio | pages/agent/MarketingStudio.tsx | Mock newsletters/direct mail | Wire to ai-newsletter.ts, ai-direct-mail.ts |
| NotificationSettings | pages/agent/NotificationSettings.tsx | Mock settings | Wire to agent-settings.ts |

### Priority 2 - Admin/Broker Pages
| Page | File | Issue | Required Action |
|------|------|-------|-----------------|
| Financials | pages/admin/Financials.tsx | mockCommissions array | Wire to ai-financial-management.ts |
| ComplianceManager | pages/admin/ComplianceManager.tsx | Mock compliance data | Wire to compliance-monitoring.ts |
| SystemConfig | pages/admin/SystemConfig.tsx | Mock config | Wire to services-config.ts |

### Priority 3 - Common/Calendar Pages
| Page | File | Issue | Required Action |
|------|------|-------|-----------------|
| CalendarDashboard | pages/common/CalendarDashboard.tsx | blockedSlots mock | Wire to ai-calendar-management.ts |
| Events | pages/common/Events.tsx | Mock events | Wire to open-house-automation.ts |

### Priority 4 - Client/Portal Pages
| Page | File | Issue | Required Action |
|------|------|-------|-----------------|
| BuyerPortal | pages/client/BuyerPortal.tsx | Mock property data | Wire to ai-property-matching.ts |
| ClientPlaybook | pages/client/ClientPlaybook.tsx | Mock playbook data | Wire to journey-tasks.ts |

### Priority 5 - Contact/Persona Dashboards
| Page | File | Issue | Required Action |
|------|------|-------|-----------------|
| FirstTimeBuyerDashboard | pages/contact/FirstTimeBuyerDashboard.tsx | Mock data | Wire to multi-persona.ts |
| MotivatedSellerDashboard | pages/contact/MotivatedSellerDashboard.tsx | Mock data | Wire to multi-persona.ts |
| RelocatingDashboard | pages/contact/RelocatingDashboard.tsx | Mock data | Wire to multi-persona.ts |

### Priority 6 - Public/Landing Pages
| Page | File | Issue | Required Action |
|------|------|-------|-----------------|
| OpenHouseKiosk | pages/public/OpenHouseKiosk.tsx | Mock attendee data | Wire to open-house-automation.ts |
| ReferralPartnerPortal | pages/public/ReferralPartnerPortal.tsx | Mock referrals | Wire to ai-referral-management.ts |
| SmartListingLanding | pages/public/SmartListingLanding.tsx | Mock listing | Wire to idx-search.ts |

## Pages Already Wired (43 pages with action imports)
These pages ARE importing actions but may need verification of proper data flow.

## Missing API Routes
Some action files may need corresponding API routes for client-side data fetching:
- ai-sphere-management.ts - No API route
- ai-review-automation.ts - No API route
- ai-client-gifting.ts - No API route
- ai-listing-packet.ts - No API route

## Database Tables Status
All schemas have been executed. Tables exist for:
- Core: agents, contacts, listings, transactions, offers
- AI Systems: all 31 AI action files have corresponding tables
- New: onboarding, packets, sphere, reviews, gifts

## RECOMMENDATION
Before UI integration, need to:
1. Create API routes for client-side data fetching
2. Wire 22 pages to their corresponding action files
3. Remove hardcoded mock data
4. Add proper loading/error states

## Estimated Backend Completion: 75%
Backend action files are complete but UI pages are not properly connected.
