# Contact CRM Functionality Fixes - Root Cause Analysis

**Date**: 2026-04-09  
**System**: VIP Real Estate OS - Contact Record CRM  
**Status**: Production Issues - All features exist in backend, UI wiring broken

---

## SCHEMA VERIFICATION COMPLETE

### ✅ Tables Exist (Confirmed in Supabase)
- `tours` (id, contact_id, agent_id, tour_date, status, notes, all_confirmed)
- `tour_stops` (id, tour_id, listing_id, property_address, order_index, buyer_interest_level, feedback)
- `property_alerts` (id, contact_id, alert_name, min_price, max_price, property_types, is_active)
- `buyer_financial_profiles` (id, contact_id, finance_type, pre_approval_amount, is_cash_buyer)
- `conversations` (id, contact_id, agent_id, status, message_count)
- `messages` (id, conversation_id, direction, body, created_at)

### ❌ Missing Schema
- `contacts.isa_enabled` - DOES NOT EXIST in schema
- Need to check if using separate table for AI ISA settings

---

## ROOT CAUSE IDENTIFICATION

### 1. BUYER CANNOT CREATE TOURS
**Status**: ✅ Backend Complete | ❌ UI Broken  
**Root Cause**: UI not calling action correctly  
**Files Involved**:
- Action: `/app/actions/tour-planner.ts` → `createTourPlan()` EXISTS
- Schema: `tours`, `tour_stops` tables EXIST
- UI: Buyer overview client has "Coming soon" stub instead of functional form

**Fix Required**:
- Wire "Schedule a Tour" button to call `createTourPlan` action
- Add tour creation dialog with property selection
- Remove "Coming soon" stub

---

### 2. ALERTS CRASH WHEN CREATED  
**Status**: ✅ Backend Complete | ⚠️ Validation Issue  
**Root Cause**: Missing required fields or schema mismatch  
**Files Involved**:
- Action: `/app/actions/property-alerts/alert-actions.ts` → `createPropertyAlert()` EXISTS
- Schema: `property_alerts` table EXISTS with all columns
- Error: Likely validation failure or missing brokerage_id

**Fix Required**:
- Add proper error handling in alert creation
- Validate all required fields before submission
- Add user-friendly error messages
- Check auth context for brokerage_id

---

### 3. AI ISA TOGGLE DOES NOTHING
**Status**: ⚠️ Backend Incomplete | ❌ Schema Missing  
**Root Cause**: No `contacts.isa_enabled` column in schema  
**Files Involved**:
- Action: `enableAIPilot` function imported but schema column doesn't exist
- Schema: `contacts` table has NO `isa_enabled` or `ai_isa_owner` column

**Fix Required**:
- Check if AI ISA settings stored in separate table
- If not, add migration to create `contacts.ai_isa_enabled` boolean column
- Wire toggle button to update action
- Show loading state while updating

---

### 4. MESSAGE GENERATES BUT CANNOT SEND
**Status**: ✅ Generation Complete | ❌ Send Broken  
**Root Cause**: UI generates draft but "Send" button not wired  
**Files Involved**:
- Generate: `generateAIDraft` action EXISTS
- Send: Need to call message send action
- Schema: `messages`, `conversations` tables EXIST

**Fix Required**:
- Find or create message send action
- Wire "Send" button to insert message into DB
- Update conversation record
- Show success/error feedback

---

### 5. NO CASH VS FINANCING SELECTOR
**Status**: ✅ Backend Complete | ❌ UI Missing  
**Root Cause**: UI doesn't render finance type selector  
**Files Involved**:
- Schema: `buyer_financial_profiles.finance_type` column EXISTS
- No UI component to set this value

**Fix Required**:
- Add financing type selector to buyer overview
- Options: "cash", "financing"
- Update `buyer_financial_profiles` on change
- Show pre-approval fields when "financing" selected

---

### 6. AI HELPER INPUT BUT NO RESPONSE  
**Status**: ⚠️ Backend Exists | ❌ Rendering Broken  
**Root Cause**: Response generated but not displayed in UI  
**Files Involved**:
- Action: Multiple AI actions exist (assistant, ai-chat, etc.)
- UI: Agent Assistant panel exists but response rendering broken

**Fix Required**:
- Check Agent Assistant component response handling
- Ensure state updates when response received
- Display AI response in chat interface
- Add error handling for failed responses

---

## IMPLEMENTATION PRIORITY

1. **AI ISA Toggle** - Check schema, add column if needed, wire toggle
2. **Cash/Financing Selector** - Simple UI + DB update
3. **Message Send** - Complete the message flow
4. **AI Helper Response** - Fix response rendering
5. **Tours** - Remove stub, add creation dialog
6. **Alerts** - Fix validation/error handling

---

## NEXT STEPS

1. Search for existing AI ISA settings table or add column
2. Implement fixes file-by-file following kernel architecture
3. Test each fix end-to-end
4. Remove all "Coming soon" stubs
5. Ensure every button/feature works UI → DB → UI
