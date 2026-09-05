package runnerscheduler

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerprotocols"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

type ProtocolSession interface {
	Run(context.Context, runnerstore.AttemptLease) error
}

type Config struct {
	Store                runnerstore.Store
	V2Session            ProtocolSession
	AuthorityRecovery    runnerstore.V2AuthorityRecoveryStore
	WorkspaceID          string
	SupervisorInstanceID string
	MaxProcesses         int
	LeaseOfferTimeout    time.Duration
	LeaseDuration        time.Duration
	PollInterval         time.Duration
	RecoveryInterval     time.Duration
	Now                  func() time.Time
}

type Scheduler struct{ config Config }

func New(config Config) (*Scheduler, error) {
	if config.Store == nil || config.V2Session == nil {
		return nil, fmt.Errorf("runner scheduler store and v2 session are required")
	}
	if config.AuthorityRecovery == nil {
		return nil, fmt.Errorf("runner scheduler authority recovery store is required")
	}
	if config.WorkspaceID == "" || config.SupervisorInstanceID == "" {
		return nil, fmt.Errorf("runner scheduler identities are required")
	}
	if config.MaxProcesses < 1 || config.MaxProcesses > 64 {
		return nil, fmt.Errorf("runner scheduler process limit is invalid")
	}
	if config.LeaseOfferTimeout < runnerstore.MinLeaseDuration || config.LeaseDuration < config.LeaseOfferTimeout || config.LeaseDuration > runnerstore.MaxLeaseDuration {
		return nil, fmt.Errorf("runner scheduler lease durations are invalid")
	}
	if config.PollInterval <= 0 || config.PollInterval > time.Second || config.RecoveryInterval <= 0 || config.RecoveryInterval > time.Minute {
		return nil, fmt.Errorf("runner scheduler intervals are invalid")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &Scheduler{config: config}, nil
}

func (scheduler *Scheduler) Run(ctx context.Context) error {
	if _, err := scheduler.config.Store.RecoverOrphans(ctx, scheduler.config.SupervisorInstanceID, scheduler.config.Now(), 1000); err != nil {
		return fmt.Errorf("recover orphan runner attempts: %w", err)
	}
	summary, err := scheduler.config.AuthorityRecovery.RecoverAuthorityBindingsAtStartup(ctx, scheduler.config.WorkspaceID, scheduler.config.Now(), 1000)
	if err != nil {
		return fmt.Errorf("recover workflow runner authority bindings: %w", err)
	}
	if summary.Reconciled > summary.Examined {
		return fmt.Errorf("recover workflow runner authority bindings: invalid recovery summary")
	}
	groupCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	errorsChannel := make(chan error, scheduler.config.MaxProcesses+1)
	var group sync.WaitGroup
	group.Add(1)
	go func() { defer group.Done(); scheduler.recoverLoop(groupCtx, errorsChannel) }()
	for index := 0; index < scheduler.config.MaxProcesses; index++ {
		group.Add(1)
		go func() { defer group.Done(); scheduler.workerLoop(groupCtx, errorsChannel) }()
	}
	select {
	case <-ctx.Done():
		cancel()
		group.Wait()
		return nil
	case err := <-errorsChannel:
		cancel()
		group.Wait()
		return err
	}
}

func (scheduler *Scheduler) workerLoop(ctx context.Context, failures chan<- error) {
	ticker := time.NewTicker(scheduler.config.PollInterval)
	defer ticker.Stop()
	for {
		lease, err := scheduler.config.Store.ClaimNext(ctx, runnerstore.ClaimInput{WorkspaceID: scheduler.config.WorkspaceID, SupervisorInstanceID: scheduler.config.SupervisorInstanceID, LeaseOfferTimeout: scheduler.config.LeaseOfferTimeout, LeaseDuration: scheduler.config.LeaseDuration, Now: scheduler.config.Now(), ProtocolVersions: []string{runnerprotocols.V2}})
		if err == nil {
			if lease.RequiredProtocolVersion != runnerprotocols.V2 {
				select {
				case failures <- runnerstore.Failure(runnerstore.ErrorUnsupportedProtocol, "claimed lease is not bound to workflow runner protocol v2", nil):
				case <-ctx.Done():
				}
				return
			}
			runErr := scheduler.config.V2Session.Run(ctx, lease)
			if runErr == nil {
				continue
			}
			if errors.Is(runErr, context.Canceled) && ctx.Err() != nil {
				return
			}
			var sessionFailure *sessionRunError
			if !errors.As(runErr, &sessionFailure) || sessionFailure.disposition == sessionErrorFatal {
				select {
				case failures <- fmt.Errorf("run leased workflow worker: %w", runErr):
				case <-ctx.Done():
				}
				return
			}
			// Durable dispatch_not_before is the cross-restart rate limiter. This
			// local delay also prevents a fleet of workers from hammering ClaimNext
			// after a job-local rejection or settled failure.
			select {
			case <-ticker.C:
			case <-ctx.Done():
				return
			}
			continue
		}
		if !runnerstore.IsCode(err, runnerstore.ErrorNoWork) {
			select {
			case failures <- fmt.Errorf("claim runner job: %w", err):
			case <-ctx.Done():
			}
			return
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
	}
}

func (scheduler *Scheduler) recoverLoop(ctx context.Context, failures chan<- error) {
	ticker := time.NewTicker(scheduler.config.RecoveryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			_, err := scheduler.config.Store.RecoverExpired(ctx, runnerstore.RecoverExpiredInput{Now: scheduler.config.Now(), Limit: 1000})
			if err != nil && !errors.Is(err, context.Canceled) {
				select {
				case failures <- fmt.Errorf("recover expired runner leases: %w", err):
				case <-ctx.Done():
				}
				return
			}
		case <-ctx.Done():
			return
		}
	}
}
