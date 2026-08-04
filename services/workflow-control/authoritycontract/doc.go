// Package authoritycontract provides the pure GS9-A Workflow Control authority
// contract mirror and validator. The TypeScript bundle remains the exact-byte
// contract authority and TypeScript remains the sole workflow state writer.
//
// This package deliberately owns no database, HTTP route, scheduler, lease,
// approval decision, budget decision, effect execution, routing, or runtime
// authority. A successfully validated or prepared message is contract evidence
// only; it never transfers or implies durable Go authority.
package authoritycontract
