import { describe, expect, it } from 'vitest';
import {
  NON_OVERRIDABLE_FORBIDDEN_CAPABILITY_IDS,
  normalizeWorkflowPermissions,
  ScenarioCapabilityError,
  sealScenarioHostCatalog,
} from '../index.js';

function catalog() {
  return sealScenarioHostCatalog({
    adapters: [
      {
        id: 'openslack.github.v1',
        kind: 'workflow',
        capabilityIds: [
          'github.contents.read',
          'github.contents.write',
          'github.issues.read',
          'github.issues.create',
          'github.prs.create',
        ],
      },
      {
        id: 'openslack.filesystem.v1',
        kind: 'workflow',
        capabilityIds: ['filesystem.read', 'filesystem.workspace.write'],
      },
      {
        id: 'openslack.collaboration.v1',
        kind: 'workflow',
        capabilityIds: ['openslack.collaboration.recordEvent'],
      },
    ],
    capabilities: [
      {
        id: 'github.contents.read',
        adapterId: 'openslack.github.v1',
        risk: 'none',
        readOnly: true,
        approvalRequired: false,
      },
      {
        id: 'github.contents.write',
        adapterId: 'openslack.github.v1',
        risk: 'medium',
        readOnly: false,
        approvalRequired: true,
      },
      {
        id: 'github.issues.read',
        adapterId: 'openslack.github.v1',
        risk: 'none',
        readOnly: true,
        approvalRequired: false,
      },
      {
        id: 'github.issues.create',
        adapterId: 'openslack.github.v1',
        risk: 'low',
        readOnly: false,
        approvalRequired: true,
      },
      {
        id: 'github.prs.create',
        adapterId: 'openslack.github.v1',
        risk: 'medium',
        readOnly: false,
        approvalRequired: true,
      },
      {
        id: 'filesystem.read',
        adapterId: 'openslack.filesystem.v1',
        risk: 'none',
        readOnly: true,
        approvalRequired: false,
      },
      {
        id: 'filesystem.workspace.write',
        adapterId: 'openslack.filesystem.v1',
        risk: 'medium',
        readOnly: false,
        approvalRequired: true,
      },
      {
        id: 'openslack.collaboration.recordEvent',
        adapterId: 'openslack.collaboration.v1',
        risk: 'low',
        readOnly: false,
        approvalRequired: true,
      },
    ],
    workflows: [
      {
        id: 'profile-sync',
        version: '1.0.0',
        adapterId: 'openslack.collaboration.v1',
        capabilityIds: [
          'github.contents.read',
          'filesystem.read',
          'openslack.collaboration.recordEvent',
        ],
      },
    ],
    projectors: [],
    deepLinkTemplates: [],
    notificationIntents: [],
  });
}

