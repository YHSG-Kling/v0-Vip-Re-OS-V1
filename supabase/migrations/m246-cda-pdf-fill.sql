-- m246: make the CDA auto-binding produce a REAL artifact. Persist the original
-- AcroForm field name on each binding (so we can target the brokerage PDF's fillable
-- field by its exact name), and store the generated/filled CDA PDF on the CDA itself.
alter table brokerage_cda_template_fields
  add column if not exists pdf_field text;

alter table closing_disclosure_agreement
  add column if not exists generated_pdf_url text,
  add column if not exists generated_pdf_at timestamptz;

comment on column brokerage_cda_template_fields.pdf_field is
  'The exact AcroForm field name on the brokerage CDA PDF this binding fills (from auto-detect); field_key is the normalized key.';
comment on column closing_disclosure_agreement.generated_pdf_url is
  'URL of the brokerage CDA PDF filled with resolved waterfall/transaction values, ready for e-sign + delivery to title.';
