-- =====================================================
-- MIGRATION 024: Education Video Templates Seed
-- =====================================================
-- Seeds 12 system-level education templates covering key
-- real estate education categories for buyers and sellers.
-- brokerage_id = NULL means system/global template.
-- =====================================================

INSERT INTO video_templates (
  template_name, category, script_type, is_active, is_system,
  duration_seconds, sort_order, tags, description
) VALUES
  -- First-Time Buyer
  ('The Home Buying Process Explained',    'education', 'buyer_education',  true, true, 90,  1,  ARRAY['buyer','first-time','process'],    'Step-by-step overview of buying a home from offer to close'),
  ('How Much Home Can You Afford?',        'education', 'buyer_education',  true, true, 60,  2,  ARRAY['buyer','finance','pre-approval'],  'Explaining DTI ratios and what lenders look at'),
  -- Mortgage Basics
  ('Fixed vs Adjustable Rate Mortgages',   'education', 'buyer_education',  true, true, 60,  3,  ARRAY['mortgage','rates','finance'],      'Plain-English breakdown of ARM vs fixed-rate loans'),
  ('What Is PMI and Can You Avoid It?',    'education', 'buyer_education',  true, true, 45,  4,  ARRAY['mortgage','pmi','down-payment'],   'Explaining private mortgage insurance and 20% down'),
  -- Closing Process
  ('What Happens at Closing?',             'education', 'buyer_education',  true, true, 60,  5,  ARRAY['closing','buyer','process'],       'What buyers should expect on closing day'),
  ('Closing Costs Demystified',            'education', 'buyer_education',  true, true, 60,  6,  ARRAY['closing','costs','buyer'],         'Breaking down typical closing cost line items'),
  -- Market Education
  ('Is Now a Good Time to Buy?',           'education', 'market_update',    true, true, 60,  7,  ARRAY['market','timing','buyer'],         'How to think about market timing without predicting the future'),
  ('Buyers Market vs Sellers Market',      'education', 'market_update',    true, true, 45,  8,  ARRAY['market','inventory','trends'],     'How market conditions affect your negotiating position'),
  -- Seller Prep
  ('How to Price Your Home to Sell Fast',  'education', 'seller_education', true, true, 60,  9,  ARRAY['seller','pricing','strategy'],     'Pricing strategy explained for sellers'),
  ('5 Staging Tips That Actually Work',    'education', 'seller_education', true, true, 60,  10, ARRAY['seller','staging','prep'],         'Practical, low-cost staging improvements'),
  -- Investment Basics
  ('How Real Estate Builds Wealth',        'education', 'buyer_education',  true, true, 60,  11, ARRAY['investment','wealth','equity'],    'Equity, appreciation, and leverage explained simply'),
  ('Renting vs Buying: The Real Math',     'education', 'buyer_education',  true, true, 60,  12, ARRAY['rent-vs-buy','finance','decision'],'Breaking down the actual financial comparison')
ON CONFLICT DO NOTHING;
