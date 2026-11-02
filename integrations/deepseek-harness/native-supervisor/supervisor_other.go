//go:build !windows

package main

import "errors"

func supervise(options) error { return errors.New("native Windows Job supervision required") }
