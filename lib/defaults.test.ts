import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_DEFAULTS,
  CORE_KIND_ORDER,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
  WIP_KINDS,
  compareKinds,
  isStageKind,
  isWipKind,
  kindOrder,
  type StageKind,
} from './defaults';

/**
 * The checklist text is the product, so this test re-reads BRIEF.md and
 * compares it bullet by bullet. If someone edits the brief, this test tells
 * them the defaults drifted.
 */
function checklistsFromBrief(): Record<string, string[]> {
  const lines = readFileSync('docs/BRIEF.md', 'utf8').split('\n');
  const start = lines.findIndex((l) =>
    l.startsWith('### Seed checklist templates'),
  );
  const end = lines.findIndex((l, i) => i > start && l.startsWith('### '));
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const headingToKind: Record<string, StageKind> = {
    '**Packaging (TTH)**': 'packaging',
    '**Scripting**': 'scripting',
    '**Filming**': 'filming',
    '**Editing**': 'editing',
    '**Publish Prep**': 'publish_prep',
    '**Published**': 'published',
    '**Repurposed**': 'repurposed',
  };

  const out: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of lines.slice(start + 1, end)) {
    if (line.startsWith('**')) {
      current = headingToKind[line.trim()];
      expect(current, `unknown heading ${line}`).toBeDefined();
      out[current] = [];
    } else if (line.startsWith('- [ ] ')) {
      out[current as string].push(line.slice('- [ ] '.length));
    }
  }
  return out;
}

describe('stage kinds', () => {
  it('has the nine core kinds in behavioural order', () => {
    expect(CORE_KIND_ORDER).toEqual([
      'idea',
      'packaging',
      'scripting',
      'filming',
      'editing',
      'publish_prep',
      'scheduled',
      'published',
      'repurposed',
    ]);
  });

  it('compares kinds by core order', () => {
    expect(compareKinds('idea', 'packaging')).toBeLessThan(0);
    expect(compareKinds('published', 'filming')).toBeGreaterThan(0);
    expect(compareKinds('editing', 'editing')).toBe(0);
    expect(kindOrder('idea')).toBe(0);
    expect(kindOrder('repurposed')).toBe(CORE_KIND_ORDER.length - 1);
  });

  it('narrows unknown values', () => {
    expect(isStageKind('packaging')).toBe(true);
    expect(isStageKind('custom stage')).toBe(false);
    expect(isStageKind(null)).toBe(false);
  });

  it('warns about WIP only for in-flight kinds', () => {
    expect(WIP_KINDS).toEqual([
      'packaging',
      'scripting',
      'filming',
      'editing',
      'publish_prep',
      'scheduled',
    ]);
    for (const kind of ['idea', 'published', 'repurposed'] as const) {
      expect(isWipKind(kind)).toBe(false);
    }
  });
});

describe('seed stages', () => {
  it('covers every kind once, positioned 1..9 in core order', () => {
    expect(SEED_STAGES.map((s) => s.kind)).toEqual([...CORE_KIND_ORDER]);
    expect(SEED_STAGES.map((s) => s.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(new Set(SEED_STAGES.map((s) => s.name)).size).toBe(
      SEED_STAGES.length,
    );
  });
});

describe('seed checklists', () => {
  const brief = checklistsFromBrief();

  it('has an entry for every kind', () => {
    expect(Object.keys(SEED_CHECKLISTS).sort()).toEqual(
      [...CORE_KIND_ORDER].sort(),
    );
    expect(SEED_CHECKLISTS.idea).toEqual([]);
    expect(SEED_CHECKLISTS.scheduled).toEqual([]);
  });

  it('matches BRIEF.md verbatim, in order', () => {
    for (const [kind, texts] of Object.entries(brief)) {
      expect(
        SEED_CHECKLISTS[kind as StageKind].map((i) => i.text),
        `checklist for ${kind}`,
      ).toEqual(texts);
    }
  });

  it('has the expected per-stage counts', () => {
    const counts = Object.fromEntries(
      Object.entries(SEED_CHECKLISTS).map(([kind, items]) => [
        kind,
        items.length,
      ]),
    );
    expect(counts).toEqual({
      idea: 0,
      packaging: 8,
      scripting: 9,
      filming: 4,
      editing: 4,
      publish_prep: 5,
      scheduled: 0,
      published: 2,
      repurposed: 3,
    });
  });

  it('gives every row a positive est_minutes', () => {
    for (const items of Object.values(SEED_CHECKLISTS)) {
      for (const item of items) {
        expect(Number.isInteger(item.est_minutes)).toBe(true);
        expect(item.est_minutes).toBeGreaterThan(0);
      }
    }
  });

  /**
   * PLAN.md enumerates a band per item category. `/now`'s "<= 10 min" filter
   * reads est_minutes, so a row seeded below its band quietly changes which
   * bucket it lands in — worth pinning rather than asserting "> 0".
   */
  it('seeds est_minutes inside the bands PLAN.md names', () => {
    const scripting = SEED_CHECKLISTS.scripting.map((i) => i.est_minutes);
    expect(scripting[0]).toBe(20); // hook scripting
    expect(scripting.at(-1)).toBe(15); // B-roll plan
    for (const minutes of scripting.slice(1, -1)) {
      // body items: 10-15
      expect(minutes).toBeGreaterThanOrEqual(10);
      expect(minutes).toBeLessThanOrEqual(15);
    }

    expect(SEED_CHECKLISTS.filming.map((i) => i.est_minutes)).toEqual([
      5, 15, 5, 30,
    ]);
    for (const minutes of SEED_CHECKLISTS.editing.map((i) => i.est_minutes)) {
      expect(minutes).toBeGreaterThanOrEqual(30);
      expect(minutes).toBeLessThanOrEqual(60);
    }
    expect(SEED_CHECKLISTS.published.map((i) => i.est_minutes)).toEqual([5, 10]);
    expect(SEED_CHECKLISTS.repurposed.map((i) => i.est_minutes)).toEqual([
      60, 15, 45,
    ]);
  });
});

describe('seed buckets', () => {
  it('seeds the eight horizontals and no verticals', () => {
    expect(SEED_BUCKETS.filter((b) => b.axis === 'vertical')).toEqual([]);
    const horizontals = SEED_BUCKETS.filter((b) => b.axis === 'horizontal');
    // BRIEF.md and PLAN.md both name these in lowercase; they are user-visible
    // bucket labels, so they are seeded verbatim rather than Title-Cased.
    expect(horizontals.map((b) => b.name)).toEqual([
      'tutorial',
      'listicle',
      'review',
      'self-experiment',
      'vlog',
      'reaction',
      'case study',
      'interview',
    ]);
    expect(horizontals.map((b) => b.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
});

describe('script template', () => {
  it('keeps the hook placeholder and a B-roll line per section', () => {
    expect(SCRIPT_TEMPLATE).toContain('{{hook}}');
    expect(SCRIPT_TEMPLATE).toContain('## Hook (verbatim)');
    expect(SCRIPT_TEMPLATE).toContain('## Body (bullets)');
    expect(SCRIPT_TEMPLATE).toContain('Structure:');
    expect(SCRIPT_TEMPLATE).toContain('## End screen');
    expect(SCRIPT_TEMPLATE.match(/^B-roll:/gm) ?? []).toHaveLength(3);
  });
});

describe('channel defaults', () => {
  it('matches the plan', () => {
    expect(CHANNEL_DEFAULTS).toEqual({
      wip_threshold: 5,
      stale_days: 7,
      expected_ctr: null,
      voice_guide: null,
    });
  });
});
