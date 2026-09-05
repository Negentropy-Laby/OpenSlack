// Code generated from workflow-budget-authority/compatibility.json; DO NOT EDIT.
package budgetcontract

const CurrentManifestSHA256 = "83e5f88e01cbeb5e301004c34ed7cad446b98a59812771a9bf3be562a0509b3b"
const PreviousManifestSHA256 = "662fdb7237d9225593f1988fc2069e15230482da26c46fac5db73e4ee2604548"

func AcceptedManifestSHA256() []string {
	return []string{"662fdb7237d9225593f1988fc2069e15230482da26c46fac5db73e4ee2604548", "83e5f88e01cbeb5e301004c34ed7cad446b98a59812771a9bf3be562a0509b3b"}
}

func AcceptsManifestSHA256(value string) bool {
	switch value {
	case "662fdb7237d9225593f1988fc2069e15230482da26c46fac5db73e4ee2604548", "83e5f88e01cbeb5e301004c34ed7cad446b98a59812771a9bf3be562a0509b3b":
		return true
	default:
		return false
	}
}
