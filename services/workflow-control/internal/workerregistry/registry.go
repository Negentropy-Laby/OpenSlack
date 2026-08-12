// Package workerregistry resolves the one trusted GS8-B TypeScript worker from
// a closed bundle manifest. HTTP requests and jobs never supply commands,
// arguments, paths, or environment values.
package workerregistry

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/processsupervisor"
)

const (
	ManifestFilename = "workflow-runner-bundle.v1.json"
	ManifestSchema   = "openslack.workflow_runner_bundle.v1"
	maxManifestBytes = 64 * 1024
	maxArtifactBytes = 512 * 1024 * 1024
)

var (
	safeIDPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	bundleFilenamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$`)
	hashPattern           = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type Artifact struct {
	RelativePath string `json:"relativePath"`
	SHA256       string `json:"sha256"`
}

type Manifest struct {
	Schema           string   `json:"schema"`
	BundleID         string   `json:"bundleId"`
	RunnerBuildHash  string   `json:"runnerBuildHash"`
	Executable       Artifact `json:"executable"`
	Entrypoint       Artifact `json:"entrypoint"`
	EntrypointMode   string   `json:"entrypointMode"`
	FixedArguments   []string `json:"fixedArguments"`
	FixedEnvironment []string `json:"fixedEnvironment"`
	WorkingDirectory string   `json:"workingDirectory"`
}

type Runtime struct {
	WorkspaceID                 string
	WorkspaceRoot               string
	DescriptorRoot              string
	CheckpointShadowEnabled     bool
	CheckpointShadowEndpoint    string
	CheckpointShadowBearerToken string
	CheckpointShadowCallerID    string
	CheckpointShadowJournalRoot string
}

type Registry struct {
	manifest              Manifest
	command               processsupervisor.Command
	bundleRoot            string
	manifestSHA256        string
	runnerBuildHash       string
	closedBundleFilenames []string
}

func Load(bundleRoot, expectedManifestSHA256 string, runtimeConfig Runtime) (*Registry, error) {
	root, err := canonicalDirectory(bundleRoot)
	if err != nil {
		return nil, fmt.Errorf("trusted worker bundle root: %w", err)
	}
	workspaceRoot, err := canonicalDirectory(runtimeConfig.WorkspaceRoot)
	if err != nil {
		return nil, fmt.Errorf("worker workspace root: %w", err)
	}
	if !safeIDPattern.MatchString(runtimeConfig.WorkspaceID) {
		return nil, fmt.Errorf("worker workspace identity is invalid")
	}
	if runtimeConfig.DescriptorRoot == "" || !filepath.IsAbs(runtimeConfig.DescriptorRoot) || filepath.Clean(runtimeConfig.DescriptorRoot) != runtimeConfig.DescriptorRoot || strings.ContainsRune(runtimeConfig.DescriptorRoot, '\x00') {
		return nil, fmt.Errorf("worker descriptor root must be a normalized absolute path")
	}
	manifestPath := filepath.Join(root, ManifestFilename)
	body, err := readStableRegularFile(manifestPath, maxManifestBytes)
	if err != nil {
		return nil, fmt.Errorf("read trusted worker bundle manifest: %w", err)
	}
	if !hashPattern.MatchString(expectedManifestSHA256) {
		return nil, fmt.Errorf("trusted worker bundle manifest anchor must be a full SHA-256")
	}
	expectedManifestHash, err := hex.DecodeString(expectedManifestSHA256)
	if err != nil || len(expectedManifestHash) != sha256.Size {
		return nil, fmt.Errorf("trusted worker bundle manifest anchor must be a full SHA-256")
	}
	actualManifestHash := sha256.Sum256(body)
	if subtle.ConstantTimeCompare(actualManifestHash[:], expectedManifestHash) != 1 {
		return nil, fmt.Errorf("trusted worker bundle manifest does not match its external SHA-256 anchor")
	}
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return nil, fmt.Errorf("decode trusted worker bundle manifest: %w", err)
	}
	if err := requireEOF(decoder); err != nil {
		return nil, fmt.Errorf("decode trusted worker bundle manifest: %w", err)
	}
	if manifest.Schema != ManifestSchema || !safeIDPattern.MatchString(manifest.BundleID) || !hashPattern.MatchString(manifest.RunnerBuildHash) {
		return nil, fmt.Errorf("trusted worker bundle identity is invalid")
	}
	if manifest.EntrypointMode != string(processsupervisor.EntrypointFirstArgument) {
		return nil, fmt.Errorf("trusted worker bundle must use the sealed TypeScript entrypoint mode")
	}
	if manifest.WorkingDirectory != "." {
		return nil, fmt.Errorf("trusted worker bundle working directory must be its closed root")
	}
	closedFilenames, err := closedBundleFilenames(manifest)
	if err != nil {
		return nil, err
	}
	if err := validateClosedBundle(root, closedFilenames); err != nil {
		return nil, err
	}
	executable, executableHash, err := resolveArtifact(root, manifest.Executable)
	if err != nil {
		return nil, fmt.Errorf("trusted worker executable: %w", err)
	}
	entrypoint, entrypointHash, err := resolveArtifact(root, manifest.Entrypoint)
	if err != nil {
		return nil, fmt.Errorf("trusted worker entrypoint: %w", err)
	}
	if manifest.RunnerBuildHash != entrypointHash {
		return nil, fmt.Errorf("trusted worker runnerBuildHash does not match the actual self-contained entrypoint")
	}
	workingDirectory, err := resolveDirectory(root, manifest.WorkingDirectory)
	if err != nil {
		return nil, fmt.Errorf("trusted worker working directory: %w", err)
	}
	environment, err := sealedEnvironment(manifest.FixedEnvironment, runtimeConfig, workspaceRoot, entrypointHash)
	if err != nil {
		return nil, err
	}
	command := processsupervisor.Command{
		Identity: manifest.BundleID, ExecutablePath: executable,
		ExecutableSHA256: executableHash,
		EntrypointPath:   entrypoint, EntrypointSHA256: entrypointHash,
		EntrypointMode: processsupervisor.EntrypointFirstArgument,
		FixedArguments: append([]string(nil), manifest.FixedArguments...),
		Environment:    environment, WorkingDirectory: workingDirectory,
	}
	// Construction here proves the manifest cannot smuggle an unsafe command,
	// argument, environment, working directory, or mismatched artifact hash.
	if _, err := processsupervisor.New(processsupervisor.Config{Command: command}); err != nil {
		return nil, fmt.Errorf("seal trusted worker bundle: %w", err)
	}
	if err := verifyManifestAnchor(manifestPath, body, expectedManifestSHA256); err != nil {
		return nil, err
	}
	if err := validateClosedBundle(root, closedFilenames); err != nil {
		return nil, err
	}
	return &Registry{
		manifest: manifest, command: command, bundleRoot: root,
		manifestSHA256: expectedManifestSHA256, runnerBuildHash: entrypointHash,
		closedBundleFilenames: append([]string(nil), closedFilenames...),
	}, nil
}

func (registry *Registry) NewSupervisor() (*processsupervisor.Supervisor, error) {
	manifestPath := filepath.Join(registry.bundleRoot, ManifestFilename)
	if err := verifyManifestAnchor(manifestPath, nil, registry.manifestSHA256); err != nil {
		return nil, err
	}
	if err := validateClosedBundle(registry.bundleRoot, registry.closedBundleFilenames); err != nil {
		return nil, err
	}
	return processsupervisor.New(processsupervisor.Config{Command: registry.command})
}

func (registry *Registry) BundleID() string        { return registry.manifest.BundleID }
func (registry *Registry) RunnerBuildHash() string { return registry.runnerBuildHash }

func sealedEnvironment(base []string, runtimeConfig Runtime, workspaceRoot, buildHash string) ([]string, error) {
	reserved := map[string]struct{}{
		"OPENSLACK_WORKFLOW_RUNNER_ENABLED":                 {},
		"OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID":            {},
		"OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT":          {},
		"OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT":         {},
		"OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH":              {},
		"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED":      {},
		"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT":     {},
		"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_BEARER_TOKEN": {},
		"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CALLER_ID":    {},
		"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT": {},
	}
	for _, entry := range base {
		name, _, found := strings.Cut(entry, "=")
		if !found {
			return nil, fmt.Errorf("trusted worker fixed environment entry is invalid")
		}
		if _, exists := reserved[strings.ToUpper(name)]; exists {
			return nil, fmt.Errorf("trusted worker manifest cannot override runtime identity environment")
		}
	}
	result := append([]string(nil), base...)
	result = append(result,
		"OPENSLACK_WORKFLOW_RUNNER_ENABLED=1",
		"OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID="+runtimeConfig.WorkspaceID,
		"OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT="+workspaceRoot,
		"OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT="+runtimeConfig.DescriptorRoot,
		"OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH="+buildHash,
	)
	if runtimeConfig.CheckpointShadowEnabled {
		parsed, parseErr := url.Parse(runtimeConfig.CheckpointShadowEndpoint)
		localRoot := filepath.Join(workspaceRoot, ".openslack.local")
		relative, relativeErr := filepath.Rel(localRoot, runtimeConfig.CheckpointShadowJournalRoot)
		if parseErr != nil || parsed.Scheme != "http" || parsed.User != nil || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "::1") || parsed.Port() == "" || parsed.Path != "/v1/shadow/workflow-control/checkpoints" || parsed.RawQuery != "" || parsed.Fragment != "" || len(runtimeConfig.CheckpointShadowBearerToken) < 32 || len(runtimeConfig.CheckpointShadowBearerToken) > 4096 || runtimeConfig.CheckpointShadowBearerToken != strings.TrimSpace(runtimeConfig.CheckpointShadowBearerToken) || strings.ContainsAny(runtimeConfig.CheckpointShadowBearerToken, "\r\n\x00") || !safeIDPattern.MatchString(runtimeConfig.CheckpointShadowCallerID) || runtimeConfig.CheckpointShadowJournalRoot == "" || !filepath.IsAbs(runtimeConfig.CheckpointShadowJournalRoot) || filepath.Clean(runtimeConfig.CheckpointShadowJournalRoot) != runtimeConfig.CheckpointShadowJournalRoot || relativeErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("checkpoint shadow runtime injection is invalid")
		}
		result = append(result,
			"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED=1",
			"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT="+runtimeConfig.CheckpointShadowEndpoint,
			"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_BEARER_TOKEN="+runtimeConfig.CheckpointShadowBearerToken,
			"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CALLER_ID="+runtimeConfig.CheckpointShadowCallerID,
			"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT="+runtimeConfig.CheckpointShadowJournalRoot,
		)
	}
	return result, nil
}

func resolveArtifact(root string, artifact Artifact) (string, string, error) {
	if !hashPattern.MatchString(artifact.SHA256) {
		return "", "", fmt.Errorf("artifact SHA-256 is invalid")
	}
	path, err := resolveRelative(root, artifact.RelativePath, false)
	if err != nil {
		return "", "", err
	}
	actualHash, err := stableRegularFileSHA256(path)
	if err != nil {
		return "", "", err
	}
	if actualHash != artifact.SHA256 {
		return "", "", fmt.Errorf("artifact SHA-256 mismatch")
	}
	return path, actualHash, nil
}

func resolveDirectory(root, relative string) (string, error) {
	if relative == "" {
		relative = "."
	}
	return resolveRelative(root, relative, true)
}

func resolveRelative(root, relative string, directory bool) (string, error) {
	if relative == "" || filepath.IsAbs(relative) || filepath.Clean(relative) != relative || strings.ContainsRune(relative, '\x00') {
		return "", fmt.Errorf("bundle path must be normalized and relative")
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("bundle path escapes the trusted root")
	}
	candidate := filepath.Join(root, relative)
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve bundle path: %w", err)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil || !samePath(candidate, resolved) || !within(root, resolved) {
		return "", fmt.Errorf("bundle path is not canonical or escapes the trusted root")
	}
	info, err := os.Lstat(resolved)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || hasReparsePoint(info) || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
		return "", fmt.Errorf("bundle path has the wrong file type")
	}
	return filepath.Clean(resolved), nil
}

func canonicalDirectory(value string) (string, error) {
	if value == "" || !filepath.IsAbs(value) || filepath.Clean(value) != value || strings.ContainsRune(value, '\x00') {
		return "", fmt.Errorf("path must be normalized and absolute")
	}
	return resolveRelative(value, ".", true)
}

func readStableRegularFile(path string, limit int64) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || hasReparsePoint(before) || before.Size() < 1 || before.Size() > limit {
		return nil, fmt.Errorf("manifest must be a bounded regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, fmt.Errorf("manifest read exceeds the closed limit: %w", err)
	}
	opened, err := file.Stat()
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(path)
	if err != nil || hasReparsePoint(after) || !os.SameFile(before, opened) || !os.SameFile(before, after) {
		return nil, fmt.Errorf("manifest identity changed while it was read")
	}
	return body, nil
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return fmt.Errorf("multiple JSON values")
	}
	return err
}

func within(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

func closedBundleFilenames(manifest Manifest) ([]string, error) {
	for label, relative := range map[string]string{
		"executable": manifest.Executable.RelativePath,
		"entrypoint": manifest.Entrypoint.RelativePath,
	} {
		if !bundleFilenamePattern.MatchString(relative) || filepath.Base(relative) != relative || strings.ContainsAny(relative, `/\\`) {
			return nil, fmt.Errorf("trusted worker %s must be one root-level file", label)
		}
		if relative == ManifestFilename {
			return nil, fmt.Errorf("trusted worker %s cannot replace the bundle manifest", label)
		}
	}
	if manifest.Executable.RelativePath == manifest.Entrypoint.RelativePath {
		return nil, fmt.Errorf("trusted worker executable and entrypoint must be distinct files")
	}
	return []string{ManifestFilename, manifest.Executable.RelativePath, manifest.Entrypoint.RelativePath}, nil
}

func validateClosedBundle(root string, expected []string) error {
	allowed := make(map[string]struct{}, len(expected))
	for _, name := range expected {
		allowed[name] = struct{}{}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("enumerate trusted worker bundle: %w", err)
	}
	if len(entries) != len(allowed) {
		return fmt.Errorf("trusted worker bundle is not the exact closed file set")
	}
	var identities []os.FileInfo
	for _, entry := range entries {
		if _, exists := allowed[entry.Name()]; !exists {
			return fmt.Errorf("trusted worker bundle contains unknown entry %q", entry.Name())
		}
		info, err := os.Lstat(filepath.Join(root, entry.Name()))
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || hasReparsePoint(info) {
			return fmt.Errorf("trusted worker bundle entry %q is not a regular non-reparse file", entry.Name())
		}
		for _, previous := range identities {
			if os.SameFile(previous, info) {
				return fmt.Errorf("trusted worker bundle entries cannot alias the same file")
			}
		}
		identities = append(identities, info)
	}
	return nil
}

func stableRegularFileSHA256(path string) (string, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || hasReparsePoint(before) {
		return "", fmt.Errorf("artifact must be a regular non-reparse file")
	}
	if before.Size() < 1 || before.Size() > maxArtifactBytes {
		return "", fmt.Errorf("artifact size is outside the closed bundle limit")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	return hashStableRegularFile(path, before, file)
}

func hashStableRegularFile(path string, before os.FileInfo, file *os.File) (string, error) {
	hasher := sha256.New()
	copied, copyErr := io.Copy(hasher, io.LimitReader(file, maxArtifactBytes+1))
	opened, statErr := file.Stat()
	closeErr := file.Close()
	if copyErr != nil || statErr != nil || closeErr != nil {
		return "", fmt.Errorf("hash artifact: %w", errors.Join(copyErr, statErr, closeErr))
	}
	if copied != before.Size() || copied > maxArtifactBytes {
		return "", fmt.Errorf("artifact size changed or exceeded the closed bundle limit while hashing")
	}
	after, err := os.Lstat(path)
	if err != nil || hasReparsePoint(opened) || hasReparsePoint(after) ||
		!os.SameFile(before, opened) || !os.SameFile(before, after) ||
		!sameArtifactMetadata(before, opened) || !sameArtifactMetadata(before, after) {
		return "", fmt.Errorf("artifact identity or metadata changed while it was hashed")
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func sameArtifactMetadata(left, right os.FileInfo) bool {
	return left.Size() == right.Size() &&
		left.Mode() == right.Mode() &&
		left.ModTime().Equal(right.ModTime())
}

func verifyManifestAnchor(path string, expectedBody []byte, expectedHash string) error {
	body, err := readStableRegularFile(path, maxManifestBytes)
	if err != nil {
		return fmt.Errorf("revalidate trusted worker bundle manifest: %w", err)
	}
	if expectedBody != nil && !bytes.Equal(body, expectedBody) {
		return fmt.Errorf("trusted worker bundle manifest changed during validation")
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != expectedHash {
		return fmt.Errorf("trusted worker bundle manifest does not match its external SHA-256 anchor")
	}
	return nil
}

func SHA256File(path string) (string, error) {
	return stableRegularFileSHA256(path)
}
