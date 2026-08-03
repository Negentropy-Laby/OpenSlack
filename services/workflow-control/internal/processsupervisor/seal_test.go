package processsupervisor

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNewSealsCommandSlicesAndProducesStableIdentity(t *testing.T) {
	executable := currentTestExecutable(t)
	digest := artifactDigest(t, executable)
	arguments := []string{"-test.run=^TestProcessSupervisorHelper$"}
	environment := []string{"OPENSLACK_PROCESS_SUPERVISOR_HELPER=exit"}
	config := Config{Command: Command{
		Identity: "typescript-v1", ExecutablePath: executable, ExecutableSHA256: digest,
		EntrypointPath: executable, EntrypointSHA256: digest, EntrypointMode: EntrypointExecutable,
		FixedArguments: arguments, Environment: environment,
	}}
	first, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	arguments[0], environment[0] = "attacker-argument", "NODE_OPTIONS=--require=attacker.js"
	if first.command.arguments[0] != "-test.run=^TestProcessSupervisorHelper$" ||
		first.command.environment[0] != "OPENSLACK_PROCESS_SUPERVISOR_HELPER=exit" {
		t.Fatal("supervisor retained caller-owned command slices")
	}
	second, err := New(configWithSlices(config, []string{"-test.run=^TestProcessSupervisorHelper$"}, []string{"OPENSLACK_PROCESS_SUPERVISOR_HELPER=exit"}))
	if err != nil {
		t.Fatal(err)
	}
	if first.CommandName() != "typescript-v1" || len(first.CommandIdentity()) != 64 || first.CommandIdentity() != second.CommandIdentity() {
		t.Fatalf("unstable command identity: %q %q", first.CommandIdentity(), second.CommandIdentity())
	}
}

func TestNewRejectsCommandAndEnvironmentEscapeHatches(t *testing.T) {
	executable := currentTestExecutable(t)
	digest := artifactDigest(t, executable)
	base := Config{Command: Command{
		Identity: "typescript-v1", ExecutablePath: executable, ExecutableSHA256: digest,
		EntrypointPath: executable, EntrypointSHA256: digest, EntrypointMode: EntrypointExecutable,
	}}
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "relative executable", mutate: func(value *Config) { value.Command.ExecutablePath = filepath.Base(executable) }},
		{name: "wrong executable hash", mutate: func(value *Config) { value.Command.ExecutableSHA256 = strings.Repeat("0", 64) }},
		{name: "native entrypoint drift", mutate: func(value *Config) {
			value.Command.EntrypointPath = filepath.Dir(executable)
			value.Command.EntrypointSHA256 = digest
		}},
		{name: "node options", mutate: func(value *Config) { value.Command.Environment = []string{"NODE_OPTIONS=--require=attacker.js"} }},
		{name: "loader preload", mutate: func(value *Config) { value.Command.Environment = []string{"LD_PRELOAD=/tmp/attacker.so"} }},
		{name: "duplicate case-folded environment", mutate: func(value *Config) { value.Command.Environment = []string{"Path=one", "PATH=two"} }},
		{name: "nul argument", mutate: func(value *Config) { value.Command.FixedArguments = []string{"safe\x00unsafe"} }},
		{name: "negative grace", mutate: func(value *Config) { value.CancelGrace = -time.Second }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneConfig(base)
			test.mutate(&candidate)
			if _, err := New(candidate); err == nil {
				t.Fatal("unsafe command configuration was accepted")
			}
		})
	}
}

