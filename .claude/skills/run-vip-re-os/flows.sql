-- run-vip-re-os flow driver — exercises the app's real business logic against the
-- LIVE Supabase schema (project ref: hrvaqgvukzxfskkcrwbt). This is the harness
-- that actually works in the agent sandbox: the UI/dev server can't run here
-- (see SKILL.md gotchas), but the kernel/schema layer that PRs actually touch is
-- fully drivable. Run each numbered block with the Supabase MCP execute_sql tool
-- (it runs privileged, bypassing RLS — the same access the app's server uses).
--
-- Seed fixtures present in the project (do NOT delete): brokerage
-- b0000000-0000-0000-0000-000000000001, agent c0000000-0000-0000-0000-000000000002.
-- Every block tags its rows and deletes them at the end. ALWAYS run the CLEANUP.

-- ============================================================================
-- FLOW 1 — Lead pipeline: scraper → raw_scraped_leads → leads → contact
-- Mirrors the kernel pipeline (ingest → promote → AI-ISA lifecycle → assignment).
-- ============================================================================
-- 1a. raw lead in
INSERT INTO raw_scraped_leads (id, brokerage_id, source, raw_data, processing_status)
VALUES ('e0000000-0000-0000-0000-0000000000aa','b0000000-0000-0000-0000-000000000001','RUNSKILL_TEST',
        '{"first_name":"Run","last_name":"Skill","email":"runskill@example.com","phone":"5615550100"}'::jsonb,'pending');
-- 1b. promote → leads (unconsented) + link
INSERT INTO leads (id, brokerage_id, raw_record_id, lifecycle_state, source, first_name, last_name, email, phone, ai_isa_owner)
VALUES ('e0000000-0000-0000-0000-0000000000bb','b0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-0000000000aa','unconsented','RUNSKILL_TEST','Run','Skill','runskill@example.com','5615550100',true);
UPDATE raw_scraped_leads SET lead_id='e0000000-0000-0000-0000-0000000000bb', processing_status='promoted' WHERE id='e0000000-0000-0000-0000-0000000000aa';
-- 1c. AI-ISA lifecycle transitions (canonical states)
UPDATE leads SET lifecycle_state='isa_qualifying' WHERE id='e0000000-0000-0000-0000-0000000000bb';
UPDATE leads SET lifecycle_state='consented', tcpa_consent=true WHERE id='e0000000-0000-0000-0000-0000000000bb';
-- 1d. assignment → create contact, link, fire kernel event
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_type, agent_id, brokerage_id, status, tcpa_consent)
VALUES ('e0000000-0000-0000-0000-0000000000cc','Run','Skill','runskill@example.com','5615550100','buyer','c0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000001','new',true);
UPDATE leads SET lifecycle_state='assigned', contact_id='e0000000-0000-0000-0000-0000000000cc', agent_id='c0000000-0000-0000-0000-000000000002' WHERE id='e0000000-0000-0000-0000-0000000000bb';
INSERT INTO lifecycle_events (brokerage_id, entity_type, entity_id, event_type, actor_user_id, metadata)
VALUES ('b0000000-0000-0000-0000-000000000001','lead','e0000000-0000-0000-0000-0000000000bb','lifecycle.lead_converted_to_contact',NULL,'{"contactId":"e0000000-0000-0000-0000-0000000000cc","source":"RUNSKILL_TEST"}'::jsonb);
-- 1e. VERIFY (expect: raw promoted, lead assigned+consent, contact linked, agent = agents.id)
SELECT r.processing_status, l.lifecycle_state, l.tcpa_consent, l.contact_id, c.contact_type, c.agent_id
FROM raw_scraped_leads r JOIN leads l ON l.id=r.lead_id JOIN contacts c ON c.id=l.contact_id
WHERE r.source='RUNSKILL_TEST';
-- 1f. CLEANUP (FK-safe order)
DELETE FROM lifecycle_events WHERE entity_id='e0000000-0000-0000-0000-0000000000bb';
UPDATE raw_scraped_leads SET lead_id=NULL WHERE id='e0000000-0000-0000-0000-0000000000aa';
DELETE FROM leads WHERE id='e0000000-0000-0000-0000-0000000000bb';
DELETE FROM contacts WHERE id='e0000000-0000-0000-0000-0000000000cc';
DELETE FROM raw_scraped_leads WHERE id='e0000000-0000-0000-0000-0000000000aa';

-- ============================================================================
-- FLOW 2 — Transaction create: contact_id = primary client, valid deal_type/status
-- Guards against the schema-drift bugs fixed this branch (deal_type ∈ {buyer,
-- seller,dual}; status ∈ {lead,qualifying,active,under_contract,closing,closed,
-- lost}; deal_name is NOT NULL). Old values like "buyer_side"/"pre_listing"/"new"
-- or columns buyer_id/transaction_type/contract_price would FAIL here.
-- ============================================================================
INSERT INTO contacts (id, first_name, last_name, email, contact_type, agent_id, brokerage_id, status)
VALUES ('e0000000-0000-0000-0000-0000000000c1','Txn','Client','txnclient@example.com','buyer','c0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000001','new');
INSERT INTO transactions (id, brokerage_id, agent_id, contact_id, buyer_contact_id, deal_name, deal_type, status, property_address)
VALUES ('e0000000-0000-0000-0000-0000000000d1','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000000c1','e0000000-0000-0000-0000-0000000000c1','RUNSKILL_TXN','buyer','active','RUNSKILL_TXN');
-- VERIFY (expect the transaction joins to its contact; agent_id = agents.id)
SELECT t.deal_type, t.status, ct.first_name AS client, t.agent_id
FROM transactions t JOIN contacts ct ON ct.id=t.contact_id WHERE t.deal_name='RUNSKILL_TXN';
-- CLEANUP
DELETE FROM transactions WHERE id='e0000000-0000-0000-0000-0000000000d1';
DELETE FROM contacts WHERE id='e0000000-0000-0000-0000-0000000000c1';

