// Package source acquires cleanup governance inputs from a fixed authority.
// Acquisition is not authorization: registry validation, OS identity matching,
// resource checks and a fresh send-boundary acquisition remain mandatory.
package source

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

const authority = "https://api.github.com/repos/Negentropy-Laby/OpenSlack"
const repositoryID = "1239520892"
const policyPath = ".openslack/policies/pr-cleanup-policy.json"

var name = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)
var agentName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
var commit = regexp.MustCompile(`^[0-9a-f]{40}$`)
var ErrEvidence = errors.New("GOVERNANCE_EVIDENCE_UNAVAILABLE")

type Reader struct {
	client *http.Client
	token  string
}

// New creates a reader for the independent read-only governance credential.
// No source URL, ref, caller Git config or redirect is accepted.
func New(readOnlyToken string) (*Reader, error) {
	return NewWithNetwork(readOnlyToken, "", "")
}

// NewWithNetwork accepts only the administrator-pinned network configuration.
// Neither the default transport nor process proxy environment is inherited.
func NewWithNetwork(readOnlyToken, httpsProxy, noProxy string) (*Reader, error) {
	if readOnlyToken == "" || strings.ContainsAny(readOnlyToken, "\r\n") {
		return nil, ErrEvidence
	}
	if len(noProxy) > 2048 {
		return nil, ErrEvidence
	}
	for _, c := range noProxy {
		if c < 32 || c > 126 {
			return nil, ErrEvidence
		}
	}
	transport := &http.Transport{DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext, ForceAttemptHTTP2: true, MaxIdleConns: 10, IdleConnTimeout: 30 * time.Second, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second}
	if httpsProxy != "" {
		u, e := url.Parse(httpsProxy)
		if e != nil || len(httpsProxy) > 2048 || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || (httpsProxy != u.Scheme+"://"+u.Host && httpsProxy != u.Scheme+"://"+u.Host+"/") {
			return nil, ErrEvidence
		}
		if u.Port() != "" {
			port, e := strconv.Atoi(u.Port())
			if e != nil || port < 1 || port > 65535 {
				return nil, ErrEvidence
			}
		}
		bypass := false
		// This reader has only one fixed host. No caller URL or environment is
		// used to decide whether that host bypasses the configured proxy.
		for _, item := range strings.Split(strings.ToLower(noProxy), ",") {
			item = strings.TrimSpace(item)
			item = strings.TrimSuffix(item, ":443")
			domain := strings.TrimPrefix(item, ".")
			if item == "*" || domain == "api.github.com" || domain == "github.com" {
				bypass = true
			}
		}
		if !bypass {
			transport.Proxy = http.ProxyURL(u)
		}
	}
	return &Reader{token: readOnlyToken, client: &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

type Bundle struct {
	Commit string
	Policy permit.Policy
	Permit permit.Permit
	// The registry is pinned to Commit, but has NOT been authorized merely by
	// acquiring it. The executor must validate its closed schema and scoped
	// action and confirm the same subject; acquisition cannot replace that gate.
	Registry     []byte
	SourceHashes map[string]string
}

func (r *Reader) Acquire(ctx context.Context, permitID, agentID string) (Bundle, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var zero Bundle
	if r == nil || !name.MatchString(permitID) || !agentName.MatchString(agentID) {
		return zero, ErrEvidence
	}
	var repo struct {
		ID            json.Number `json:"id"`
		FullName      string      `json:"full_name"`
		DefaultBranch string      `json:"default_branch"`
	}
	if r.get(ctx, "", &repo) != nil || repo.ID.String() != repositoryID || repo.FullName != "Negentropy-Laby/OpenSlack" || repo.DefaultBranch != "main" {
		return zero, ErrEvidence
	}
	head, err := r.head(ctx)
	if err != nil {
		return zero, err
	}
	var object struct {
		SHA  string `json:"sha"`
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if r.get(ctx, "/git/commits/"+head, &object) != nil || object.SHA != head || !commit.MatchString(object.Tree.SHA) {
		return zero, ErrEvidence
	}
	policyBytes, err := r.file(ctx, policyPath, object.Tree.SHA)
	if err != nil {
		return zero, err
	}
	permitPath := ".openslack/policies/pr-cleanup-grants/" + permitID + ".json"
	registryPath := ".openslack/agents/registry/" + agentID + ".yaml"
	permitBytes, err := r.file(ctx, permitPath, object.Tree.SHA)
	if err != nil {
		return zero, err
	}
	registry, err := r.file(ctx, registryPath, object.Tree.SHA)
	if err != nil {
		return zero, err
	}
	var p permit.Permit
	var policy permit.Policy
	if permit.Decode(policyBytes, &policy) != nil || permit.Decode(permitBytes, &p) != nil || p.ID != permitID {
		return zero, ErrEvidence
	}
	after, err := r.head(ctx)
	if err != nil || after != head {
		return zero, ErrEvidence
	}
	hashes := map[string]string{}
	for path, data := range map[string][]byte{policyPath: policyBytes, permitPath: permitBytes, registryPath: registry} {
		hashes[path] = fmt.Sprintf("%x", sha256.Sum256(data))
	}
	return Bundle{Commit: head, Policy: policy, Permit: p, Registry: registry, SourceHashes: hashes}, nil
}

func (r *Reader) head(ctx context.Context) (string, error) {
	var ref struct {
		Ref    string `json:"ref"`
		Object struct {
			Type string `json:"type"`
			SHA  string `json:"sha"`
		} `json:"object"`
	}
	if r.get(ctx, "/git/ref/heads/main", &ref) != nil || ref.Ref != "refs/heads/main" || ref.Object.Type != "commit" || !commit.MatchString(ref.Object.SHA) {
		return "", ErrEvidence
	}
	return ref.Object.SHA, nil
}

func (r *Reader) file(ctx context.Context, path, treeSHA string) ([]byte, error) {
	// Contents API may dereference symlinks. Walk exact pinned Git tree modes
	// instead; neither a symlink ancestor nor a submodule is a policy source.
	parts := strings.Split(path, "/")
	for i, part := range parts {
		var tree struct {
			SHA       string `json:"sha"`
			Truncated bool   `json:"truncated"`
			Tree      []struct {
				Path string `json:"path"`
				Mode string `json:"mode"`
				Type string `json:"type"`
				SHA  string `json:"sha"`
			} `json:"tree"`
		}
		if r.get(ctx, "/git/trees/"+url.PathEscape(treeSHA), &tree) != nil || tree.SHA != treeSHA || tree.Truncated {
			return nil, ErrEvidence
		}
		found := false
		for _, entry := range tree.Tree {
			if entry.Path != part {
				continue
			}
			if found || !commit.MatchString(entry.SHA) {
				return nil, ErrEvidence
			}
			found = true
			if i < len(parts)-1 {
				if entry.Mode != "040000" || entry.Type != "tree" {
					return nil, ErrEvidence
				}
				treeSHA = entry.SHA
			} else {
				if (entry.Mode != "100644" && entry.Mode != "100755") || entry.Type != "blob" {
					return nil, ErrEvidence
				}
				treeSHA = entry.SHA
			}
		}
		if !found {
			return nil, ErrEvidence
		}
	}
	var blob struct {
		SHA      string `json:"sha"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
		Size     int    `json:"size"`
	}
	if r.get(ctx, "/git/blobs/"+treeSHA, &blob) != nil || blob.SHA != treeSHA || blob.Encoding != "base64" {
		return nil, ErrEvidence
	}
	data, err := base64.StdEncoding.DecodeString(blob.Content)
	if err != nil || len(data) == 0 || len(data) > 65536 || blob.Size != len(data) {
		return nil, ErrEvidence
	}
	// Git blob identity anchors the bytes to the selected tree entry. SHA-256
	// source digests are independently returned for the operation evidence.
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(data))
	h.Write(data)
	if fmt.Sprintf("%x", h.Sum(nil)) != treeSHA {
		return nil, ErrEvidence
	}
	return data, nil
}

func (r *Reader) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, authority+path, nil)
	if err != nil {
		return ErrEvidence
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	res, err := r.client.Do(req)
	if err != nil {
		return ErrEvidence
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ErrEvidence
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 131073))
	if err != nil || len(b) > 131072 {
		return ErrEvidence
	}
	if err = json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("%w", ErrEvidence)
	}
	return nil
}
