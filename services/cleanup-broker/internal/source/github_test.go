package source

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

type roundTrip func(*http.Request) (*http.Response, error)

func TestNetworkIsExplicitAndDoesNotInheritEnvironment(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://untrusted.invalid:8181")
	t.Setenv("NO_PROXY", "*")
	r, err := New("synthetic")
	if err != nil {
		t.Fatal(err)
	}
	transport := r.client.Transport.(*http.Transport)
	if transport.Proxy != nil {
		t.Fatal("default reader inherited environment")
	}
	r, err = NewWithNetwork("synthetic", "http://approved.invalid:8080", "")
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", authority, nil)
	u, err := r.client.Transport.(*http.Transport).Proxy(req)
	if err != nil || u.String() != "http://approved.invalid:8080" {
		t.Fatal("explicit proxy was not retained")
	}
	r, err = NewWithNetwork("synthetic", "http://approved.invalid:8080", ".github.com")
	if err != nil || r.client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("explicit bypass not used")
	}
	for _, proxy := range []string{"http://user:secret@proxy", "http://proxy/path", "http://proxy:99999", "file:///tmp/proxy"} {
		if _, err := NewWithNetwork("synthetic", proxy, ""); err == nil {
			t.Fatal("unsafe proxy accepted")
		}
	}
}

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func treeID(n int) string { return fmt.Sprintf("%040x", n) }
func blobID(b []byte) string {
	return fmt.Sprintf("%x", sha1.Sum(append([]byte(fmt.Sprintf("blob %d\x00", len(b))), b...)))
}

func readerFixture(t *testing.T, change func(*http.Request, map[string]any)) (*Reader, *[]string) {
	t.Helper()
	seen := []string{}
	p, _ := json.Marshal(permit.Permit{ID: "permit-1"})
	policy, _ := json.Marshal(permit.Policy{})
	inputs := map[string][]byte{policyPath: policy, ".openslack/policies/pr-cleanup-grants/permit-1.json": p, ".openslack/agents/registry/agent-1.yaml": []byte("synthetic pinned registry")}
	entry := func(path, mode, kind, sha string) map[string]any {
		return map[string]any{"path": path, "mode": mode, "type": kind, "sha": sha}
	}
	trees := map[string][]map[string]any{
		treeID(1): {entry(".openslack", "040000", "tree", treeID(2))},
		treeID(2): {entry("policies", "040000", "tree", treeID(3)), entry("agents", "040000", "tree", treeID(5))},
		treeID(3): {entry("pr-cleanup-policy.json", "100644", "blob", blobID(policy)), entry("pr-cleanup-grants", "040000", "tree", treeID(4))},
		treeID(4): {entry("permit-1.json", "100644", "blob", blobID(p))},
		treeID(5): {entry("registry", "040000", "tree", treeID(6))},
		treeID(6): {entry("agent-1.yaml", "100644", "blob", blobID(inputs[".openslack/agents/registry/agent-1.yaml"]))},
	}
	r, err := New("synthetic-read-only-token")
	if err != nil {
		t.Fatal(err)
	}
	r.client.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.Path, "/contents/") || req.URL.RawQuery != "" {
			t.Fatal("Contents API or unpinned query used")
		}
		if req.URL.Scheme != "https" || req.URL.Host != "api.github.com" || req.Method != "GET" {
			t.Fatal("source override")
		}
		if req.Header.Get("Authorization") != "Bearer synthetic-read-only-token" {
			t.Fatal("missing read identity")
		}
		seen = append(seen, req.URL.String())
		var body map[string]any
		switch req.URL.Path {
		case "/repos/Negentropy-Laby/OpenSlack":
			body = map[string]any{"id": 1239520892, "full_name": "Negentropy-Laby/OpenSlack", "default_branch": "main"}
		case "/repos/Negentropy-Laby/OpenSlack/git/ref/heads/main":
			body = map[string]any{"ref": "refs/heads/main", "object": map[string]string{"type": "commit", "sha": strings.Repeat("a", 40)}}
		case "/repos/Negentropy-Laby/OpenSlack/git/commits/" + strings.Repeat("a", 40):
			body = map[string]any{"sha": strings.Repeat("a", 40), "tree": map[string]string{"sha": treeID(1)}}
		default:
			if strings.Contains(req.URL.Path, "/git/trees/") {
				id := strings.TrimPrefix(req.URL.Path, "/repos/Negentropy-Laby/OpenSlack/git/trees/")
				entries, ok := trees[id]
				if !ok {
					t.Fatalf("unanchored tree %s", id)
				}
				body = map[string]any{"sha": id, "truncated": false, "tree": entries}
			} else if strings.Contains(req.URL.Path, "/git/blobs/") {
				id := strings.TrimPrefix(req.URL.Path, "/repos/Negentropy-Laby/OpenSlack/git/blobs/")
				for _, data := range inputs {
					if blobID(data) == id {
						body = map[string]any{"sha": id, "encoding": "base64", "size": len(data), "content": base64.StdEncoding.EncodeToString(data)}
						break
					}
				}
				if body == nil {
					t.Fatalf("unanchored blob %s", id)
				}
			} else {
				t.Fatalf("unexpected path %s", req.URL.Path)
			}
		}
		if change != nil {
			change(req, body)
		}
		data, _ := json.Marshal(body)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(data))), Header: make(http.Header)}, nil
	})
	return r, &seen
}

