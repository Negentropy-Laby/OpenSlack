// Fixture: Uses variadic multi-stage pipeline.
// Has meta, then uses pipeline(items, stage1, stage2, stage3) form at top level.
// analyzeStaticMeta should parse the meta successfully.

export const meta = {
  name: 'ambient-pipeline-multistage',
  description: 'Multi-stage pipeline ambient claude workflow',
  phases: [
    { title: 'Collect', detail: 'Collect items' },
    { title: 'Enrich', detail: 'Enrich items' },
    { title: 'Rank', detail: 'Rank results' },
  ],
};

phase('Collect');
log('Collecting items for multi-stage pipeline');

const items = ['item-a', 'item-b', 'item-c', 'item-d'];

const enriched = await pipeline(items, (item) => {
  return agent('Enrich ' + item, {
    label: 'enrich:' + item,
    phase: 'Enrich',
  });
});

log('Enriched ' + enriched.length + ' items');

const ranked = await pipeline(enriched, (item) => {
  return agent('Rank ' + item, {
    label: 'rank:item',
    phase: 'Rank',
  });
});

log('Ranked ' + ranked.length + ' items');
