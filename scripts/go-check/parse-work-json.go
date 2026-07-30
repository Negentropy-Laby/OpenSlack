package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
)

var modulePathPattern = regexp.MustCompile(`^\./services/[a-z0-9][a-z0-9-]*$`)

const (
	maxWorkspaceJSONBytes = 1 << 20
	requiredGoVersion      = "1.26.5"
)

type workspace struct {
	Go        string            `json:"Go"`
	Toolchain string            `json:"Toolchain"`
	Godebug   []json.RawMessage `json:"Godebug"`
	Use       []workspaceUse    `json:"Use"`
	Replace   []json.RawMessage `json:"Replace"`
}

type workspaceUse struct {
	DiskPath string `json:"DiskPath"`
}

func main() {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, maxWorkspaceJSONBytes+1))
	if err != nil {
		fail("read workspace JSON: %v", err)
	}
	if len(input) > maxWorkspaceJSONBytes {
		fail("workspace JSON exceeds %d bytes", maxWorkspaceJSONBytes)
	}

	decoder := json.NewDecoder(bytes.NewReader(input))
	var document workspace
	if err = decoder.Decode(&document); err != nil {
		fail("decode workspace JSON: %v", err)
	}

	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			fail("workspace JSON contains more than one value")
		}
		fail("decode trailing workspace JSON: %v", err)
	}
	if document.Go != requiredGoVersion {
		fail("workspace Go version must be %s", requiredGoVersion)
	}
	if document.Toolchain != "" {
		fail("workspace toolchain directives are forbidden")
	}
	if len(document.Godebug) != 0 {
		fail("workspace godebug directives are forbidden")
	}
	if len(document.Replace) != 0 {
		fail("workspace replace directives are forbidden")
	}
	if len(document.Use) == 0 {
		fail("workspace contains no use entries")
	}

	paths := make([]string, 0, len(document.Use))
	seen := make(map[string]struct{}, len(document.Use))
	for _, entry := range document.Use {
		if !modulePathPattern.MatchString(entry.DiskPath) {
			fail("workspace module path is outside the reviewed services namespace")
		}
		if _, exists := seen[entry.DiskPath]; exists {
			fail("workspace contains a duplicate module path")
		}
		seen[entry.DiskPath] = struct{}{}
		paths = append(paths, entry.DiskPath)
	}

	sort.Strings(paths)
	for _, path := range paths {
		fmt.Println(path)
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "go-check workspace parser: "+format+"\n", args...)
	os.Exit(1)
}
