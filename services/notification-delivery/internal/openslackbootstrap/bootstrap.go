// Package openslackbootstrap owns the one-shot, non-HTTP bootstrap boundary
// for the two least-privileged OpenSlack integration identities.
package openslackbootstrap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess"
)

const (
	OutputSchema       = "rc_wsman.openslack_bootstrap_keys.v1"
	CallerPrincipalID  = "openslack-handoff-caller"
	AuditorPrincipalID = "openslack-canary-auditor"
	OwningScope        = "openslack"
)

// PersistenceFailureKind distinguishes a confirmed non-commit from an
// indeterminate commit. The distinction controls whether the credential file
// can be safely removed.
type PersistenceFailureKind string

const (
	FailureKnownRollback PersistenceFailureKind = "known_rollback"
	FailureCommitUnknown PersistenceFailureKind = "commit_outcome_unknown"
)

// PersistenceError is intentionally sanitized: Error never reflects SQL,
// request values, hashes, or raw credentials.
type PersistenceError struct {
	Kind PersistenceFailureKind
	Code string
	Err  error
}

func (e PersistenceError) Error() string {
	if e.Code == "" {
		return string(e.Kind)
	}
	return e.Code
}

func (e PersistenceError) Unwrap() error { return e.Err }

// IsCommitOutcomeUnknown reports whether the database may have committed.
func IsCommitOutcomeUnknown(err error) bool {
	var persistenceError PersistenceError
	return errors.As(err, &persistenceError) && persistenceError.Kind == FailureCommitUnknown
}

// Credential is one raw API key written only to the protected output file.
type Credential struct {
	PrincipalID string `json:"principal_id"`
	KeyID       string `json:"key_id"`
	APIKey      string `json:"api_key"`
}

// Output is the stable create-once credential file schema.
type Output struct {
	Schema  string     `json:"schema"`
	Caller  Credential `json:"caller"`
	Auditor Credential `json:"auditor"`
}

// KeyRecord carries only verifier material into PostgreSQL.
type KeyRecord struct {
	KeyID       string
	PrincipalID string
	SecretHash  []byte
	PepperID    string
}

// PersistRequest is committed atomically by Store.
type PersistRequest struct {
	Caller     calleraccess.PrincipalRecord
	Auditor    calleraccess.PrincipalRecord
	CallerKey  KeyRecord
	AuditorKey KeyRecord
}

// Store is deliberately separate from calleraccess.Repository because the
// bootstrap is one indivisible transaction, not four ordinary admin calls.
type Store interface {
	BootstrapOpenSlack(context.Context, PersistRequest) error
}

// StoreFactory is invoked only after the output file and its parent directory
// are durably synchronized.
type StoreFactory func(context.Context) (Store, func(), error)

// Options are the complete inputs to the one-shot bootstrap operation.
type Options struct {
	OutputPath   string
	VendorIDs    []string
	ActivePepper calleraccess.Pepper
	OpenStore    StoreFactory
}

// Result contains non-secret convergence identifiers only.
type Result struct {
	OutputPath   string
	CallerKeyID  string
	AuditorKeyID string
}

// Run creates the credential file before opening PostgreSQL, then persists
// both principals and both key verifiers in one Store transaction.
func Run(ctx context.Context, options Options) (Result, error) {
	request, output, err := prepare(options.VendorIDs, options.ActivePepper)
	if err != nil {
		return Result{}, err
	}
	if options.OutputPath == "" {
		return Result{}, fmt.Errorf("output path is required")
	}
	if options.OpenStore == nil {
		return Result{}, fmt.Errorf("store factory is required")
	}

	encoded, err := json.Marshal(output)
	if err != nil {
		return Result{}, fmt.Errorf("encode credential output")
	}
	encoded = append(encoded, '\n')
	if err := durableCreate(options.OutputPath, encoded); err != nil {
		return Result{}, fmt.Errorf("create credential output: %w", err)
	}

	result := Result{
		OutputPath: options.OutputPath, CallerKeyID: output.Caller.KeyID, AuditorKeyID: output.Auditor.KeyID,
	}
	store, closeStore, err := options.OpenStore(ctx)
	if err != nil {
		return Result{}, cleanupAfterKnownFailure(options.OutputPath, "database_open_failed", err)
	}
	if closeStore != nil {
		defer closeStore()
	}
	if store == nil {
		return Result{}, cleanupAfterKnownFailure(options.OutputPath, "database_open_failed", errors.New("nil store"))
	}

	if err := store.BootstrapOpenSlack(ctx, request); err != nil {
		if IsCommitOutcomeUnknown(err) {
			return result, err
		}
		return Result{}, cleanupAfterKnownFailure(options.OutputPath, publicCode(err), err)
	}
	return result, nil
}