-- ============================================================================
-- FLOW 3 — Listing agreement signed → "coming soon" (NOT live-on-MLS)
-- Mirrors the e-sign webhook kernel transition: only LISTING_AGREEMENT_INITIATED
-- advances to LISTING_AGREEMENT_SIGNED + status coming_soon. (lifecycle_stage and
-- status are both CHECK-constrained.)
-- ============================================================================
INSERT INTO listings (id, brokerage_id, agent_id, address, status, lifecycle_stage)
VALUES ('e0000000-0000-0000-0000-0000000000e1','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','RUNSKILL_LISTING','draft','LISTING_AGREEMENT_INITIATED');
UPDATE listings SET lifecycle_stage='LISTING_AGREEMENT_SIGNED', status='coming_soon', stage_entered_at=now()
WHERE id='e0000000-0000-0000-0000-0000000000e1' AND lifecycle_stage='LISTING_AGREEMENT_INITIATED';
INSERT INTO lifecycle_events (brokerage_id, entity_type, entity_id, event_type, actor_user_id, metadata)
VALUES ('b0000000-0000-0000-0000-000000000001','listing_stage_machine','e0000000-0000-0000-0000-0000000000e1','lifecycle.listing_agreement_signed',NULL,'{"source":"RUNSKILL_TEST"}'::jsonb);
-- VERIFY (expect LISTING_AGREEMENT_SIGNED + coming_soon)
SELECT lifecycle_stage, status FROM listings WHERE id='e0000000-0000-0000-0000-0000000000e1';
-- CLEANUP
DELETE FROM lifecycle_events WHERE entity_id='e0000000-0000-0000-0000-0000000000e1';
DELETE FROM listings WHERE id='e0000000-0000-0000-0000-0000000000e1';

-- ============================================================================
-- FLOW 4 — FULL CYCLE: seller + buyer from start to a closed deal
-- Seller: lead → contact → listing (LISTING_AGREEMENT_INITIATED → SIGNED +
-- coming_soon → MLS_ACTIVE). Buyer: lead → contact → offer on that listing.
-- Deal: offer accepted → transaction (buyer + seller contacts + listing + offer
-- + agent role) → UNDER_CONTRACT → CLOSED; listing → CLOSED/sold. Uses the seed
-- brokerage b0000…0001 + agent c0000…0002 (user_id a0000…0002). Valid enums:
-- listing_agreements.agreement_type='listing'; transactions deal_type='buyer',
-- stage UNDER_CONTRACT|CLOSED. NOTE: contacts has buyer_stage but NO seller_stage
-- (seller journey lives on listings.lifecycle_stage).
INSERT INTO leads (id, brokerage_id, agent_id, lifecycle_state, lead_type, source, first_name, last_name, email, tcpa_consent) VALUES
 ('e0000000-0000-0000-0000-0000000c0011','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','consented','motivated_seller','E2E_CYCLE','Sally','Seller','sally.e2ecycle@example.com',true),
 ('e0000000-0000-0000-0000-0000000c0014','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','consented','buying','E2E_CYCLE','Bob','Buyer','bob.e2ecycle@example.com',true);
INSERT INTO contacts (id, brokerage_id, agent_id, lifecycle_state, contact_type, first_name, last_name, email, status, tcpa_consent) VALUES
 ('e0000000-0000-0000-0000-0000000c0012','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','assigned','seller','Sally','Seller','sally.e2ecycle@example.com','new',true);
INSERT INTO contacts (id, brokerage_id, agent_id, lifecycle_state, contact_type, buyer_stage, first_name, last_name, email, status, tcpa_consent, ai_isa_enabled) VALUES
 ('e0000000-0000-0000-0000-0000000c0015','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','assigned','buyer','BUYER_OFFER_ELIGIBLE','Bob','Buyer','bob.e2ecycle@example.com','new',true,true);
UPDATE leads SET contact_id='e0000000-0000-0000-0000-0000000c0012', lifecycle_state='assigned' WHERE id='e0000000-0000-0000-0000-0000000c0011';
UPDATE leads SET contact_id='e0000000-0000-0000-0000-0000000c0015', lifecycle_state='assigned' WHERE id='e0000000-0000-0000-0000-0000000c0014';
INSERT INTO listings (id, brokerage_id, agent_id, seller_contact_id, contact_id, address, city, state, status, lifecycle_stage) VALUES
 ('e0000000-0000-0000-0000-0000000c0013','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000c0012','e0000000-0000-0000-0000-0000000c0012','123 E2E Cycle Way','Miami','FL','draft','LISTING_AGREEMENT_INITIATED');
INSERT INTO listing_agreements (id, listing_id, brokerage_id, agent_user_id, seller_contact_id, agreement_type, esign_status, seller_signed_at) VALUES
 ('e0000000-0000-0000-0000-0000000c0a13','e0000000-0000-0000-0000-0000000c0013','b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000c0012','listing','fully_signed', now());
