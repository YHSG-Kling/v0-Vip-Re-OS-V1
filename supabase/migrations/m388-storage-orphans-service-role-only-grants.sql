-- m388 — make "service-role only" true at the GRANT level, not only at RLS.
--
-- m387 enabled RLS on storage_orphaned_objects and deliberately created no
-- policy, so no row is readable by anon/authenticated. The security advisor is
-- still right to flag it: the default grants leave SELECT on the table for both
-- roles, so the table itself remains DISCOVERABLE through the GraphQL/PostgREST
-- schema even though every row is denied. This ledger names raw storage object
-- paths across every tenant and has no end-user surface at all.
revoke all on public.storage_orphaned_objects from anon, authenticated;
