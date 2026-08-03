// Package processsupervisor launches one build-sealed workflow runner without
// a shell. Commands, entrypoints, arguments, and environments are fixed when
// the supervisor is constructed; a job or wire message cannot select them.
package processsupervisor

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const commandIdentityDomain = "openslack.process_supervisor.sealed_command.v1"

const (
	maximumFixedArguments     = 64
	maximumArgumentBytes      = 4096
	maximumEnvironmentEntries = 256
	maximumEnvironmentBytes   = 32 * 1024
	maximumArtifactBytes      = 512 * 1024 * 1024
)

var (
	identityPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	hashPattern            = regexp.MustCompile(`^[0-9a-f]{64}$`)
	environmentNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// EntrypointMode determines how the sealed entrypoint participates in argv.
// It is part of the command identity and cannot be changed per launch.
type EntrypointMode string

const (
	// EntrypointFirstArgument directly executes ExecutablePath and supplies the
	// sealed entrypoint as argv[1]. This is the TypeScript/Node worker mode.
	EntrypointFirstArgument EntrypointMode = "first-argument"
	// EntrypointExecutable directly executes a native sealed entrypoint. In
	// this mode ExecutablePath and EntrypointPath must name the same file.
	EntrypointExecutable EntrypointMode = "executable"
)

// Command is the complete immutable launch description. Environment is exact:
// an empty slice means an empty environment rather than inheriting os.Environ.
type Command struct {
	Identity         string
	ExecutablePath   string
	ExecutableSHA256 string
	EntrypointPath   string
	EntrypointSHA256 string
	EntrypointMode   EntrypointMode
	FixedArguments   []string
	Environment      []string
	WorkingDirectory string
}

type sealedCommand struct {
	identity         string
	executable       string
	executableHash   string
	entrypoint       string
	entrypointHash   string
	entrypointMode   EntrypointMode
	arguments        []string
	environment      []string
	workingDirectory string
	identityHash     string
}

func sealCommand(input Command) (sealedCommand, error) {
	if !identityPattern.MatchString(input.Identity) {
		return sealedCommand{}, fmt.Errorf("sealed command identity is invalid")
	}
	if input.EntrypointMode != EntrypointFirstArgument && input.EntrypointMode != EntrypointExecutable {
		return sealedCommand{}, fmt.Errorf("sealed entrypoint mode is invalid")
	}
	executable, err := validateArtifact(input.ExecutablePath, input.ExecutableSHA256, true)
	if err != nil {
		return sealedCommand{}, fmt.Errorf("sealed executable: %w", err)
	}
	entrypoint, err := validateArtifact(input.EntrypointPath, input.EntrypointSHA256, input.EntrypointMode == EntrypointExecutable)
	if err != nil {
		return sealedCommand{}, fmt.Errorf("sealed entrypoint: %w", err)
	}
	if input.EntrypointMode == EntrypointExecutable && !samePath(executable, entrypoint) {
		return sealedCommand{}, fmt.Errorf("native sealed entrypoint must be the executable")
	}
	arguments, err := validateArguments(input.FixedArguments)
	if err != nil {
		return sealedCommand{}, err
	}
	environment, err := validateEnvironment(input.Environment)
	if err != nil {
		return sealedCommand{}, err
	}
	workingDirectoryValue := input.WorkingDirectory
	if workingDirectoryValue == "" {
		workingDirectoryValue = filepath.Dir(entrypoint)
	}
	workingDirectory, err := validateWorkingDirectory(workingDirectoryValue)
	if err != nil {
		return sealedCommand{}, err
	}
	result := sealedCommand{
		identity: input.Identity, executable: executable,
		executableHash: input.ExecutableSHA256, entrypoint: entrypoint,
		entrypointHash: input.EntrypointSHA256, entrypointMode: input.EntrypointMode,
		arguments: arguments, environment: environment, workingDirectory: workingDirectory,
	}
	result.identityHash = hashCommandIdentity(result)
	return result, nil
}

func (command sealedCommand) revalidate() error {
	if _, err := validateArtifact(command.executable, command.executableHash, true); err != nil {
		return fmt.Errorf("sealed executable changed after composition: %w", err)
	}
	if _, err := validateArtifact(command.entrypoint, command.entrypointHash, command.entrypointMode == EntrypointExecutable); err != nil {
		return fmt.Errorf("sealed entrypoint changed after composition: %w", err)
	}
	if command.workingDirectory != "" {
		if _, err := validateWorkingDirectory(command.workingDirectory); err != nil {
			return fmt.Errorf("sealed working directory changed after composition: %w", err)
		}
	}
	return nil
}

func (command sealedCommand) argv() []string {
	result := make([]string, 0, len(command.arguments)+1)
	if command.entrypointMode == EntrypointFirstArgument {
		result = append(result, command.entrypoint)
	}
	return append(result, command.arguments...)
}

func validateArtifact(value, expectedHash string, requireExecutable bool) (string, error) {
	if !hashPattern.MatchString(expectedHash) {
		return "", fmt.Errorf("expected SHA-256 must be 64 lowercase hexadecimal characters")
	}
	if value == "" || strings.ContainsRune(value, '\x00') || !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return "", fmt.Errorf("path must be normalized and absolute")
	}
	before, err := os.Lstat(value)
	if err != nil {
		return "", fmt.Errorf("inspect path: %w", err)
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || hasReparsePoint(before) {
		return "", fmt.Errorf("path must be a regular non-reparse file")
	}
	if before.Size() < 1 || before.Size() > maximumArtifactBytes {
		return "", fmt.Errorf("file size is outside the closed artifact limit")
	}
	if found, inspectErr := pathContainsReparsePoint(value); inspectErr != nil {
		return "", fmt.Errorf("inspect path components: %w", inspectErr)
	} else if found {
		return "", fmt.Errorf("path contains a reparse point")
	}
	if runtime.GOOS != "windows" && requireExecutable && before.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("file is not executable")
	}
	resolved, err := filepath.EvalSymlinks(value)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil || !samePath(value, filepath.Clean(resolved)) {
		return "", fmt.Errorf("path is not canonical")
	}
	file, err := os.Open(value)
	if err != nil {
		return "", fmt.Errorf("open path: %w", err)
	}
	hasher := sha256.New()
	copied, copyErr := io.Copy(hasher, io.LimitReader(file, maximumArtifactBytes+1))
	opened, statErr := file.Stat()
	closeErr := file.Close()
	if copyErr != nil || statErr != nil || closeErr != nil {
		return "", fmt.Errorf("hash path: %w", joinErrors(copyErr, statErr, closeErr))
	}
	if copied != before.Size() || copied > maximumArtifactBytes {
		return "", fmt.Errorf("file size changed or exceeded the closed artifact limit while hashing")
	}
	after, err := os.Lstat(value)
	if err != nil {
		return "", fmt.Errorf("reinspect path: %w", err)
	}
	if hasReparsePoint(opened) || hasReparsePoint(after) ||
		!os.SameFile(before, opened) || !os.SameFile(before, after) ||
		!sameArtifactMetadata(before, opened) || !sameArtifactMetadata(before, after) {
		return "", fmt.Errorf("file identity or metadata changed during validation")
	}
	if found, inspectErr := pathContainsReparsePoint(value); inspectErr != nil {
		return "", fmt.Errorf("reinspect path components: %w", inspectErr)
	} else if found {
		return "", fmt.Errorf("path acquired a reparse point during validation")
	}
	actualHash := hex.EncodeToString(hasher.Sum(nil))
	if actualHash != expectedHash {
		return "", fmt.Errorf("SHA-256 mismatch")
	}
	return value, nil
}

