package workflowcontrol_test

import (
	"testing"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
)

func TestPublicConsumerBoundary(t *testing.T) {
	if workflowcontrol.ObservationSchema != "openslack.workflow_control_observation.v1" {
		t.Fatal("observation schema drift")
	}
	if workflowcontrol.Authority != "typescript" || workflowcontrol.GoRole != "credential-free-read-model-only" {
		t.Fatal("authority boundary drift")
	}
	if err := workflowcontrol.ValidateTransition(workflowcontrol.RunRunning, workflowcontrol.RunCompleted); err != nil {
		t.Fatal(err)
	}
	if err := workflowcontrol.ValidateTransition(workflowcontrol.RunCompleted, workflowcontrol.RunRunning); err == nil {
		t.Fatal("terminal state unexpectedly accepted a transition")
	}
}
