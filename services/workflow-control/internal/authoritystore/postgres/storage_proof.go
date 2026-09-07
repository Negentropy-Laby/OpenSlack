package postgres

import (
	"context"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/storageproof"
)

func (repository *Repository) ProveStorage(ctx context.Context, challenge storageproof.Challenge) (storageproof.Answer, error) {
	// This is deliberately the same pool used by Mutate, not a health/read pool.
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return storageproof.Answer{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	return storageproof.Inspect(ctx, tx, challenge)
}
