// Command bootstrap-openslack creates the two least-privileged OpenSlack
// integration identities. It is a one-shot deployment command, not a general
// key-administration or HTTP surface.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"

	calleraccesspostgres "github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/openslackbootstrap"
)

type repeatedStrings []string

func (values *repeatedStrings) String() string { return "<redacted-list>" }
func (values *repeatedStrings) Set(value string) error {
	*values = append(*values, value)
	return nil
}

type commandDependencies struct {
	loadConfig func() (*config.OpenSlackBootstrapConfig, error)
	execute    func(context.Context, *config.OpenSlackBootstrapConfig, string, []string) (openslackbootstrap.Result, error)
}

func productionDependencies() commandDependencies {
	return commandDependencies{
		loadConfig: config.LoadOpenSlackBootstrap,
		execute: func(ctx context.Context, cfg *config.OpenSlackBootstrapConfig, outputPath string, vendorIDs []string) (openslackbootstrap.Result, error) {
			return openslackbootstrap.Run(ctx, openslackbootstrap.Options{
				OutputPath: outputPath, VendorIDs: vendorIDs, ActivePepper: cfg.ActivePepper,
				OpenStore: func(ctx context.Context) (openslackbootstrap.Store, func(), error) {
					pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
					if err != nil {
						return nil, nil, err
					}
					if err := pool.Ping(ctx); err != nil {
						pool.Close()
						return nil, nil, err
					}
					return calleraccesspostgres.NewOpenSlackBootstrapStore(pool), pool.Close, nil
				},
			})
		},
	}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr, productionDependencies()))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer, dependencies commandDependencies) int {
	flags := flag.NewFlagSet("bootstrap-openslack", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var outputPath string
	var vendorIDs repeatedStrings
	flags.StringVar(&outputPath, "output", "", "create-only JSON credential output path")
	flags.Var(&vendorIDs, "vendor-id", "fixture vendor ID; specify exactly twice")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 || outputPath == "" || len(vendorIDs) != 2 || vendorIDs[0] == vendorIDs[1] {
		fmt.Fprintln(stderr, "invalid_arguments: require --output and exactly two unique --vendor-id values")
		return 2
	}

	cfg, err := dependencies.loadConfig()
	if err != nil {
		fmt.Fprintf(stderr, "configuration_failed: %v\n", err)
		return 1
	}
	result, err := dependencies.execute(ctx, cfg, outputPath, []string(vendorIDs))
	if err != nil {
		if openslackbootstrap.IsCommitOutcomeUnknown(err) {
			fmt.Fprintf(stderr,
				"commit_outcome_unknown: credential file retained for manual convergence; caller_key_id=%s auditor_key_id=%s\n",
				result.CallerKeyID, result.AuditorKeyID)
		} else {
			fmt.Fprintf(stderr, "bootstrap_failed: %v\n", err)
		}
		return 1
	}
	fmt.Fprintf(stdout, "bootstrap committed; credentials written to %s\n", result.OutputPath)
	return 0
}
