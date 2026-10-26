// Geometry and pointer lifecycle checks without a browser or copied activity DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const classes = new Set();
const root = { classList: { add: x => classes.add(x), remove: x => classes.delete(x) } };
const context = {
  document: { documentElement: root, querySelector: () => null, readyState: 'loading', addEventListener() {} },
  window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
  CSS: { supports: () => true },
  performance,
};
vm.createContext(context);
const source = fs.readFileSync(require.resolve('../theme/style.js'), 'utf8');
vm.runInContext(source.replace(source.slice(source.lastIndexOf('})();')), `
  globalThis.test = { turnPlan: turnPlan, foldAt: foldAt, pointAt: pointAt, bindCorner: bindCorner,
    setup: function (reduced) {
      spread = 1; spreads = 4; columns = 2; running = null; dragging = null;
      book = { classList: { add: function () {}, remove: function () {} } };
      neighbour = function () { return null; };
      main = { clientWidth: 1000, clientHeight: 700, getBoundingClientRect: function () { return { top: globalThis.mainTop || 0 }; } };
      show = function () {};
      reducedMotion = function () { return reduced; };
      globalThis.turns = [];
      turnTo = function (target, gesture) { globalThis.turns.push({ target: target, gesture: gesture }); };
    },
    dragging: function () { return dragging; },
    setMainTop: function (top) { globalThis.mainTop = top; }
  };
})();`), context);
const api = context.test;
for (const columns of [1, 2]) {
  for (const forward of [true, false]) {
    for (const width of [320, 390, 1136]) {
      const plan = api.turnPlan(forward, columns, width, 728);
      for (const lift of [12, plan.lift, 470]) {
        for (let step = 0; step <= 100; step++) {
          const frame = api.foldAt(plan, step / 100, lift);
          assert(!/NaN|Infinity/.test(JSON.stringify(frame)), 'All geometry stays finite');
          assert(!('opacity' in frame.flap), 'The paper must never disappear by opacity');
          if (step === 0 || step === 100) {
            assert.equal(frame.flap.clipPath, 'polygon(0px 0px, 0px 0px, 0px 0px)', 'No raised paper at rest');
            assert.match(frame.shadow.filter, /rgba\(59, 42, 26, 0\)/, 'No floating shadow at rest');
          }
        }
      }
      const end = api.foldAt(plan, 1, plan.lift);
      assert.equal(end[plan.reverse ? 'under' : 'sheet'].clipPath, 'path("M0 0 L0 0 L0 0 Z")', 'The outgoing snapshot is fully removed');
      const middle = api.foldAt(plan, 0.5, plan.lift);
      const late = api.foldAt(plan, 0.99, plan.lift);
      const scale = frame => Math.hypot(...frame.flap.transform.slice(7, -1).split(',').slice(0, 2).map(Number));
      assert(scale(late) < scale(middle) / 10, 'The curved back flattens geometrically');
    }
  }
}
// A sheet held anywhere on its outer edge folds from that height, like turn.js.
for (const forward of [true, false]) {
  for (const grab of [0, 200, 364, 700]) {
    const plan = api.turnPlan(forward, 2, 1136, 728, grab);
    for (const lift of [-300, 0, 300]) {
      for (let step = 0; step <= 100; step++) {
        const frame = api.foldAt(plan, step / 100, lift);
        assert(!/NaN|Infinity/.test(JSON.stringify(frame)), 'Edge geometry stays finite');
        if (step === 0 || step === 100) assert.equal(frame.flap.clipPath, 'polygon(0px 0px, 0px 0px, 0px 0px)', 'No raised paper at rest');
      }
    }
  }
}
const edge = api.turnPlan(true, 2, 1136, 728, 364);
const level = api.foldAt(edge, 0.3, 0);
const curl = frame => Math.hypot(...frame.flap.transform.slice(7, -1).split(',').slice(0, 2).map(Number)) * 1136;
assert(curl(level) > 20, 'A level pull from the middle of the edge still curls the back of the sheet');
const xs = level.sheet.clipPath.match(/M([^Z]+)Z/)[1].trim().split(' L').map(p => Number(p.split(' ')[0]));
assert(Math.max(...xs) - Math.min(...xs) <= 1136 / 2 + 0.2 && new Set(xs.map(x => x.toFixed(0))).size <= 3, 'A level pull folds the sheet along a vertical crease');
assert.equal(edge.lift, 0, 'An edge grab rests level');

