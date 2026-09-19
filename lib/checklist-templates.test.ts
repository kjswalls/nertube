import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEMPLATE_MINUTES,
  EstMinutesSchema,
  MAX_EST_MINUTES,
  TemplateTextSchema,
  fitsTenMinutes,
  formatMinutes,
  isPermutationOf,
  moveTemplate,
  nextPosition,
  quickCount,
  renumber,
  sortTemplates,
  stageMinutes,
  type TemplateItem,
} from './checklist-templates';
import { DEFAULT_EST_MINUTES } from './checklist';
import { SEED_CHECKLISTS } from './defaults';
import { QUICK_MINUTES } from './next-action';

function row(partial: Partial<TemplateItem> & { id: string }): TemplateItem {
  return {
    stageId: 'stage',
    text: `item ${partial.id}`,
    position: 1,
    estMinutes: 10,
    ...partial,
  };
}

/** The seeded Packaging list, positioned the way `create_channel` writes it. */
const PACKAGING: TemplateItem[] = SEED_CHECKLISTS.packaging.map((item, index) =>
  row({ id: `p${index + 1}`, text: item.text, position: index + 1, estMinutes: item.est_minutes }),
);

describe('the cost', () => {
  it('is the plain sum of the estimates, and zero for no template', () => {
    expect(stageMinutes(PACKAGING)).toBe(
      SEED_CHECKLISTS.packaging.reduce((sum, item) => sum + item.est_minutes, 0),
    );
    expect(stageMinutes([])).toBe(0);
  });

  it('prints minutes under an hour and hours above it', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(80)).toBe('1 h 20');
    expect(formatMinutes(120)).toBe('2 h');
  });

  it("agrees with /now's quick filter about what fits ten minutes", () => {
    expect(fitsTenMinutes(QUICK_MINUTES, 'packaging')).toBe(true);
    expect(fitsTenMinutes(QUICK_MINUTES + 1, 'packaging')).toBe(false);
    // Filming and Editing need a block whatever the item claims.
    expect(fitsTenMinutes(5, 'filming')).toBe(false);
    expect(fitsTenMinutes(5, 'editing')).toBe(false);
    // An inert stage has no kind and only the estimate to go on.
    expect(fitsTenMinutes(5, null)).toBe(true);
  });

  it('counts the quick rows of the seeded Packaging list', () => {
    const quick = SEED_CHECKLISTS.packaging.filter(
      (item) => item.est_minutes <= QUICK_MINUTES,
    ).length;
    expect(quickCount(PACKAGING, 'packaging')).toBe(quick);
    expect(quickCount(PACKAGING, 'filming')).toBe(0);
  });

  it('defaults a new row to the same ten minutes a null estimate reads as', () => {
    expect(DEFAULT_TEMPLATE_MINUTES).toBe(DEFAULT_EST_MINUTES);
  });
});

describe('the input rules', () => {
  it('trims and refuses an empty text, like a custom item on a video', () => {
    expect(TemplateTextSchema.parse('  Chapters set ')).toBe('Chapters set');
    expect(TemplateTextSchema.safeParse('   ').success).toBe(false);
  });

  it('takes whole minutes from 1 to a working day', () => {
    expect(EstMinutesSchema.safeParse(1).success).toBe(true);
    expect(EstMinutesSchema.safeParse(MAX_EST_MINUTES).success).toBe(true);
    expect(EstMinutesSchema.safeParse(0).success).toBe(false);
    expect(EstMinutesSchema.safeParse(-5).success).toBe(false);
    expect(EstMinutesSchema.safeParse(2.5).success).toBe(false);
    expect(EstMinutesSchema.safeParse(MAX_EST_MINUTES + 1).success).toBe(false);
    expect(EstMinutesSchema.safeParse(Number.NaN).success).toBe(false);
    expect(EstMinutesSchema.safeParse('10').success).toBe(false);
  });
});

describe('order', () => {
  it('sorts by position and appends after the last one', () => {
    const items = [row({ id: 'b', position: 5 }), row({ id: 'a', position: 2 })];
    expect(sortTemplates(items).map((item) => item.id)).toEqual(['a', 'b']);
    expect(nextPosition(items)).toBe(6);
    expect(nextPosition([])).toBe(1);
  });

  it('moves a row one step and renumbers the whole list 1..n', () => {
    const moved = moveTemplate(PACKAGING, 'p3', 'up');
    expect(moved?.map((item) => item.id)).toEqual([
      'p1', 'p3', 'p2', 'p4', 'p5', 'p6', 'p7', 'p8',
    ]);
    expect(moved?.map((item) => item.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const down = moveTemplate(PACKAGING, 'p3', 'down');
    expect(down?.map((item) => item.id)).toEqual([
      'p1', 'p2', 'p4', 'p3', 'p5', 'p6', 'p7', 'p8',
    ]);
  });

  it('renumbers from whatever positions the rows carried', () => {
    // Positions with gaps (a removed row) still come out dense.
    const gappy = [row({ id: 'a', position: 3 }), row({ id: 'b', position: 9 })];
    expect(renumber(sortTemplates(gappy)).map((item) => item.position)).toEqual([1, 2]);
  });

  it('refuses to move off either end, and an unknown row', () => {
    expect(moveTemplate(PACKAGING, 'p1', 'up')).toBeNull();
    expect(moveTemplate(PACKAGING, 'p8', 'down')).toBeNull();
    expect(moveTemplate(PACKAGING, 'nope', 'down')).toBeNull();
  });

  it('accepts only an exact permutation of the stage as a reorder', () => {
    const ids = PACKAGING.map((item) => item.id);
    expect(isPermutationOf(ids, PACKAGING)).toBe(true);
    expect(isPermutationOf([...ids].reverse(), PACKAGING)).toBe(true);
    // A missing row.
    expect(isPermutationOf(ids.slice(1), PACKAGING)).toBe(false);
    // A duplicate in place of one.
    expect(isPermutationOf([ids[0], ...ids.slice(0, -1)], PACKAGING)).toBe(false);
    // A row from somewhere else.
    expect(isPermutationOf([...ids.slice(0, -1), 'forged'], PACKAGING)).toBe(false);
    // Too many.
    expect(isPermutationOf([...ids, ids[0]], PACKAGING)).toBe(false);
  });
});
