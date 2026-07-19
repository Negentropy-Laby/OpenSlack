import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { themes, resolveTheme } from '../design-system/theme.js';
import type { ThemeColorKey } from '../design-system/theme.js';

const COLOR_KEYS: ThemeColorKey[] = [
  'success',
  'error',
  'warning',
  'info',
  'muted',
  'accent',
  'border',
  'pass',
  'blocker',
  'foreground',
  'background',
];

describe('themes', () => {
  it('dark theme has mode "dark" and all 11 color keys', () => {
    const dark = themes.dark;
    expect(dark.mode).toBe('dark');
    for (const key of COLOR_KEYS) {
      expect(dark[key]).toBeDefined();
    }
    expect(Object.keys(COLOR_KEYS)).toHaveLength(11);
  });

  it('light theme has mode "light" and all 11 color keys', () => {
    const light = themes.light;
    expect(light.mode).toBe('light');
    for (const key of COLOR_KEYS) {
      expect(light[key]).toBeDefined();
    }
  });

  it('all dark theme color values start with "ansi:"', () => {
    const dark = themes.dark;
    for (const key of COLOR_KEYS) {
      expect((dark as unknown as Record<string, string>)[key]).toMatch(/^ansi:/);
    }
  });

  it('all light theme color values start with "ansi:"', () => {
    const light = themes.light;
    for (const key of COLOR_KEYS) {
      expect((light as unknown as Record<string, string>)[key]).toMatch(/^ansi:/);
    }
  });
});

describe('resolveTheme', () => {
  beforeEach(() => {
    delete process.env.COLORSCHEME;
    delete process.env.OPENSLACK_AUTO_THEME;
  });

  afterEach(() => {
    delete process.env.COLORSCHEME;
    delete process.env.OPENSLACK_AUTO_THEME;
  });

  it('returns dark theme when called without arguments', () => {
    const result = resolveTheme();
    expect(result.mode).toBe('dark');
    expect(result).toBe(themes.dark);
  });

  it('returns light theme when called with "light"', () => {
    const result = resolveTheme('light');
    expect(result.mode).toBe('light');
    expect(result).toBe(themes.light);
  });

  it('returns dark theme when called with "dark"', () => {
    const result = resolveTheme('dark');
    expect(result.mode).toBe('dark');
    expect(result).toBe(themes.dark);
  });

  it('respects COLORSCHEME=light env var', () => {
    process.env.COLORSCHEME = 'light';
    const result = resolveTheme();
    expect(result.mode).toBe('light');
    expect(result).toBe(themes.light);
  });

  it('returns dark when OPENSLACK_AUTO_THEME=false overrides COLORSCHEME=light', () => {
    process.env.COLORSCHEME = 'light';
    process.env.OPENSLACK_AUTO_THEME = 'false';
    const result = resolveTheme();
    expect(result.mode).toBe('dark');
    expect(result).toBe(themes.dark);
  });
});
