package authoritycontract

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

type goldenVectors struct {
	Schema          string `json:"schema"`
	ContractVersion string `json:"contractVersion"`
	Authority       string `json:"authority"`
	GoRole          string `json:"goRole"`
	AuthorityClaim  string `json:"authorityClaim"`
	Positive        struct {
		State    json.RawMessage `json:"state"`
		Messages []struct {
			Kind     string          `json:"kind"`
			Input    json.RawMessage `json:"input"`
			Prepared PreparedMessage `json:"prepared"`
		} `json:"messages"`
		Receipts    []json.RawMessage `json:"receipts"`
		Transitions []struct {
			From    RunState `json:"from"`
			To      RunState `json:"to"`
			Allowed bool     `json:"allowed"`
		} `json:"transitions"`
		Decimals []struct {
			Input    string `json:"input"`
			Expected string `json:"expected"`
		} `json:"decimals"`
		USDToNanoUSD []struct {
			Input    string `json:"input"`
			Expected string `json:"expected"`
		} `json:"usdToNanoUsd"`
	} `json:"positive"`
	Negative []struct {
		ID            string          `json:"id"`
		Operation     string          `json:"operation"`
		Input         json.RawMessage `json:"input"`
		ExpectedError struct {
			Code    ErrorCode `json:"code"`
			Path    string    `json:"path"`
			Message string    `json:"message"`
		} `json:"expectedError"`
	} `json:"negative"`
}

func TestFrozenGoldenVectorsParity(t *testing.T) {
	vectors := loadGoldenVectors(t)
	if vectors.Schema != "openslack.workflow_control_authority_golden_vectors.v2" ||
		vectors.ContractVersion != ContractVersion || vectors.Authority != Authority ||
		vectors.GoRole != GoRole || vectors.AuthorityClaim != AuthorityClaim {
		t.Fatalf("golden vector authority identity drifted")
	}
	if _, err := DecodeStateJSON(vectors.Positive.State); err != nil {
		t.Fatalf("positive state: %v", err)
	}
	for _, vector := range vectors.Positive.Messages {
		vector := vector
		t.Run("message/"+vector.Kind, func(t *testing.T) {
			if _, err := DecodeMessageJSON(vector.Input); err != nil {
				t.Fatalf("closed decode: %v", err)
			}
			value, err := parseStrictJSON(vector.Input, MaxJSONDepth, MaxJSONNodes, MaxStringBytes)
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := PrepareMessage(value)
			if err != nil {
				t.Fatalf("prepare: %v", err)
			}
			if !reflect.DeepEqual(prepared, vector.Prepared) {
				t.Fatalf("prepared parity mismatch\n got: %#v\nwant: %#v", prepared, vector.Prepared)
			}
		})
	}
	for index, receipt := range vectors.Positive.Receipts {
		if _, err := DecodeReceiptJSON(receipt); err != nil {
			t.Fatalf("positive receipt %d: %v", index, err)
		}
	}
	for _, transition := range vectors.Positive.Transitions {
		err := ValidateTransition(transition.From, transition.To)
		if (err == nil) != transition.Allowed {
			t.Fatalf("transition %s -> %s: allowed=%v err=%v", transition.From, transition.To, transition.Allowed, err)
		}
	}
	for _, decimal := range vectors.Positive.Decimals {
		result, err := ValidateDecimal(decimal.Input)
		if err != nil || string(result) != decimal.Expected {
			t.Fatalf("decimal %s: result=%s err=%v", decimal.Input, result, err)
		}
	}
	for _, conversion := range vectors.Positive.USDToNanoUSD {
		result, err := CostNanoUSD(conversion.Input)
		if err != nil || string(result) != conversion.Expected {
			t.Fatalf("USD conversion %s: result=%s err=%v", conversion.Input, result, err)
		}
	}
	for _, vector := range vectors.Negative {
		vector := vector
		t.Run("negative/"+vector.ID, func(t *testing.T) {
			err := replayNegativeVector(vector.Operation, vector.Input)
			if err == nil {
				t.Fatal("negative vector unexpectedly passed")
			}
			var contractError *ContractError
			if !errors.As(err, &contractError) {
				t.Fatalf("error is not ContractError: %T %v", err, err)
			}
			if contractError.Code != vector.ExpectedError.Code || contractError.Path != vector.ExpectedError.Path || contractError.Message != vector.ExpectedError.Message {
				t.Fatalf("error parity mismatch\n got:  %#v\nwant: %#v", contractError, vector.ExpectedError)
			}
		})
	}
}

func loadGoldenVectors(t *testing.T) goldenVectors {
	t.Helper()
	contents, err := BundleFile("golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors goldenVectors
	if err := json.Unmarshal(contents, &vectors); err != nil {
		t.Fatalf("decode golden vectors: %v", err)
	}
	return vectors
}

func replayNegativeVector(operation string, input json.RawMessage) error {
	switch operation {
	case "validate_state":
		_, err := DecodeStateJSON(input)
		return err
	case "validate_message":
		_, err := DecodeMessageJSON(input)
		return err
	case "validate_decimal":
		var value any
		if err := json.Unmarshal(input, &value); err != nil {
			return err
		}
		_, err := ValidateDecimal(value)
		return err
	case "transition":
		var value struct {
			From RunState `json:"from"`
			To   RunState `json:"to"`
		}
		if err := json.Unmarshal(input, &value); err != nil {
			return err
		}
		return ValidateTransition(value.From, value.To)
	default:
		return failure(ErrorInvalid, "$/operation", "unsupported golden operation")
	}
}
