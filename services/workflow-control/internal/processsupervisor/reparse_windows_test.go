//go:build windows

package processsupervisor

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestWindowsReparseAttributeIsAlwaysRejected(t *testing.T) {
	reparse := windowsAttributeFileInfo{attributes: syscall.FILE_ATTRIBUTE_REPARSE_POINT}
	if !hasReparsePoint(reparse) {
		t.Fatal("Windows reparse attribute was not detected")
	}
	if hasReparsePoint(windowsAttributeFileInfo{attributes: syscall.FILE_ATTRIBUTE_NORMAL}) {
		t.Fatal("ordinary Windows file was classified as a reparse point")
	}
}

func TestWindowsArtifactAndWorkingDirectoryRejectReparseLinks(t *testing.T) {
	root := t.TempDir()
	targetFile := filepath.Join(root, "worker.exe")
	if err := os.WriteFile(targetFile, []byte("sealed"), 0o700); err != nil {
		t.Fatal(err)
	}
	fileLink := filepath.Join(root, "worker-link.exe")
	if err := os.Symlink(targetFile, fileLink); err != nil {
		t.Skipf("Windows reparse link privilege unavailable: %v", err)
	}
	if _, err := validateArtifact(fileLink, strings.Repeat("0", 64), false); err == nil || !strings.Contains(err.Error(), "reparse") {
		t.Fatalf("artifact reparse error = %v", err)
	}

	targetDirectory := filepath.Join(root, "working")
	if err := os.Mkdir(targetDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	directoryLink := filepath.Join(root, "working-link")
	if err := os.Symlink(targetDirectory, directoryLink); err != nil {
		t.Skipf("Windows directory reparse link privilege unavailable: %v", err)
	}
	if _, err := validateWorkingDirectory(directoryLink); err == nil || !strings.Contains(err.Error(), "reparse") {
		t.Fatalf("working directory reparse error = %v", err)
	}
	nestedTarget := filepath.Join(targetDirectory, "nested-worker.js")
	if err := os.WriteFile(nestedTarget, []byte("sealed"), 0o600); err != nil {
		t.Fatal(err)
	}
	nestedThroughReparse := filepath.Join(directoryLink, "nested-worker.js")
	if _, err := validateArtifact(nestedThroughReparse, strings.Repeat("0", 64), false); err == nil || !strings.Contains(err.Error(), "reparse") {
		t.Fatalf("parent reparse error = %v", err)
	}
}

type windowsAttributeFileInfo struct{ attributes uint32 }

func (info windowsAttributeFileInfo) Name() string       { return "windows-artifact" }
func (info windowsAttributeFileInfo) Size() int64        { return 1 }
func (info windowsAttributeFileInfo) Mode() os.FileMode  { return 0 }
func (info windowsAttributeFileInfo) ModTime() time.Time { return time.Unix(0, 0) }
func (info windowsAttributeFileInfo) IsDir() bool        { return false }
func (info windowsAttributeFileInfo) Sys() any {
	return &syscall.Win32FileAttributeData{FileAttributes: info.attributes}
}