describe('scenario capability compatibility', () => {
  it('normalizes mixed legacy and canonical declarations deterministically', () => {
    const known = catalog().capabilityIds();
    const first = normalizeWorkflowPermissions(
      {
        github: ['contents:read', 'contents:write', 'pull_requests:create', 'issues:create'],
        filesystem: ['read', 'write', 'workspace:write'],
        openslack: ['collaboration:recordEvent'],
        capabilities: ['github.issues.read', 'openslack.collaboration.recordEvent'],
      },
      known,
    );
    const second = normalizeWorkflowPermissions(
      {
        capabilities: ['openslack.collaboration.recordEvent', 'github.issues.read'],
        openslack: ['collaboration.recordEvent'],
        filesystem: ['workspace.write', 'write', 'read'],
        github: ['issues.create', 'pull_requests.create', 'contents.write', 'contents.read'],
      },
      known,
    );
    expect(first).toEqual(second);
    expect(first).toEqual([
      'filesystem.read',
      'filesystem.workspace.write',
      'github.contents.read',
      'github.contents.write',
      'github.issues.create',
      'github.issues.read',
      'github.prs.create',
      'openslack.collaboration.recordEvent',
    ]);
  });

  it.each([
    [{ capabilities: ['github.*'] }, 'SCENARIO_CAPABILITY_INVALID'],
    [{ capabilities: ['github.unknown.read'] }, 'SCENARIO_CAPABILITY_UNKNOWN'],
    [{ github: ['pr:merge'] }, 'SCENARIO_CAPABILITY_FORBIDDEN'],
    [{ shell: ['run'] }, 'SCENARIO_CAPABILITY_INVALID'],
  ])(
    'fails closed for invalid, unknown, forbidden, or unknown namespace declarations',
    (value, code) => {
      expect(() => normalizeWorkflowPermissions(value, catalog().capabilityIds())).toThrowError(
        expect.objectContaining({ code }),
      );
    },
  );

  it('keeps the non-overridable list immutable to consumers', () => {
    expect(Object.isFrozen(NON_OVERRIDABLE_FORBIDDEN_CAPABILITY_IDS)).toBe(true);
    expect(() => (NON_OVERRIDABLE_FORBIDDEN_CAPABILITY_IDS as unknown as string[]).pop()).toThrow(
      TypeError,
    );
    expect(() =>
      normalizeWorkflowPermissions(
        { capabilities: ['github.pr.merge'] },
        new Set(['github.pr.merge']),
      ),
    ).toThrowError(ScenarioCapabilityError);
  });

  it('supports cross-adapter workflows but rejects dangling reverse adapter claims', () => {
    expect(catalog().workflow('profile-sync')?.capabilityIds).toContain('github.contents.read');
    expect(() =>
      sealScenarioHostCatalog({
        adapters: [
          {
            id: 'openslack.github.v1',
            kind: 'workflow',
            capabilityIds: ['github.issues.read'],
          },
        ],
        capabilities: [],
        workflows: [],
        projectors: [],
        deepLinkTemplates: [],
        notificationIntents: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCENARIO_CATALOG_REFERENCE_MISSING' }));
  });

  it('rejects accessor-bearing host catalog input without invoking the getter', () => {
    let invoked = false;
    const entry = {
      id: 'openslack.adapter.v1',
      kind: 'workflow',
      capabilityIds: [],
    };
    Object.defineProperty(entry, 'kind', {
      enumerable: true,
      get() {
        invoked = true;
        return 'workflow';
      },
    });
    expect(() =>
      sealScenarioHostCatalog({
        adapters: [entry as never],
        capabilities: [],
        workflows: [],
        projectors: [],
        deepLinkTemplates: [],
        notificationIntents: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCENARIO_CATALOG_INVALID' }));
    expect(invoked).toBe(false);
  });

  it('rejects a top-level catalog getter before invoking it', () => {
    let invoked = false;
    const input = {
      adapters: [],
      capabilities: [],
      workflows: [],
      projectors: [],
      deepLinkTemplates: [],
      notificationIntents: [],
    };
    Object.defineProperty(input, 'adapters', {
      enumerable: true,
      get() {
        invoked = true;
        return [];
      },
    });
    expect(() => sealScenarioHostCatalog(input as never)).toThrowError(
      expect.objectContaining({ code: 'SCENARIO_CATALOG_INVALID' }),
    );
    expect(invoked).toBe(false);
  });

  it.each(['sparse', 'named', 'iterator'] as const)(
    'rejects %s outer catalog arrays without iterating them',
    (shape) => {
      let invoked = false;
      const adapters: unknown[] = [];
      if (shape === 'sparse') adapters.length = 1;
      if (shape === 'named') {
        Object.defineProperty(adapters, 'extra', {
          enumerable: true,
          get() {
            invoked = true;
            return [];
          },
        });
      }
      if (shape === 'iterator') {
        Object.defineProperty(adapters, Symbol.iterator, {
          enumerable: false,
          get() {
            invoked = true;
            return Array.prototype[Symbol.iterator];
          },
        });
      }
      expect(() =>
        sealScenarioHostCatalog({
          adapters: adapters as never,
          capabilities: [],
          workflows: [],
          projectors: [],
          deepLinkTemplates: [],
          notificationIntents: [],
        }),
      ).toThrowError(expect.objectContaining({ code: 'SCENARIO_CATALOG_INVALID' }));
      expect(invoked).toBe(false);
    },
  );

  it.each(['sparse', 'named', 'iterator'] as const)(
    'rejects %s permission arrays without iterating them',
    (shape) => {
      let invoked = false;
      const values: unknown[] = [];
      if (shape === 'sparse') values.length = 1;
      if (shape === 'named') {
        Object.defineProperty(values, 'extra', {
          enumerable: true,
          get() {
            invoked = true;
            return 'github.contents.read';
          },
        });
      }
      if (shape === 'iterator') {
        Object.defineProperty(values, Symbol.iterator, {
          enumerable: false,
          get() {
            invoked = true;
            return Array.prototype[Symbol.iterator];
          },
        });
      }
      expect(() =>
        normalizeWorkflowPermissions({ capabilities: values as never }, catalog().capabilityIds()),
      ).toThrowError(expect.objectContaining({ code: 'SCENARIO_CAPABILITY_INVALID' }));
      expect(invoked).toBe(false);
    },
  );
});
