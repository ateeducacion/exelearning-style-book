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
};
vm.createContext(context);
const source = fs.readFileSync(require.resolve('../theme/style.js'), 'utf8');
vm.runInContext(source.replace(source.slice(source.lastIndexOf('})();')), `
  globalThis.test = { turnPlan: turnPlan, foldAt: foldAt, bindCorner: bindCorner,
    setup: function (reduced) {
      spread = 1; spreads = 4; columns = 2; running = null; dragging = null;
      main = { clientWidth: 1000, clientHeight: 700 };
      show = function () {};
      reducedMotion = function () { return reduced; };
      globalThis.turns = [];
      turnTo = function (target, gesture) { globalThis.turns.push({ target: target, gesture: gesture }); };
    },
    dragging: function () { return dragging; }
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
gesture.settle = (from, to, lift, done) => { assert.equal(to, 1); settled = true; done(); };
gesture.finish();
assert(settled, 'An early release settles once snapshots become ready');
assert.equal(api.dragging(), null);
console.log('PASS: fold endpoints, finite geometry, opaque flattening, phone reversal, tap/drag/cancel and early pointer release.');