func validateArguments(values []string) ([]string, error) {
	if len(values) > maximumFixedArguments {
		return nil, fmt.Errorf("sealed argument count exceeds the closed limit")
	}
	result := append([]string(nil), values...)
	for _, value := range result {
		if strings.ContainsRune(value, '\x00') || len(value) > maximumArgumentBytes {
			return nil, fmt.Errorf("sealed argument is invalid or exceeds the closed limit")
		}
	}
	return result, nil
}

var forbiddenEnvironment = map[string]struct{}{
	"BASH_ENV": {}, "COMSPEC": {}, "DYLD_FRAMEWORK_PATH": {}, "DYLD_INSERT_LIBRARIES": {},
	"DYLD_LIBRARY_PATH": {}, "ENV": {}, "LD_AUDIT": {}, "LD_LIBRARY_PATH": {}, "LD_PRELOAD": {},
	"NODE_OPTIONS": {}, "NODE_PATH": {}, "NODE_REPL_EXTERNAL_MODULE": {}, "PATHEXT": {},
	"PROMPT_COMMAND": {}, "PYTHONPATH": {}, "RUBYOPT": {},
}

func validateEnvironment(values []string) ([]string, error) {
	if len(values) > maximumEnvironmentEntries {
		return nil, fmt.Errorf("sealed environment count exceeds the closed limit")
	}
	result := append([]string{}, values...)
	seen := make(map[string]struct{}, len(result))
	for _, entry := range result {
		if strings.ContainsRune(entry, '\x00') || len(entry) > maximumEnvironmentBytes {
			return nil, fmt.Errorf("sealed environment entry is invalid or exceeds the closed limit")
		}
		name, _, found := strings.Cut(entry, "=")
		if !found || !environmentNamePattern.MatchString(name) {
			return nil, fmt.Errorf("sealed environment entry is invalid")
		}
		canonical := strings.ToUpper(name)
		if _, duplicate := seen[canonical]; duplicate {
			return nil, fmt.Errorf("sealed environment contains duplicate variable %s", canonical)
		}
		seen[canonical] = struct{}{}
		if _, forbidden := forbiddenEnvironment[canonical]; forbidden {
			return nil, fmt.Errorf("sealed environment variable %s can alter executable behavior", canonical)
		}
	}
	return result, nil
}

