//go:build !windows

package workerregistry

import "os"

func hasReparsePoint(os.FileInfo) bool { return false }
