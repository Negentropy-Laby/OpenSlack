import { describe, expect, it } from 'vitest';
import {
  canonicalizeJcs,
  computeGitHubWatchConfigDigestV2,
  normalizeGitHubWatchConfigV2,
} from '../watch-config-digest-v2.js';
import type { GitHubWatchConfigV2 } from '../watch-config-v2.js';

describe('RFC 8785/JCS', () => {
  it('matches the RFC 8785 serialization example', () => {
    expect(
      canonicalizeJcs({
        numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
        string: '€$\u000f\nA\'B"\\\\"/',
        literals: [null, true, false],
      }),
    ).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\\\\\"/"}',
    );
  });

  it('sorts object properties by UTF-16 code units and preserves array order', () => {
    expect(canonicalizeJcs({ '\u20ac': 1, '\r': 2, '1': 3, '\ud83d\ude00': 4 })).toBe(
      '{"\\r":2,"1":3,"€":1,"😀":4}',
    );
    expect(canonicalizeJcs(['z', 'a'])).toBe('["z","a"]');
  });

  it('rejects values outside the I-JSON/JCS domain', () => {
    expect(() => canonicalizeJcs(Number.NaN)).toThrow(/non-finite/u);
    expect(() => canonicalizeJcs('\ud800')).toThrow(/lone surrogate/u);
    const sparse = new Array(2) as unknown[];
    expect(() => canonicalizeJcs(sparse)).toThrow(/sparse/u);
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'x' });
    expect(() => canonicalizeJcs(accessor)).toThrow(/accessor/u);
  });
});

describe('watch config v2 digest', () => {
  it('normalizes every frozen semantic field and matches its golden digest', () => {
    const normalized = normalizeGitHubWatchConfigV2(configFixture());
    expect(normalized).toEqual({
      schema: 'openslack.github_watch.v2',
      notification_service: {
        endpoint_origin: 'https://notification.internal',
        credential_ref: 'keychain:openslack/notification-service',
        expected_deployment_digest: `sha256:${'a'.repeat(64)}`,
        allow_insecure_loopback: false,
      },
      repositories: [
        {
          repository: 'negentropy-laby/openslack',
          events: ['issues.opened', 'push'],
          labels: { include: ['A', 'z'] },
          routes: [
            {
              id: 'slack-primary',
              sink: 'slack',
              target: { channel: 'C123', name: 'primary' },
              delivery: {
                backend: 'notification_service',
                routing_epoch: 2,
                vendor_id: 'openslack-slack',
              },
            },
            {
              id: 'webhook-direct',
              sink: 'webhook',
              target: { name: 'audit' },
              delivery: { backend: 'direct', routing_epoch: 1 },
            },
          ],
          auto_claim: { enabled: true, agent_ids: ['agent-a', 'agent-z'] },
        },
        {
          repository: 'negentropy-laby/second',
          events: ['pull_request.opened'],
        },
      ],
    });
    expect(computeGitHubWatchConfigDigestV2(configFixture())).toBe(
      'sha256:40dbfb0ec1cb7611a71dee32745ef09c3e0c60dd0fb639eed87a34a01f558adb',
    );
  });

  it('ignores YAML-derived order, comments and resolved-secret-shaped extras', () => {
    const first = configFixture() as GitHubWatchConfigV2 & Record<string, unknown>;
    first.comment = 'not semantic';
    first.resolved_secret = 'must-not-enter-digest';
    const second = configFixture();
    second.repositories.reverse();
    const openslack = second.repositories.find((repo) => repo.repo === 'OpenSlack')!;
    openslack.events.reverse();
    openslack.labels!.include!.reverse();
    openslack.routes!.reverse();
    openslack.auto_claim!.agent_ids!.reverse();
    expect(computeGitHubWatchConfigDigestV2(first)).toBe(computeGitHubWatchConfigDigestV2(second));
    expect(canonicalizeJcs(normalizeGitHubWatchConfigV2(first))).not.toContain(
      'must-not-enter-digest',
    );
  });

  it.each([
    [
      'endpoint origin',
      (config: GitHubWatchConfigV2) =>
        (config.notification_service!.endpoint = 'https://notification-2.internal'),
    ],
    [
      'credential reference',
      (config: GitHubWatchConfigV2) =>
        (config.notification_service!.credential_ref = 'env:NOTIFICATION_TOKEN'),
    ],
    [
      'deployment digest',
      (config: GitHubWatchConfigV2) =>
        (config.notification_service!.expected_deployment_digest = `sha256:${'b'.repeat(64)}`),
    ],
    ['route target', (config: GitHubWatchConfigV2) => (serviceRoute(config).channel = 'C456')],
    [
      'vendor',
      (config: GitHubWatchConfigV2) =>
        (serviceRoute(config).delivery.vendor_id = 'openslack-slack-2'),
    ],
    ['epoch', (config: GitHubWatchConfigV2) => (serviceRoute(config).delivery.routing_epoch = 3)],
  ])('changes the digest when %s changes', (_name, mutate) => {
    const baseline = configFixture();
    const changed = structuredClone(baseline);
    mutate(changed);
    expect(computeGitHubWatchConfigDigestV2(changed)).not.toBe(
      computeGitHubWatchConfigDigestV2(baseline),
    );
  });

  it('fails closed on invalid typed input rather than hashing an ambiguous config', () => {
    const duplicate = configFixture();
    duplicate.repositories[0]!.events.push('pull_request.opened');
    expect(() => computeGitHubWatchConfigDigestV2(duplicate)).toThrow(/not valid/u);
    const missingService = configFixture();
    delete missingService.notification_service;
    expect(() => computeGitHubWatchConfigDigestV2(missingService)).toThrow(/not valid/u);
  });
});

function serviceRoute(config: GitHubWatchConfigV2) {
  return config.repositories
    .find((repository) => repository.repo === 'OpenSlack')!
    .routes!.find((route) => route.id === 'slack-primary')!;
}

function configFixture(): GitHubWatchConfigV2 {
  return {
    schema: 'openslack.github_watch.v2',
    notification_service: {
      endpoint: 'https://notification.internal:443',
      credential_ref: 'keychain:openslack/notification-service',
      expected_deployment_digest: `sha256:${'a'.repeat(64)}`,
    },
    repositories: [
      {
        owner: 'Negentropy-Laby',
        repo: 'Second',
        events: ['pull_request.opened'],
      },
      {
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        events: ['push', 'issues.opened'],
        labels: { include: ['z', 'A'] },
        routes: [
          {
            id: 'webhook-direct',
            sink: 'webhook',
            name: 'audit',
            delivery: { backend: 'direct', routing_epoch: 1 },
          },
          {
            id: 'slack-primary',
            sink: 'slack',
            channel: 'C123',
            name: 'primary',
            delivery: {
              backend: 'notification_service',
              routing_epoch: 2,
              vendor_id: 'openslack-slack',
            },
          },
        ],
        auto_claim: { enabled: true, agent_ids: ['agent-z', 'agent-a'] },
      },
    ],
  };
}
