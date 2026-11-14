// Geometry and pointer lifecycle checks without a browser or copied activity DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const classes = new Set();
const animations = [];
const frames = [];
let clock = 1000;
// Stands for the root element: records the paused animations that hold the snapshots.
const root = {
  classList: { add: (...names) => names.forEach(x => classes.add(x)), remove: (...names) => names.forEach(x => classes.delete(x)) },
  animate(keyframes, options) {
    const animation = { pseudo: options.pseudoElement, cancelled: false, frames: 0, finished: Promise.resolve(), pause() {}, cancel() { this.cancelled = true; },
      effect: { setKeyframes(list) { animation.frames++; animation.last = list[0]; } } };
    animations.push(animation);
    return animation;
  },
};
const context = {
  document: { documentElement: root, querySelector: () => null, querySelectorAll: () => [], readyState: 'loading', addEventListener() {},
    createElement: () => ({ setAttribute() {}, remove() {} }) },
  window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
  CSS: { supports: () => true },
  // A clock and a frame queue the checks advance by hand.
  performance: { now: () => clock },
  requestAnimationFrame: callback => frames.push(callback),
  getComputedStyle: () => ({ getPropertyValue: () => '0.7s' }),
};
const runFrame = time => { clock = time; frames.splice(0).forEach(callback => callback(time)); };
vm.createContext(context);
const source = fs.readFileSync(require.resolve('../theme/style.js'), 'utf8');
vm.runInContext(source.replace(source.slice(source.lastIndexOf('})();')), `
  var realTurnTo = turnTo;
  globalThis.test = { turnPlan: turnPlan, foldAt: foldAt, foldTo: foldTo, pointAt: pointAt, progressOf: progressOf, bound: bound,
    bindCorner: bindCorner, bindEdge: bindEdge, glideTo: glideTo, fly: fly, rollLayers: rollLayers,
    flying: function () { return flying; }, spread: function () { return spread; },
    realTurns: function () { turnTo = realTurnTo; },
    setColumns: function (count) { columns = count; },
    setup: function (reduced) {
      spread = 1; spreads = 4; columns = 2; running = null; dragging = null; flying = null;
      parts = { prev: { style: { removeProperty: function () {}, setProperty: function () {} } }, next: { style: { removeProperty: function () {}, setProperty: function () {} } } };
      book = { classList: { add: function () {}, remove: function () {} }, append: function () {} };
      neighbour = function () { return null; };
      main = { clientWidth: 1000, clientHeight: 700, querySelectorAll: function () { return []; }, getBoundingClientRect: function () { return { top: globalThis.mainTop || 0, left: 0 }; } };
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
    const plan = api.turnPlan(forward, 2, 1136, 728, { x: null, y: grab });
    for (const lift of [-300, 0, 300]) {
      for (let step = 0; step <= 100; step++) {
        const frame = api.foldAt(plan, step / 100, lift);
        assert(!/NaN|Infinity/.test(JSON.stringify(frame)), 'Edge geometry stays finite');
        if (step === 0 || step === 100) assert.equal(frame.flap.clipPath, 'polygon(0px 0px, 0px 0px, 0px 0px)', 'No raised paper at rest');
      }
    }
  }
}
const edge = api.turnPlan(true, 2, 1136, 728, { x: null, y: 364 });
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
assert.deepEqual({ ...api.dragging().plan.grab }, { x: 1000, y: 300 }, 'The fold starts where the edge is held');
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

/* ---------- Any point of the three free edges, both models ---------- */

const numbers = text => (text.match(/-?\d+(\.\d+)?/g) || []).map(Number);
const polygons = clipPath => [...clipPath.matchAll(/M([^Z]+)Z/g)].map(match => match[1].trim().split(' L').map(p => p.split(' ').map(Number)));
const area = clipPath => polygons(clipPath).reduce((sum, polygon) => sum + Math.abs(polygon.reduce((a, p, i) => {
  const q = polygon[(i + 1) % polygon.length];
  return a + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2, 0);
const W = 1136;
const H = 728;
// Where a sheet can be held: its outer edge, and its top and bottom edges away from the spine.
const grabs = (columns, forward) => {
  const page = W / columns;
  const spine = columns > 1 ? W / 2 : 0;
  const dir = columns > 1 && !forward ? -1 : 1;
  const list = [0.1, 0.25, 0.5, 0.75, 0.9].map(k => ({ x: null, y: H * k, edge: 'outer' }));
  for (const k of [0.1, 0.35, 0.6, 0.85, 1]) for (const y of [0, H]) list.push({ x: spine + dir * page * k, y, edge: y ? 'bottom' : 'top' });
  return list;
};
for (const columns of [1, 2]) {
  for (const forward of [true, false]) {
    for (const faces of columns > 1 ? [2, 3] : [2]) {
      for (const grab of grabs(columns, forward)) {
        const plan = api.turnPlan(forward, columns, W, H, grab, faces);
        const name = `${columns} col ${forward ? 'forward' : 'back'} faces ${faces} ${grab.edge}`;
        assert(Math.abs(plan.grab.x - plan.spine) > 20, 'The sheet is never held by the spine');
        const rest = api.foldAt(plan, plan.reverse ? 1 : 0, 0);
        const landed = api.foldAt(plan, plan.reverse ? 0 : 1, 0);
        assert.equal(rest.flap.clipPath, 'polygon(0px 0px, 0px 0px, 0px 0px)', name + ': flat at rest');
        assert.equal(landed.flap.clipPath, 'polygon(0px 0px, 0px 0px, 0px 0px)', name + ': flat once landed');
        assert.match(rest.shadow.filter + landed.shadow.filter, /rgba\(59, 42, 26, 0\).*rgba\(59, 42, 26, 0\)/, name + ': no shadow left behind');
        assert.equal(landed.sheet.clipPath, 'path("M0 0 L0 0 L0 0 Z")', name + ': the turned sheet is gone');
        // Pull the held point everywhere, far outside the book included: the paper stays bound.
        let before = null;
        for (let step = 0; step <= 400; step++) {
          const angle = step / 400 * Math.PI * 6;
          const pull = step * 4;
          const hand = api.bound(plan, { x: plan.grab.x + Math.cos(angle) * pull, y: plan.grab.y + Math.sin(angle) * pull });
          for (const y of [0, H]) {
            assert(Math.hypot(hand.x - plan.spine, hand.y - y) <= Math.hypot(plan.grab.x - plan.spine, plan.grab.y - y) + 0.01, name + ': held point within reach of the spine');
          }
          const frame = api.foldTo(plan, hand);
          assert(!/NaN|Infinity/.test(JSON.stringify(frame)), name + ': finite geometry');
          assert(!('opacity' in frame.flap) && !('opacity' in frame.sheet), name + ': paper stays opaque');
          if (faces === 3) {
            // A real fold never cuts the binding: the whole spine stays on the flat part of the sheet.
            const flat = polygons(frame.sheet.clipPath)[0] || [];
            if (api.progressOf(plan, hand) < 1 - 1e-6 && flat.length) {
              const ys = flat.filter(p => Math.abs(p[0] - plan.spine) < 0.06).map(p => p[1]);
              assert(Math.min(...ys) < 0.06 && Math.max(...ys) > H - 0.06, name + ': the sheet stays bound along the whole spine');
            }
            // Two mirrors make a rigid turn: the back of the sheet is never stretched or flipped.
            const m = numbers(frame.face.transform);
            assert(Math.abs(m[0] * m[3] - m[1] * m[2] - 1) < 1e-4 && Math.abs(Math.hypot(m[0], m[1]) - 1) < 1e-4, name + ': the back keeps its size and reads the right way round');
          }
          before = frame;
        }
        // The same pull in small steps: no region of the page jumps between frames.
        const end = api.pointAt(plan, plan.reverse ? 0 : 1, 0);
        const side = plan.grab.y > H / 2 ? -1 : 1;
        let last = null;
        for (let step = 0; step <= 8000; step++) {
          const k = step / 8000;
          const hand = api.bound(plan, { x: plan.grab.x + (end.x - plan.grab.x) * k, y: plan.grab.y + side * 120 * Math.sin(Math.PI * k) });
          const frame = api.foldTo(plan, hand);
          // In a real fold the opposite page stays whole under the back of the sheet until that
          // lands on it (checked below), so what must not jump is the flat part of the sheet itself.
          const whole = area(frame.sheet.clipPath);
          const now = faces === 3 && whole >= W / 2 * H ? whole - W / 2 * H : whole;
          // A step moves the hand a quarter of a pixel. A crease may turn quickly, but a jump is a jump at any step.
          if (last !== null) assert(Math.abs(now - last) < H * 4, `${name}: continuous at step ${step} (${last} -> ${now})`);
          last = now;
        }
      }
    }
  }
}

// A real fold lays the back of the sheet exactly on the opposite page: no jump into the final page.
for (const forward of [true, false]) {
  for (const grab of grabs(2, forward)) {
    const plan = api.turnPlan(forward, 2, W, H, grab, 3);
    const end = api.pointAt(plan, 1, 0);
    const almost = api.foldTo(plan, { x: end.x + (plan.grab.x - end.x) * 1e-5, y: end.y });
    const m = numbers(almost.face.transform);
    // The still picture holds two double pages; the facing one sits a double page away (see realFold).
    assert(Math.abs(m[0] - 1) < 1e-3 && Math.abs(m[1]) < 1e-3 && Math.abs(Math.abs(m[4]) - W) < 0.5 && Math.abs(m[5]) < 0.5, 'The back of the sheet lands flat on the opposite page');
    assert(Math.abs(area(almost.sheet.clipPath) - W / 2 * H) < H, 'and by then the sheet has left its own page');
  }
}

// Left and right sheets fold as mirror images.
const mirrored = (clipPath, width) => polygons(clipPath).flat().map(p => [(width - p[0]).toFixed(0), p[1].toFixed(0)].join()).sort().join(' ');
const plain = clipPath => polygons(clipPath).flat().map(p => [p[0].toFixed(0), p[1].toFixed(0)].join()).sort().join(' ');
for (const faces of [2, 3]) {
  for (const [gx, gy, hx, hy] of [[null, 364, 700, 300], [null, 728, 500, 400], [900, 0, 760, 180], [800, 728, 300, 600]]) {
    const right = api.turnPlan(true, 2, W, H, { x: gx, y: gy }, faces);
    const left = api.turnPlan(false, 2, W, H, { x: gx === null ? null : W - gx, y: gy }, faces);
    const a = api.foldTo(right, api.bound(right, { x: hx, y: hy }));
    const b = api.foldTo(left, api.bound(left, { x: W - hx, y: hy }));
    assert.equal(mirrored(b.sheet.clipPath, W), plain(a.sheet.clipPath), `Faces ${faces}: the left sheet mirrors the right one`);
  }
}

// Held near a corner the fold is a diagonal dog-ear; pulled level from mid-edge it stands upright.
{
  const corner = api.turnPlan(true, 2, W, H, { x: null, y: H }, 3);
  const ear = polygons(api.foldTo(corner, { x: 1040, y: 640 }).sheet.clipPath)[0];
  assert(ear.some(p => p[0] === W && p[1] < H) && ear.some(p => p[1] === H && p[0] < W), 'A corner folds diagonally and locally');
  const top = api.turnPlan(true, 2, W, H, { x: 850, y: 0 }, 3);
  const fromTop = polygons(api.foldTo(top, api.bound(top, { x: 780, y: 120 })).sheet.clipPath)[0];
  assert(fromTop.some(p => p[1] === 0 && p[0] > 568 && p[0] < 850), 'A top-edge grab folds from the point where it is held, not from a corner');
}

/* ---------- Gestures: direction, reversal, flick, cancellation ---------- */

// The top and bottom strips take the sheet under the pointer, on either side of the spine.
api.setup(false);
context.document.startViewTransition = undefined;
api.setMainTop(0);
for (const [top, x, direction] of [[true, 800, 1], [true, 200, -1], [false, 800, 1], [false, 200, -1]]) {
  const strip = button();
  api.bindEdge(strip, top);
  strip.fire('pointerdown', { clientX: x, clientY: top ? 5 : 695 });
  const held = api.dragging();
  assert.equal(held.direction, direction, 'The side of the spine decides which sheet is held');
  assert.deepEqual({ ...held.plan.grab }, { x, y: top ? 0 : 700 }, 'It is held at that very point of the edge');
  strip.fire('pointermove', { clientX: x - direction * 150, clientY: top ? 105 : 595 });
  const reach = Math.abs(x - 500);
  assert(Math.hypot(held.point.x - 500, held.point.y - (top ? 0 : 700)) <= reach + 0.01, 'and stays within reach of the spine');
  strip.fire('pointercancel');
  assert.equal(api.dragging(), null);
}
{
  const strip = button();
  api.bindEdge(strip, true);
  strip.fire('pointerdown', { clientX: 510, clientY: 5 });
  assert.equal(api.dragging(), null, 'Next to the spine the sheet is bound: nothing to hold');
}
// One page: the same edge goes either way, and waits for the hand to say which.
api.setup(false);
api.setColumns(1);
for (const [dx, direction] of [[-60, 1], [60, -1]]) {
  const strip = button();
  api.bindEdge(strip, false);
  strip.fire('pointerdown', { clientX: 500, clientY: 695 });
  assert.equal(api.dragging(), null, 'Mid-edge on one page no direction is chosen at the press');
  strip.fire('pointermove', { clientX: 500, clientY: 660 });
  assert.equal(api.dragging(), null, 'nor by a vertical move');
  strip.fire('pointermove', { clientX: 500 + dx, clientY: 660 });
  assert.equal(api.dragging().direction, direction, 'The horizontal pull chooses forward or back');
  assert.equal(api.dragging().plan.grab.x, 500, 'and the sheet is held where the press began');
  strip.fire('pointerup');
  assert.equal(api.dragging(), null);
}
api.setColumns(2);

// Reversal, held stops and flicks, on a clock the check controls.
const pull = moves => {
  api.setup(false);
  context.turns.length = 0;
  const strip = button();
  api.bindCorner(strip, 1, button());
  clock += 1000;
  strip.fire('pointerdown', { clientX: 1000, clientY: 350 });
  for (const [x, y, wait] of moves) { clock += wait; strip.fire('pointermove', { clientX: x, clientY: y }); }
  return { strip, gesture: api.dragging() };
};
{
  const { strip, gesture } = pull([[900, 350, 16], [600, 350, 16], [300, 300, 16]]);
  assert(gesture.progress > 0.6, 'The sheet crosses the spine with the hand');
  clock += 16; strip.fire('pointermove', { clientX: 700, clientY: 350 });
  assert(gesture.progress < 0.35 && gesture.speed < 0, 'and comes back when the hand reverses');
  clock += 16; strip.fire('pointermove', { clientX: 1000, clientY: 350 });
  assert.deepEqual({ ...gesture.point }, { x: 1000, y: 350 }, 'all the way to where it rested');
  clock += 300; strip.fire('pointerup');
  assert.equal(gesture.commit, false, 'A sheet put back does not turn');
}
{
  const { strip, gesture } = pull([[950, 350, 16], [900, 350, 16], [850, 350, 16]]);
  strip.fire('pointerup');
  assert.equal(gesture.commit, true, 'A short quick flick turns the page');
  assert(gesture.velocity.x < -0.4, 'and hands its speed to the glide');
}
{
  const { strip, gesture } = pull([[950, 350, 16], [900, 350, 16], [850, 350, 16]]);
  clock += 2000; strip.fire('pointerup');
  assert.equal(gesture.commit, false, 'The same pull held still for seconds returns');
  assert.deepEqual({ ...gesture.velocity }, { x: 0, y: 0 }, 'with no speed left');
}
{
  const { strip, gesture } = pull([[700, 350, 16], [400, 350, 16], [450, 350, 16], [520, 350, 16], [600, 350, 16]]);
  strip.fire('pointerup');
  assert.equal(gesture.commit, false, 'A flick back cancels a turn that had gone past the threshold');
}
{
  // One jittery event among slow ones (6 px in 8 ms, 0.75 px/ms by itself) must not read as a flick.
  const { strip, gesture } = pull([[990, 350, 100], [980, 350, 100], [970, 350, 100], [964, 350, 8]]);
  strip.fire('pointerup');
  assert.equal(gesture.commit, false, 'Velocity is filtered');
}

/* ---------- Letting go: one frame loop, continuous in position and speed ---------- */

const glide = (velocity, commit, from, to) => {
  api.setup(false);
  frames.length = 0;
  animations.length = 0;
  const plan = api.turnPlan(true, 2, 1000, 700, { x: null, y: 350 });
  const leaf = { plan, point: from, velocity, commit };
  api.fly(leaf, api.rollLayers(plan));
  let done = 0;
  api.glideTo(leaf, to, 0, () => done++);
  const trace = [];
  let time = 5000;
  while (frames.length && trace.length < 400) {
    runFrame(time);
    trace.push({ time, x: leaf.point.x, y: leaf.point.y });
    time += 8;
  }
  return { trace, done: () => done, leaf, plan };
};
{
  const { trace, done, leaf } = glide({ x: -1.2, y: 0 }, true, { x: 700, y: 350 }, { x: 0, y: 350 });
  assert.deepEqual([trace[0].x, trace[0].y], [700, 350], 'The glide starts exactly where the hand let go');
  const first = (trace[1].x - trace[0].x) / 8;
  assert(Math.abs(first + 1.2) < 0.15, `and at the speed of the hand (${first} px/ms)`);
  for (let i = 1; i < trace.length; i++) assert(trace[i].x <= trace[i - 1].x + 1e-9, 'A flick never comes back');
  assert(trace.every(p => p.x >= -1e-9), 'nor overshoots the opposite page');
  assert.deepEqual({ ...leaf.point }.x <= 0.01 && done(), 1, 'It lands once, exactly on the page');
  const steps = trace.slice(1).map((p, i) => Math.abs(p.x - trace[i].x));
  assert(steps.at(-2) < steps[1] / 4, 'slowing down as it lands');
  const time = trace.at(-1).time - trace[0].time;
  assert(time >= 120 && time <= 500, `in a time in proportion to what is left (${time} ms)`);
}
{
  const { trace, done } = glide({ x: 0, y: 0 }, false, { x: 800, y: 300 }, { x: 1000, y: 350 });
  const time = trace.at(-1).time - trace[0].time;
  assert(done() === 1 && time >= 180 && time <= 350, `A cancelled sheet glides back (${time} ms)`);
  assert.deepEqual([trace.at(-1).x, trace.at(-1).y].map(Math.round), [1000, 350]);
}
{
  const slow = glide({ x: 0, y: 0 }, true, { x: 400, y: 350 }, { x: 0, y: 350 });
  const near = glide({ x: 0, y: 0 }, true, { x: 40, y: 350 }, { x: 0, y: 350 });
  assert(near.trace.length < slow.trace.length, 'Less left to turn takes less time');
  assert(Math.abs(slow.trace[1].x - slow.trace[0].x) < 2, 'A sheet let go at rest starts gently');
}

/* ---------- The whole life of a turn against a stand-in for view transitions ---------- */

const transitions = [];
context.document.startViewTransition = options => {
  const transition = { skipped: false, types: { add() {} }, skipTransition() { this.skipped = true; } };
  transition.ready = new Promise((resolve, reject) => { transition.resolve = resolve; transition.reject = reject; });
  transition.finished = new Promise(resolve => { transition.finish = resolve; });
  (options.update || options)();
  transitions.push(transition);
  return transition;
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const live = () => animations.filter(animation => !animation.cancelled);
const start = () => {
  api.setup(false);
  api.realTurns();
  animations.length = frames.length = transitions.length = 0;
  const zone = button();
  api.bindCorner(zone, 1, button());
  clock += 1000;
  zone.fire('pointerdown', { clientX: 1000, clientY: 350 });
  clock += 16; zone.fire('pointermove', { clientX: 800, clientY: 350 });
  return zone;
};
(async () => {
  // Held, moved, let go and landed.
  let zone = start();
  assert.equal(transitions.length, 1, 'The first move opens one transition');
  assert.equal(live().length, 0, 'Nothing is drawn before the snapshots exist');
  clock += 16; zone.fire('pointermove', { clientX: 300, clientY: 340 });
  transitions[0].resolve();
  await tick();
  assert.equal(live().length, 4, 'One paused animation per layer');
  assert(animations.every(animation => animation.frames === 1), 'The sheet is drawn at once where the hand already is');
  for (const x of [280, 260, 240]) zone.fire('pointermove', { clientX: x, clientY: 340 });
  assert.equal(frames.length, 1, 'Several pointer moves ask for a single frame');
  runFrame(clock += 16);
  assert(animations.every(animation => animation.frames === 2), 'and are drawn once');
  runFrame(clock += 16);
  assert(animations.every(animation => animation.frames === 2) && frames.length === 0, 'A sheet held still draws nothing and keeps no loop running');
  zone.fire('pointerup');
  for (let i = 0; i < 200 && frames.length; i++) runFrame(clock += 16);
  assert.equal(api.spread(), 2, 'Let go past the threshold, the page turns');
  assert.equal(live().length, 0, 'Its animations are cancelled');
  assert(transitions[0].skipped && api.flying() === null && api.dragging() === null && !classes.has('book-dragging'), 'and nothing of the turn is left');
  transitions[0].finish();
  await tick();

  // Let go before the snapshots exist: the turn still happens, once.
  zone = start();
  clock += 16; zone.fire('pointermove', { clientX: 300, clientY: 340 });
  clock += 200; zone.fire('pointerup');
  assert.equal(api.dragging().released, true);
  transitions[0].resolve();
  await tick();
  for (let i = 0; i < 200 && frames.length; i++) runFrame(clock += 16);
  assert.equal(api.spread(), 2, 'A release before the snapshots still turns the page');
  assert.equal(live().length, 0);
  transitions[0].finish();
  await tick();

  // Cancelled while waiting for the snapshots: they arrive to nothing.
  zone = start();
  zone.fire('pointercancel');
  assert(api.dragging() === null && transitions[0].skipped && api.spread() === 1, 'Cancelling during the wait restores the page');
  transitions[0].resolve();
  await tick();
  assert(animations.length === 0 && frames.length === 0 && api.flying() === null, 'and the late snapshots start nothing');
  transitions[0].finish();
  await tick();

  // The transition itself fails (skipped by the browser, a resize...).
  zone = start();
  transitions[0].reject(new Error('skipped'));
  await tick();
  assert(api.dragging() === null && api.spread() === 1 && !classes.has('book-dragging'), 'A failed transition leaves the book as it was');
  transitions[0].finish();
  await tick();

  // Fifty turns in a row leave nothing behind.
  for (let i = 0; i < 50; i++) {
    zone = start();
    transitions[0].resolve();
    await tick();
    zone.fire(i % 3 ? 'pointerup' : 'pointercancel');
    for (let j = 0; j < 200 && frames.length; j++) runFrame(clock += 16);
    transitions[0].finish();
    await tick();
    assert(live().length === 0 && frames.length === 0 && api.flying() === null && api.dragging() === null, 'No animation, frame request or held sheet survives a turn');
  }
  console.log('PASS: fold endpoints, finite geometry, opaque flattening, phone reversal, tap/drag/cancel and early pointer release;');
  console.log('      every free edge in both models, spine binding, mirror symmetry, continuity, real back landing,');
  console.log('      direction by pull, reversal, filtered flicks, continuous glide, and the life of a turn with clean-up.');
})().catch(error => { console.error(error); process.exitCode = 1; });