func prepare(vendorIDs []string, pepper calleraccess.Pepper) (PersistRequest, Output, error) {
	if len(vendorIDs) != 2 || vendorIDs[0] == vendorIDs[1] {
		return PersistRequest{}, Output{}, fmt.Errorf("exactly two unique vendor IDs are required")
	}
	if pepper == nil || pepper.PepperID() == "" || len(pepper.PepperValue()) == 0 {
		return PersistRequest{}, Output{}, fmt.Errorf("active pepper is required")
	}

	caller := calleraccess.PrincipalRecord{
		PrincipalID: CallerPrincipalID, Kind: calleraccess.KindCaller, Status: "active",
		VendorScope: append([]string(nil), vendorIDs...), OwningScope: OwningScope,
		Capabilities: []string{calleraccess.CapabilitySubmitNotification}, ManagedPrincipalScope: []string{},
	}
	auditor := calleraccess.PrincipalRecord{
		PrincipalID: AuditorPrincipalID, Kind: calleraccess.KindOperator, Status: "active",
		VendorScope: append([]string(nil), vendorIDs...), OwningScope: OwningScope,
		Capabilities: []string{calleraccess.CapabilityReadNotifications}, ManagedPrincipalScope: []string{},
	}
	if err := calleraccess.ValidatePrincipal(caller); err != nil {
		return PersistRequest{}, Output{}, fmt.Errorf("invalid caller principal: %w", err)
	}
	if err := calleraccess.ValidatePrincipal(auditor); err != nil {
		return PersistRequest{}, Output{}, fmt.Errorf("invalid auditor principal: %w", err)
	}

	callerKeyID, callerSecret, callerHash, err := calleraccess.GenerateKey(pepper)
	if err != nil {
		return PersistRequest{}, Output{}, fmt.Errorf("generate caller key")
	}
	auditorKeyID, auditorSecret, auditorHash, err := calleraccess.GenerateKey(pepper)
	if err != nil {
		return PersistRequest{}, Output{}, fmt.Errorf("generate auditor key")
	}
	request := PersistRequest{
		Caller: caller, Auditor: auditor,
		CallerKey:  KeyRecord{KeyID: callerKeyID, PrincipalID: CallerPrincipalID, SecretHash: callerHash, PepperID: pepper.PepperID()},
		AuditorKey: KeyRecord{KeyID: auditorKeyID, PrincipalID: AuditorPrincipalID, SecretHash: auditorHash, PepperID: pepper.PepperID()},
	}
	output := Output{
		Schema:  OutputSchema,
		Caller:  Credential{PrincipalID: CallerPrincipalID, KeyID: callerKeyID, APIKey: callerKeyID + "." + callerSecret},
		Auditor: Credential{PrincipalID: AuditorPrincipalID, KeyID: auditorKeyID, APIKey: auditorKeyID + "." + auditorSecret},
	}
	return request, output, nil
}

func durableCreate(path string, data []byte) (err error) {
	parent := filepath.Dir(path)
	info, err := os.Lstat(parent)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("output parent must be a real directory")
	}

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	created := true
	defer func() {
		if file != nil {
			_ = file.Close()
		}
		if err != nil && created {
			_ = os.Remove(path)
			_ = syncDirectory(parent)
		}
	}()
	if err = file.Chmod(0o600); err != nil {
		return err
	}
	if _, err = file.Write(data); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		file = nil
		return err
	}
	file = nil
	if err = syncDirectory(parent); err != nil {
		return err
	}
	created = false
	return nil
}

func cleanupAfterKnownFailure(path, code string, cause error) error {
	if err := durableRemove(path); err != nil {
		return fmt.Errorf("%s; credential_output_cleanup_failed", code)
	}
	return PersistenceError{Kind: FailureKnownRollback, Code: code, Err: cause}
}

func durableRemove(path string) error {
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func publicCode(err error) string {
	var persistenceError PersistenceError
	if errors.As(err, &persistenceError) && persistenceError.Code != "" {
		return persistenceError.Code
	}
	return "bootstrap_persistence_failed"
}

// ReadOutput reads the credential file for controlled deployment handoff and
// convergence tooling. Callers must not log or serialize the returned keys.
func ReadOutput(path string) (Output, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Output{}, err
	}
	var output Output
	if err := json.Unmarshal(data, &output); err != nil {
		return Output{}, fmt.Errorf("decode credential output")
	}
	if output.Schema != OutputSchema || output.Caller.PrincipalID != CallerPrincipalID || output.Auditor.PrincipalID != AuditorPrincipalID {
		return Output{}, fmt.Errorf("credential output contract mismatch")
	}
	return output, nil
}