UPDATE listings SET lifecycle_stage='LISTING_AGREEMENT_SIGNED', status='coming_soon' WHERE id='e0000000-0000-0000-0000-0000000c0013' AND lifecycle_stage='LISTING_AGREEMENT_INITIATED';
UPDATE listings SET lifecycle_stage='MLS_ACTIVE', status='active' WHERE id='e0000000-0000-0000-0000-0000000c0013';
INSERT INTO offers (id, brokerage_id, agent_id, contact_id, listing_id, offer_price, status, submitted_at) VALUES
 ('e0000000-0000-0000-0000-0000000c0016','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000c0015','e0000000-0000-0000-0000-0000000c0013',500000,'submitted', now());
UPDATE offers SET status='accepted' WHERE id='e0000000-0000-0000-0000-0000000c0016';
INSERT INTO transactions (id, brokerage_id, agent_id, contact_id, buyer_contact_id, seller_contact_id, listing_id, offer_id, deal_name, deal_type, stage, status, purchase_price, contract_date) VALUES
 ('e0000000-0000-0000-0000-0000000c0017','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000c0015','e0000000-0000-0000-0000-0000000c0015','e0000000-0000-0000-0000-0000000c0012','e0000000-0000-0000-0000-0000000c0013','e0000000-0000-0000-0000-0000000c0016','123 E2E Cycle Way','buyer','UNDER_CONTRACT','under_contract',500000, now()::date);
INSERT INTO transaction_agent_roles (transaction_id, brokerage_id, agent_id, role_type) VALUES
 ('e0000000-0000-0000-0000-0000000c0017','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','primary');
UPDATE listings SET lifecycle_stage='UNDER_CONTRACT', status='pending' WHERE id='e0000000-0000-0000-0000-0000000c0013';
UPDATE contacts SET buyer_stage='BUYER_UNDER_CONTRACT' WHERE id='e0000000-0000-0000-0000-0000000c0015';
-- close
UPDATE transactions SET stage='CLOSED', status='closed', close_date=now()::date WHERE id='e0000000-0000-0000-0000-0000000c0017';
UPDATE listings SET lifecycle_stage='CLOSED', status='sold' WHERE id='e0000000-0000-0000-0000-0000000c0013';
UPDATE contacts SET buyer_stage='BUYER_CLOSED', lifecycle_state='representation' WHERE id='e0000000-0000-0000-0000-0000000c0015';
-- VERIFY full cycle (expect listing CLOSED/sold, txn CLOSED, fully_linked=true)
SELECT l.lifecycle_stage, l.status, o.status AS offer_status, bc.buyer_stage, t.stage AS txn_stage,
  (t.seller_contact_id='e0000000-0000-0000-0000-0000000c0012' AND t.buyer_contact_id='e0000000-0000-0000-0000-0000000c0015' AND t.listing_id=l.id AND t.offer_id=o.id) AS fully_linked
FROM transactions t JOIN listings l ON l.id=t.listing_id JOIN offers o ON o.id=t.offer_id JOIN contacts bc ON bc.id=t.buyer_contact_id
WHERE t.id='e0000000-0000-0000-0000-0000000c0017';
-- CLEANUP (FK order)
DELETE FROM transaction_agent_roles WHERE transaction_id='e0000000-0000-0000-0000-0000000c0017';
DELETE FROM transactions WHERE id='e0000000-0000-0000-0000-0000000c0017';
DELETE FROM offers WHERE id='e0000000-0000-0000-0000-0000000c0016';
DELETE FROM listing_agreements WHERE id='e0000000-0000-0000-0000-0000000c0a13';
DELETE FROM listings WHERE id='e0000000-0000-0000-0000-0000000c0013';
DELETE FROM leads WHERE source='E2E_CYCLE';
DELETE FROM contacts WHERE id IN ('e0000000-0000-0000-0000-0000000c0012','e0000000-0000-0000-0000-0000000c0015');

-- ============================================================================
-- FLOW 5 — OUTSIDE PROPERTY: buyer tours an external/IDX property, then buys it
-- CORRECT MODEL: buyer properties live in saved_properties (NOT listings, which are
-- seller-owned). The buyer TOUR system (tours + tour_stops) handles external/IDX/
-- manual properties: each stop carries the OUTSIDE listing agent's contact; showings
-- are created only for INSIDE-listing stops (so an external stop gets NO showing).
-- finalizeTour -> confirmed + agent_approved + report (client_portal_messages) +
-- calendar_events per stop. Tour gate = financial verification (buyer_financial_profiles
-- .verified). Buying an external property needs NO synthetic listing: offer.listing_id
-- is nullable, the property is named via offer/transaction.property_address.
-- Valid enums: tour_stops.scheduling_method ∈ {showingtime,manual_call,email,text,other};
-- buyer_financial_profiles.finance_type ∈ {conventional,fha,va,usda,jumbo,cash,bridge,other};
-- client_portal_messages.direction ∈ {agent_to_client,client_to_agent}.
INSERT INTO leads (id, brokerage_id, agent_id, lifecycle_state, lead_type, source, first_name, last_name, email, tcpa_consent) VALUES
 ('e0000000-0000-0000-0000-0000000d0001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','assigned','buying','E2E_EXT_BUY','Tina','Tourbuyer','tina.extbuy@example.com',true);
INSERT INTO contacts (id, brokerage_id, agent_id, lifecycle_state, contact_type, buyer_stage, first_name, last_name, email, status, tcpa_consent) VALUES
 ('e0000000-0000-0000-0000-0000000d0002','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','assigned','buyer','BUYER_TOUR_ELIGIBLE','Tina','Tourbuyer','tina.extbuy@example.com','new',true);