const front = api.turnPlan(true, 1, 390, 844);
const back = api.turnPlan(false, 1, 390, 844);
assert.equal(JSON.stringify(api.foldAt(front, 0.25, 100)), JSON.stringify(api.foldAt(back, 0.75, 100)), 'Phone backward turns reverse the same geometry');

function button() {
  const handlers = {};
  let capture = false;
  return {
    style: { removeProperty() {}, setProperty() {} },
    addEventListener: (name, handler) => { handlers[name] = handler; },
    setPointerCapture() { capture = true; },
    hasPointerCapture: () => capture,
    releasePointerCapture() { capture = false; },
    fire(name, values = {}) { handlers[name]({ pointerId: 7, isPrimary: true, button: 0, clientX: 950, clientY: 650, detail: 1, ...values }); },
  };
}
for (const reduced of [false, true]) {
  api.setup(reduced);
  const corner = button();
  api.bindCorner(corner, 1);
  corner.fire('pointerdown'); corner.fire('pointerup'); corner.fire('click');
  assert.equal(context.turns.length, 1, 'A tap turns exactly once');
  corner.fire('pointerdown'); corner.fire('pointermove', { clientX: 850 }); corner.fire('pointerup'); corner.fire('click');
  assert.equal(context.turns.length, 1, 'A short drag returns without a synthetic click');
  corner.fire('pointerdown'); corner.fire('pointermove', { clientX: 500 }); corner.fire('pointerup'); corner.fire('click');
  assert.equal(context.turns.length, 2, 'A long drag completes exactly once');
  corner.fire('pointerdown'); corner.fire('pointermove', { clientX: 500 }); corner.fire('pointercancel'); corner.fire('click');
  assert.equal(context.turns.length, 2, 'Pointer cancellation cannot navigate');
  assert.equal(api.dragging(), null);
  assert.equal(classes.has('book-dragging'), false);
}

// The outer-edge strip starts the fold at the height where it is held.
api.setup(false);
context.document.startViewTransition = undefined;
const strip = button();
const stripCorner = button();
api.bindCorner(strip, 1, stripCorner);
api.setMainTop(40);
strip.fire('pointerdown', { clientX: 1000, clientY: 340 });
strip.fire('pointermove', { clientX: 700, clientY: 340 });
assert.equal(api.dragging().plan.grab, 300, 'The fold starts where the edge is held');
assert.deepEqual({ ...api.dragging().point }, { x: 700, y: 300 }, 'The held point stays under the pointer');
strip.fire('pointermove', { clientX: 700, clientY: 440 });
assert.equal(api.dragging().point.y, 400, 'Pulling down lowers the held point');
strip.fire('pointermove', { clientX: 700, clientY: 2000 });
assert(api.dragging().point.y <= 700, 'The held point never leaves the page');
strip.fire('pointermove', { clientX: 500, clientY: 340 });
strip.fire('pointerup');
assert.equal(context.turns.at(-1).target, 2, 'A long pull from the edge turns the page');
assert.equal(api.dragging(), null);
strip.fire('pointerdown', { clientX: 1000, clientY: 340 });
strip.fire('pointermove', { clientX: -2000, clientY: 340 });
const held = api.dragging().point;
assert(Math.hypot(held.x - 500, held.y) <= Math.hypot(500, 300) + 2, 'The sheet stays bound at the spine');
strip.fire('pointercancel');

// Release before the asynchronous View Transition snapshots are ready.
context.document.startViewTransition = function () {};
api.setup(false);
const corner = button();
api.bindCorner(corner, -1);
corner.fire('pointerdown', { clientX: 50 });
corner.fire('pointermove', { clientX: 550 });
const gesture = api.dragging();
corner.fire('pointerup');
assert.equal(gesture.released, true);
assert.equal(gesture.commit, true);
assert.equal(context.turns.length, 1);
let settled = false;
gesture.settle = (from, to, lift, done) => { assert.deepEqual({ ...to }, { ...api.pointAt(gesture.plan, 1, 0) }); settled = true; done(); };
gesture.finish();
assert(settled, 'An early release settles once snapshots become ready');
assert.equal(api.dragging(), null);
console.log('PASS: fold endpoints, finite geometry, opaque flattening, phone reversal, tap/drag/cancel and early pointer release.');
