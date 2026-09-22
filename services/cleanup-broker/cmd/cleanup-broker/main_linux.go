//go:build linux

// cleanup-broker is a foreground service with no client-selected configuration.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/broker"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/lifecycle"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/runner"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/source"
)

func main() {
	if err := run(); err != nil {
		// Do not expose errors from upstream transports or installation contents.
		fmt.Fprintln(os.Stderr, "CLEANUP_BROKER_START_OR_SHUTDOWN_FAILED")
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 1 {
		return errors.New("arguments unsupported")
	}
	snapshot, err := config.Load()
	if err != nil {
		return err
	}
	defer snapshot.Close()
	runtime, err := lifecycle.Start(snapshot)
	if err != nil {
		return err
	}
	defer runtime.Close()
	// Execution is available only from fixed installed evidence. Missing or
	// unsafe execution prerequisites never disable authenticated historical
	// receipt queries and never select a direct/human transport.
	var reader *source.Reader
	var worker *runner.ProcessRunner
	installed, executionErr := snapshot.LoadExecution()
	if executionErr == nil {
		var token []byte
		token, executionErr = snapshot.ReadOwnedCredential(config.GovernanceCredential)
		if executionErr == nil {
			reader, executionErr = source.NewWithNetwork(string(token), installed.Network.HTTPSProxy, installed.Network.NoProxy)
		}
		clear(token)
	}
	if executionErr == nil {
		worker, executionErr = runner.New(snapshot, runtime.Ledger)
	}
	var executor broker.Runner
	if executionErr != nil {
		runtime.StopAdmission()
		fmt.Fprintln(os.Stderr, "CLEANUP_BROKER_EXECUTION_BLOCKED_STATUS_AVAILABLE")
	} else {
		executor = worker
	}
	handler, err := broker.New(snapshot, runtime, reader, executor)
	if err != nil {
		return err
	}
	server := newHTTPServer(handler, handler.ConnContext)
	var closer workerCloser
	if worker != nil {
		closer = worker
	}
	// This defer precedes runtime.Close on every exit, including Serve failure.
	// Closing the worker alone is insufficient: the handler still owns the
	// terminal receipt append after Execute returns.
	defer shutdown(server, handler, closer, 90*time.Second, func() {
		fmt.Fprintln(os.Stderr, "CLEANUP_BROKER_DRAIN_BLOCKED_LOCK_RETAINED")
		time.Sleep(time.Second)
	})
	stopped, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	finished := make(chan error, 1)
	go func() { finished <- server.Serve(runtime.Listener) }()
	select {
	case err = <-finished:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-stopped.Done():
	}
	return nil
}

// The write deadline begins during request parsing, before body processing and
// the broker's bounded admission work. Cover both without extending execution,
// permit validity, or transport budgets. Clients still own their own deadline;
// a disconnected caller must reconcile rather than retry a destructive action.
func newHTTPServer(handler http.Handler, connContext func(context.Context, net.Conn) context.Context) *http.Server {
	const readBudget = 10 * time.Second
	const responseMargin = 5 * time.Second
	return &http.Server{Handler: handler, ConnContext: connContext, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: readBudget, WriteTimeout: readBudget + broker.RequestTimeout + responseMargin, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8192}
}

type serverCloser interface {
	Shutdown(context.Context) error
	Close() error
}
type handlerDrainer interface {
	StopAdmission()
	Drain(context.Context) error
}
type workerCloser interface{ Close() error }

// shutdown deliberately does not time out into releasing the ledger lock. A
// permanently poisoned worker remains stopped and requires operator recovery.
func shutdown(server serverCloser, handler handlerDrainer, worker workerCloser, budget time.Duration, retry func()) {
	handler.StopAdmission()
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	if server.Shutdown(ctx) != nil {
		_ = server.Close()
	}
	cancel()
	if worker != nil {
		for worker.Close() != nil {
			retry()
		}
	}
	for {
		ctx, cancel = context.WithTimeout(context.Background(), budget)
		err := handler.Drain(ctx)
		cancel()
		if err == nil {
			return
		}
		retry()
	}
}
