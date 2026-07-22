package calleraccess

import (
	"context"
	"fmt"
)

// ValidateLoadedPepperGenerations fails closed when a non-revoked access key
// references a pepper generation not loaded by this process.
func ValidateLoadedPepperGenerations(ctx context.Context, repo Repository, peppers PepperSet) error {
	if repo == nil || peppers == nil || peppers.Active() == nil {
		return fmt.Errorf("pepper validation: missing repository or active pepper")
	}
	ids, err := repo.ListNonRevokedPepperIDs(ctx)
	if err != nil {
		return fmt.Errorf("pepper validation: list required generations: %w", err)
	}
	for _, id := range ids {
		if !peppers.Has(id) {
			return fmt.Errorf("pepper validation: required generation %q is not loaded", id)
		}
	}
	return nil
}
