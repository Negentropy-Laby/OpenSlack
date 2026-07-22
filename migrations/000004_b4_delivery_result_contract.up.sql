-- B4 Delivery/Store result-union enforcement.
-- Mirrors notificationstore.ValidateDeliveryResult so direct SQL writes cannot
-- create an attempt history row that the domain would reject.

BEGIN;

ALTER TABLE delivery_attempts
    ADD CONSTRAINT delivery_attempts_result_union_check CHECK (
        (event_kind IN ('claimed', 'replay')
            AND result_kind IS NULL AND outcome_class IS NULL
            AND http_status IS NULL AND error_code IS NULL AND reason IS NULL)
        OR
        (event_kind = 'recovery'
            AND result_kind = 'unknown_result'
            AND outcome_class = 'retryable_failure'
            AND http_status IS NULL AND error_code IS NULL
            AND reason = 'lease_expired_unknown_result')
        OR
        (event_kind = 'outcome' AND (
            (result_kind = 'http_response'
                AND outcome_class = 'success'
                AND http_status BETWEEN 100 AND 999
                AND error_code IS NULL AND reason IS NULL)
            OR
            (result_kind = 'http_response'
                AND outcome_class = 'retryable_failure'
                AND http_status BETWEEN 100 AND 999
                AND reason IS NULL)
            OR
            (result_kind = 'transport_failure'
                AND outcome_class = 'retryable_failure'
                AND http_status IS NULL AND error_code IS NOT NULL
                AND length(error_code) > 0 AND reason IS NULL)
            OR
            (result_kind = 'http_response'
                AND outcome_class = 'permanent_failure'
                AND http_status BETWEEN 100 AND 999
                AND reason IN ('non_retryable_http_status', 'vendor_unreachable', 'deadline_exceeded'))
            OR
            (result_kind = 'transport_failure'
                AND outcome_class = 'permanent_failure'
                AND http_status IS NULL AND error_code IS NOT NULL
                AND length(error_code) > 0
                AND reason IN ('non_retryable_http_status', 'vendor_unreachable', 'deadline_exceeded'))
            OR
            (result_kind = 'policy_termination'
                AND outcome_class = 'permanent_failure'
                AND http_status IS NULL AND error_code IS NULL
                AND reason IN (
                    'attempt_limit', 'deadline_exceeded', 'vendor_unavailable',
                    'destination_rejected', 'credential_unavailable', 'request_unbuildable'
                ))
        ))
    );

COMMIT;
