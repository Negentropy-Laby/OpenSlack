-- GS1-B Organization Graph PostgreSQL shadow store rollback.

BEGIN;

DROP TRIGGER IF EXISTS graph_ingest_receipts_immutable ON graph_ingest_receipts;
DROP TRIGGER IF EXISTS graph_deltas_immutable ON graph_deltas;
DROP TRIGGER IF EXISTS graph_snapshots_immutable ON graph_snapshots;

DROP TABLE IF EXISTS graph_ingest_receipts CASCADE;
DROP TABLE IF EXISTS graph_heads CASCADE;
DROP TABLE IF EXISTS graph_deltas CASCADE;
DROP TABLE IF EXISTS graph_snapshots CASCADE;

DROP FUNCTION IF EXISTS organization_graph_reject_immutable_mutation();

COMMIT;
