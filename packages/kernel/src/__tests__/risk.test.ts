import { describe, expect, it } from 'vitest';
import { highestRiskZone, isRiskZone, isTaskRiskLevel, taskRiskLevelToZone } from '../risk.js';

describe('canonical task risk', () => {
  it('maps every task risk level to its canonical zone', () => {
    expect(taskRiskLevelToZone('low')).toBe('green');
    expect(taskRiskLevelToZone('medium')).toBe('yellow');
    expect(taskRiskLevelToZone('high')).toBe('red');
    expect(taskRiskLevelToZone('critical')).toBe('black');
  });

  it('selects the highest supplied risk without inventing one', () => {
    expect(highestRiskZone(undefined, 'green', 'red', 'yellow')).toBe('red');
    expect(highestRiskZone(undefined)).toBeUndefined();
  });

  it('keeps risk vocabularies closed at runtime', () => {
    expect(isRiskZone('red')).toBe(true);
    expect(isRiskZone('reed')).toBe(false);
    expect(isTaskRiskLevel('high')).toBe(true);
    expect(isTaskRiskLevel('hig')).toBe(false);
  });
});
