-- IB1-03 closes the delivery result reason/error-code vocabulary. This keeps
-- sanitized Slack acknowledgement classifications enforceable for direct SQL
-- writers as well as the Go domain.

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM delivery_attempts
        WHERE (
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
                    AND error_code IS NULL
                    AND reason IS NULL)
                OR
                (result_kind = 'http_response'
                    AND outcome_class = 'retryable_failure'
                    AND http_status BETWEEN 100 AND 999
                    AND error_code IN (
                        'fatal_error', 'internal_error', 'ratelimited',
                        'request_timeout', 'service_unavailable'
                    )
                    AND reason IS NULL)
                OR
                (result_kind = 'transport_failure'
                    AND outcome_class = 'retryable_failure'
                    AND http_status IS NULL
                    AND error_code IN (
                        'dns_failure', 'connection_failure', 'tls_failure',
                        'timeout', 'preflight_timeout', 'registry_access_failure'
                    )
                    AND reason IS NULL)
                OR
                (result_kind = 'http_response'
                    AND outcome_class = 'permanent_failure'
                    AND http_status BETWEEN 100 AND 999
                    AND error_code IS NULL
                    AND reason IN (
                        'non_retryable_http_status', 'vendor_unreachable',
                        'deadline_exceeded', 'vendor_rejected', 'vendor_protocol_error'
                    ))
                OR
                (result_kind = 'http_response'
                    AND outcome_class = 'permanent_failure'
                    AND http_status BETWEEN 100 AND 999
                    AND error_code IN (
                        'fatal_error', 'internal_error', 'ratelimited',
                        'request_timeout', 'service_unavailable'
                    )
                    AND reason = 'deadline_exceeded')
                OR
                (result_kind = 'transport_failure'
                    AND outcome_class = 'permanent_failure'
                    AND http_status IS NULL
                    AND error_code IN (
                        'dns_failure', 'connection_failure', 'tls_failure',
                        'timeout', 'preflight_timeout', 'registry_access_failure'
                    )
                    AND reason IN ('vendor_unreachable', 'deadline_exceeded'))
                OR
                (result_kind = 'policy_termination'
                    AND outcome_class = 'permanent_failure'
                    AND http_status IS NULL AND error_code IS NULL
                    AND reason IN (
                        'attempt_limit', 'deadline_exceeded', 'vendor_unavailable',
                        'destination_rejected', 'credential_unavailable', 'request_unbuildable'
                    ))
            ))
        ) IS NOT TRUE
    ) THEN
        RAISE EXCEPTION '000008 cannot close delivery result codes: incompatible historical delivery_attempts rows exist';
    END IF;
END
$$;

ALTER TABLE delivery_attempts
    DROP CONSTRAINT delivery_attempts_result_union_check;

ALTER TABLE delivery_attempts
    ADD CONSTRAINT delivery_attempts_result_union_check CHECK ((
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
                AND error_code IS NULL
                AND reason IS NULL)
            OR
            (result_kind = 'http_response'
                AND outcome_class = 'retryable_failure'
                AND http_status BETWEEN 100 AND 999
                AND error_code IN (
                    'fatal_error', 'internal_error', 'ratelimited',
                    'request_timeout', 'service_unavailable'
                )
                AND reason IS NULL)
            OR
            (result_kind = 'transport_failure'
                AND outcome_class = 'retryable_failure'
                AND http_status IS NULL
                AND error_code IN (
                    'dns_failure', 'connection_failure', 'tls_failure',
                    'timeout', 'preflight_timeout', 'registry_access_failure'
                )
                AND reason IS NULL)
            OR
            (result_kind = 'http_response'
                AND outcome_class = 'permanent_failure'
                AND http_status BETWEEN 100 AND 999
                AND error_code IS NULL
                AND reason IN (
                    'non_retryable_http_status', 'vendor_unreachable',
                    'deadline_exceeded', 'vendor_rejected', 'vendor_protocol_error'
                ))
            OR
            (result_kind = 'http_response'
                AND outcome_class = 'permanent_failure'
                AND http_status BETWEEN 100 AND 999
                AND error_code IN (
                    'fatal_error', 'internal_error', 'ratelimited',
                    'request_timeout', 'service_unavailable'
                )
                AND reason = 'deadline_exceeded')
            OR
            (result_kind = 'transport_failure'
                AND outcome_class = 'permanent_failure'
                AND http_status IS NULL
                AND error_code IN (
                    'dns_failure', 'connection_failure', 'tls_failure',
                    'timeout', 'preflight_timeout', 'registry_access_failure'
                )
                AND reason IN ('vendor_unreachable', 'deadline_exceeded'))
            OR
            (result_kind = 'policy_termination'
                AND outcome_class = 'permanent_failure'
                AND http_status IS NULL AND error_code IS NULL
                AND reason IN (
                    'attempt_limit', 'deadline_exceeded', 'vendor_unavailable',
                    'destination_rejected', 'credential_unavailable', 'request_unbuildable'
                ))
        ))) IS TRUE
    );

COMMIT;