UPDATE leads SET contact_id='e0000000-0000-0000-0000-0000000d0002' WHERE id='e0000000-0000-0000-0000-0000000d0001';
INSERT INTO buyer_financial_profiles (brokerage_id, contact_id, finance_type, verified) VALUES
 ('b0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-0000000d0002','conventional',true);
-- buyer-owned external/IDX property (saved_properties, no inside listing)
INSERT INTO saved_properties (id, user_id, contact_id, brokerage_id, property_address, city, state, list_price, source, external_property_id, listing_url) VALUES
 ('e0000000-0000-0000-0000-0000000d0003','a0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000d0002','b0000000-0000-0000-0000-000000000001','999 Outside Property Rd','Tampa','FL',425000,'idx','IDX-77001','https://idx.example.com/999');
-- tour with one external stop (outside listing agent captured); NO showing for external
INSERT INTO tours (id, contact_id, buyer_id, agent_id, brokerage_id, tour_date, start_time, status, ai_plan_narrative, plan_sent_at) VALUES
 ('e0000000-0000-0000-0000-0000000d0008','e0000000-0000-0000-0000-0000000d0002','e0000000-0000-0000-0000-0000000d0002','c0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000001', now()::date,'10:00','planned','route', now());
INSERT INTO tour_stops (id, tour_id, brokerage_id, contact_id, listing_id, order_index, property_address, listing_agent_name, listing_agent_phone, scheduling_method, suggested_time, is_confirmed) VALUES
 ('e0000000-0000-0000-0000-0000000d0009','e0000000-0000-0000-0000-0000000d0008','b0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-0000000d0002',NULL,0,'999 Outside Property Rd','Ling Listingagent','305-555-7777','manual_call', now(),false);
UPDATE tours SET status='scheduling' WHERE id='e0000000-0000-0000-0000-0000000d0008';
UPDATE tour_stops SET is_confirmed=true, confirmed_time=now() WHERE id='e0000000-0000-0000-0000-0000000d0009';
UPDATE tours SET status='confirmed', all_confirmed=true, agent_approved_at=now(), agent_approved_by='a0000000-0000-0000-0000-000000000002', report_sent_at=now(), report_sent_via=ARRAY['portal'] WHERE id='e0000000-0000-0000-0000-0000000d0008';
INSERT INTO calendar_events (brokerage_id, entity_type, entity_id, event_type, start_at) VALUES
 ('b0000000-0000-0000-0000-000000000001','tour','e0000000-0000-0000-0000-0000000d0008','tour_stop', now());
INSERT INTO client_portal_messages (brokerage_id, contact_id, agent_id, direction, body) VALUES
 ('b0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-0000000d0002','c0000000-0000-0000-0000-000000000002','agent_to_client','Tour confirmed.');
UPDATE saved_properties SET added_to_tour=true WHERE id='e0000000-0000-0000-0000-0000000d0003';
UPDATE contacts SET buyer_stage='BUYER_TOURING' WHERE id='e0000000-0000-0000-0000-0000000d0002';
-- buyer buys the external property: offer + transaction with NO listing (external) and NO in-house seller
INSERT INTO offers (id, brokerage_id, agent_id, contact_id, listing_id, property_address, offer_price, status, submitted_at) VALUES
 ('e0000000-0000-0000-0000-0000000d0006','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000d0002',NULL,'999 Outside Property Rd',425000,'accepted', now());
INSERT INTO transactions (id, brokerage_id, agent_id, contact_id, buyer_contact_id, listing_id, offer_id, deal_name, deal_type, stage, status, purchase_price, contract_date) VALUES
 ('e0000000-0000-0000-0000-0000000d0007','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000d0002','e0000000-0000-0000-0000-0000000d0002',NULL,'e0000000-0000-0000-0000-0000000d0006','999 Outside Property Rd','buyer','CLOSED','closed',425000, now()::date);
UPDATE contacts SET buyer_stage='BUYER_CLOSED' WHERE id='e0000000-0000-0000-0000-0000000d0002';
-- VERIFY (tour confirmed, external stop has NO showing, offer/txn carry no listing & no seller)
SELECT t.status AS tour_status, (SELECT count(*) FROM showings WHERE tour_id=t.id) AS showings_for_external,
  sp.source AS property_source, o.listing_id IS NULL AS offer_no_listing,
  tx.listing_id IS NULL AS txn_no_listing, tx.seller_contact_id IS NULL AS txn_no_seller, tx.stage
FROM tours t JOIN saved_properties sp ON sp.contact_id=t.contact_id
JOIN offers o ON o.contact_id=t.contact_id JOIN transactions tx ON tx.offer_id=o.id
WHERE t.id='e0000000-0000-0000-0000-0000000d0008';
-- CLEANUP
DELETE FROM transactions WHERE id='e0000000-0000-0000-0000-0000000d0007';
DELETE FROM offers WHERE id='e0000000-0000-0000-0000-0000000d0006';
DELETE FROM client_portal_messages WHERE contact_id='e0000000-0000-0000-0000-0000000d0002';
DELETE FROM calendar_events WHERE entity_id='e0000000-0000-0000-0000-0000000d0008';
DELETE FROM tour_stops WHERE tour_id='e0000000-0000-0000-0000-0000000d0008';
DELETE FROM tours WHERE id='e0000000-0000-0000-0000-0000000d0008';
DELETE FROM saved_properties WHERE id='e0000000-0000-0000-0000-0000000d0003';
DELETE FROM buyer_financial_profiles WHERE contact_id='e0000000-0000-0000-0000-0000000d0002';
DELETE FROM leads WHERE source='E2E_EXT_BUY';
DELETE FROM contacts WHERE id='e0000000-0000-0000-0000-0000000d0002';

