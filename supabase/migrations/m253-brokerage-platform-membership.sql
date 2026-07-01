-- m253-brokerage-platform-membership.sql
--
-- Platform membership: at solo-agent account creation the agent indicates whether their managing
-- BROKERAGE and/or TEAM are also on the platform. Drives disposition routing — broker-side steps (CDA
-- signature, compliance approval) run IN-APP when the brokerage is on-platform, else they route OUT to
-- the agent's configured external form platform. For team/brokerage/multi tiers the org IS the customer
-- (its own broker/admin users run those steps), so these default true.
alter table brokerages
  add column if not exists brokerage_on_platform boolean not null default true,
  add column if not exists team_on_platform      boolean not null default true;

comment on column brokerages.brokerage_on_platform is
  'Solo-agent account: is the agent''s managing brokerage also a platform customer? False → broker-side steps route to the external form platform in settings. Non-solo tiers: true (the org is the customer).';
