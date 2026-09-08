-- Keep schema 11 and use a compatible reader build for rollback. Removing these
-- indexes while a v3 reader is serving pages would invalidate its consistency proof.
DO $$ BEGIN RAISE EXCEPTION 'recovery pagination metadata must be retained; use a compatible build'; END $$;
