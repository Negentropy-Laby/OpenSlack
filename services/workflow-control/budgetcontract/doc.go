// Package budgetcontract is the non-authoritative Go exact mirror of the
// TypeScript-owned GS9-E1 workflow budget operational contract.
//
// It contains pure validation, canonical hashing, request binding, and fold
// functions only. It deliberately has no database, HTTP, migration, config,
// runtime-routing, or production-authority integration.
package budgetcontract

// HasDurableAuthority reports the deliberately inert E1 authority boundary.
func HasDurableAuthority() bool { return false }
