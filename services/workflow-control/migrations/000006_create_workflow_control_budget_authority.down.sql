BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM workflow_control_budget_accounts LIMIT 1)
       OR EXISTS (SELECT 1 FROM workflow_control_budget_reservations LIMIT 1)
       OR EXISTS (SELECT 1 FROM workflow_control_budget_ledger LIMIT 1)
       OR EXISTS (SELECT 1 FROM workflow_control_budget_receipts LIMIT 1)
       OR EXISTS (SELECT 1 FROM workflow_control_budget_reconciliations LIMIT 1) THEN
        RAISE EXCEPTION 'refusing to remove GS9-E2 workflow budget authority schema while budget evidence exists';
    END IF;
END;
$$;

ALTER TABLE workflow_control_budget_reservations
    DROP CONSTRAINT workflow_control_budget_reservations_terminal_ledger_fk;
DROP TABLE workflow_control_budget_reconciliations;
DROP TABLE workflow_control_budget_receipts;
DROP TABLE workflow_control_budget_reservations;
DROP TABLE workflow_control_budget_ledger;
DROP TABLE workflow_control_budget_accounts;
DROP FUNCTION workflow_control_budget_reservation_transition();
DROP FUNCTION workflow_control_budget_account_transition();
DROP FUNCTION workflow_control_budget_reject_immutable_mutation();

COMMIT;