func TestStartRevalidatesArtifactHashBeforeEveryLaunch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a running Windows test executable cannot be replaced safely")
	}
	source := currentTestExecutable(t)
	copyPath := filepath.Join(t.TempDir(), "sealed-worker")
	body, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copyPath, body, 0o700); err != nil {
		t.Fatal(err)
	}
	digest := artifactDigest(t, copyPath)
	supervisor, err := New(Config{Command: Command{
		Identity: "typescript-v1", ExecutablePath: copyPath, ExecutableSHA256: digest,
		EntrypointPath: copyPath, EntrypointSHA256: digest, EntrypointMode: EntrypointExecutable,
		FixedArguments: []string{"-test.run=^TestProcessSupervisorHelper$"},
		Environment:    []string{"OPENSLACK_PROCESS_SUPERVISOR_HELPER=exit"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copyPath, append(body, byte('x')), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := supervisor.Start(t.Context()); err == nil || !strings.Contains(err.Error(), "changed after composition") {
		t.Fatalf("artifact drift error = %v", err)
	}
}

func TestStartRevalidatesFirstArgumentEntrypoint(t *testing.T) {
	executable := currentTestExecutable(t)
	executableDigest := artifactDigest(t, executable)
	entrypoint := filepath.Join(t.TempDir(), "worker.mjs")
	if err := os.WriteFile(entrypoint, []byte("export {};\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	entrypointDigest := artifactDigest(t, entrypoint)
	supervisor, err := New(Config{Command: Command{
		Identity: "typescript-v1", ExecutablePath: executable, ExecutableSHA256: executableDigest,
		EntrypointPath: entrypoint, EntrypointSHA256: entrypointDigest, EntrypointMode: EntrypointFirstArgument,
		Environment: []string{},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if supervisor.command.workingDirectory != filepath.Dir(entrypoint) {
		t.Fatalf("default working directory = %q", supervisor.command.workingDirectory)
	}
	if err := os.WriteFile(entrypoint, []byte("import 'attacker';\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := supervisor.Start(t.Context()); err == nil || !strings.Contains(err.Error(), "entrypoint changed") {
		t.Fatalf("entrypoint drift error = %v", err)
	}
}

func TestNewRejectsSymlinkedArtifact(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlink creation requires an external privilege")
	}
	executable := currentTestExecutable(t)
	link := filepath.Join(t.TempDir(), "worker-link")
	if err := os.Symlink(executable, link); err != nil {
		t.Fatal(err)
	}
	digest := artifactDigest(t, executable)
	_, err := New(Config{Command: Command{
		Identity: "typescript-v1", ExecutablePath: link, ExecutableSHA256: digest,
		EntrypointPath: executable, EntrypointSHA256: digest, EntrypointMode: EntrypointFirstArgument,
	}})
	if err == nil || !strings.Contains(err.Error(), "non-reparse") {
		t.Fatalf("symlink error = %v", err)
	}
}

func TestNewRejectsArtifactOutsideClosedSizeLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversized-worker")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maximumArtifactBytes + 1); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = New(Config{Command: Command{
		Identity: "oversized-worker", ExecutablePath: path, ExecutableSHA256: strings.Repeat("0", 64),
		EntrypointPath: path, EntrypointSHA256: strings.Repeat("0", 64), EntrypointMode: EntrypointExecutable,
	}})
	if err == nil || !strings.Contains(err.Error(), "closed artifact limit") {
		t.Fatalf("oversized artifact error = %v", err)
	}
}

func TestArtifactMetadataComparisonRejectsSizeModeAndTimestampDrift(t *testing.T) {
	modified := time.Unix(1_775_260_800, 123_000_000)
	baseline := artifactFileInfo{size: 1024, mode: 0o700, modified: modified}
	if !sameArtifactMetadata(baseline, baseline) {
		t.Fatal("identical artifact metadata was rejected")
	}
	for _, test := range []struct {
		name string
		info artifactFileInfo
	}{
		{name: "size", info: artifactFileInfo{size: 1025, mode: 0o700, modified: modified}},
		{name: "mode", info: artifactFileInfo{size: 1024, mode: 0o600, modified: modified}},
		{name: "modtime", info: artifactFileInfo{size: 1024, mode: 0o700, modified: modified.Add(time.Nanosecond)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if sameArtifactMetadata(baseline, test.info) {
				t.Fatal("artifact metadata drift was accepted")
			}
		})
	}
}

type artifactFileInfo struct {
	size     int64
	mode     os.FileMode
	modified time.Time
}

func (info artifactFileInfo) Name() string       { return "artifact" }
func (info artifactFileInfo) Size() int64        { return info.size }
func (info artifactFileInfo) Mode() os.FileMode  { return info.mode }
func (info artifactFileInfo) ModTime() time.Time { return info.modified }
func (info artifactFileInfo) IsDir() bool        { return info.mode.IsDir() }
func (info artifactFileInfo) Sys() any           { return nil }

func configWithSlices(value Config, arguments, environment []string) Config {
	result := cloneConfig(value)
	result.Command.FixedArguments = arguments
	result.Command.Environment = environment
	return result
}

func cloneConfig(value Config) Config {
	value.Command.FixedArguments = append([]string(nil), value.Command.FixedArguments...)
	value.Command.Environment = append([]string(nil), value.Command.Environment...)
	return value
}

func currentTestExecutable(t *testing.T) string {
	t.Helper()
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	path, err = filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(path)
}

func artifactDigest(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}
