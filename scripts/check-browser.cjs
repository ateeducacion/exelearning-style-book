// Uses Playwright already installed in the eXeLearning checkout; no test runner.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://localhost:1314/';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && response.url().startsWith(base)) errors.push(`${response.status()} ${response.url()}`); });
  const ready = () => page.waitForFunction(() => document.querySelector('.book-corner') && [...document.querySelectorAll('.idevice_node[data-idevice-component-type="json"]')].every(node => node.classList.contains('loaded')));
  const book = () => page.evaluate(() => {
    const main = document.querySelector('main.page');
    return {
      url: location.href,
      columns: getComputedStyle(main).columnCount,
      spread: Math.round(main.scrollLeft / main.clientWidth),
      bodyScroll: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
      next: !document.querySelector('.book-corner-next').hidden,
      prev: !document.querySelector('.book-corner-prev').hidden,
    };
  });
  const turn = async side => {
    const before = page.url();
    await page.locator(`.book-corner-${side}`).click();
    await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
    if (page.url() !== before) await ready();
  };
  try {
    await page.goto(base);
    await ready();
    await page.evaluate(() => document.fonts.ready);
    if (process.env.BOOK_SCREENSHOT) await page.screenshot({ path: process.env.BOOK_SCREENSHOT });
    const urls = await page.locator('#siteNav a').evaluateAll(links => links.map(link => link.href));
    let state = await book();
    assert.equal(state.columns, '2', 'Two pages side by side on a wide screen');
    assert.equal(state.bodyScroll, false, 'The book does not scroll');
    assert.equal(state.prev, false, 'Nothing before the first page');

    // Read the whole book with the right-hand corner.
    const visited = new Set([stripped(page.url())]);
    let turns = 0;
    while ((await book()).next && turns < 60) {
      await turn('next');
      visited.add(stripped(page.url()));
      turns++;
    }
    assert.equal(visited.size, urls.length, 'The corner reaches every section');
    assert.equal(stripped(page.url()), stripped(urls.at(-1)), 'Reading ends on the last section');

    // Going back to the previous section opens it at its last page.
    await page.goto(urls[1]); await ready();
    const sectionSpreads = await page.evaluate(() => {
      const main = document.querySelector('main.page');
      const mark = document.querySelector('.book-end-of-text');
      const x = mark.getBoundingClientRect().left - main.getBoundingClientRect().left + main.scrollLeft;
      return Math.floor(x / main.clientWidth) + 1;
    });
    await page.goto(urls[2]); await ready();
    await turn('prev');
    state = await book();
    assert.equal(stripped(state.url), stripped(urls[1]), 'Left corner goes to the previous section');
    assert.equal(state.spread, sectionSpreads - 1, 'and opens it at its last double page');

    // Keyboard and the ribbon index.
    await page.goto(urls[1]); await ready();
    if (sectionSpreads > 1) {
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('main.page').scrollLeft > 0);
    }
    await page.locator('.book-ribbon').click();
    assert(await page.locator('#siteNav').isVisible(), 'The ribbon opens the index');
    assert.equal(await page.locator('.book-ribbon').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.book-index').evaluate(node => node.inert), true, 'Escape closes the index');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'book-ribbon', 'Focus returns to the ribbon');
    await page.locator('.book-ribbon').click();
    await page.locator('#siteNav a').nth(2).click();
    await page.waitForURL(urls[2]); await ready();

    // Activities work inside the pages.
    await page.goto(urls.find(url => url.includes('verdadero'))); await ready();
    for (const [index, value] of ['1', '0', '1', '0'].entries()) {
      await page.locator('.TOFP-QuestionDiv').nth(index).locator(`input[value="${value}"]`).check();
    }
    await page.locator('[id^="tofPCheckTest-"]').click();
    assert.equal(await page.locator('.TOFP-SolutionMessage').filter({ hasText: /Correct/i }).count(), 4, 'True/false quiz marks all answers');

    await page.goto(urls.find(url => url.includes('ordena'))); await ready();
    const options = await page.locator('.scrambled-list').evaluate(node => JSON.parse(node.dataset.ideviceJsonData).options);
    for (let i = 0; i < options.length; i++) {
      for (let attempts = 0; attempts < options.length; attempts++) {
        const items = await page.locator('.exe-sortableList-options > li').allTextContents();
        const index = items.findIndex(text => text.includes(options[i]));
        if (index === i) break;
        await page.locator('.exe-sortableList-options > li').nth(index).locator('a.up').click();
      }
    }
    await page.locator('input[class*="exe-sortableList-check-"]').click();
    assert.match(await page.locator('[id$="-feedback"]').innerText(), /Correcto|superada/i, 'Sorting exercise can be completed');

    // Phones: one page, nothing wider than the screen.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(urls[2]); await ready();
      state = await book();
      assert.equal(state.columns, '1', `One page at ${width}px`);
      assert.equal(state.bodyScroll, false, `Fits ${width}px`);
    }
    assert.deepEqual(errors, [], errors.join('\n'));
    console.log(`PASS: ${urls.length} sections read with the corners (${turns} turns), back to the last page, keyboard, index, activities and phone widths.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

function stripped(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.search = '';
  return parsed.href;
}
