BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM governance_authority_routes LIMIT 1)
       OR EXISTS (SELECT 1 FROM governance_authority_receipts LIMIT 1)
       OR EXISTS (SELECT 1 FROM governance_authority_events LIMIT 1)
       OR EXISTS (SELECT 1 FROM governance_authority_audit_deliveries LIMIT 1) THEN
        RAISE EXCEPTION 'refusing to remove GS6 governance authority schema while authority records exist';
    END IF;
END;
$$;

DROP TABLE governance_authority_audit_deliveries;
DROP FUNCTION governance_authority_audit_delivery_transition();
DROP TABLE governance_authority_events;
DROP TABLE governance_authority_receipts;
DROP TABLE governance_authority_record_versions;
DROP TABLE governance_authority_heads;
DROP TABLE governance_authority_routes;
DROP FUNCTION governance_authority_reject_immutable_mutation();

COMMIT;
