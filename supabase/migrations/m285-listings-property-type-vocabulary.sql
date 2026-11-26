-- m285 — constrain listings.property_type to the canonical vocabulary.
--
-- Walkthrough [49]: "Property type should be a selection." It was free text at every
-- layer: the column had NO check constraint, and the app carried four different lists
-- (lib/constants PROPERTY_TYPES with 7 values, the listing intake's type union with 6,
-- its AI extraction zod enum with only 3, and state-forms field-defs with 5). A
-- multi-family or commercial listing extracted by the AI was forced into one of three
-- buckets and silently mis-typed.
--
-- The app side now resolves every one of those to lib/constants PROPERTY_TYPES. This
-- closes the data side so the column cannot accept a value the UI would never offer.
-- NULL stays allowed — property type is not known at every stage of intake.
--
-- Verified before applying: 3 listings on file, 0 with a property_type set, 0 that
-- would violate.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_property_type_check;
ALTER TABLE listings ADD CONSTRAINT listings_property_type_check
  CHECK (property_type IS NULL OR property_type = ANY (ARRAY[
    'single_family','condo','townhouse','multi_family','land','commercial','other'
  ]));
