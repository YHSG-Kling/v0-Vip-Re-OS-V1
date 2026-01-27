# Production Readiness - Consolidation Plan

## STATUS: IN PROGRESS

### Completed Fixes:
- [x] Fixed all broken import paths (supabaseService imports)
- [x] Added MOCK_CRM_LEADS and MOCK_FAVORITES exports
- [x] Restored lib/communications/index.tsx with re-exports
- [x] All pages using correct @/services/supabaseService path

### Architecture Pattern (Production-Ready):
- **Data Fetching**: SWR hooks via `hooks/use-dashboard-data.ts`
- **Data Mutations**: Server actions + supabaseService methods
- **Centralized Exports**: `app/actions/index.ts` for clean imports

---

## CRITICAL DUPLICATIONS IDENTIFIED

### 1. Communication Functions (HIGH PRIORITY)
**Files with duplicate send functions:**
- `app/actions/communications.ts` - `sendSMS()`, `sendEmail()`
- `lib/services/communication.service.tsx` - `sendSMS()`, `sendEmail()`
- `lib/communications/index.tsx` - `sendEmail()`
- `app/actions/workflows.ts` - `sendMessage()`

**Resolution:** Consolidate all to `lib/services/communication.service.tsx` as the single source

---

### 2. CMA (Comparative Market Analysis) Functions (HIGH PRIORITY)
**Files with duplicate CMA functions:**
- `app/actions/ai-cma.ts` - `generateAICMA()` - Main CMA system
- `app/actions/ai-cma-analysis.ts` - `aiGenerateCMA()` - Duplicate
- `app/actions/ai-predictions.ts` - `generateAICMA()` - Another duplicate

**Resolution:** Keep `app/actions/ai-cma.ts` as canonical, delete duplicates

---

### 3. Contact Functions (MEDIUM PRIORITY)
**Files with overlapping contact functions:**
- `app/actions/crm.ts` - `createContact()`, `updateContact()`, `deleteContact()`
- `app/actions/contact-details.ts` - `getContactDetails()`, various contact getters
- `app/actions/contact-enrichment.ts` - `getContactsNeedingLifeChangeCheck()`
- `app/actions/credit-copilot.ts` - `updateContactCreditStatus()`
- `app/actions/portal-settings.ts` - `updateContactProfile()`

**Resolution:** `crm.ts` for CRUD, domain-specific files for specialized functions

---

### 4. Multiple Supabase Client Imports (LOW PRIORITY - Already Centralized)
**Correctly centralized in:**
- `lib/supabase/client.ts` - Browser client (singleton)
- `lib/supabase/server.ts` - Server client

**Status:** GOOD - All actions import from these centralized locations

---

## ACTION ITEMS

### Phase 1: Fix Communications (Immediate)
1. Update `app/actions/communications.ts` to re-export from `lib/services/communication.service.tsx`
2. Remove duplicate implementations
3. Update all imports across codebase

### Phase 2: Fix CMA Functions (Immediate)
1. Keep `app/actions/ai-cma.ts` as canonical
2. Delete `app/actions/ai-cma-analysis.ts`
3. Remove `generateAICMA` from `app/actions/ai-predictions.ts`
4. Update all imports

### Phase 3: Standardize API Routes
**Pattern to follow:**
- API routes for external webhooks/integrations
- Server actions for internal app functionality
- No duplicate endpoints

### Phase 4: Verify Data Flow
- Ensure all pages use hooks from `hooks/use-dashboard-data.ts`
- Server actions handle mutations
- No direct `supabaseService` calls in pages (use actions/hooks)

---

## FILES TO DELETE (After Consolidation)
- `app/actions/ai-cma-analysis.ts` (duplicate of ai-cma.ts)
- `lib/communications/index.tsx` (duplicate of communication.service.tsx)

## FILES TO UPDATE
- `app/actions/communications.ts` - Re-export from service
- `app/actions/ai-predictions.ts` - Remove generateAICMA function
- `app/actions/workflows.ts` - Use consolidated communication service
