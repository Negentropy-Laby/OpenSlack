import { describe, it, expect, vi } from 'vitest';
import { runMultiStagePipeline } from '../pipeline-runner.js';

describe('claude-pipeline-multistage', () => {
  // ── Basic multi-stage pipeline ──────────────────────────────────────────────

  describe('runMultiStagePipeline', () => {
    it('runs a 2-stage pipeline', async () => {
      const items = ['a', 'b', 'c'];

      const stage1 = vi.fn(async (_prev: unknown, item: string, _idx: number) => {
        return item.toUpperCase();
      });
      const stage2 = vi.fn(async (prev: unknown, _item: string, _idx: number) => {
        return `processed-${prev as string}`;
      });

      const results = await runMultiStagePipeline(items, [stage1, stage2]);

      expect(results).toEqual(['processed-A', 'processed-B', 'processed-C']);
      expect(stage1).toHaveBeenCalledTimes(3);
      expect(stage2).toHaveBeenCalledTimes(3);
    });

    it('runs a 3-stage pipeline', async () => {
      const items = [1, 2, 3];

      const stage1 = vi.fn(async (_prev: unknown, item: number, _idx: number) => {
        return item * 2;
      });
      const stage2 = vi.fn(async (prev: unknown, _item: number, _idx: number) => {
        return (prev as number) + 10;
      });
      const stage3 = vi.fn(async (prev: unknown, _item: number, _idx: number) => {
        return `result:${prev as number}`;
      });

      const results = await runMultiStagePipeline(items, [stage1, stage2, stage3]);

      // Stage1: [2, 4, 6], Stage2: [12, 14, 16], Stage3: ["result:12", "result:14", "result:16"]
      expect(results).toEqual(['result:12', 'result:14', 'result:16']);
      expect(stage1).toHaveBeenCalledTimes(3);
      expect(stage2).toHaveBeenCalledTimes(3);
      expect(stage3).toHaveBeenCalledTimes(3);
    });

    it('runs 4+ stages', async () => {
      const items = ['x'];

      const stages = [
        vi.fn(async (_p: unknown, item: string) => item + '1'),
        vi.fn(async (p: unknown, _item: string) => (p as string) + '2'),
        vi.fn(async (p: unknown, _item: string) => (p as string) + '3'),
        vi.fn(async (p: unknown, _item: string) => (p as string) + '4'),
      ];

      const results = await runMultiStagePipeline(items, stages);

      expect(results).toEqual(['x1234']);
    });

    // ── Stage N receives correct arguments ────────────────────────────────────

    it('stage N receives (prevResult, originalItem, index)', async () => {
      const items = ['alpha', 'beta'];

      const stage1 = vi.fn(async (_prev: unknown, item: string, idx: number) => {
        return { item, idx, transformed: item.toUpperCase() };
      });
      const stage2 = vi.fn(async (prev: unknown, item: string, idx: number) => {
        return {
          prevResult: prev,
          originalItem: item,
          index: idx,
        };
      });

      const results = await runMultiStagePipeline(items, [stage1, stage2]);

      // Verify stage2 received prevResult from stage1
      expect(results).toHaveLength(2);

      // Item 0: stage1 returns { item: 'alpha', idx: 0, transformed: 'ALPHA' }
      // stage2 receives that as prevResult, 'alpha' as originalItem, 0 as index
      expect(results[0]).toEqual({
        prevResult: { item: 'alpha', idx: 0, transformed: 'ALPHA' },
        originalItem: 'alpha',
        index: 0,
      });

      expect(results[1]).toEqual({
        prevResult: { item: 'beta', idx: 1, transformed: 'BETA' },
        originalItem: 'beta',
        index: 1,
      });
    });

    it('stage 1 receives undefined as prevResult', async () => {
      const items = ['test'];

      const stage1 = vi.fn(async (prev: unknown, _item: string, _idx: number) => {
        return { prev };
      });

      await runMultiStagePipeline(items, [stage1]);

      expect(stage1).toHaveBeenCalledWith(undefined, 'test', 0);
    });

    // ── Failed items ──────────────────────────────────────────────────────────

    it('records failed items as null', async () => {
      const items = ['ok', 'fail', 'also-ok'];

      const stage = vi.fn(async (_prev: unknown, item: string) => {
        if (item === 'fail') throw new Error('Intentional failure');
        return `processed-${item}`;
      });

      const results = await runMultiStagePipeline(items, [stage]);

      expect(results).toEqual(['processed-ok', null, 'processed-also-ok']);
    });

    it('records null for item that fails in stage 2', async () => {
      const items = ['good', 'bad'];

      const stage1 = vi.fn(async (_prev: unknown, item: string) => {
        return `stage1-${item}`;
      });
      const stage2 = vi.fn(async (_prev: unknown, item: string) => {
        if (item === 'bad') throw new Error('Stage 2 failure');
        return `stage2-${item}`;
      });

      const results = await runMultiStagePipeline(items, [stage1, stage2]);

      expect(results).toEqual(['stage2-good', null]);
      // Stage 1 runs for both items
      expect(stage1).toHaveBeenCalledTimes(2);
      // Stage 2 runs for both, but 'bad' throws
      expect(stage2).toHaveBeenCalledTimes(2);
    });

    // ── Concurrency limit ─────────────────────────────────────────────────────

    it('respects concurrency limit', async () => {
      const items = [1, 2, 3, 4, 5, 6];
      const concurrency = 2;

      const inFlight: number[] = [];
      const maxInFlight = { value: 0 };
      let currentInFlight = 0;

      const stage = vi.fn(async (_prev: unknown, _item: number, _idx: number) => {
        currentInFlight++;
        if (currentInFlight > maxInFlight.value) {
          maxInFlight.value = currentInFlight;
        }
        inFlight.push(currentInFlight);
        // Small delay to allow concurrency control to be exercised
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentInFlight--;
        return 'done';
      });

      await runMultiStagePipeline(items, [stage], { concurrency });

      expect(maxInFlight.value).toBeLessThanOrEqual(concurrency);
      expect(stage).toHaveBeenCalledTimes(6);
    });

    it('defaults concurrency to 4', async () => {
      const items = Array.from({ length: 8 }, (_, i) => i);
      const maxInFlight = { value: 0 };
      let currentInFlight = 0;

      const stage = vi.fn(async () => {
        currentInFlight++;
        if (currentInFlight > maxInFlight.value) {
          maxInFlight.value = currentInFlight;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentInFlight--;
        return 'done';
      });

      await runMultiStagePipeline(items, [stage]);

      expect(maxInFlight.value).toBeLessThanOrEqual(4);
    });

    // ── Empty arrays ──────────────────────────────────────────────────────────

    it('returns empty array for empty items', async () => {
      const results = await runMultiStagePipeline([], [vi.fn(async () => 'never')]);
      expect(results).toEqual([]);
    });

    it('returns array of nulls for empty stages', async () => {
      const results = await runMultiStagePipeline([1, 2, 3], []);
      expect(results).toEqual([null, null, null]);
    });

    it('returns empty array for empty items and empty stages', async () => {
      const results = await runMultiStagePipeline([], []);
      expect(results).toEqual([]);
    });

    // ── Single item / single stage ────────────────────────────────────────────

    it('handles single item correctly', async () => {
      const stage = vi.fn(async (_prev: unknown, item: string) => item.toUpperCase());
      const results = await runMultiStagePipeline(['hello'], [stage]);
      expect(results).toEqual(['HELLO']);
    });

    it('handles single stage correctly', async () => {
      const items = [1, 2, 3];
      const stage = vi.fn(async (_prev: unknown, item: number) => item * 10);
      const results = await runMultiStagePipeline(items, [stage]);
      expect(results).toEqual([10, 20, 30]);
    });
  });
});
