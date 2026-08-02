package canonicaljson

import "testing"

func TestECMAScriptSurrogateCompatibility(t *testing.T) {
	for name, testCase := range map[string]struct {
		input    string
		expected string
	}{
		"lone-high":       {`"\ud800"`, `"\ud800"`},
		"lone-low":        {`"\udc00"`, `"\udc00"`},
		"paired":          {`"\ud800\udc00"`, `"𐀀"`},
		"high-before-bmp": {`"\ud800\u0041"`, `"\ud800A"`},
	} {
		t.Run(name, func(t *testing.T) {
			value, err := Parse([]byte(testCase.input), Limits{MaxDepth: 4, MaxNodes: 8, MaxStringLength: 32})
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := Encode(value)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != testCase.expected {
				t.Fatalf("got %s, want %s", encoded, testCase.expected)
			}
		})
	}
}

func TestRejectsInvalidRawUTF8(t *testing.T) {
	if _, err := Parse([]byte{'"', 0xff, '"'}, Limits{MaxDepth: 4, MaxNodes: 8, MaxStringLength: 32}); err == nil {
		t.Fatal("invalid raw UTF-8 accepted")
	}
}
