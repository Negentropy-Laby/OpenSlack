// Package runnerbindingcontract is the non-authoritative Go exact mirror of
// the TypeScript-owned GS9-F2a Workflow Runner authority-binding companion
// contract.
//
// It contains pure, importable validation, canonical-byte preparation, and
// exact replay helpers only. It deliberately owns no database, HTTP surface,
// migration, repository, scheduler, worker, runner port, or runtime authority.
package runnerbindingcontract

// HasDurableAuthority reports the deliberately inert F2a authority boundary.
func HasDurableAuthority() bool { return false }
