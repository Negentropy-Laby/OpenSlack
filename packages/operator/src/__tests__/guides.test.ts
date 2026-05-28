import { describe, it, expect } from 'vitest';
import { getRoleGuide, listRoles, renderGuide } from '../guides.js';
import type { RoleGuide } from '../guides.js';

describe('guides', () => {
  const ALL_ROLES = ['operator', 'reviewer', 'agent-maintainer', 'lead'];

  describe('getRoleGuide', () => {
    it('returns the operator guide', () => {
      const guide = getRoleGuide('operator');
      expect(guide).toBeDefined();
      expect(guide!.title).toContain('Operator');
    });

    it('returns the reviewer guide', () => {
      const guide = getRoleGuide('reviewer');
      expect(guide).toBeDefined();
      expect(guide!.title).toContain('Reviewer');
    });

    it('returns the agent-maintainer guide', () => {
      const guide = getRoleGuide('agent-maintainer');
      expect(guide).toBeDefined();
      expect(guide!.title).toContain('Agent Maintainer');
    });

    it('returns the lead guide', () => {
      const guide = getRoleGuide('lead');
      expect(guide).toBeDefined();
      expect(guide!.title).toContain('Lead');
    });

    it('returns undefined for an unknown role', () => {
      const guide = getRoleGuide('nonexistent');
      expect(guide).toBeUndefined();
    });
  });

  describe('listRoles', () => {
    it('returns all four role names', () => {
      const roles = listRoles();
      expect(roles).toHaveLength(4);
      for (const role of ALL_ROLES) {
        expect(roles).toContain(role);
      }
    });
  });

  describe('renderGuide', () => {
    it('produces a non-empty string for the operator guide', () => {
      const guide = getRoleGuide('operator')!;
      const rendered = renderGuide(guide);
      expect(rendered.length).toBeGreaterThan(0);
    });

    it('includes the title in the rendered output', () => {
      const guide = getRoleGuide('lead')!;
      const rendered = renderGuide(guide);
      expect(rendered).toContain(guide.title);
    });

    it('includes section headings in the rendered output', () => {
      const guide = getRoleGuide('reviewer')!;
      const rendered = renderGuide(guide);
      for (const section of guide.sections) {
        expect(rendered).toContain(section.heading);
      }
    });

    it('includes all items with bullet markers', () => {
      const guide = getRoleGuide('agent-maintainer')!;
      const rendered = renderGuide(guide);
      for (const section of guide.sections) {
        for (const item of section.items) {
          expect(rendered).toContain(item);
        }
      }
    });
  });

  describe('guide content quality', () => {
    it.each(ALL_ROLES)('role "%s" has at least 2 sections with content', (role) => {
      const guide = getRoleGuide(role)!;
      expect(guide).toBeDefined();
      expect(guide.sections.length).toBeGreaterThanOrEqual(2);
      for (const section of guide.sections) {
        expect(section.items.length).toBeGreaterThanOrEqual(1);
      }
    });

    it.each(ALL_ROLES)('role "%s" has a non-empty description', (role) => {
      const guide = getRoleGuide(role)!;
      expect(guide.description.length).toBeGreaterThan(0);
    });
  });
});
