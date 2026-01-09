-- Seed test users in Supabase for all user types and roles
-- Test Admins
INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, role) VALUES
('admin@nexus.com', 'admin', 'Admin', 'User', 'admin', '$2a$10$abc123admin', 'Nexus Real Estate', 'System Admin');

-- Test Brokers
INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, role) VALUES
('broker@nexus.com', 'broker', 'Broker', 'Manager', 'broker', '$2a$10$abc123broker', 'Nexus Real Estate', 'Broker');

-- Test Agents (multiple agents for testing)
INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, role) VALUES
('agent1@nexus.com', 'agent', 'Sarah', 'Smith', 'sarah.smith', '$2a$10$abc123agent1', 'Nexus Real Estate', 'Senior Agent'),
('agent2@nexus.com', 'agent', 'Mike', 'Johnson', 'mike.johnson', '$2a$10$abc123agent2', 'Nexus Real Estate', 'Agent');

-- Test Transaction Coordinators
INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, role) VALUES
('tc@nexus.com', 'TC', 'Emily', 'Rodriguez', 'emily.rodriguez', '$2a$10$abc123tc', 'Nexus Real Estate', 'Transaction Coordinator');

-- Test Vendors
INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, role) VALUES
('vendor@nexus.com', 'vendor', 'Vendor', 'Partner', 'vendor.partner', '$2a$10$abc123vendor', 'Premium Inspections', 'Home Inspector');

-- Test Lenders
INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, role) VALUES
('lender@nexus.com', 'lender', 'David', 'Loan', 'david.loan', '$2a$10$abc123lender', 'Premier Funding', 'Loan Officer');

-- Test Compliance Officers
INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, role) VALUES
('compliance@nexus.com', 'compliance_officer', 'Compliance', 'Manager', 'compliance.manager', '$2a$10$abc123compliance', 'Nexus Real Estate', 'Compliance Officer');

-- Test Contacts (created by agents)
INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, is_contact, contact_type, contact_persona, created_by) 
SELECT 
  'ftb-test@contacts.com', 'contact', 'John', 'Buyer', 'john.buyer', '$2a$10$abc123ftb', NULL, true, 'buyer', 'first_time_buyer', id
FROM users WHERE email = 'agent1@nexus.com' LIMIT 1;

INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, is_contact, contact_type, contact_persona, created_by) 
SELECT 
  'investor-test@contacts.com', 'contact', 'Jane', 'Investor', 'jane.investor', '$2a$10$abc123investor', NULL, true, 'investor', 'investor', id
FROM users WHERE email = 'agent1@nexus.com' LIMIT 1;

INSERT INTO users (email, user_type, first_name, last_name, username, password_hash, brokerage, is_contact, contact_type, contact_persona, created_by) 
SELECT 
  'seller-test@contacts.com', 'contact', 'Robert', 'Seller', 'robert.seller', '$2a$10$abc123seller', NULL, true, 'seller', 'motivated_seller', id
FROM users WHERE email = 'agent2@nexus.com' LIMIT 1;
