package runnerstore

import (
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
)

func validV2JobSpec() V2JobSpec {
	return V2JobSpec{
		Schema: V2JobSpecSchema, WorkspaceID: "workspace.test", JobID: "job.test",
		WorkflowRunID: "run.test", CorrelationID: "correlation.test",
		ExecutionDescriptorRef: "descriptor.test", ExecutionDescriptorHash: strings.Repeat("1", 64),
		WorkflowID: "workflow.test", WorkflowVersion: "1.0.0", WorkflowSourceHash: strings.Repeat("2", 64),
		ManifestHash: strings.Repeat("3", 64), InputHash: strings.Repeat("4", 64), WholeTimeoutMS: 60_000,
		SubmittedAt: "2026-08-15T00:00:00.000Z", RequiredProtocolVersion: authoritycontract.ProtocolVersion,
		RequiredCapabilities: V2RequiredCapabilities(),
		AuthorityRoute:       authoritycontract.Route{Backend: "ts-local", Authority: "typescript", RoutingEpoch: 1, AuthorityBuildHash: strings.Repeat("5", 64)},
		RunRevision:          1, ResumeGeneration: 0,
	}
}

func TestV2QualificationAdmissionIsCanonicalAndDoesNotActivateGoAuthority(t *testing.T) {
	spec := validV2JobSpec()
	prepared, err := PrepareV2JobSpec(spec)
	if err != nil {
		t.Fatal(err)
	}
	key, fingerprint := V2SubmissionBindings(prepared)
	if err := ValidateV2SubmitInput(V2SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint}); err != nil {
		t.Fatalf("TypeScript qualification route rejected: %v", err)
	}
	parsed, err := ParseV2JobSpec(prepared.ExactBody)
	if err != nil || parsed.JobSpecHash != prepared.JobSpecHash {
		t.Fatalf("canonical v2 round trip failed: %+v %v", parsed, err)
	}

	goRoute := spec
	goRoute.AuthorityRoute.Backend = "go"
	goRoute.AuthorityRoute.Authority = "workflow-control"
	goPrepared, err := PrepareV2JobSpec(goRoute)
	if err != nil {
		t.Fatalf("frozen v2 contract must remain able to represent a future Go route: %v", err)
	}
	goKey, goFingerprint := V2SubmissionBindings(goPrepared)
	err = ValidateV2SubmitInput(V2SubmitInput{Prepared: goPrepared, IdempotencyKey: goKey, RequestFingerprint: goFingerprint})
	if !IsCode(err, ErrorAuthorityUnavailable) {
		t.Fatalf("F1 admitted a Go-authority route: %v", err)
	}
}

func TestV2QualificationRejectsCapabilityAndProtocolDowngrade(t *testing.T) {
	for name, mutate := range map[string]func(*V2JobSpec){
		"old protocol":                func(value *V2JobSpec) { value.RequiredProtocolVersion = "openslack.workflow_runner.v1" },
		"non semver workflow version": func(value *V2JobSpec) { value.WorkflowVersion = "latest" },
		"capability order": func(value *V2JobSpec) {
			value.RequiredCapabilities[0], value.RequiredCapabilities[1] = value.RequiredCapabilities[1], value.RequiredCapabilities[0]
		},
	} {
		t.Run(name, func(t *testing.T) {
			value := validV2JobSpec()
			mutate(&value)
			if _, err := PrepareV2JobSpec(value); err == nil {
				t.Fatal("invalid v2 binding was accepted")
			}
		})
	}
}
