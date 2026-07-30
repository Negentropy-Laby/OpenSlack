-- GS1-B Organization Graph PostgreSQL shadow store.
--
-- Canonical Snapshot and Delta bytes are the integrity authority. PostgreSQL
-- JSON representations may be added later as rebuildable indexes, but they
-- must never replace the bytea columns below as hash authority.

BEGIN;

CREATE OR REPLACE FUNCTION organization_graph_reject_immutable_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is immutable and does not allow UPDATE or DELETE', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE graph_snapshots (
    scenario_instance_id TEXT NOT NULL,
    cursor TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    canonical_bytes BYTEA NOT NULL CHECK (octet_length(canonical_bytes) > 0),
    integrity_hash TEXT NOT NULL CHECK (integrity_hash ~ '^sha256:[0-9a-f]{64}$'),
    projector_version TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL,
    stored_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (scenario_instance_id, cursor),
    UNIQUE (scenario_instance_id, revision)
);

CREATE TABLE graph_deltas (
    scenario_instance_id TEXT NOT NULL,
    from_cursor TEXT NOT NULL,
    to_cursor TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 2),
    canonical_bytes BYTEA NOT NULL CHECK (octet_length(canonical_bytes) > 0),
    integrity_hash TEXT NOT NULL CHECK (integrity_hash ~ '^sha256:[0-9a-f]{64}$'),
    generated_at TIMESTAMPTZ NOT NULL,
    stored_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (scenario_instance_id, from_cursor, to_cursor),
    UNIQUE (scenario_instance_id, revision),
    FOREIGN KEY (scenario_instance_id, from_cursor)
        REFERENCES graph_snapshots (scenario_instance_id, cursor),
    FOREIGN KEY (scenario_instance_id, to_cursor)
        REFERENCES graph_snapshots (scenario_instance_id, cursor),
    CHECK (from_cursor <> to_cursor)
);

CREATE TABLE graph_heads (
    scenario_instance_id TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    snapshot_integrity_hash TEXT NOT NULL
        CHECK (snapshot_integrity_hash ~ '^sha256:[0-9a-f]{64}$'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (scenario_instance_id, cursor)
        REFERENCES graph_snapshots (scenario_instance_id, cursor),
    UNIQUE (scenario_instance_id, revision)
);

CREATE TABLE graph_ingest_receipts (
    receipt_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL
        CHECK (operation IN ('snapshot_ingest', 'delta_ingest')),
    status TEXT NOT NULL
        CHECK (status IN ('accepted', 'reconciliation_required')),
    scenario_instance_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint BYTEA NOT NULL
        CHECK (octet_length(request_fingerprint) = 32),
    previous_cursor TEXT,
    cursor TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    snapshot_integrity_hash TEXT NOT NULL
        CHECK (snapshot_integrity_hash ~ '^sha256:[0-9a-f]{64}$'),
    delta_integrity_hash TEXT
        CHECK (delta_integrity_hash IS NULL OR delta_integrity_hash ~ '^sha256:[0-9a-f]{64}$'),
    committed_at TIMESTAMPTZ,
    reconciliation_token TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (scenario_instance_id, idempotency_key),
    CHECK (
        (status = 'accepted'
            AND committed_at IS NOT NULL
            AND reconciliation_token IS NULL)
        OR (status = 'reconciliation_required'
            AND committed_at IS NULL
            AND reconciliation_token IS NOT NULL)
    ),
    CHECK (
        (revision = 1 AND previous_cursor IS NULL)
        OR (revision > 1 AND previous_cursor IS NOT NULL)
    ),
    CHECK (
        (operation = 'snapshot_ingest' AND delta_integrity_hash IS NULL)
        OR (operation = 'delta_ingest' AND delta_integrity_hash IS NOT NULL)
    )
);

CREATE INDEX graph_snapshots_scenario_revision_idx
    ON graph_snapshots (scenario_instance_id, revision);
CREATE INDEX graph_deltas_scenario_revision_idx
    ON graph_deltas (scenario_instance_id, revision);
CREATE INDEX graph_receipts_scenario_accepted_idx
    ON graph_ingest_receipts (scenario_instance_id, revision);

CREATE TRIGGER graph_snapshots_immutable
BEFORE UPDATE OR DELETE ON graph_snapshots
FOR EACH ROW EXECUTE FUNCTION organization_graph_reject_immutable_mutation();

CREATE TRIGGER graph_deltas_immutable
BEFORE UPDATE OR DELETE ON graph_deltas
FOR EACH ROW EXECUTE FUNCTION organization_graph_reject_immutable_mutation();

CREATE TRIGGER graph_ingest_receipts_immutable
BEFORE UPDATE OR DELETE ON graph_ingest_receipts
FOR EACH ROW EXECUTE FUNCTION organization_graph_reject_immutable_mutation();

COMMIT;