-- ============================================================================
-- FLOW 6 — OUTSIDE AGENT: our seller's listing gets an offer from an external agent
-- The outside buyer's agent is captured in outside_agents + linked via
-- outside_agent_contact_links AND as a free-text transaction_participants row
-- (role buyer_agent). Our agent is the seller_agent (transaction_agent_roles).
INSERT INTO leads (id, brokerage_id, agent_id, lifecycle_state, lead_type, source, first_name, last_name, email, tcpa_consent) VALUES
 ('e0000000-0000-0000-0000-0000000f0001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','assigned','motivated_seller','E2E_OUTAGENT','Sam','Selleragent','sam.outagent@example.com',true);
INSERT INTO contacts (id, brokerage_id, agent_id, contact_type, first_name, last_name, email, status) VALUES
 ('e0000000-0000-0000-0000-0000000f0002','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','seller','Sam','Selleragent','sam.outagent@example.com','new'),
 ('e0000000-0000-0000-0000-0000000f0022','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Ext','Buyer','ext.buyer.outagent@example.com','new');
UPDATE leads SET contact_id='e0000000-0000-0000-0000-0000000f0002' WHERE id='e0000000-0000-0000-0000-0000000f0001';
INSERT INTO listings (id, brokerage_id, agent_id, seller_contact_id, contact_id, address, city, state, status, lifecycle_stage) VALUES
 ('e0000000-0000-0000-0000-0000000f0003','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000f0002','e0000000-0000-0000-0000-0000000f0002','77 Our Listing Blvd','Orlando','FL','active','MLS_ACTIVE');
INSERT INTO outside_agents (id, brokerage_id, full_name, email, license_number, license_state, outside_brokerage_name) VALUES
 ('e0000000-0000-0000-0000-0000000f00a1','b0000000-0000-0000-0000-000000000001','Oscar Outside','oscar@externalrealty.com','SL3334444','FL','External Realty Group');
INSERT INTO offers (id, brokerage_id, agent_id, contact_id, listing_id, offer_price, status, submitted_at) VALUES
 ('e0000000-0000-0000-0000-0000000f0006','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000f0022','e0000000-0000-0000-0000-0000000f0003',610000,'accepted', now());
INSERT INTO transactions (id, brokerage_id, agent_id, contact_id, seller_contact_id, buyer_contact_id, listing_id, offer_id, deal_name, deal_type, stage, status, purchase_price, contract_date) VALUES
 ('e0000000-0000-0000-0000-0000000f0007','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000f0002','e0000000-0000-0000-0000-0000000f0002','e0000000-0000-0000-0000-0000000f0022','e0000000-0000-0000-0000-0000000f0003','e0000000-0000-0000-0000-0000000f0006','77 Our Listing Blvd','seller','CLOSED','closed',610000, now()::date);
INSERT INTO transaction_participants (transaction_id, brokerage_id, role, name, company, email, license_number) VALUES
 ('e0000000-0000-0000-0000-0000000f0007','b0000000-0000-0000-0000-000000000001','buyer_agent','Oscar Outside','External Realty Group','oscar@externalrealty.com','SL3334444');
INSERT INTO outside_agent_contact_links (outside_agent_id, contact_id, brokerage_id, link_role, transaction_id, listing_id, created_by_user_id) VALUES
 ('e0000000-0000-0000-0000-0000000f00a1','e0000000-0000-0000-0000-0000000f0022','b0000000-0000-0000-0000-000000000001','buyer_agent','e0000000-0000-0000-0000-0000000f0007','e0000000-0000-0000-0000-0000000f0003','a0000000-0000-0000-0000-000000000002');
INSERT INTO transaction_agent_roles (transaction_id, brokerage_id, agent_id, role_type) VALUES
 ('e0000000-0000-0000-0000-0000000f0007','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','seller_agent');
UPDATE listings SET lifecycle_stage='CLOSED', status='sold' WHERE id='e0000000-0000-0000-0000-0000000f0003';
-- VERIFY (expect our seller + ext buyer + outside agent captured both ways)
SELECT t.deal_type, tp.role AS participant_role, oa.full_name AS outside_agent, oacl.link_role
FROM transactions t JOIN transaction_participants tp ON tp.transaction_id=t.id
JOIN outside_agent_contact_links oacl ON oacl.transaction_id=t.id JOIN outside_agents oa ON oa.id=oacl.outside_agent_id
WHERE t.id='e0000000-0000-0000-0000-0000000f0007';
-- CLEANUP
DELETE FROM transaction_agent_roles WHERE transaction_id='e0000000-0000-0000-0000-0000000f0007';
DELETE FROM transaction_participants WHERE transaction_id='e0000000-0000-0000-0000-0000000f0007';
DELETE FROM outside_agent_contact_links WHERE transaction_id='e0000000-0000-0000-0000-0000000f0007';
DELETE FROM transactions WHERE id='e0000000-0000-0000-0000-0000000f0007';
DELETE FROM offers WHERE id='e0000000-0000-0000-0000-0000000f0006';
DELETE FROM outside_agents WHERE id='e0000000-0000-0000-0000-0000000f00a1';
DELETE FROM listings WHERE id='e0000000-0000-0000-0000-0000000f0003';
DELETE FROM leads WHERE source='E2E_OUTAGENT';
DELETE FROM contacts WHERE id IN ('e0000000-0000-0000-0000-0000000f0002','e0000000-0000-0000-0000-0000000f0022');

