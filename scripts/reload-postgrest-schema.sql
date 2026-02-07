-- Reload PostgREST schema cache
-- This notifies PostgREST to refresh its schema cache so it can see newly created tables
NOTIFY pgrst, 'reload schema';
