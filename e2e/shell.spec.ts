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

  // Board is the section you are in.
  await expect(sidebar.getByRole('link', { name: 'Board' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  /*
    There are no placeholders left.

    Calendar was the last one — a disabled control reading "Calendar M6" — and
    M6 built the page, so on an account that has channels every row in the
    sections list is a link. `SidebarDisabled` still exists for the two rows
    that can genuinely have nowhere to go (Board and Ideas before a channel is
    created), and `e2e/capture.spec.ts` covers that account; here there must be
    none of it.

    The rule this replaces is the same one it was enforcing: no dead links in
    the sidebar. It is now checked from the other side — every section row goes
    somewhere, and the hrefs are asserted below.
  */
  await expect(sidebar.getByTestId('sidebar-unbuilt')).toHaveCount(0);
  const calendarLink = sidebar.getByRole('link', {
    name: 'Calendar',
    exact: true,
  });
  await expect(calendarLink).toHaveAttribute('href', '/calendar');
  await expect(calendarLink).not.toHaveAttribute('aria-current', /.*/);
  // Still keyboard-reachable, which was the whole point of the disabled
  // control it replaces.
  await calendarLink.focus();
  await expect(calendarLink).toBeFocused();

  // `/now` was one of those three until M3 built it, and Ideas was one until M5
  // did. Both are links now, and they have to be working ones — the rule the
  // disabled controls exist to keep is "no dead links in the sidebar", not "no
  // links". Ideas is the one M3's review filed as unreachable by keyboard and
  // explained only by a tooltip; building the page it points at is the fix.
  const ideasLink = sidebar.getByRole('link', { name: 'Ideas', exact: true });
  await expect(ideasLink).toHaveAttribute('href', '/c/personal/ideas');
  await expect(ideasLink).not.toHaveAttribute('aria-current', /.*/);

  const nowLink = sidebar.getByRole('link', { name: 'Now', exact: true });
  await expect(nowLink).toHaveAttribute('href', '/now');
  await expect(nowLink).not.toHaveAttribute('aria-current', /.*/);

  // Nothing in the sidebar points at a route that does not exist. `/calendar`
  // is one since M6 and is expected exactly once; the idea bank lives under its
  // channel (`/c/[slug]/ideas`), never at a bare `/ideas`.
  const hrefs = await sidebar.getByRole('link').evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute('href') ?? ''),
  );
  expect(hrefs.filter((href) => href === '/calendar')).toHaveLength(1);
  expect(hrefs.some((href) => /^\/ideas/.test(href))).toBe(false);

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

/* -------------------------------------------------------------------------- */
/* The page does not scroll sideways                                           */
/* -------------------------------------------------------------------------- */

/**
 * The board's column strip scrolls; the document does not.
 *
 * It used to do both. `<html>` grew a horizontal scrollbar on `/c/[slug]/board`
 * at *every* viewport width, and because the sidebar is a static flex item on
 * the same page, one ordinary trackpad swipe — pointer on the page heading,
 * nowhere near the strip — scrolled the viewport 860px and took capture, the
 * channel switcher, the theme control and Sign out off the screen, revealing
 * ~900px of blank ground. The strip's own `scrollLeft` never moved: its
 * scrollable overflow was propagating to the viewport.
 *
 * Nothing in the 97-spec suite asserted this, which is how it survived. It is
 * asserted here at a desk width and at a phone width, and with a real wheel
 * event rather than only a measurement, because the measurement is what was
 * missing and the swipe is what a person does.
 */
test('the board scrolls sideways and the page does not', async ({ page }) => {
  await signIn(page);

  const documentScroll = () =>
    page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

  for (const width of [1920, 1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/c/personal/board');
    await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');

    const measured = await documentScroll();
    expect(
      measured.scrollWidth,
      `the document scrolls sideways at ${width}px`,
    ).toBe(measured.clientWidth);
  }

  // The strip itself still scrolls — the sideways scroll is supposed to live
  // there, and a fix that took it away would be the wrong fix.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/c/personal/board');
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');

  const strip = page.getByTestId('board');
  const scrollable = await strip.evaluate(
    (node) => node.scrollWidth > node.clientWidth,
  );
  expect(scrollable).toBe(true);

  // A horizontal wheel with the pointer on the heading, outside the strip.
  await page.mouse.move(700, 60);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(200, 0);

  const after = await page.evaluate(() => ({
    windowScrollX: window.scrollX,
    sidebarLeft:
      document
        .querySelector('[data-testid="app-sidebar"]')
        ?.getBoundingClientRect().left ?? null,
  }));
  expect(after.windowScrollX).toBe(0);
  expect(after.sidebarLeft).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* Focus, including where box-shadow is not allowed                            */
/* -------------------------------------------------------------------------- */

/**
 * Focus is visible in Windows High Contrast Mode.
 *
 * Every interactive element in this app pairs `outline-none` with
 * `focus-visible:ring-2 focus-visible:ring-accent`. Tailwind's ring is a
 * `box-shadow`, and the Forced Colors spec forces `box-shadow: none` — so the
 * ring vanished and `outline-none` had already thrown away the UA ring that
 * would otherwise still have been drawn. A keyboard user in High Contrast Mode
 * had no visible focus anywhere in the product.
 *
 * The measurement is negative-controlled by the same page in normal mode: the
 * ring is a box-shadow there and an outline here, and both are something.
 */
test('focus is visible under forced colors, where a ring is not', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');

  const focusStyle = async () => {
    const toggle = page.getByTestId('theme-toggle');
    await toggle.focus();
    return toggle.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
        focusVisible: node.matches(':focus-visible'),
      };
    });
  };

  // Normal: the ring is the box-shadow, as designed.
  const normal = await focusStyle();
  expect(normal.focusVisible).toBe(true);
  expect(normal.boxShadow).not.toBe('none');

  // Forced colors: the box-shadow is gone, and an outline has taken over.
  await page.emulateMedia({ forcedColors: 'active' });
  const forced = await focusStyle();
  expect(forced.focusVisible).toBe(true);
  expect(forced.boxShadow).toBe('none');
  expect(forced.outlineStyle).toBe('solid');
  expect(parseFloat(forced.outlineWidth)).toBeGreaterThanOrEqual(2);

  await page.emulateMedia({ forcedColors: null });
});

/**
 * The bypass block (WCAG 2.4.1).
 *
 * The sidebar is nine tab stops before the page begins, on every signed-in
 * route, and it grows by one per channel. The first thing Tab reaches is the
 * way past it.
 */
test('the first tab stop is a skip link to the page itself', async ({ page }) => {
  await signIn(page);
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');

  await page.keyboard.press('Tab');

  const skip = page.getByTestId('skip-to-main');
  await expect(skip).toBeFocused();
  // Parked off-screen until it is focused, and on-screen once it is.
  const onScreen = await skip.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0;
  });
  expect(onScreen).toBe(true);

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('app-main')).toBeFocused();
  expect(page.url()).toContain('#main');
});
