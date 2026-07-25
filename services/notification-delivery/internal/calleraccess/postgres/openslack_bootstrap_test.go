package postgres

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/openslackbootstrap"
)

func TestClassifyBootstrapCommitFailure(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		wantUnknown bool
	}{
		{name: "transaction rolled back", err: pgx.ErrTxCommitRollback},
		{name: "constraint error", err: &pgconn.PgError{Code: "23505"}},
		{name: "server shutdown", err: &pgconn.PgError{Code: "57P01"}, wantUnknown: true},
		{name: "statement completion unknown", err: &pgconn.PgError{Code: "40003"}, wantUnknown: true},
		{name: "connection loss", err: errors.New("connection lost"), wantUnknown: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := classifyBootstrapCommitFailure(tt.err)
			if openslackbootstrap.IsCommitOutcomeUnknown(err) != tt.wantUnknown {
				t.Fatalf("unknown=%v, want %v; error=%v", openslackbootstrap.IsCommitOutcomeUnknown(err), tt.wantUnknown, err)
			}
		})
	}
}

func TestValidateOpenSlackBootstrapRequestRejectsAuthorityExpansion(t *testing.T) {
	caller := calleraccess.PrincipalRecord{
		PrincipalID: openslackbootstrap.CallerPrincipalID, Kind: calleraccess.KindCaller, Status: "active", OwningScope: openslackbootstrap.OwningScope,
		VendorScope: []string{"fixture-slack", "fixture-webhook"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification, calleraccess.CapabilityReadNotifications},
	}
	auditor := calleraccess.PrincipalRecord{
		PrincipalID: openslackbootstrap.AuditorPrincipalID, Kind: calleraccess.KindOperator, Status: "active", OwningScope: openslackbootstrap.OwningScope,
		VendorScope: []string{"fixture-slack", "fixture-webhook"}, Capabilities: []string{calleraccess.CapabilityReadNotifications},
	}
	request := openslackbootstrap.PersistRequest{
		Caller: caller, Auditor: auditor,
		CallerKey:  openslackbootstrap.KeyRecord{KeyID: "caller-key", PrincipalID: caller.PrincipalID, SecretHash: []byte("caller-hash"), PepperID: "fixture"},
		AuditorKey: openslackbootstrap.KeyRecord{KeyID: "auditor-key", PrincipalID: auditor.PrincipalID, SecretHash: []byte("auditor-hash"), PepperID: "fixture"},
	}
	if err := validateOpenSlackBootstrapRequest(request); err == nil {
		t.Fatal("caller authority expansion was accepted")
	}
}
