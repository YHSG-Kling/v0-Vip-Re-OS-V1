## CONSOLIDATION & CLEANUP ACTION PLAN

### Phase 1: Foundation (Days 1-3)

#### 1.1 Create Shared Validation Module
**File**: `lib/validations/index.ts`
- Central UUID validation
- Contact/property/transaction schemas
- Reusable error types

#### 1.2 Create Shared Constants
**File**: `lib/constants/index.ts`
- UUID regex pattern
- Feature flags
- Error messages
- Demo mode configuration

#### 1.3 Add Consistent Error Handling
**File**: `lib/errors/index.ts`
- Custom error classes
- Error logging utility
- Error recovery strategies

---

### Phase 2: Action Consolidation (Days 4-7)

#### 2.1 Consolidate Email Functions
**DUPLICATE**: `generateEmail()` in 3 files
- SOURCE: `app/actions/ai-content-generation.tsx` (keep)
- DELETE: Remove from `content-studio.ts`
- DELETE: Remove from `communications.ts`
- ACTION: Create re-export in `communications.ts` pointing to ai-content-generation.tsx

#### 2.2 Consolidate Social Functions
**DUPLICATE**: `publishPost()` in 2 files
- MERGE: `social-publishing.ts` → `social-media-automation.ts`
- DELETE: `social-publishing.ts` after merging
- ACTION: Update imports across 8+ components

#### 2.3 Consolidate Video Functions
**DUPLICATE**: `generateListingVideo()` across 3 files
- KEEP: `listing-video.ts` (newest)
- MERGE: `video-generation.ts` → `listing-video.ts`
- DELETE: `link-to-video.ts` (oldest implementation)
- ACTION: Update 6+ component imports

#### 2.4 Consolidate Lead Functions
**DUPLICATE**: Lead scoring appears in 3 files
- CONSOLIDATE: Keep in `lead-intelligence.ts`
- IMPORT: From `ai-predictions.ts` and `lead-scraping-config.ts`

#### 2.5 Consolidate Contact Functions
**DUPLICATE**: Contact queries across 3 files
- CONSOLIDATE: Single CRM module in `app/actions/crm.ts`
- IMPORT: From `contact-details.ts` and `contact-enrichment.ts`

---

### Phase 3: Database Fixes (Days 8-10)

#### 3.1 Fix Foreign Key Relationships
- Add missing FK constraints to 8 tables
- Create migration script: `531-fix-foreign-keys.sql`

#### 3.2 Fix RLS Policies
- Update chat_sessions RLS for demo mode compatibility
- Fix contacts RLS for proper access control
- Create migration script: `532-fix-rls-policies.sql`

#### 3.3 Add Missing Columns
- Add weather_forecast to open_house_events
- Add compliance_check to social_media_posts
- Create migration script: `533-add-missing-columns.sql`

---

### Phase 4: API Routes (Days 11-12)

#### 4.1 Create Unified API Routes
- `/api/content/generate` - All content generation
- `/api/email/send` - Email sending
- `/api/social/publish` - Social publishing
- `/api/video/generate` - Video generation
- `/api/webhook/incoming` - Webhook handler

#### 4.2 Add Rate Limiting & Validation
- Implement Redis-based rate limiting
- Add request validation middleware
- Add response standardization

---

### Phase 5: Complete Missing Features (Days 13-15)

#### 5.1 Complete Dotloop Integration
- Implement full transaction sync
- Add error recovery
- Add webhook handlers

#### 5.2 Complete Video Generation
- Implement HeyGen API integration
- Add status tracking
- Add webhook for completion

#### 5.3 Complete Showings Sync
- Add calendar sync with major providers
- Add reminder automation
- Add attendee tracking

---

### Phase 6: UI/Component Fixes (Days 16-18)

#### 6.1 Fix Portal Navigation
- Update all portal pages to use PortalNav
- Add missing breadcrumbs
- Fix mobile navigation

#### 6.2 Add Missing Components
- Create global error boundary
- Create loading skeleton components
- Standardize toast notifications

#### 6.3 Fix Broken Integrations
- Update component imports for consolidation
- Fix any broken prop interfaces
- Test all navigation flows

