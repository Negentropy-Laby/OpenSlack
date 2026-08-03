//go:build !windows

package processsupervisor

import "os"

func hasReparsePoint(os.FileInfo) bool { return false }