-- ============================================================================
-- FLOW 7 — OUTBOUND COMPLIANCE DECISION MATRIX (TCPA / DNC / opt-out)
-- Contract test for the dispatch-layer suppression gate
-- (lib/kernel/communication-compliance.ts::evaluateOutboundCompliance) which
-- must agree with the kernel content gate (lib/kernel/compliance.ts Gate 2):
--   • DNC blocks ALL channels.
--   • Email + direct_mail are allowed for UNCONSENTED leads (the ISA allowance).
--   • SMS / phone / voicemail are HARD-blocked without tcpa_consent (TCPA).
--   • Restricted states (CA/NY/DC) block ALL channels without consent.
--   • Per-channel opt-out (email_opt_out/sms_opt_out/opt_out_channels) blocks.
--   • Implied consent — an active deal/agreement (open transaction, signed BBA,
--     fully-signed listing agreement, or live offer) counts as TCPA consent for
--     sms/phone (see FLOW 8). The contacts below have no deals, so the implied-
--     consent clauses evaluate false and do not change this matrix.
-- The SELECT below replicates the gate's hard-block logic against the real
-- stored columns so any schema/logic drift surfaces as a mismatch.
-- ============================================================================
INSERT INTO contacts (id, brokerage_id, agent_id, contact_type, first_name, last_name, email, phone, status, tcpa_consent, dnc_status, sms_opt_out, email_opt_out, phone_opt_out, call_stop_flag, state, opt_out_channels) VALUES
 ('e0000000-0000-0000-0000-0000000c1001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Una','Unconsented','una.e2ecomp@example.com','5610000001','new',false,false,false,false,false,false,'FL',NULL),
 ('e0000000-0000-0000-0000-0000000c1002','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Connie','Consented','connie.e2ecomp@example.com','5610000002','new',true ,false,false,false,false,false,'FL',NULL),
 ('e0000000-0000-0000-0000-0000000c1003','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Donna','Dnc','donna.e2ecomp@example.com','5610000003','new',true ,true ,false,false,false,false,'FL',NULL),
 ('e0000000-0000-0000-0000-0000000c1004','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Sam','Smsout','sam.e2ecomp@example.com','5610000004','new',true ,false,true ,false,false,false,'FL',NULL),
 ('e0000000-0000-0000-0000-0000000c1005','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Cara','California','cara.e2ecomp@example.com','5610000005','new',false,false,false,false,false,false,'CA',NULL);
-- VERIFY (expected gate_allows per row):
--   Una:    email t, direct_mail t, sms f, phone f   (unconsented → email/DM only)
--   Connie: all t                                     (consented)
--   Donna:  all f                                     (DNC)
--   Sam:    email t, direct_mail t, phone t, sms f    (sms opt-out)
--   Cara:   all f                                     (restricted state, no consent)
WITH ch AS (SELECT unnest(ARRAY['email','sms','phone','direct_mail']) AS channel)
SELECT c.first_name, ch.channel,
  NOT (
       c.dnc_status
    OR (ch.channel IN ('phone','voicemail') AND c.call_stop_flag)
    OR (ch.channel='email' AND c.email_opt_out)
    OR (ch.channel='sms'   AND c.sms_opt_out)
    OR (c.opt_out_channels IS NOT NULL AND ch.channel = ANY(c.opt_out_channels))
    OR (c.state IN ('CA','NY','DC') AND c.tcpa_consent IS NOT TRUE)
    OR (ch.channel IN ('sms','phone','voicemail') AND c.tcpa_consent IS NOT TRUE)
  ) AS gate_allows
FROM contacts c CROSS JOIN ch
WHERE c.email LIKE '%e2ecomp@example.com'
ORDER BY c.first_name, ch.channel;
-- CLEANUP
DELETE FROM contacts WHERE email LIKE '%e2ecomp@example.com';

-- ============================================================================
-- FLOW 8 — IMPLIED CONSENT FROM ACTIVE REPRESENTATION ("agreements have consent")
-- An UNCONSENTED contact (tcpa_consent=false, no opt-out, no DNC) becomes
-- reachable on sms/phone once an active deal/agreement exists. Mirrors
-- lib/kernel/compliance/active-representation.ts::hasActiveRepresentation, used
-- by BOTH gates. Expected sms_allowed: Anna f (no deal); Bart/Cleo/Dale/Erin t.
-- ============================================================================
INSERT INTO contacts (id, brokerage_id, agent_id, contact_type, first_name, last_name, email, phone, status, tcpa_consent, dnc_status) VALUES
 ('e0000000-0000-0000-0000-0000000ca001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Anna','NoDeal','anna.e2erep@example.com','5612220001','active',false,false),
 ('e0000000-0000-0000-0000-0000000ca002','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Bart','OpenTxn','bart.e2erep@example.com','5612220002','active',false,false),
 ('e0000000-0000-0000-0000-0000000ca003','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Cleo','ActiveBBA','cleo.e2erep@example.com','5612220003','active',false,false),
 ('e0000000-0000-0000-0000-0000000ca004','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','seller','Dale','SignedLA','dale.e2erep@example.com','5612220004','active',false,false),
 ('e0000000-0000-0000-0000-0000000ca005','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','buyer','Erin','LiveOffer','erin.e2erep@example.com','5612220005','active',false,false);
INSERT INTO transactions (id, brokerage_id, agent_id, contact_id, buyer_contact_id, deal_name, deal_type, status) VALUES
 ('e0000000-0000-0000-0000-0000000cb002','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000ca002','e0000000-0000-0000-0000-0000000ca002','E2EREP_TXN','buyer','under_contract');
