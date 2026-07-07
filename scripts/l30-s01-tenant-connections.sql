-- l30-s01-tenant-connections.sql — tenant-finished vendor connections join the
-- credential vocabulary: listhub (listing syndication), mls_direct (the
-- tenant's own board feed), opcity (ReadyConnect referral intake). The tenant
-- has the vendor relationship; the platform provides the rail.
ALTER TABLE public.platform_credentials DROP CONSTRAINT platform_credentials_platform_check;
ALTER TABLE public.platform_credentials ADD CONSTRAINT platform_credentials_platform_check
  CHECK (platform = ANY (ARRAY['dotloop','docusign','skyslope','authentisign','formsimplicity','brokermint','showingtime','mls','zillow','realtor_com','idxbroker','facebook','instagram','linkedin','buffer','heygen','google_flow','did','twilio','telnyx','bandwidth','sinch','vapi','plivo','sendgrid','resend','postmark','mailgun','gmail','outlook','google_calendar','stripe','plaid','lob','quickbooks','gohighlevel','followupboss','lofty','hubspot','twilio_subaccount','twilio_byo','pexels','listhub','mls_direct','opcity']));
