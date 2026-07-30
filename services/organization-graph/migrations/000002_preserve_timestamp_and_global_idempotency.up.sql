-- Preserve exact contract timestamps and enforce the globally scoped
-- Idempotency-Key contract for every graph ingest operation.

BEGIN;

ALTER TABLE graph_snapshots
    ALTER COLUMN generated_at TYPE TEXT
    USING (convert_from(canonical_bytes, 'UTF8')::jsonb ->> 'generatedAt');
ALTER TABLE graph_snapshots
    ADD CONSTRAINT graph_snapshots_generated_at_text_check
    CHECK (octet_length(generated_at) BETWEEN 20 AND 64);

ALTER TABLE graph_deltas
    ALTER COLUMN generated_at TYPE TEXT
    USING (convert_from(canonical_bytes, 'UTF8')::jsonb ->> 'generatedAt');
ALTER TABLE graph_deltas
    ADD CONSTRAINT graph_deltas_generated_at_text_check
    CHECK (octet_length(generated_at) BETWEEN 20 AND 64);

ALTER TABLE graph_ingest_receipts
    DROP CONSTRAINT graph_ingest_receipts_scenario_instance_id_idempotency_key_key;
-- Existing cross-scenario duplicate keys intentionally make this migration
-- fail closed. Operators must reconcile or rebuild the non-authoritative shadow
-- store instead of silently choosing one receipt.
ALTER TABLE graph_ingest_receipts
    ADD CONSTRAINT graph_ingest_receipts_idempotency_key_key
    UNIQUE (idempotency_key);

COMMIT;
