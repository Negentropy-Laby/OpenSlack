package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func validRequest() Request {
	return Request{Schema: "openslack.cleanup_request.v1", Mode: "execute", AgentID: "cleanup", PrincipalID: "agent:cleanup", RuntimeUID: "runtime-1", RunID: "run-1", Repo: "owner/repo", Remote: "qualification", PRNumber: 42, PermitID: "permit-1", OperationID: "operation-1"}
}

func TestClosedRequest(t *testing.T) {
	r := validRequest()
	b, _ := json.Marshal(r)
	if _, e := Decode(b); e != nil {
		t.Fatal(e)
	}
	for _, raw := range []string{strings.Replace(string(b), `"execute"`, `"preview"`, 1), strings.Replace(string(b), `"prNumber":42`, `"prNumber":"42"`, 1), strings.Replace(string(b), `"mode":"execute"`, `"mode":"execute","mode":"execute"`, 1), strings.Replace(string(b), `"run-1"`, `null`, 1), strings.Replace(string(b), `"run-1"`, `"\ud800"`, 1), string(b[:len(b)-1]) + `,"authorized":true}`, strings.Repeat(" ", MaxMessage) + string(b)} {
		if _, e := Decode([]byte(raw)); e == nil {
			t.Fatalf("accepted invalid request")
		}
	}
	preview := strings.Replace(string(b), `"execute"`, `"preview"`, 1)
	preview = strings.Replace(preview, `,"operationId":"operation-1"`, "", 1)
	if _, e := Decode([]byte(preview)); e != nil {
		t.Fatal(e)
	}
}

func TestDigestBindsExecutionNotTransportMode(t *testing.T) {
	r := validRequest()
	original := r.Digest()
	r.Mode = "status"
	if r.Digest() != original {
		t.Fatal("status must find execution")
	}
	r.RunID = "other-run"
	if r.Digest() == original {
		t.Fatal("subject unbound")
	}
	r = validRequest()
	r.Repo = "other/repo"
	if r.Digest() == original {
		t.Fatal("target unbound")
	}
	r = validRequest()
	r.OperationID = "other-operation"
	if r.Digest() == original {
		t.Fatal("operation unbound")
	}
}

func TestCrossLanguageIdentifierLimits(t *testing.T) {
	for _, change := range []func(*Request){func(r *Request) { r.AgentID = "agent:invalid" }, func(r *Request) { r.OperationID = "op:invalid" }, func(r *Request) { r.Remote = strings.Repeat("a", 101) }, func(r *Request) { r.Repo = strings.Repeat("a", 101) + "/repo" }} {
		r := validRequest()
		change(&r)
		b, _ := json.Marshal(r)
		if _, err := Decode(b); err == nil {
			t.Fatal("accepted incompatible identifier")
		}
	}
	r := validRequest()
	r.AgentID = "agent.with-dot"
	r.Remote = strings.Repeat("a", 100)
	r.Repo = strings.Repeat("a", 100) + "/repo"
	b, _ := json.Marshal(r)
	if _, err := Decode(b); err != nil {
		t.Fatal(err)
	}
}

// Constants are shared with cleanup-broker-digest.test.ts, not generated from
// Digest. The max-safe-JS-integer case fixes decimal string serialization.
func TestTypeScriptDigestGoldenVectors(t *testing.T) {
	for _, test := range []struct {
		number uint64
		digest string
	}{
		{42, "04d357307c5087c2699a89571825a4219403f9763dfd53420dcc9302206c3337"},
		{9007199254740991, "0b9694e37d7fdd3eeeb1447040a549a8a7d4f1691d5fd760fa8069a500fd77c2"},
	} {
		for _, mode := range []string{"execute", "status"} {
			r := validRequest()
			r.PRNumber = test.number
			r.Mode = mode
			if r.Digest() != test.digest {
				t.Fatalf("%s PR %d digest mismatch", mode, test.number)
			}
		}
	}
}
