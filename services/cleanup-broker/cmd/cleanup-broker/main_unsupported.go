//go:build !linux

package main

import (
	"fmt"
	"os"
)

func main() { fmt.Fprintln(os.Stderr, "CLEANUP_BROKER_UNSUPPORTED_PLATFORM"); os.Exit(1) }
