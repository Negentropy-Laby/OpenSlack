package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
)

type accountRepository struct {
	workspaceID string
	runID       string
	account     budgetstore.Account
}

func (repository accountRepository) Reserve(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
	return budgetstore.MutationResult{}, errors.New("reserve is unavailable in the framing fixture")
}

func (repository accountRepository) Settle(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
	return budgetstore.MutationResult{}, errors.New("settle is unavailable in the framing fixture")
}

func (repository accountRepository) ReadAccount(_ context.Context, workspaceID, runID string) (budgetstore.Account, error) {
	if workspaceID != repository.workspaceID || runID != repository.runID {
		return budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorNotFound, "account fixture identity mismatch", nil)
	}
	return repository.account, nil
}

func (accountRepository) ReadReservation(context.Context, string, string, string) (budgetstore.Reservation, error) {
	return budgetstore.Reservation{}, budgetstore.Failure(budgetstore.ErrorNotFound, "reservation unavailable", nil)
}

func (accountRepository) ReadReceipt(context.Context, string, string) (budgetstore.Receipt, error) {
	return budgetstore.Receipt{}, budgetstore.Failure(budgetstore.ErrorNotFound, "receipt unavailable", nil)
}

func (accountRepository) Ready(context.Context) error { return nil }

func (accountRepository) Statistics(context.Context) (budgetstore.Statistics, error) {
	return budgetstore.Statistics{}, nil
}

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		panic(fmt.Sprintf("%s is required", name))
	}
	return value
}

func main() {
	buildSHA := required("OPENSLACK_TEST_BUDGET_BUILD_SHA")
	workspaceID := required("OPENSLACK_TEST_BUDGET_WORKSPACE_ID")
	callerID := required("OPENSLACK_TEST_BUDGET_CALLER_ID")
	runID := required("OPENSLACK_TEST_BUDGET_RUN_ID")
	bearerToken := required("OPENSLACK_TEST_BUDGET_BEARER_TOKEN")
	routingEpoch, err := strconv.ParseInt(required("OPENSLACK_TEST_BUDGET_ROUTING_EPOCH"), 10, 64)
	if err != nil {
		panic(err)
	}
	exactBytes, err := base64.StdEncoding.DecodeString(required("OPENSLACK_TEST_BUDGET_ACCOUNT_BASE64"))
	if err != nil {
		panic(err)
	}
	durable, err := budgetstore.DecodeDurableRecord(exactBytes)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256([]byte(bearerToken))
	service, err := budgetapp.New(budgetapp.Options{
		Repository: accountRepository{
			workspaceID: workspaceID,
			runID:       runID,
			account: budgetstore.Account{
				Value:      durable.OperationalProjection,
				Durable:    durable,
				ExactBytes: exactBytes,
			},
		},
		QualificationMode: true,
		BuildSHA:          buildSHA,
		BearerTokenSHA256: hex.EncodeToString(digest[:]),
		WorkspaceID:       workspaceID,
		CallerID:          callerID,
		RoutingEpoch:      routingEpoch,
		Seed: budgetstore.QualificationSeed{
			PolicyHash: buildSHA,
			Limit: budgetstore.Quantities{
				Tokens:  "1",
				NanoUSD: "1",
				Calls:   "1",
			},
		},
		Logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
	})
	if err != nil {
		panic(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	done := make(chan struct{}, 1)
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		service.Handler().ServeHTTP(writer, request)
		done <- struct{}{}
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			panic(serveErr)
		}
	}()
	fmt.Printf("http://%s\n", listener.Addr().String())
	<-done
	shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownContext); err != nil {
		panic(err)
	}
}
