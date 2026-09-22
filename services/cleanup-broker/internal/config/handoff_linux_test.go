//go:build linux

package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

func TestHandoffTemplatesCannotActivateExecution(t *testing.T) {
	read := func(name string) []byte {
		t.Helper()
		b, err := os.ReadFile(filepath.Join("../../handoff", name+".template.json"))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	var c Config
	raw := read("broker")
	if err := permit.Decode(raw, &c); err != nil {
		t.Fatal(err)
	}
	if c.Schema != Schema || decode(raw, &c, loadSpec{runtimeUID: 21001, runtimeGID: 21001}) == nil {
		t.Fatal("unfilled broker template must be schema-shaped but invalid")
	}
	var install ExecutionInstallation
	if err := permit.Decode(read("install-manifest"), &install); err != nil {
		t.Fatal(err)
	}
	if install.Schema != "openslack.cleanup_installation.v1" || len(install.Files) != 5 {
		t.Fatal("installation shape drift")
	}
	for _, f := range install.Files {
		if sha256Pattern.MatchString(f.SHA256) {
			t.Fatal("template must not claim reviewed installation bytes")
		}
	}
	var view TaskView
	if err := permit.Decode(read("task-dependencies"), &view); err != nil {
		t.Fatal(err)
	}
	if view.Schema != "openslack.cleanup_task_view.v1" || positiveDecimal(view.RepositoryID) || len(view.Tasks) == 0 || view.Tasks[0].IssueNumber != 0 {
		t.Fatal("template must require administrator repository and task evidence")
	}
}
