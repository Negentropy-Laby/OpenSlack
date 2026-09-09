// Code generated from control-sequences.json. DO NOT EDIT.
package runnerbindingcontract

func controlCompanionSequence(kind string) int64 {
	switch kind {
	case "event_receipt":
		return 3
	case "budget_authorization":
		return 4
	case "effect_authorization":
		return 4
	case "resume_offer":
		return 4
	case "cancel_request":
		return 4
	default:
		return 0
	}
}
