-- m452 — the rest of what the authored catalogue carried, merged forward.
--
-- m450 moved the 25 phrases off lib/seed-compliance-rules.ts. Auditing that file
-- for DELETION turned up two things it carried that the survivor did not, which
-- is exactly what the merge-before-delete rule exists to catch.
--
-- ── (1) suggested_alternative: A COLUMN THE READER ALREADY EXPECTS ──────────
--
-- lib/application/compliance-monitoring.ts emits
--     suggestedAlternative: phrase.suggested_alternative
-- on every prohibited-phrase hit, and app/actions/ai-chat.ts surfaces the same
-- field as `alternative`. MEASURED: prohibited_phrases has NO
-- suggested_alternative column. The live columns are
--     id, phrase, phrase_pattern, category, severity, is_active, notes,
--     created_at, updated_at
-- so that field has been `undefined` on every issue this scanner has ever
-- produced. The agent is told what is wrong and never what to write instead.
--
-- This is also a THIRD reason seedComplianceRules() could never have run: it
-- upserts objects carrying suggested_alternative, and PostgREST rejects an
-- unknown column outright (PGRST204). Zero rows, wrong severity vocabulary, and
-- a column that does not exist — three independent failures in one unwired
-- function. "No caller" was the least of it.
--
-- The 19 alternatives below are lifted VERBATIM from the authored file. Six of
-- the 25 phrases had no alternative there and get none here: "no children",
-- "adults only", "ethnic area", "able-bodied" and "kickback" have no compliant
-- rewrite — they are not phrasings to soften, they are statements to remove.
alter table public.prohibited_phrases
  add column if not exists suggested_alternative text;

update public.prohibited_phrases p
   set suggested_alternative = v.alt,
       updated_at = now()
  from (values
    ('perfect for families',                'This home offers generous space and a welcoming layout'),
    ('ideal for couples',                   'This home features a cozy layout'),
    ('great for young professionals',       'This home is ideal for those seeking convenient urban living'),
    ('perfect for retirees',                'This home offers low-maintenance living'),
    ('close to church',                     'Conveniently located near community amenities'),
    ('Christian neighborhood',              'Welcoming community'),
    ('diverse neighborhood',                'Vibrant community'),
    ('no wheelchairs',                      'Please inquire about accessibility features'),
    ('bachelor pad',                        'Stylish studio or one-bedroom'),
    ('man cave',                            'Bonus room or recreation space'),
    ('guaranteed return',                   'Potential for strong returns based on market analysis'),
    ('best agent',                          'Experienced and dedicated agent'),
    ('referral fee',                        'Please review RESPA guidelines for referral arrangements'),
    ('guaranteed approval',                 'We work hard to find financing options that fit your situation'),
    ('no credit check needed',              'Various financing options available'),
    ('investment guaranteed to increase',   'Real estate has historically shown potential for appreciation'),
    ('I can help you',                      'You deserve expert guidance through this process'),
    ('my expertise',                        'Focus on the benefits you will receive'),
    ('master bedroom',                      'primary bedroom/suite/bath'),
    ('no Section 8',                        'Remove this restriction - it may violate fair housing laws')
  ) as v(phrase, alt)
 where p.phrase = v.phrase
   and p.suggested_alternative is distinct from v.alt;

-- ── (2) required_disclosures: THE OTHER EMPTY CATALOGUE ─────────────────────
--
-- MEASURED: required_disclosures = 0 rows, and scanContentComplianceService
-- iterates it exactly the way it iterated the phrase list — `|| []`, so the
-- missing-disclosure check has never once fired either. Same construction as
-- prohibited_phrases and therefore the same ruling: no brokerage_id column,
-- SELECT `true` to authenticated, writes gated on is_platform_admin(). A
-- platform catalogue, seeded in a migration for the same reason.
--
-- ── WHY THREE ROWS AND NOT THE AUTHORED FIVE ────────────────────────────────
--
-- The reader's test is a LITERAL substring match:
--     !content.contentBody.includes(disclosure.disclosure_text)
-- so disclosure_text must be a string that compliant copy actually contains.
-- Two of the authored five fail that test and are deliberately NOT seeded:
--
--   · brokerage_name  → text is "Brokerage Name Required". That is a LABEL, not
--     a disclosure. No real asset contains that string, so seeding it would warn
--     on 100% of email/print/social content forever.
--   · license_number  → text is "Licensed Real Estate Agent". The actual legal
--     requirement is the agent's licence NUMBER, which is a per-agent fact. An
--     agent who writes "License #12345" satisfies the law and would still be
--     warned.
--
-- Both are per-tenant/per-agent facts wearing placeholder text, and this table
-- has no tenant column to hold them. They need a resolver that substitutes
-- brokerages.name and the agent's licence number per asset — which does not
-- exist. Seeding them would turn a gate that never fires into a gate that always
-- fires, and a warning on every compliant asset is worth exactly as little as no
-- warning at all. Reported for a ruling, not guessed at.
--
-- The three below are platform-wide, literal and satisfiable as written.
create unique index if not exists required_disclosures_type_key
  on public.required_disclosures (disclosure_type);

insert into public.required_disclosures
  (disclosure_type, disclosure_text, required_for_channels, required_for_states, placement_requirement)
values
  ('equal_housing',
   'Equal Housing Opportunity',
   array['print','email'], null, 'footer'),
  ('advertising_disclosure',
   'This is a paid advertisement',
   array['social'], null, 'beginning'),
  ('mls_disclaimer',
   'Information deemed reliable but not guaranteed. Data provided by MLS.',
   array['email','print'], null, 'footer')
on conflict (disclosure_type) do update
  set disclosure_text        = excluded.disclosure_text,
      required_for_channels  = excluded.required_for_channels,
      required_for_states    = excluded.required_for_states,
      placement_requirement  = excluded.placement_requirement,
      updated_at             = now();

do $$
declare n_alt int; n_disc int;
begin
  select count(*) into n_alt from public.prohibited_phrases where suggested_alternative is not null;
  select count(*) into n_disc from public.required_disclosures where is_active;
  raise notice 'm452: % phrases now carry a suggested alternative the scanner can surface; % required disclosures seeded (the missing-disclosure check has never fired before now).', n_alt, n_disc;
end $$;