func validateWorkingDirectory(value string) (string, error) {
	if strings.ContainsRune(value, '\x00') || !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return "", fmt.Errorf("sealed working directory must be normalized and absolute")
	}
	before, err := os.Lstat(value)
	if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 || hasReparsePoint(before) {
		return "", fmt.Errorf("sealed working directory must be a non-reparse directory")
	}
	if found, inspectErr := pathContainsReparsePoint(value); inspectErr != nil {
		return "", fmt.Errorf("inspect sealed working directory components: %w", inspectErr)
	} else if found {
		return "", fmt.Errorf("sealed working directory path contains a reparse point")
	}
	resolved, err := filepath.EvalSymlinks(value)
	if err != nil || !samePath(value, filepath.Clean(resolved)) {
		return "", fmt.Errorf("sealed working directory is not canonical")
	}
	after, err := os.Lstat(value)
	if err != nil || !after.IsDir() || hasReparsePoint(after) || !os.SameFile(before, after) {
		return "", fmt.Errorf("sealed working directory identity changed during validation")
	}
	return value, nil
}

func sameArtifactMetadata(left, right os.FileInfo) bool {
	return left.Size() == right.Size() &&
		left.Mode() == right.Mode() &&
		left.ModTime().Equal(right.ModTime())
}

func hashCommandIdentity(command sealedCommand) string {
	hasher := sha256.New()
	writeIdentityField(hasher, commandIdentityDomain)
	for _, value := range []string{
		command.identity, command.executable, command.executableHash,
		command.entrypoint, command.entrypointHash, string(command.entrypointMode),
		command.workingDirectory,
	} {
		writeIdentityField(hasher, value)
	}
	writeIdentityList(hasher, command.arguments)
	writeIdentityList(hasher, command.environment)
	return hex.EncodeToString(hasher.Sum(nil))
}

func writeIdentityList(destination io.Writer, values []string) {
	_ = binary.Write(destination, binary.BigEndian, uint64(len(values)))
	for _, value := range values {
		writeIdentityField(destination, value)
	}
}

func writeIdentityField(destination io.Writer, value string) {
	_ = binary.Write(destination, binary.BigEndian, uint64(len(value)))
	_, _ = io.WriteString(destination, value)
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}
