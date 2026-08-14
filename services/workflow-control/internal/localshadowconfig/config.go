// Package localshadowconfig owns the shared loopback endpoint and journal-root
// rules used by both trusted runner composition and worker injection.
package localshadowconfig

import (
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

type Options struct {
	WorkspaceRoot  string
	JournalRoot    string
	Endpoint       string
	Routes         []string
	ProtectedRoots []string
}

func Validate(options Options) error {
	parsed, err := url.Parse(options.Endpoint)
	if err != nil || parsed == nil {
		return fmt.Errorf("local shadow endpoint must be an exact loopback HTTP observation URL")
	}
	route := parsed.Path
	if route == "" {
		route = "/"
	}
	exact := parsed.String() == options.Endpoint
	if route == "/" {
		exact = exact || strings.TrimSuffix(parsed.String(), "/") == options.Endpoint
	}
	if parsed.Scheme != "http" || parsed.User != nil || parsed.Port() == "" || parsed.RawPath != "" || !contains(options.Routes, route) || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || !exact {
		return fmt.Errorf("local shadow endpoint must be an exact loopback HTTP observation URL")
	}
	if host := parsed.Hostname(); host != "127.0.0.1" && host != "::1" {
		return fmt.Errorf("local shadow endpoint must be loopback")
	}
	if options.WorkspaceRoot == "" || !filepath.IsAbs(options.WorkspaceRoot) || filepath.Clean(options.WorkspaceRoot) != options.WorkspaceRoot || options.JournalRoot == "" || !filepath.IsAbs(options.JournalRoot) || filepath.Clean(options.JournalRoot) != options.JournalRoot {
		return fmt.Errorf("local shadow paths must be normalized and absolute")
	}
	localRoot := filepath.Join(options.WorkspaceRoot, ".openslack.local")
	if !strictlyWithin(localRoot, options.JournalRoot) {
		return fmt.Errorf("local shadow journal root must be below workspace .openslack.local")
	}
	for _, protected := range options.ProtectedRoots {
		if protected == "" || !filepath.IsAbs(protected) || filepath.Clean(protected) != protected {
			return fmt.Errorf("local shadow protected root must be normalized and absolute")
		}
		if within(protected, options.JournalRoot) || within(options.JournalRoot, protected) {
			return fmt.Errorf("local shadow journal overlaps protected authority evidence")
		}
	}
	return nil
}

func contains(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func strictlyWithin(root, candidate string) bool {
	return candidate != root && within(root, candidate)
}

func within(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
