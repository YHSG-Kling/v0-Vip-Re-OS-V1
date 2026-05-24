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
-- FLOW 5 — OUTSIDE PROPERTY: buyer tours + buys a non-MLS property (NAR-gated)
-- NAR 2024: an ACTIVE buyer_broker_agreement is required before a showing
-- (enforced in app/actions/showings.ts via lib/buyer-broker/gate.ts). An active
-- BBA needs a commission value (CHECK). External property = synthetic listing +
-- showings.external_* metadata (showings.listing_id is NOT NULL). Valid enums:
-- buyer_broker_agreements.agreement_type ∈ {exclusive,non_exclusive,showing_only,open}.
INSERT INTO leads (id, brokerage_id, agent_id, lifecycle_state, lead_type, source, first_name, last_name, email, tcpa_consent) VALUES
 ('e0000000-0000-0000-0000-0000000d0001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','assigned','buying','E2E_EXT_BUY','Tina','Tourbuyer','tina.extbuy@example.com',true);
INSERT INTO contacts (id, brokerage_id, agent_id, lifecycle_state, contact_type, buyer_stage, first_name, last_name, email, status, tcpa_consent) VALUES
 ('e0000000-0000-0000-0000-0000000d0002','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','assigned','buyer','BUYER_TOUR_ELIGIBLE','Tina','Tourbuyer','tina.extbuy@example.com','new',true);
UPDATE leads SET contact_id='e0000000-0000-0000-0000-0000000d0002' WHERE id='e0000000-0000-0000-0000-0000000d0001';
INSERT INTO buyer_broker_agreements (id, brokerage_id, buyer_contact_id, agent_id, created_by, agreement_type, status, commission_percentage, signed_at) VALUES
 ('e0000000-0000-0000-0000-0000000d0004','b0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-0000000d0002','c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002','exclusive','active',2.5, now());
INSERT INTO listings (id, brokerage_id, agent_id, address, city, state, lifecycle_stage) VALUES
 ('e0000000-0000-0000-0000-0000000d0003','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','999 Outside Property Rd','Tampa','FL','LEAD');
INSERT INTO showings (id, brokerage_id, listing_id, contact_id, agent_id, scheduled_at, status, external_source, external_address, external_mls_id, completed_at) VALUES
 ('e0000000-0000-0000-0000-0000000d0005','b0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-0000000d0003','e0000000-0000-0000-0000-0000000d0002','c0000000-0000-0000-0000-000000000002', now(),'completed','external_mls','999 Outside Property Rd, Tampa, FL','EXT-12345', now());
INSERT INTO offers (id, brokerage_id, agent_id, contact_id, listing_id, offer_price, status, submitted_at) VALUES
 ('e0000000-0000-0000-0000-0000000d0006','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000d0002','e0000000-0000-0000-0000-0000000d0003',425000,'accepted', now());
INSERT INTO transactions (id, brokerage_id, agent_id, contact_id, buyer_contact_id, listing_id, offer_id, deal_name, deal_type, stage, status, purchase_price, contract_date) VALUES
 ('e0000000-0000-0000-0000-0000000d0007','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-0000000d0002','e0000000-0000-0000-0000-0000000d0002','e0000000-0000-0000-0000-0000000d0003','e0000000-0000-0000-0000-0000000d0006','999 Outside Property Rd','buyer','CLOSED','closed',425000, now()::date);
UPDATE contacts SET buyer_stage='BUYER_CLOSED' WHERE id='e0000000-0000-0000-0000-0000000d0002';
-- VERIFY (expect bba active, external showing, txn CLOSED, no in-house seller)
SELECT bba.status, s.external_mls_id, t.stage, t.seller_contact_id IS NULL AS external_no_seller
FROM transactions t JOIN buyer_broker_agreements bba ON bba.buyer_contact_id=t.buyer_contact_id
JOIN showings s ON s.listing_id=t.listing_id WHERE t.id='e0000000-0000-0000-0000-0000000d0007';
-- CLEANUP
DELETE FROM transactions WHERE id='e0000000-0000-0000-0000-0000000d0007';
DELETE FROM offers WHERE id='e0000000-0000-0000-0000-0000000d0006';
DELETE FROM showings WHERE id='e0000000-0000-0000-0000-0000000d0005';
DELETE FROM buyer_broker_agreements WHERE id='e0000000-0000-0000-0000-0000000d0004';
DELETE FROM listings WHERE id='e0000000-0000-0000-0000-0000000d0003';
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
-- FINAL CLEANUP GUARD — confirm zero leftover test rows (expect all 0)
-- ============================================================================
SELECT
 (SELECT count(*) FROM raw_scraped_leads WHERE source='RUNSKILL_TEST') AS raw_left,
 (SELECT count(*) FROM leads WHERE source IN ('RUNSKILL_TEST','E2E_CYCLE','E2E_EXT_BUY','E2E_OUTAGENT')) AS leads_left,
 (SELECT count(*) FROM contacts WHERE email IN ('runskill@example.com','txnclient@example.com','sally.e2ecycle@example.com','bob.e2ecycle@example.com','tina.extbuy@example.com','sam.outagent@example.com','ext.buyer.outagent@example.com')) AS contacts_left,
 (SELECT count(*) FROM transactions WHERE deal_name IN ('RUNSKILL_TXN','123 E2E Cycle Way','999 Outside Property Rd','77 Our Listing Blvd')) AS txn_left,
 (SELECT count(*) FROM listings WHERE address IN ('RUNSKILL_LISTING','123 E2E Cycle Way','999 Outside Property Rd','77 Our Listing Blvd')) AS listings_left,
 (SELECT count(*) FROM outside_agents WHERE email='oscar@externalrealty.com') AS outside_agents_left;