---

### Phase 7: Testing & Polish (Days 19-20)

#### 7.1 Add Unit Tests
- Test action functions
- Test validations
- Test utilities

#### 7.2 Add Integration Tests
- Test database operations
- Test API routes
- Test complex workflows

#### 7.3 Performance Optimization
- Implement pagination
- Add data caching
- Optimize images

---

## CONSOLIDATION CHECKLIST

### Duplicates to Remove
- [ ] Remove `generateEmail()` from `content-studio.ts`
- [ ] Remove `generateEmail()` from `communications.ts`
- [ ] Remove `publishPost()` from `social-publishing.ts`
- [ ] Remove `generateListingVideo()` from `video-generation.ts`
- [ ] Remove `generateListingVideo()` from `link-to-video.ts`
- [ ] Remove duplicate `getContacts()` implementations
- [ ] Remove duplicate `updateContact()` implementations
- [ ] Delete `social-publishing.ts` file
- [ ] Delete `link-to-video.ts` file
- [ ] Update all imports (50+ files)

### Files to Merge
- [ ] `communications.ts` → `email-campaign-automation.ts`
- [ ] `contact-enrichment.ts` → `crm.ts`
- [ ] `video-generation.ts` → `listing-video.ts`
- [ ] `lead-scraping-config.ts` → `lead-intelligence.ts`
- [ ] `ai-predictions.ts` (merge lead-related functions) → `lead-intelligence.ts`

### New Files to Create
- [ ] `lib/validations/index.ts`
- [ ] `lib/constants/index.ts`
- [ ] `lib/errors/index.ts`
- [ ] `lib/services/content-generation.ts`
- [ ] `lib/services/email-service.ts`
- [ ] `lib/services/social-media-service.ts`
- [ ] `api/content/generate/route.ts`
- [ ] `api/email/send/route.ts`
- [ ] `api/social/publish/route.ts`

### Migrations to Create
- [ ] `scripts/531-fix-foreign-keys.sql`
- [ ] `scripts/532-fix-rls-policies.sql`
- [ ] `scripts/533-add-missing-columns.sql`

### Components to Fix
- [ ] Update all portal pages for consistent navigation
- [ ] Add error boundary to app/layout.tsx
- [ ] Add loading states to all list views
- [ ] Fix mobile responsiveness in portal

---

## ESTIMATED EFFORT

**Total Time**: 20 days of focused development

### Breakdown:
- Phase 1 (Foundation): 3 days
- Phase 2 (Consolidation): 4 days
- Phase 3 (Database): 3 days
- Phase 4 (API): 2 days
- Phase 5 (Missing Features): 3 days
- Phase 6 (UI/Components): 3 days
- Phase 7 (Testing): 2 days

---

## RISK MITIGATION

### Risk: Breaking Changes
**Mitigation**: 
- Create feature branch for all changes
- Test all imports after consolidation
- Use find-and-replace with verification

### Risk: Data Loss
**Mitigation**:
- Database backup before any schema changes
- Test migrations on staging first
- Keep old tables temporarily with `_deprecated` suffix

### Risk: Performance Issues
**Mitigation**:
- Monitor query performance after consolidation
- Keep query caching strategy
- Test with production-like data volumes

---

## VERIFICATION CHECKLIST

After completion, verify:
- [ ] All duplicate functions removed
- [ ] All TODO/FIXME markers completed or documented
- [ ] All imports updated and working
- [ ] All database migrations applied
- [ ] All API routes functional
- [ ] Portal navigation complete
- [ ] Mobile responsiveness tested
- [ ] Unit tests passing (coverage > 80%)
- [ ] E2E tests passing
- [ ] No console errors in dev/prod
- [ ] Performance benchmarks met

---

## NEXT STEP

Ready to begin Phase 1: Foundation setup?

Execute in this order:
1. Create `lib/validations/index.ts` with shared schemas
2. Create `lib/constants/index.ts` with shared constants
3. Create `lib/errors/index.ts` with error handling
4. Update `services/supabaseService.ts` to use new validations

Would you like me to start?
