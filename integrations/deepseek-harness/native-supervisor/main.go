// The private helper owns only a process tree; it has no task or approval authority.
package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const protocol = "openslack.windows_job.v1"

type options struct {
	runID, generation string
	cleanup           time.Duration
	command           []string
}

func parseOptions(args []string) (options, error) {
	var result options
	seen := map[string]bool{}
	for len(args) > 0 && args[0] != "--" {
		if len(args) < 2 || seen[args[0]] {
			return result, errors.New("invalid supervisor arguments")
		}
		seen[args[0]] = true
		switch args[0] {
		case "--run-id":
			result.runID = args[1]
		case "--generation":
			result.generation = args[1]
		case "--cleanup-ms":
			value, err := strconv.Atoi(args[1])
			if err != nil || value < 100 || value > 30000 {
				return result, errors.New("invalid supervisor cleanup bound")
			}
			result.cleanup = time.Duration(value) * time.Millisecond
		default:
			return result, errors.New("unknown supervisor argument")
		}
		args = args[2:]
	}
	if len(args) < 3 || args[0] != "--" || len(seen) != 3 ||
		!regexp.MustCompile(`^RUN-[A-Z0-9-]+$`).MatchString(result.runID) ||
		!regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`).MatchString(result.generation) ||
		!filepath.IsAbs(args[1]) || !filepath.IsAbs(args[2]) {
		return result, errors.New("incomplete supervisor deployment")
	}
	for _, value := range args {
		if strings.ContainsRune(value, '\x00') {
			return result, errors.New("invalid supervisor argument bytes")
		}
	}
	result.command = append([]string(nil), args[1:]...)
	return result, nil
}

func main() {
	config, err := parseOptions(os.Args[1:])
	if err != nil {
		os.Stderr.WriteString("OPENSLACK_SUPERVISOR_CONFIGURATION_INVALID\n")
		os.Exit(2)
	}
	if err := supervise(config); err != nil {
		// Child arguments, environment and upstream text may contain sensitive data.
		os.Stderr.WriteString("OPENSLACK_SUPERVISOR_STOP_UNCONFIRMED\n")
		os.Exit(1)
	}
}
