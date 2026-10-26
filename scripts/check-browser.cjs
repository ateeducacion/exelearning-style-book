// Uses Playwright already installed in the eXeLearning checkout; no test runner.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://localhost:1314/';

(async () => {
  const browser = await chromium.launch(process.env.BOOK_CHROME ? { executablePath: process.env.BOOK_CHROME } : { channel: 'chrome' });
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

    // Between sections the outgoing page keeps showing its last frame until the next
    // one is ready, so the back of the sheet must not be on it (it covers the spread).
    await page.goto(urls[1]); await ready();
    await page.evaluate(() => addEventListener('pageswap', () => {
      sessionStorage.setItem('check-sheet-back', String(document.querySelectorAll('.book-sheet-back').length));
    }));
    while (stripped(page.url()) === stripped(urls[1])) await turn('next');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('check-sheet-back')), '0', 'The outgoing page is not covered by the back of the sheet');
    assert.equal(await page.locator('.book-sheet-back').count(), 0, 'The incoming page drops the back of the sheet after the turn');

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

    // Without eXe's page counter ("Add pagination" off) the folios still carry the section.
    await page.goto(urls[2]); await ready();
    const folio = () => page.locator('.book-folio-left').innerText();
    const withCounter = await folio();
    await page.evaluate(() => document.querySelector('.page-counter').remove());
    await page.waitForFunction(() => !document.querySelector('.page-counter'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await folio(), withCounter, 'Folios keep the section number without the page counter');

    // An image with its own width keeps it, as in other styles (height follows the aspect ratio).
    const sized = await page.evaluate(() => {
      const image = document.querySelector('main.page img[src*="content/resources"]');
      const copy = image.cloneNode();
      copy.setAttribute('width', '200');
      copy.setAttribute('height', '176');
      copy.style.cssText = 'float: right; margin-left: 50px;';
      image.before(copy);
      const box = copy.getBoundingClientRect();
      const float = getComputedStyle(copy).float;
      copy.remove();
      return { width: Math.round(box.width), float };
    });
    assert.deepEqual(sized, { width: 200, float: 'right' }, 'Images keep their width attribute and float');

    // Activities work inside the pages.
    await page.goto(urls.find(url => url.includes('verdadero'))); await ready();
    assert.equal(await page.getByRole('radio', { name: 'Verdadero', exact: true }).count(), 4, 'True labels are in Spanish');
    assert.equal(await page.getByRole('radio', { name: 'Falso', exact: true }).count(), 4, 'False labels are in Spanish');
    assert.equal(await page.locator('[id^="tofPCheckTest-"]').innerText(), 'Comprobar');
    for (const [index, value] of ['1', '0', '1', '0'].entries()) {
      await page.locator('.TOFP-QuestionDiv').nth(index).locator(`input[value="${value}"]`).check();
    }
    await page.locator('[id^="tofPCheckTest-"]').click();
    assert.deepEqual(await page.locator('.TOFP-SolutionMessage').allTextContents(), Array(4).fill('Correcto'), 'Correct answers get Spanish feedback');
    assert.equal(await page.locator('.TOFP-Message').innerText(), 'Tu puntuación: 10.00');
    await page.reload(); await ready();
    await page.getByRole('radio', { name: 'Falso', exact: true }).first().check();
    await page.getByRole('button', { name: 'Comprobar', exact: true }).click();
    assert.deepEqual(await page.locator('.TOFP-SolutionMessage').allTextContents(), Array(4).fill('Incorrecto'), 'Wrong and unanswered questions get Spanish feedback');
    assert.equal(await page.locator('.TOFP-Message').innerText(), 'Tu puntuación: 0.00');

    // Keep the real activity nodes while adding enough text to exercise turns
    // independently of font/platform differences in the example's pagination.
    await page.evaluate(() => {
      window.bookActivityNodes = [...document.querySelectorAll('.idevice_node')];
      const fixture = document.createElement('section');
      for (let i = 0; i < 48; i++) {
        const paragraph = document.createElement('p');
        paragraph.textContent = 'Page-turn regression fixture. '.repeat(18);
        fixture.append(paragraph);
      }
      document.querySelector('.book-end-of-text').before(fixture);
    });
    await page.waitForFunction(() => document.querySelector('main.page').scrollWidth > 3 * document.querySelector('main.page').clientWidth);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Holding still before letting go decides by distance; letting go while moving is a flick.
    const drag = async (side, fraction, cancel, flick) => {
      const bounds = await page.locator('.book-corner-' + side).boundingBox();
      const width = await page.locator('main.page').evaluate(node => node.clientWidth);
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      const sign = side === 'next' ? -1 : 1;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + sign * width * fraction, y - 35, { steps: 6 });
      if (cancel === 'escape') await page.keyboard.press('Escape');
      if (cancel === 'pointer') await page.locator('.book-corner-' + side).dispatchEvent('pointercancel');
      if (cancel === 'mutate') {
        await page.evaluate(() => { document.querySelector('.idevice_node').style.outlineColor = 'red'; });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      if (!flick) await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition') && !document.documentElement.classList.contains('book-dragging'));
    };
    // The whole outer edge of each page can be pulled, not only the corners.
    const edges = await page.evaluate(() => {
      const main = document.querySelector('main.page').getBoundingClientRect();
      return ['prev', 'next'].map(side => {
        const strip = document.querySelector('.book-edge-' + side);
        if (!strip) return null;
        const box = strip.getBoundingClientRect();
        return { top: Math.round(box.top - main.top), bottom: Math.round(main.bottom - box.bottom), outer: Math.round(side === 'next' ? main.right - box.right : box.left - main.left) };
      });
    });
    assert.deepEqual(edges, [{ top: 0, bottom: 0, outer: 0 }, { top: 0, bottom: 0, outer: 0 }], 'Both outer edges can be pulled along their full height');
    const edgeSpread = (await book()).spread;
    const strip = await page.locator('.book-edge-next').boundingBox();
    const edgeWidth = await page.locator('main.page').evaluate(node => node.clientWidth);
    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2);
    await page.mouse.down();
    await page.mouse.move(strip.x + strip.width / 2 - edgeWidth * 0.48, strip.y + strip.height / 2, { steps: 6 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition') && !document.documentElement.classList.contains('book-dragging'));
    assert.equal((await book()).spread, edgeSpread + 1, 'Pulling the middle of the edge turns the page');
    await drag('prev', 0.48);
    const sourceSpread = (await book()).spread;
    await drag('next', 0.16);
    assert.equal((await book()).spread, sourceSpread, 'A short drag returns to the original spread');
    await drag('next', 0.16, null, true);
    assert.equal((await book()).spread, sourceSpread + 1, 'A short flick turns the page');
    await drag('prev', 0.48);
    await drag('next', 0.48);
    assert.equal((await book()).spread, sourceSpread + 1, 'A completed drag advances once');
    await drag('prev', 0.48);
    assert.equal((await book()).spread, sourceSpread, 'The left corner drags backward');
    await drag('next', 0.48, 'escape');
    assert.equal((await book()).spread, sourceSpread, 'Escape cancels a held corner');
    await drag('next', 0.48, 'pointer');
    assert.equal((await book()).spread, sourceSpread, 'Pointer cancellation restores the original spread');
    await drag('next', 0.48, 'mutate');
    assert.equal((await book()).spread, sourceSpread + 1, 'A content change during a drag does not cancel it');
    await drag('prev', 0.48);
    // A two-finger trackpad swipe, momentum included, turns exactly once.
    const swipe = async sign => {
      await page.mouse.move(640, 400);
      for (const delta of [10, 20, 30, 40, 40, 30, 25, 20, 15, 10, 8, 6, 4, 3, 2, 1]) {
        await page.mouse.wheel(sign * delta, 1);
        await page.waitForTimeout(16);
      }
      await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition') && !document.documentElement.classList.contains('book-dragging'));
    };
    await swipe(1);
    assert.equal((await book()).spread, sourceSpread + 1, 'A trackpad swipe turns the page');
    await swipe(-1);
    assert.equal((await book()).spread, sourceSpread, 'A trackpad swipe turns back');
    assert(await page.evaluate(() => window.bookActivityNodes.every((node, i) => node === document.querySelectorAll('.idevice_node')[i])), 'Activity nodes keep their identity');
    assert(await page.getByRole('radio', { name: 'Falso', exact: true }).first().isChecked(), 'Activity answers survive completed and cancelled turns');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await drag('next', 0.48);
    assert.equal((await book()).spread, sourceSpread + 1, 'Reduced motion preserves drag navigation');
    assert.equal(await page.evaluate(() => document.documentElement.matches(':active-view-transition')), false, 'Reduced motion does not create a transition');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // Towards another section the held sheet already folds, over blank paper.
    await page.goto(urls[0]); await ready();
    const cover = await page.locator('.book-corner-next').boundingBox();
    const coverWidth = await page.locator('main.page').evaluate(node => node.clientWidth);
    await page.mouse.move(cover.x + cover.width / 2, cover.y + cover.height / 2);
    await page.mouse.down();
    await page.mouse.move(cover.x + cover.width / 2 - coverWidth * 0.48, cover.y, { steps: 6 });
    assert.deepEqual(await page.evaluate(() => [document.documentElement.matches(':active-view-transition'), document.querySelector('.exe-content').classList.contains('book-blank')]), [true, true], 'A sheet held at a section boundary folds');
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForURL(urls[1]); await ready();
    await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
    assert.equal(await page.evaluate(() => document.querySelector('.book-blank, .book-sheet-back')), null, 'The next section finishes the turn and leaves no blank paper');

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

    // Phones: one page, nothing wider than the screen. A phone in desktop-site mode
    // reports a desktop width but a much taller screen, so it gets one page too.
    for (const [width, height] of [[390, 844], [320, 844], [980, 2100]]) {
      await page.setViewportSize({ width, height });
      await page.goto(urls[2]); await ready();
      state = await book();
      assert.equal(state.columns, '1', `One page at ${width}×${height}`);
      assert.equal(state.bodyScroll, false, `Fits ${width}×${height}`);
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
