package runnerbindingcontract

import (
	"errors"
	"testing"
)

func TestErrorPrepareAndParseMatchesTypeScriptExactBytes(t *testing.T) {
	t.Parallel()

	value := Record{
		"schema":              ErrorSchema,
		"code":                string(ErrorInvalid),
		"message":             "invalid frame",
		"bindingId":           nil,
		"operation":           nil,
		"reconciliationToken": nil,
	}
	prepared, err := PrepareError(value)
	if err != nil {
		t.Fatal(err)
	}
	const body = "{\"bindingId\":null,\"code\":\"WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID\",\"message\":\"invalid frame\",\"operation\":null,\"reconciliationToken\":null,\"schema\":\"openslack.workflow_runner_authority_binding_error.v1\"}\n"
	if prepared.Schema != PreparedSchema || prepared.Body != body ||
		prepared.BodyHash != "17f9a263b9705e21ed054c64e2cd481e4a20b7d3197fd20f7f7db107ef2ee516" ||
		prepared.IdempotencyKey != IdempotencyPrefix+prepared.BodyHash ||
		prepared.RequestFingerprint != "sha256:d19174050950845dc3a363500b451ee20955de51285a799959e57a3c3cdcafc7" {
		t.Fatalf("prepared error drifted: %+v", prepared)
	}
	parsed, err := ParseErrorBytes([]byte(prepared.Body))
	if err != nil {
		t.Fatalf("parse exact prepared bytes: %v", err)
	}
	if !sameCanonical(parsed, prepared.Value) {
		t.Fatal("parsed value differs from prepared value")
	}
}

func TestErrorParserRejectsNonExactFramingAndCanonicalization(t *testing.T) {
	t.Parallel()

	canonical := []byte("{\"bindingId\":null,\"code\":\"WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID\",\"message\":\"invalid frame\",\"operation\":null,\"reconciliationToken\":null,\"schema\":\"openslack.workflow_runner_authority_binding_error.v1\"}\n")
	for name, input := range map[string][]byte{
		"missing LF":    canonical[:len(canonical)-1],
		"double LF":     append(append([]byte(nil), canonical...), '\n'),
		"CRLF":          append(append([]byte(nil), canonical[:len(canonical)-1]...), '\r', '\n'),
		"leading space": append([]byte{' '}, canonical...),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ParseErrorBytes(input)
			var contractErr *ContractError
			if !errors.As(err, &contractErr) || contractErr.Code != ErrorInvalid {
				t.Fatalf("expected exact-frame invalid error, got %v", err)
			}
		})
	}
}

func TestErrorMessageRejectsECMAScriptLineTerminators(t *testing.T) {
	t.Parallel()
	for _, separator := range []string{"\n", "\r", "\u2028", "\u2029"} {
		value := Record{
			"schema": ErrorSchema, "code": string(ErrorInvalid), "message": "left" + separator + "right",
			"bindingId": nil, "operation": nil, "reconciliationToken": nil,
		}
		_, err := ValidateErrorRecord(value)
		var contractErr *ContractError
		if !errors.As(err, &contractErr) || contractErr.Code != ErrorInvalid || contractErr.Path != "$/message" {
			t.Fatalf("separator %q: expected invalid message, got %v", separator, err)
		}
	}
}