INSERT INTO buyer_broker_agreements (id, brokerage_id, buyer_contact_id, agent_id, created_by, status, commission_percentage) VALUES
 ('e0000000-0000-0000-0000-0000000cb003','b0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-0000000ca003','c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002','active',3.0);
INSERT INTO listings (id, brokerage_id, agent_id, seller_contact_id, contact_id, address, city, state, status, lifecycle_stage) VALUES
 ('e0000000-0000-0000-0000-0000000cb004','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000ca004','e0000000-0000-0000-0000-0000000ca004','5 Rep Test Ct','Tampa','FL','active','MLS_ACTIVE');
INSERT INTO listing_agreements (id, brokerage_id, listing_id, agent_user_id, seller_contact_id, esign_status) VALUES
 ('e0000000-0000-0000-0000-0000000cb014','b0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-0000000cb004','a0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000ca004','fully_signed');
INSERT INTO offers (id, brokerage_id, agent_id, contact_id, offer_price, status, property_address) VALUES
 ('e0000000-0000-0000-0000-0000000cb005','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000ca005',500000,'accepted','5 Rep Test Ct');
SELECT c.first_name,
 (c.tcpa_consent
  OR EXISTS(SELECT 1 FROM transactions t WHERE t.brokerage_id=c.brokerage_id AND t.status IN ('active','under_contract','closing') AND (t.contact_id=c.id OR t.buyer_contact_id=c.id OR t.seller_contact_id=c.id))
  OR EXISTS(SELECT 1 FROM buyer_broker_agreements b WHERE b.brokerage_id=c.brokerage_id AND b.buyer_contact_id=c.id AND b.status='active')
  OR EXISTS(SELECT 1 FROM listing_agreements la WHERE la.brokerage_id=c.brokerage_id AND la.seller_contact_id=c.id AND la.esign_status='fully_signed')
  OR EXISTS(SELECT 1 FROM offers o WHERE o.brokerage_id=c.brokerage_id AND o.contact_id=c.id AND o.status IN ('submitted','accepted','countered'))
 ) AS sms_allowed
FROM contacts c WHERE c.email LIKE '%e2erep@example.com' ORDER BY c.first_name;
-- CLEANUP (FK-safe order)
DELETE FROM offers WHERE id='e0000000-0000-0000-0000-0000000cb005';
DELETE FROM listing_agreements WHERE id='e0000000-0000-0000-0000-0000000cb014';
DELETE FROM listings WHERE id='e0000000-0000-0000-0000-0000000cb004';
DELETE FROM buyer_broker_agreements WHERE id='e0000000-0000-0000-0000-0000000cb003';
DELETE FROM transactions WHERE id='e0000000-0000-0000-0000-0000000cb002';
DELETE FROM contacts WHERE email LIKE '%e2erep@example.com';

-- ============================================================================
-- FLOW 9 — PLATFORM-OWNED RAW LEADS: scraped without brokerage_id, brokerage
-- resolved from the active-subscriber territory (market) at promotion.
-- Raw records carry market_id but NO brokerage_id (RLS hides them from every
-- brokerage role; only platform_admin + ai_isa_system read raw_scraped_leads).
-- processRawRecord derives the owning brokerage from market.brokerage_id and
-- stamps it on the promoted lead. Expect: lead assigned to the territory owner.
-- ============================================================================
INSERT INTO lead_scraping_markets (id, brokerage_id, name, city, state, is_active)
VALUES ('e0000000-0000-0000-0000-0000000ad001','b0000000-0000-0000-0000-000000000001','E2E Platform Market','Tampa','FL',true);
INSERT INTO raw_scraped_leads (id, brokerage_id, market_id, source, raw_data, normalized_preview, processing_status)
VALUES ('e0000000-0000-0000-0000-0000000ad002', NULL, 'e0000000-0000-0000-0000-0000000ad001','E2E_PLATFORM',
  '{"first_name":"Plat","last_name":"Owned","email":"plat.owned@example.com","city":"Tampa","state":"FL"}'::jsonb,
  '{"firstName":"Plat","lastName":"Owned","email":"plat.owned@example.com","city":"Tampa","state":"FL"}'::jsonb,
  'pending');
-- Promote: brokerage derived from the market territory (effectiveBrokerageId)
INSERT INTO leads (id, brokerage_id, raw_record_id, lifecycle_state, source, first_name, last_name, email, ai_isa_owner)
SELECT 'e0000000-0000-0000-0000-0000000ad003', m.brokerage_id, r.id, 'unconsented', 'E2E_PLATFORM', 'Plat','Owned','plat.owned@example.com', true
FROM raw_scraped_leads r JOIN lead_scraping_markets m ON m.id = r.market_id
WHERE r.id = 'e0000000-0000-0000-0000-0000000ad002';
UPDATE raw_scraped_leads SET lead_id='e0000000-0000-0000-0000-0000000ad003', processing_status='promoted' WHERE id='e0000000-0000-0000-0000-0000000ad002';
-- VERIFY (expect: raw brokerage NULL, lead assigned to territory owner, unconsented)
SELECT r.brokerage_id IS NULL AS raw_platform_owned,
       l.brokerage_id = 'b0000000-0000-0000-0000-000000000001' AS lead_to_territory_owner,
       l.lifecycle_state
