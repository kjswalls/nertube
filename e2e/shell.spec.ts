import { expect, test, type Page } from '@playwright/test';

import { SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * The design shell: the sidebar, and the theme that must be right on the first
 * paint.
 *
 * ## How "no flash" is actually measured
 *
 * "It did not flash" is a claim about a moment, so it needs a probe that fires
 * at that moment. The one the browser offers is `requestAnimationFrame`: the
 * first callback runs immediately **before the first paint**. So every theme
 * test installs an init script — which runs before any of the page's own
 * scripts — that schedules one frame and records what the document said in it:
 * the two attributes, and the *computed* background colour.
 *
 * If that record already holds the right palette, no paint of the wrong one
 * can have happened, because there had been no paint at all. A `useEffect`
 * implementation fails this outright; so does a script that runs early and
 * writes the wrong thing, because the colour is checked and not just the
 * attribute.
 *
 * `waitUntil: 'commit'` was tried first and is not good enough: a navigation
 * can commit before `<head>` is parsed, so it sometimes reads the document
 * before the script it is testing has had its turn.
 */

interface FirstFrame {
  theme: string | null;
  choice: string | null;
  background: string;
}

declare global {
  interface Window {
    __nertubeFirstFrame?: FirstFrame;
  }
}

/** Record the document's theme in the frame before the first paint. */
async function recordFirstFrame(page: Page): Promise<void> {
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      const root = document.documentElement;
      window.__nertubeFirstFrame = {
        theme: root.getAttribute('data-theme'),
        choice: root.getAttribute('data-theme-choice'),
        background: getComputedStyle(document.body ?? root).backgroundColor,
      };
    });
  });
}

async function firstFrame(page: Page): Promise<FirstFrame> {
  const frame = await page.evaluate(() => window.__nertubeFirstFrame);
  if (!frame) {
    throw new Error(
      'no frame was recorded — the page never painted, so this proves nothing',
    );
  }
  return frame;
}

const DARK_GROUND = 'rgb(15, 19, 17)'; // #0f1311
const LIGHT_GROUND = 'rgb(248, 249, 246)'; // #f8f9f6

const STORAGE_KEY = 'nertube-theme';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // `/` lands on `/now` as of M3. The sidebar tests below are about a board, so
  // this goes to one through the sidebar's own Board link.
  await page.waitForURL('**/now');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Board', exact: true })
    .click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
}

const bodyBackground = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/* -------------------------------------------------------------------------- */
/* The theme                                                                   */
/* -------------------------------------------------------------------------- */

test('with nothing stored the system decides, in both directions', async ({
  browser,
}) => {
  for (const [scheme, ground] of [
    ['dark', DARK_GROUND],
    ['light', LIGHT_GROUND],
  ] as const) {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await recordFirstFrame(page);

    await page.goto('/login');
    const first = await firstFrame(page);

    // "Follow the system" is the *absence* of the attribute, which is what
    // leaves the `prefers-color-scheme` media query in charge. An attribute
    // here would mean a decision nobody made.
    expect(first.theme, `system ${scheme}: data-theme`).toBeNull();
    expect(first.choice, `system ${scheme}: the stored choice`).toBe('system');
    expect(first.background, `system ${scheme}: the ground it first painted`).toBe(
      ground,
    );
    expect(await bodyBackground(page), `system ${scheme}: the ground`).toBe(ground);

    await context.close();
  }
});

test('a stored override beats the system, and is already applied at first paint', async ({
  browser,
}) => {
  // The case the whole inline script exists for: a light OS and a user who
  // asked for dark. Anything that applies the preference after hydration
  // paints this page white first.
  for (const [scheme, stored, ground] of [
    ['light', 'dark', DARK_GROUND],
    ['dark', 'light', LIGHT_GROUND],
  ] as const) {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await recordFirstFrame(page);

    await page.goto('/login');
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [STORAGE_KEY, stored],
    );
    await page.goto('/login');

    const first = await firstFrame(page);
    expect(first.theme, `${scheme} system, ${stored} asked for`).toBe(stored);
    expect(first.choice).toBe(stored);
    // The one that matters: the colour the browser was about to paint.
    expect(first.background, 'the first frame already had the chosen ground').toBe(
      ground,
    );
    expect(await bodyBackground(page)).toBe(ground);

    await context.close();
  }
});

test('the theme control is one labelled button that cycles and persists', async ({
  page,
}) => {
  await signIn(page);

  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toHaveRole('button');

  // Exactly one of the three words is rendered — the other two are
  // `display: none`, which is also what keeps them out of the accessible name.
  expect(await toggle.innerText()).toMatch(/Theme\s+System/);
  await expect(toggle).toHaveAccessibleName('Theme System');

  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAccessibleName('Theme Light');
  expect(await bodyBackground(page)).toBe(LIGHT_GROUND);

  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAccessibleName('Theme Dark');
  expect(await bodyBackground(page)).toBe(DARK_GROUND);

  // It survives a full reload, and it survives it *at first paint* — both the
  // palette and the button's own word, which is why that word is chosen in CSS
  // from an attribute the head script has already written.
  await recordFirstFrame(page);
  await page.reload();
  const first = await firstFrame(page);
  expect(first.theme).toBe('dark');
  expect(first.background).toBe(DARK_GROUND);
  await expect(toggle).toHaveAccessibleName('Theme Dark');

  // Third click is back to the system, which removes the attribute rather
  // than writing a third palette.
  await toggle.click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  await expect(toggle).toHaveAccessibleName('Theme System');
});

