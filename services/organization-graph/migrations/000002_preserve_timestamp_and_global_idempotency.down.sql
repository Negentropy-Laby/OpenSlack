-- Restore the original GS1-B version 1 storage shape.

BEGIN;

ALTER TABLE graph_ingest_receipts
    DROP CONSTRAINT graph_ingest_receipts_idempotency_key_key;
ALTER TABLE graph_ingest_receipts
    ADD CONSTRAINT graph_ingest_receipts_scenario_instance_id_idempotency_key_key
    UNIQUE (scenario_instance_id, idempotency_key);

ALTER TABLE graph_deltas
    DROP CONSTRAINT graph_deltas_generated_at_text_check;
ALTER TABLE graph_deltas
    ALTER COLUMN generated_at TYPE TIMESTAMPTZ
    USING generated_at::timestamptz;

ALTER TABLE graph_snapshots
    DROP CONSTRAINT graph_snapshots_generated_at_text_check;
ALTER TABLE graph_snapshots
    ALTER COLUMN generated_at TYPE TIMESTAMPTZ
    USING generated_at::timestamptz;

COMMIT;
