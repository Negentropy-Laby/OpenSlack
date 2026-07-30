package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestParserAcceptsAndSortsReviewedModules(t *testing.T) {
	output, status := runParserProcess(t, `{
		"Go":"1.26.5",
		"Use":[
			{"DiskPath":"./services/a-"},
			{"DiskPath":"./services/zulu"},
			{"DiskPath":"./services/alpha"}
		],
		"Replace":null
	}`)
	if status != 0 {
		t.Fatalf("parser exited %d: %s", status, output)
	}
	if output != "./services/a-\n./services/alpha\n./services/zulu\n" {
		t.Fatalf("unexpected output: %q", output)
	}
}

func TestParserRejectsUnreviewedWorkspaceAuthority(t *testing.T) {
	cases := map[string]string{
		"wrong Go version": `{"Go":"1.26.4","Use":[{"DiskPath":"./services/a"}]}`,
		"toolchain":        `{"Go":"1.26.5","Toolchain":"go1.26.5","Use":[{"DiskPath":"./services/a"}]}`,
		"godebug":          `{"Go":"1.26.5","Godebug":[{"Key":"x","Value":"1"}],"Use":[{"DiskPath":"./services/a"}]}`,
		"replace":          `{"Go":"1.26.5","Use":[{"DiskPath":"./services/a"}],"Replace":[{"Old":{"Path":"x"},"New":{"Path":"y"}}]}`,
		"path escape":      `{"Go":"1.26.5","Use":[{"DiskPath":"../services/a"}]}`,
		"long path":        `{"Go":"1.26.5","Use":[{"DiskPath":"./services/` + strings.Repeat("a", 49) + `"}]}`,
		"duplicate":        `{"Go":"1.26.5","Use":[{"DiskPath":"./services/a"},{"DiskPath":"./services/a"}]}`,
		"trailing value":   `{"Go":"1.26.5","Use":[{"DiskPath":"./services/a"}]} {}`,
		"malformed":        `{"Go":"1.26.5","Use":[`,
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			output, status := runParserProcess(t, input)
			if status == 0 {
				t.Fatalf("parser unexpectedly accepted input: %s", output)
			}
		})
	}
}

func TestParserRejectsOversizedInput(t *testing.T) {
	input := `{"Go":"1.26.5","Use":[{"DiskPath":"./services/a"}],"Padding":"` +
		strings.Repeat("x", maxWorkspaceJSONBytes) + `"}`
	output, status := runParserProcess(t, input)
	if status == 0 {
		t.Fatalf("parser unexpectedly accepted oversized input: %s", output)
	}
}

func TestParserProcess(t *testing.T) {
	if os.Getenv("GO_CHECK_PARSER_HELPER") != "1" {
		return
	}
	main()
	os.Exit(0)
}

func runParserProcess(t *testing.T, input string) (string, int) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestParserProcess$")
	command.Env = append(os.Environ(), "GO_CHECK_PARSER_HELPER=1")
	command.Stdin = strings.NewReader(input)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	err := command.Run()
	if err == nil {
		return output.String(), 0
	}
	exitError, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("run parser process: %v", err)
	}
	return output.String(), exitError.ExitCode()
}
