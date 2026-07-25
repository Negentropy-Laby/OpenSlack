BEGIN;

ALTER TABLE delivery_attempts
    DROP CONSTRAINT delivery_attempts_result_union_check;

COMMIT;
