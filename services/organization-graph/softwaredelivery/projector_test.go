package softwaredelivery

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

func TestProjectIsDeterministicAndDoesNotAliasInput(t *testing.T) {
	golden := loadProjectorGolden(t)
	input := append([]byte(nil), golden.Cases[0].Input.Source...)
	first, err := Project(input)
	if err != nil {
		t.Fatalf("first Project: %v", err)
	}
	firstBytes, err := graph.SerializeSnapshot(first.Snapshot)
	if err != nil {
		t.Fatalf("serialize first result: %v", err)
	}
	for index := range input {
		input[index] = ' '
	}
	second, err := Project(golden.Cases[0].Input.Source)
	if err != nil {
		t.Fatalf("second Project: %v", err)
	}
	secondBytes, err := graph.SerializeSnapshot(second.Snapshot)
	if err != nil {
		t.Fatalf("serialize second result: %v", err)
	}
	if string(firstBytes) != string(secondBytes) {
		t.Fatal("same source produced different sealed snapshot bytes")
	}
}

func TestProjectFreezesStrictJSONErrors(t *testing.T) {
	tests := []struct {
		name    string
		input   []byte
		code    graph.JSONErrorCode
		offset  int
		message string
	}{
		{name: "bom", input: []byte{0xef, 0xbb, 0xbf, '{', '}'}, code: graph.JSONBOMForbidden, offset: 0, message: "UTF-8 BOM is forbidden"},
		{name: "utf8", input: []byte{'"', 0xff, '"'}, code: graph.JSONUTF8Invalid, offset: 0, message: "JSON input is not valid UTF-8"},
		{name: "syntax", input: []byte("{"), code: graph.JSONSyntaxInvalid, offset: 1, message: "expected a quoted JSON object key"},
		{name: "duplicate", input: []byte(`{"a":1,"a":2}`), code: graph.JSONDuplicateKey, offset: 7, message: "duplicate JSON object key"},
		{name: "limit", input: []byte(strings.Repeat("[", 33) + "0" + strings.Repeat("]", 33)), code: graph.JSONLimitExceeded, offset: 33, message: "JSON nesting depth exceeds its limit"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Project(testCase.input)
			var jsonError *graph.JSONError
			if !errors.As(err, &jsonError) {
				t.Fatalf("error = %T %v, want *organizationgraph.JSONError", err, err)
			}
			if jsonError.Code != testCase.code || jsonError.Offset != testCase.offset || jsonError.Message != testCase.message {
				t.Fatalf("JSON error = (%s, %d, %q), want (%s, %d, %q)", jsonError.Code, jsonError.Offset, jsonError.Message, testCase.code, testCase.offset, testCase.message)
			}
		})
	}
}

func TestProjectRejectsRawInputOverBound(t *testing.T) {
	input := make([]byte, MaxSourceBytes+1)
	_, err := Project(input)
	var contractError *graph.ContractError
	if !errors.As(err, &contractError) || contractError.Code != graph.ContractBoundExceeded || contractError.Path != "$" {
		t.Fatalf("error = %T %v, want root bound error", err, err)
	}
}

func TestECMAScriptSlicePrefixUsesUTF16CodeUnits(t *testing.T) {
	if got := ecmaScriptSlicePrefix("1234567890😀tail", 12); got != "1234567890😀" {
		t.Fatalf("whole surrogate pair slice = %q, want %q", got, "1234567890😀")
	}
	cut := ecmaScriptSlicePrefix("12345678901😀tail", 12)
	if utf8.ValidString(cut) {
		t.Fatalf("split surrogate slice unexpectedly produced valid UTF-8: %q", cut)
	}
	if len(cut) != 14 || cut[:11] != "12345678901" || cut[11:] != string([]byte{0xed, 0xa0, 0xbd}) {
		t.Fatalf("split surrogate WTF-8 bytes = %x", []byte(cut))
	}
}

func TestProjectRejectsCommitTitleSplitSurrogateAtGraphSeal(t *testing.T) {
	golden := loadProjectorGolden(t)
	var source map[string]any
	if err := json.Unmarshal(golden.Cases[0].Input.Source, &source); err != nil {
		t.Fatalf("decode golden source: %v", err)
	}
	sources := source["sources"].(map[string]any)
	commits := sources["commits"].(map[string]any)
	items := commits["items"].([]any)
	items[0].(map[string]any)["sha"] = "12345678901😀tail"
	input, err := json.Marshal(source)
	if err != nil {
		t.Fatalf("encode split-surrogate source: %v", err)
	}
	_, err = Project(input)
	var contractError *graph.ContractError
	if !errors.As(err, &contractError) {
		t.Fatalf("error = %T %v, want *organizationgraph.ContractError", err, err)
	}
	if contractError.Code != graph.ContractSchemaInvalid || contractError.Path != "$.nodes[23].title" || contractError.Message != "contains an unsafe control or Unicode character." {
		t.Fatalf("contract error = (%s, %s, %q)", contractError.Code, contractError.Path, contractError.Message)
	}
}
