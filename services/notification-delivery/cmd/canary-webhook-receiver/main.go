package main

import (
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/canaryreceiver"
)

func main() {
	bind := os.Getenv("WEBHOOK_RECEIVER_BIND")
	if bind == "" {
		bind = ":8090"
	}
	store := os.Getenv("WEBHOOK_RECEIVER_STORE")
	auditKey := os.Getenv("WEBHOOK_AUDIT_TOKEN")
	receiver, err := canaryreceiver.New(store, auditKey)
	if err != nil {
		slog.Error("canary_receiver_config_invalid")
		os.Exit(1)
	}
	server := &http.Server{
		Addr:              bind,
		Handler:           receiver.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	slog.Info("canary_receiver_listening", "addr", bind)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("canary_receiver_failed")
		os.Exit(1)
	}
}
