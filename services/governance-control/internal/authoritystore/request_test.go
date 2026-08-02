package authoritystore_test

import (
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

func TestAuthorityRequestUsesBodyIdempotencyAndBoundFingerprint(t *testing.T) {
	prepared, input := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	if prepared.Route.RoutingEpoch != 7 || input.IdempotencyKey != authoritystore.ExpectedIdempotencyKey(prepared.ExactBody) {
		t.Fatalf("prepared/input = %+v / %+v", prepared, input)
	}
	other := prepared
	other.CallerID = "typescript:other"
	if authoritystore.RequestFingerprint("POST", "/v1/governance/plans:accept", other) == input.RequestFingerprint {
		t.Fatal("caller identity did not affect request fingerprint")
	}
}

func TestAuthorityRequestRejectsNonCanonicalEpochAndBody(t *testing.T) {
	prepared, _ := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 1)
	for _, epoch := range []string{"0", "01", "-1", "1.0", "9007199254740992"} {
		if _, err := authoritystore.PrepareRequest(prepared.ExactBody, prepared.CallerID, prepared.WorkspaceID, epoch, prepared.ExpectedServiceBuild); err == nil {
			t.Fatalf("accepted epoch %q", epoch)
		}
	}
	if _, err := authoritystore.PrepareRequest([]byte(strings.TrimSuffix(string(prepared.ExactBody), "\n")), prepared.CallerID, prepared.WorkspaceID, "1", prepared.ExpectedServiceBuild); err == nil {
		t.Fatal("accepted body without canonical LF")
	}
}

func TestExpireRequiresUpdatedAtAtOrAfterExpirationBoundary(t *testing.T) {
	pending, _ := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	atBoundary, _ := testsupport.AuthorityRequestForPlan(t, authoritystore.OperationExpire, "expired-record-validation-and-read-model", 1, 7, testsupport.PlanID, "2026-08-02T06:15:00.000Z")
	if err := authoritystore.ValidateTransition(atBoundary, pending.RecordBytes); err != nil {
		t.Fatalf("exact expiration boundary rejected: %v", err)
	}
	early, _ := testsupport.AuthorityRequestForPlan(t, authoritystore.OperationExpire, "expired-record-validation-and-read-model", 1, 7, testsupport.PlanID, "2026-08-02T06:14:59.999Z")
	if err := authoritystore.ValidateTransition(early, pending.RecordBytes); !authoritystore.IsCode(err, authoritystore.ErrorConflict) {
		t.Fatalf("early expiration error = %v", err)
	}
}

func TestExpectedRevisionRejectsMaximumSafeInteger(t *testing.T) {
	prepared, _ := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 1)
	body := strings.Replace(string(prepared.ExactBody), `"expectedRevision":0`, `"expectedRevision":9007199254740991`, 1)
	if _, err := authoritystore.PrepareRequest([]byte(body), prepared.CallerID, prepared.WorkspaceID, "1", prepared.ExpectedServiceBuild); err == nil {
		t.Fatal("accepted expectedRevision that cannot be incremented safely")
	}
}