func TestAcquirePinsAllInputsToOneAuthorityCommit(t *testing.T) {
	r, seen := readerFixture(t, nil)
	b, err := r.Acquire(context.Background(), "permit-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if b.Commit != strings.Repeat("a", 40) || b.Permit.ID != "permit-1" || len(b.Registry) == 0 || len(*seen) != 18 {
		t.Fatalf("unexpected bundle or requests: %d", len(*seen))
	}
	p, _ := json.Marshal(permit.Permit{ID: "permit-1"})
	policy, _ := json.Marshal(permit.Policy{})
	if len(b.SourceHashes) != 3 {
		t.Fatal("missing source hashes")
	}
	for path, data := range map[string][]byte{policyPath: policy, ".openslack/policies/pr-cleanup-grants/permit-1.json": p, ".openslack/agents/registry/agent-1.yaml": []byte("synthetic pinned registry")} {
		if b.SourceHashes[path] != fmt.Sprintf("%x", sha256.Sum256(data)) {
			t.Fatalf("source hash mismatch %s", path)
		}
	}
	// This syntactically decoded but semantically invalid permit intentionally
	// proves Acquire does NOT label its bundle authorized or skip Check.
	if permit.Check(b.Permit, b.Policy, permit.Subject{}, permit.Target{}, permit.Instance{}, b.Permit.NotBefore) == nil {
		t.Fatal("acquisition granted authority")
	}
}

func TestAcquireRejectsWrongRepositoryAndDriftingHead(t *testing.T) {
	for _, kind := range []string{"repo", "repo-name", "branch", "head", "commit-sha", "tree-sha", "truncated", "missing", "duplicate", "ancestor-symlink", "final-symlink", "gitlink", "blob-sha", "blob-content", "blob-size", "encoding"} {
		t.Run(kind, func(t *testing.T) {
			heads := 0
			r, _ := readerFixture(t, func(req *http.Request, b map[string]any) {
				if strings.HasSuffix(req.URL.Path, "/git/ref/heads/main") {
					heads++
					if kind == "head" && heads == 2 {
						b["object"] = map[string]string{"type": "commit", "sha": strings.Repeat("b", 40)}
					}
				}
				if _, ok := b["id"]; ok {
					if kind == "repo-name" {
						b["full_name"] = "other/OpenSlack"
					}
					if kind == "repo" {
						b["id"] = 123
					}
					if kind == "branch" {
						b["default_branch"] = "replacement"
					}
				}
				if strings.Contains(req.URL.Path, "/git/commits/") && kind == "commit-sha" {
					b["sha"] = strings.Repeat("b", 40)
				}
				if strings.Contains(req.URL.Path, "/git/trees/") {
					switch kind {
					case "tree-sha":
						b["sha"] = strings.Repeat("b", 40)
					case "truncated":
						b["truncated"] = true
					case "missing":
						b["tree"] = []map[string]any{}
					}
					entries := b["tree"].([]map[string]any)
					if len(entries) > 0 {
						if kind == "duplicate" {
							b["tree"] = append(entries, entries[0])
						}
						if (kind == "ancestor-symlink" && strings.HasSuffix(req.URL.Path, treeID(1))) || (kind == "final-symlink" && strings.HasSuffix(req.URL.Path, treeID(3))) {
							entries[0]["mode"], entries[0]["type"] = "120000", "blob"
						}
						if kind == "gitlink" {
							entries[0]["mode"], entries[0]["type"] = "160000", "commit"
						}
					}
				}
				if _, ok := b["content"]; ok {
					switch kind {
					case "blob-sha":
						b["sha"] = strings.Repeat("b", 40)
					case "blob-content":
						data, _ := base64.StdEncoding.DecodeString(b["content"].(string))
						data[0] ^= 1
						b["content"] = base64.StdEncoding.EncodeToString(data)
					case "blob-size":
						b["size"] = -1
					case "encoding":
						b["encoding"] = "none"
					}
				}
			})
			if _, err := r.Acquire(context.Background(), "permit-1", "agent-1"); err == nil {
				t.Fatal("bad source accepted")
			}
		})
	}
}

func TestRegularExecutableBlobModeIsAccepted(t *testing.T) {
	r, _ := readerFixture(t, func(_ *http.Request, b map[string]any) {
		if entries, ok := b["tree"].([]map[string]any); ok {
			for _, entry := range entries {
				if entry["type"] == "blob" {
					entry["mode"] = "100755"
				}
			}
		}
	})
	if _, err := r.Acquire(context.Background(), "permit-1", "agent-1"); err != nil {
		t.Fatal(err)
	}
}

func TestNoSourcePathInjectionOrRedirect(t *testing.T) {
	r, seen := readerFixture(t, nil)
	for _, id := range []string{"../permit-1", "permit-1?ref=other", "https://evil", "a/b", ""} {
		if _, err := r.Acquire(context.Background(), id, "agent-1"); err == nil {
			t.Fatal("path accepted")
		}
		if _, err := r.Acquire(context.Background(), "permit-1", id); err == nil {
			t.Fatal("agent path accepted")
		}
	}
	if len(*seen) != 0 {
		t.Fatal("invalid input sent request")
	}
	if err := r.client.CheckRedirect(nil, nil); err != http.ErrUseLastResponse {
		t.Fatal("redirect allowed")
	}
	r.client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 302, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})
	if _, err := r.Acquire(context.Background(), "permit-1", "agent-1"); err == nil {
		t.Fatal("redirect accepted")
	}
}
