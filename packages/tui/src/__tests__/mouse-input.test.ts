import { describe, expect, it } from 'vitest';
import { handleMouseEvent } from '../ink/components/App.js';
import type App from '../ink/components/App.js';
import { INITIAL_STATE, parseMultipleKeypresses, type ParsedMouse } from '../ink/parse-keypress.js';
import { createSelectionState } from '../ink/selection.js';

function legacyX10Mouse(button: number, col: number, row: number): string {
  return `\x1b[M${String.fromCharCode(button + 32)}${String.fromCharCode(col + 32)}${String.fromCharCode(row + 32)}`;
}

function createMouseApp() {
  const hoverPositions: Array<[number, number]> = [];
  let selectionChanges = 0;
  const app = {
    lastHoverCol: -1,
    lastHoverRow: -1,
    props: {
      selection: createSelectionState(),
      onSelectionChange: () => {
        selectionChanges += 1;
      },
      onHoverAt: (col: number, row: number) => {
        hoverPositions.push([col, row]);
      },
    },
  } as unknown as App;

  return {
    app,
    hoverPositions,
    get selectionChanges() {
      return selectionChanges;
    },
  };
}

describe('mouse input', () => {
  it('parses legacy X10 no-button motion as a mouse hover event', () => {
    const [items] = parseMultipleKeypresses(INITIAL_STATE, legacyX10Mouse(35, 12, 8));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'mouse',
      button: 35,
      action: 'press',
      col: 12,
      row: 8,
    });
  });

  it('resynthesizes legacy X10 fragments after a dropped ESC byte', () => {
    const [items] = parseMultipleKeypresses(INITIAL_STATE, legacyX10Mouse(35, 12, 8).slice(1));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'mouse',
      button: 35,
      action: 'press',
      col: 12,
      row: 8,
    });
  });

  it('leaves legacy X10 wheel events on the keyboard navigation path', () => {
    const [items] = parseMultipleKeypresses(INITIAL_STATE, legacyX10Mouse(64, 12, 8));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'key',
      name: 'wheelup',
    });
  });

  it('dispatches no-button motion hover even when the terminal marks it as release-shaped', () => {
    const { app, hoverPositions, selectionChanges } = createMouseApp();
    const event: ParsedMouse = {
      kind: 'mouse',
      button: 35,
      action: 'release',
      col: 10,
      row: 5,
      sequence: '\x1b[<35;10;5m',
    };

    handleMouseEvent(app, event);

    expect(hoverPositions).toEqual([[9, 4]]);
    expect(selectionChanges).toBe(0);
  });
});