/* -------------------------------------------------------------------------- */
/* The sidebar                                                                 */
/* -------------------------------------------------------------------------- */

test('the sidebar is a real nav, 224px wide, and says where you are without colour', async ({
  page,
}) => {
  await signIn(page);

  const sidebar = page.getByRole('navigation', { name: 'Main' });
  await expect(sidebar).toBeVisible();
  // 224px is the strip, hairline included; the <nav> inside it is the 223px
  // that leaves.
  expect((await page.getByTestId('app-sidebar').boundingBox())?.width).toBe(224);

  // The current channel is marked for assistive technology, not only in
  // paint. `aria-current="page"` on its own board is the strong form.
  const current = sidebar.getByRole('link', { name: 'Personal', exact: true });
  await expect(current).toHaveAttribute('aria-current', 'page');
  const other = sidebar.getByRole('link', { name: 'Sunday Softworks', exact: true });
  await expect(other).not.toHaveAttribute('aria-current', /.*/);

  // Board is the section you are in; the two that do not exist yet are real
  // disabled controls naming the milestone, not links to a 404.
  await expect(sidebar.getByRole('link', { name: 'Board' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  for (const name of ['Calendar', 'Ideas']) {
    const item = sidebar.getByRole('button', { name, exact: true });
    await expect(item).toBeDisabled();
    await expect(item).toHaveAttribute('title', /arrives in M\d/);
  }

  // `/now` was one of those three until M3 built it. It is a link now, and it
  // has to be a working one — the rule the disabled controls exist to keep is
  // "no dead links in the sidebar", not "no links".
  const nowLink = sidebar.getByRole('link', { name: 'Now', exact: true });
  await expect(nowLink).toHaveAttribute('href', '/now');
  await expect(nowLink).not.toHaveAttribute('aria-current', /.*/);

  // Nothing in the sidebar points at a route that does not exist.
  const hrefs = await sidebar.getByRole('link').evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute('href') ?? ''),
  );
  expect(hrefs.some((href) => /^\/(calendar|ideas)/.test(href))).toBe(false);

  // And it really opens, with the sidebar marking it as the page you are on.
  await nowLink.click();
  await page.waitForURL('**/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');
  await expect(
    page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Now', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await page.waitForURL(/\/c\/[^/]+\/board$/);

  // On a video page the channel is still marked, but not as "page" — the
  // video is the page, and the board is not the route being looked at.
  await page.getByTestId('board-card').first().locator('h3 a').click();
  await page.waitForURL(/\/videos\//);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', {
      name: 'Personal',
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Board' }),
  ).not.toHaveAttribute('aria-current', /.*/);
});

test('the shell wraps every signed-in route, and the login page has none of it', async ({
  page,
}) => {
  await signIn(page);

  for (const url of ['/c/personal/board', '/c/new']) {
    await page.goto(url);
    await expect(
      page.getByRole('navigation', { name: 'Main' }),
      `${url} should render the shell`,
    ).toBeVisible();
  }

  await page.goto('/videos/' + (await firstVideoId(page)));
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // The gutters are the design's, and they differ by what the page is for:
  // 32px where work happens, 40px where prose is read.
  await page.goto('/c/personal/board');
  await expect(page.getByTestId('app-main')).toHaveCSS('padding-left', '32px');
  await page.goto('/c/new');
  await expect(page.getByTestId('app-main')).toHaveCSS('padding-left', '40px');

  // Signed out, there is nothing to navigate to and no sidebar to do it with.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'NerTube' })).toBeVisible();
});

async function firstVideoId(page: Page): Promise<string> {
  await page.goto('/c/personal/board');
  const id = await page.getByTestId('board-card').first().getAttribute('data-video-id');
  if (!id) throw new Error('the seeded board should have at least one card');
  return id;
}

/* -------------------------------------------------------------------------- */
/* The metrics                                                                 */
/* -------------------------------------------------------------------------- */

test('the board takes the design metrics: 216px columns, a 16px gap, 8px cards', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/c/personal/board');
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');

  const columns = page.getByTestId('board-column');
  const first = await columns.nth(0).boundingBox();
  const second = await columns.nth(1).boundingBox();
  expect(first?.width).toBe(216);
  expect(second!.x - (first!.x + first!.width)).toBe(16);

  const card = page.getByTestId('board-card').first();
  await expect(card).toHaveCSS('border-radius', '8px');
  await expect(card).toHaveCSS('padding-top', '12px');
  await expect(card).toHaveCSS('padding-left', '13px');
  // 1px, never 2 — in every state the card can be in.
  await expect(card).toHaveCSS('border-top-width', '1px');
  await card.getByTestId('days-in-stage').click();
  await expect(card).toHaveAttribute('data-selected', 'true');
  await expect(card).toHaveCSS('border-top-width', '1px');
});
