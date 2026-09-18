import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_TARGET,
  DEFAULT_EST_MINUTES,
  HOOK_TARGET,
  compareItems,
  estMinutesOf,
  evidenceFor,
  nextItem,
  progressOf,
  sortItems,
  topPosition,
  type ChecklistItem,
} from './checklist';
import { SEED_CHECKLISTS } from './defaults';
import { TITLE_WARN_LENGTH } from './packaging';

/** A row, with the boring fields filled in. */
function item(partial: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return {
    text: `item ${partial.id}`,
    position: 1,
    estMinutes: null,
    checkedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('ordering', () => {
  it('is position ascending, so ticking never moves the row under the cursor', () => {
    const items = [
      item({ id: 'c', position: 3 }),
      item({ id: 'a', position: 1, checkedAt: '2026-01-02T00:00:00.000Z' }),
      item({ id: 'b', position: 2 }),
    ];
    expect(sortItems(items).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a shared position by age and then by id, so the order is total', () => {
    // Two custom items added in the same second legitimately share
    // `min(position) - 1`: there is no unique on (video, stage, position).
    const older = item({
      id: 'zzz',
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = item({
      id: 'aaa',
      position: 0,
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    expect(compareItems(older, newer)).toBeLessThan(0);

    const sameInstant = item({ id: 'bbb', position: 0 });
    const alsoSameInstant = item({ id: 'ccc', position: 0 });
    expect(compareItems(sameInstant, alsoSameInstant)).toBeLessThan(0);
    expect(compareItems(alsoSameInstant, sameInstant)).toBeGreaterThan(0);
    expect(compareItems(sameInstant, sameInstant)).toBe(0);
  });

  it('puts a custom item above everything, and starts at 1 on an empty stage', () => {
    expect(topPosition([])).toBe(1);
    expect(
      topPosition([item({ id: 'a', position: 1 }), item({ id: 'b', position: 2 })]),
    ).toBe(0);
    // Twice in a row keeps going down rather than colliding with the first.
    expect(
      topPosition([
        item({ id: 'custom', position: 0 }),
        item({ id: 'a', position: 1 }),
      ]),
    ).toBe(-1);
  });
});

describe('the ratio and the next action', () => {
  it('counts ticks, not rows', () => {
    const items = [
      item({ id: 'a', checkedAt: '2026-01-02T00:00:00.000Z' }),
      item({ id: 'b' }),
      item({ id: 'c', checkedAt: '2026-01-03T00:00:00.000Z' }),
    ];
    expect(progressOf(items)).toEqual({ done: 2, total: 3 });
  });

  it('reports 0 of 0 for a stage with no checklist — the caller decides what that means', () => {
    expect(progressOf([])).toEqual({ done: 0, total: 0 });
    expect(nextItem([])).toBeNull();
  });

  it('is the first unticked row in list order, not the first row in the array', () => {
    const items = [
      item({ id: 'third', position: 3 }),
      item({ id: 'first', position: 1, checkedAt: '2026-01-02T00:00:00.000Z' }),
      item({ id: 'second', position: 2 }),
    ];
    expect(nextItem(items)?.id).toBe('second');
  });

  it('is null when everything is ticked', () => {
    expect(
      nextItem([item({ id: 'a', checkedAt: '2026-01-02T00:00:00.000Z' })]),
    ).toBeNull();
  });
});

describe('est_minutes', () => {
  it('reads NULL as ten minutes, which is what the ≤ 10 min filter will compare', () => {
    expect(estMinutesOf(item({ id: 'a' }))).toBe(DEFAULT_EST_MINUTES);
    expect(estMinutesOf(item({ id: 'b', estMinutes: 60 }))).toBe(60);
    // A real zero is a real zero, not an absence.
    expect(estMinutesOf(item({ id: 'c', estMinutes: 0 }))).toBe(0);
  });
});

describe('evidence', () => {
  const facts = { titleLength: 20, candidateCount: 4, hookCount: 2 };

  it('counts the candidates for the row that asks for 10–20 of them', () => {
    const evidence = evidenceFor(SEED_CHECKLISTS.packaging[0].text, facts);
    expect(evidence?.label).toBe('4 written');
    expect(evidence?.overLimit).toBe(false);
    expect(evidence?.detail).toContain(`${CANDIDATE_TARGET}–20`);
  });

  it('measures the title for the row that asks for under 55 characters', () => {
    const under = evidenceFor(SEED_CHECKLISTS.packaging[3].text, facts);
    expect(under?.label).toBe(`20/${TITLE_WARN_LENGTH}`);
    expect(under?.overLimit).toBe(false);

    const over = evidenceFor(SEED_CHECKLISTS.packaging[3].text, {
      ...facts,
      titleLength: TITLE_WARN_LENGTH + 1,
    });
    expect(over?.overLimit).toBe(true);
  });

  it('counts the hooks written for the row that asks for three versions', () => {
    const evidence = evidenceFor(SEED_CHECKLISTS.packaging[7].text, facts);
    expect(evidence?.label).toBe(`2/${HOOK_TARGET} written`);
  });

  it('does not fire on the scripting rows that merely say "hook"', () => {
    for (const row of SEED_CHECKLISTS.scripting) {
      expect(evidenceFor(row.text, facts)).toBeNull();
    }
  });

  it('has nothing to say about a row the app cannot count', () => {
    expect(evidenceFor('Footage backed up to cloud', facts)).toBeNull();
    expect(evidenceFor('', facts)).toBeNull();
  });

  it('covers exactly the three seeded rows the app can measure', () => {
    const measurable = SEED_CHECKLISTS.packaging.filter(
      (row) => evidenceFor(row.text, facts) !== null,
    );
    expect(measurable.map((row) => row.text)).toEqual([
      'Generated 10–20 title candidates, not 3',
      'Title under 55 characters',
      'Hook drafted in 3 versions, strongest picked',
    ]);
  });
});