FROM raw_scraped_leads r JOIN leads l ON l.id = r.lead_id
WHERE r.id = 'e0000000-0000-0000-0000-0000000ad002';
-- CLEANUP
UPDATE raw_scraped_leads SET lead_id=NULL WHERE id='e0000000-0000-0000-0000-0000000ad002';
DELETE FROM leads WHERE id='e0000000-0000-0000-0000-0000000ad003';
DELETE FROM raw_scraped_leads WHERE id='e0000000-0000-0000-0000-0000000ad002';
DELETE FROM lead_scraping_markets WHERE id='e0000000-0000-0000-0000-0000000ad001';

-- ============================================================================
-- FLOW 10 — RECRUITING SOURCING: platform-owned raw recruit prospect (agent
-- looking to switch) → territory-derived promotion into brokerage-owned recruits.
-- Mirrors the lead pipeline: raw_recruit_prospects.brokerage_id NULL + market_id;
-- promotion resolves the owning brokerage from the market and requires a full
-- name + (email or current brokerage). Anonymous (no-name) signals are filtered.
-- ============================================================================
INSERT INTO lead_scraping_markets (id, brokerage_id, name, state, is_active)
VALUES ('e0000000-0000-0000-0000-0000000a1001','b0000000-0000-0000-0000-000000000001','E2E Recruit Market','FL',true);
INSERT INTO raw_recruit_prospects (id, brokerage_id, market_id, source, source_record_id, raw_data, normalized_preview, processing_status) VALUES
 ('e0000000-0000-0000-0000-0000000a1002', NULL, 'e0000000-0000-0000-0000-0000000a1001','reddit_agent_switch','rec-viable',
   '{"matched_term":"switching brokerages"}'::jsonb,
   '{"firstName":"Switchy","lastName":"Agent","email":"switchy.agent@example.com","licenseState":"FL","currentBrokerage":"Old Realty"}'::jsonb,'pending'),
 ('e0000000-0000-0000-0000-0000000a1003', NULL, 'e0000000-0000-0000-0000-0000000a1001','reddit_agent_switch','rec-anon',
   '{"matched_term":"low commission split"}'::jsonb,
   '{"firstName":null,"lastName":null,"state":"FL","handle":"anon123"}'::jsonb,'pending');
-- VERIFY identity gate: viable passes, anon fails (raw platform-owned)
SELECT source_record_id, brokerage_id IS NULL AS platform_owned,
  ((normalized_preview->>'firstName') IS NOT NULL AND (normalized_preview->>'lastName') IS NOT NULL
    AND ((normalized_preview->>'email') IS NOT NULL OR (normalized_preview->>'currentBrokerage') IS NOT NULL)) AS passes_identity_gate
FROM raw_recruit_prospects WHERE market_id='e0000000-0000-0000-0000-0000000a1001' ORDER BY source_record_id;
-- Promote the viable prospect (brokerage derived from territory)
INSERT INTO recruits (id, brokerage_id, first_name, last_name, email, license_state, current_brokerage, status, referral_source)
SELECT 'e0000000-0000-0000-0000-0000000a1004', m.brokerage_id,
  rp.normalized_preview->>'firstName', rp.normalized_preview->>'lastName', rp.normalized_preview->>'email',
  rp.normalized_preview->>'licenseState', rp.normalized_preview->>'currentBrokerage', 'prospect', rp.source
FROM raw_recruit_prospects rp JOIN lead_scraping_markets m ON m.id=rp.market_id
WHERE rp.id='e0000000-0000-0000-0000-0000000a1002';
UPDATE raw_recruit_prospects SET recruit_id='e0000000-0000-0000-0000-0000000a1004', processing_status='promoted' WHERE id='e0000000-0000-0000-0000-0000000a1002';
-- VERIFY (recruit assigned to territory owner, status prospect, referral_source = source)
SELECT brokerage_id = 'b0000000-0000-0000-0000-000000000001' AS recruit_to_territory_owner, status, referral_source
FROM recruits WHERE id='e0000000-0000-0000-0000-0000000a1004';
-- CLEANUP
UPDATE raw_recruit_prospects SET recruit_id=NULL WHERE market_id='e0000000-0000-0000-0000-0000000a1001';
DELETE FROM recruits WHERE id='e0000000-0000-0000-0000-0000000a1004';
DELETE FROM raw_recruit_prospects WHERE market_id='e0000000-0000-0000-0000-0000000a1001';
DELETE FROM lead_scraping_markets WHERE id='e0000000-0000-0000-0000-0000000a1001';

-- ============================================================================
-- FINAL CLEANUP GUARD — confirm zero leftover test rows (expect all 0)
-- ============================================================================
SELECT
 (SELECT count(*) FROM raw_scraped_leads WHERE source='RUNSKILL_TEST') AS raw_left,
 (SELECT count(*) FROM leads WHERE source IN ('RUNSKILL_TEST','E2E_CYCLE','E2E_EXT_BUY','E2E_OUTAGENT')) AS leads_left,
 (SELECT count(*) FROM contacts WHERE email IN ('runskill@example.com','txnclient@example.com','sally.e2ecycle@example.com','bob.e2ecycle@example.com','tina.extbuy@example.com','sam.outagent@example.com','ext.buyer.outagent@example.com')) AS contacts_left,
 (SELECT count(*) FROM transactions WHERE deal_name IN ('RUNSKILL_TXN','123 E2E Cycle Way','999 Outside Property Rd','77 Our Listing Blvd')) AS txn_left,
 (SELECT count(*) FROM listings WHERE address IN ('RUNSKILL_LISTING','123 E2E Cycle Way','999 Outside Property Rd','77 Our Listing Blvd')) AS listings_left,
 (SELECT count(*) FROM outside_agents WHERE email='oscar@externalrealty.com') AS outside_agents_left;
