/*!
 * Libro (Book) — eXeLearning style script
 * Cuts each page into book pages, turns them from any free edge with a paper fold,
 * and opens the table of contents from a ribbon bookmark.
 * Licensed under Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA).
 */
(function () {
    'use strict';

    var root = document.documentElement;
    var generator = document.querySelector('meta[name="generator"]');
    var paged =
        !!generator &&
        /eXeLearning/.test(generator.getAttribute('content') || '') &&
        !!window.CSS &&
        CSS.supports('column-fill', 'auto');
    // Before the first paint, so the book never flashes as a long page.
    if (paged) root.classList.add('book-paged');

    var TURN_KEY = 'exe-book-turn';
    var LAND_KEY = 'exe-book-land-end';
    // Top and bottom grabs keep this far from the spine, where the sheet is bound.
    var SPINE = 24;
    var CONTROLS = 'a[href], input, textarea, select, button, [contenteditable], [tabindex], video, audio, canvas, .idevice_node:not(.text)';

    var book = null;
    var main = null;
    var sentinel = null;
    var parts = {};
    var spread = 0;
    var spreads = 1;
    var columns = 2;
    var rightEmpty = false;
    var running = null;
    var scheduled = false;
    var dragging = null;
    var deferred = false;
    var handoff = null;
    // The sheet in the air (a held gesture or an automatic turn) and its frame request.
    var flying = null;
    var frame = 0;
    // main is showing two double pages for a snapshot.
    var wide = false;

    /* ---------- Small helpers ---------- */

    function label(key, fallback) {
        return (window.$exe_i18n && window.$exe_i18n[key]) || fallback;
    }

    function stripUrl(url) {
        var parsed = new URL(url, location.href);
        parsed.hash = '';
        parsed.search = '';
        return parsed.href;
    }

    function store(key, value) {
        try {
            if (value === null) sessionStorage.removeItem(key);
            else sessionStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            /* Storage can be blocked: the book still works, only without the turn. */
        }
    }

    function take(key) {
        try {
            var value = JSON.parse(sessionStorage.getItem(key));
            sessionStorage.removeItem(key);
            return value;
        } catch (e) {
            return null;
        }
    }

    function noop() {}

    // Skipping a transition rejects its promises; nobody else is waiting for them.
    function skip(transition) {
        if (transition.ready) transition.ready.catch(noop);
        if (transition.finished) transition.finished.catch(noop);
        transition.skipTransition();
    }

    function reducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function pageIndex(url) {
        var target = stripUrl(url);
        var links = document.querySelectorAll('#siteNav a[href]');
        for (var i = 0; i < links.length; i++) {
            if (stripUrl(links[i].href) === target) return i;
        }
        return -1;
    }

    function neighbour(side) {
        var link = document.querySelector('.nav-buttons a.nav-button-' + side);
        return link ? link.href : null;
    }

    function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    /* ---------- Paper geometry (pure: no DOM) ---------- */

    // Clip a polygon to the half-plane where (point - origin) · normal >= 0 (Sutherland–Hodgman).
    function clip(points, origin, normal) {
        var side = function (p) {
            return (p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y;
        };
        var result = [];
        for (var i = 0; i < points.length; i++) {
            var a = points[i];
            var b = points[(i + 1) % points.length];
            var sa = side(a);
            var sb = side(b);
            if (sa >= 0) result.push(a);
            if (sa >= 0 !== sb >= 0) {
                var k = sa / (sa - sb);
                result.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
            }
        }
        return result;
    }

    function rect(left, right, height) {
        return [
            { x: left, y: 0 },
            { x: right, y: 0 },
            { x: right, y: height },
            { x: left, y: height },
        ];
    }

    // Mirror a polygon in the line through origin with the given normal.
    function reflect(list, origin, normal) {
        return list.map(function (p) {
            var d = 2 * ((p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y);
            return { x: p.x - d * normal.x, y: p.y - d * normal.y };
        });
    }

    function points(list) {
        return list
            .map(function (p) {
                return p.x.toFixed(1) + 'px ' + p.y.toFixed(1) + 'px';
            })
            .join(', ');
    }

    function path(polygons) {
        var d = polygons
            .filter(function (polygon) {
                return polygon.length > 2;
            })
            .map(function (polygon) {
                return (
                    'M' +
                    polygon
                        .map(function (p) {
                            return p.x.toFixed(1) + ' ' + p.y.toFixed(1);
                        })
                        .join(' L') +
                    ' Z'
                );
            })
            .join(' ');
        return 'path("' + (d || 'M0 0 L0 0 L0 0 Z') + '")';
    }

    function matrix(values) {
        return 'matrix(' + values.map(function (v) { return v.toFixed(6); }).join(', ') + ')';
    }

    var EMPTY = 'polygon(0px 0px, 0px 0px, 0px 0px)';
    var FLAT = 'matrix(1, 0, 0, 1, 0, 0)';

    function shadowOf(x, y, blur, alpha) {
        return 'drop-shadow(' + x.toFixed(2) + 'px ' + y.toFixed(2) + 'px ' + blur.toFixed(2) + 'px rgba(59, 42, 26, ' +
            (alpha ? alpha.toFixed(3) : '0') + '))';
    }

    /*
     * The sheet is held at plan.grab, any point of its three free edges, and that
     * point follows the hand. Two models share the crease maths:
     *
     * - faces 3, a real fold: the crease is the perpendicular bisector of grab and
     *   hand, and everything behind it is mirrored over the page. The mirrored part
     *   shows the true back of the sheet (the facing page of the next double page),
     *   so it can land on the opposite page without a jump.
     * - faces 2, a roll: a view transition only has two pictures of the pages, so
     *   the back is plain paper. The crease stays one curl behind the hand and the
     *   rest of the sheet counts as rolled up; the curl narrows to nothing as the
     *   paper lands, rather than fading a blank sheet out.
     *
     * No activity DOM is copied: every face is a browser-owned snapshot.
     */
    function foldAt(plan, progress, lift) {
        return foldTo(plan, pointAt(plan, progress, lift));
    }

    // The held point at a given progress, raised along an arc of height lift.
    function pointAt(plan, progress, lift) {
        var t = plan.reverse ? 1 - progress : progress;
        return { x: plan.grab.x + 2 * (plan.spine - plan.grab.x) * t, y: plan.grab.y - lift * Math.sin(Math.PI * t) };
    }

    // How far the held point is from rest (0) to its mirror image across the spine (1).
    function travel(plan, to) {
        return Math.max(0, Math.min(1, (plan.grab.x - to.x) / (2 * (plan.grab.x - plan.spine))));
    }

    function progressOf(plan, to) {
        return plan.reverse ? 1 - travel(plan, to) : travel(plan, to);
    }

    // The sheet is bound at the spine and paper does not stretch: the held point stays
    // as far from both ends of the spine as it rests. That keeps the crease off the binding.
    function bound(plan, to) {
        for (var pass = 0; pass < 3; pass++) {
            [0, plan.height].forEach(function (y) {
                var reach = Math.hypot(plan.grab.x - plan.spine, plan.grab.y - y);
                var dx = to.x - plan.spine;
                var dy = to.y - y;
                var distance = Math.hypot(dx, dy);
                if (distance > reach) to = { x: plan.spine + dx * reach / distance, y: y + dy * reach / distance };
            });
        }
        return to;
    }

    /*
     * The normal of the crease for a pull along `pull`. Away from a corner, a crease
     * tilted against the held edge would fold a whole wedge of the sheet at the first
     * pixel; paper bends there before it creases. So the tilt is earned with distance:
     * it may only grow as fast as the pull compares with the edge left on that side,
     * or as the turn advances (a sheet held near the spine lands with an upright crease).
     */
    function creaseNormal(plan, pull, length, t) {
        var across = Math.max(0, pull.x * plan.inward.x + pull.y * plan.inward.y);
        var along = pull.x * plan.along.x + pull.y * plan.along.y;
        var limit = Math.max(3 * length / Math.max(1e-6, plan.room[along > 0 ? 0 : 1]), t * Math.PI / 2);
        var tilt = Math.max(-limit, Math.min(limit, Math.atan2(along, across)));
        return { x: plan.inward.x * Math.cos(tilt) + plan.along.x * Math.sin(tilt), y: plan.inward.y * Math.cos(tilt) + plan.along.y * Math.sin(tilt) };
    }

    // hand: where the held point of the paper is now.
    function foldTo(plan, hand) {
        var width = plan.width;
        var height = plan.height;
        var dir = plan.dir;
        var x0 = plan.spine;
        var real = plan.faces === 3;
        var sheet = dir > 0 ? rect(x0, x0 + width, height) : rect(x0 - width, x0, height);
        var other = plan.columns > 1 ? (dir > 0 ? rect(0, x0, height) : rect(x0, 2 * width, height)) : [];
        var t = travel(plan, hand);
        var dx = hand.x - plan.grab.x;
        var dy = hand.y - plan.grab.y;
        var length = Math.hypot(dx, dy);
        if (length < 0.01 || t > 1 - 1e-9) {
            var flat = {
                sheet: { clipPath: path(t < 0.5 ? [sheet, other] : []) },
                flap: { clipPath: EMPTY, transform: FLAT },
                shadow: { filter: shadowOf(0, 0, 0, 0) },
            };
            if (real) flat.face = { clipPath: EMPTY, transform: FLAT };
            else flat.under = { clipPath: path(t < 0.5 ? [] : [sheet, other]) };
            return flat;
        }
        var n = creaseNormal(plan, { x: dx / length, y: dy / length }, length, t);
        var back = { x: -n.x, y: -n.y };
        var tangent = { x: -n.y, y: n.x };
        var reach = Math.hypot(plan.totalWidth, height);
        // A corner pulled straight up has not travelled yet, but it is in the air.
        var strength = Math.sin(Math.PI * Math.max(t, Math.min(0.5, length / (2 * width))));
        if (real) return realFold(plan, hand, n, tangent, length, strength, sheet, other, reach);

        // A sheet pulled level still bends as much as a lifted corner.
        var bend = Math.max(Math.abs(plan.grab.y - hand.y), plan.bend);
        var curl = Math.max(0.01, Math.min(width * 0.24, bend * 0.65, length / 2) * strength);
        // On a double page the roll has to clear the whole opposite page by the time the
        // held point lands, so a sheet held short of its outer edge rolls ahead of the hand.
        if (plan.columns > 1) hand = { x: x0 + (hand.x - x0) * width / Math.abs(plan.grab.x - x0), y: hand.y };
        // The crease sits one curl behind the hand.
        var middle = { x: hand.x - n.x * curl, y: hand.y - n.y * curl };
        // Past the spine the roll keeps crossing the opposite page, so the band is cut
        // from the whole double page, not only from the sheet.
        var rolled = clip(rect(0, plan.totalWidth, height), middle, back);
        var band = clip(reflect(rolled, middle, n), hand, back);
        var origin = { x: middle.x - tangent.x * reach, y: middle.y - tangent.y * reach };
        // Put a fixed paper gradient in fold coordinates. Its light and dark edges
        // rotate with the crease, including left turns and single-page reverse turns.
        var local = band.map(function (p) {
            var x = p.x - origin.x;
            var y = p.y - origin.y;
            return { x: (x * n.x + y * n.y) * plan.totalWidth / curl, y: (x * tangent.x + y * tangent.y) * height / (2 * reach) };
        });
        return {
            sheet: { clipPath: path([clip(sheet, middle, n), clip(other, middle, n)]) },
            under: { clipPath: path([clip(sheet, middle, back), clip(other, middle, back)]) },
            flap: { clipPath: local.length > 2 ? 'polygon(' + points(local) + ')' : EMPTY,
                transform: matrix([n.x * curl / plan.totalWidth, n.y * curl / plan.totalWidth,
                    tangent.x * 2 * reach / height, tangent.y * 2 * reach / height, origin.x, origin.y]) },
            // Thrown behind the curl, onto the page it uncovers, and a little down: the light is above.
            shadow: { filter: shadowOf(-n.x * 8 * strength, (2 - n.y * 8) * strength, 1 + 12 * strength, 0.38 * strength) },
        };
    }

    function realFold(plan, hand, n, tangent, length, strength, sheet, other, reach) {
        var back = { x: -n.x, y: -n.y };
        // Halfway to where the held point lands; never past either end of the spine.
        var half = ((hand.x - plan.grab.x) * n.x + (hand.y - plan.grab.y) * n.y) / 2;
        [0, plan.height].forEach(function (y) {
            half = Math.min(half, (plan.spine - plan.grab.x) * n.x + (y - plan.grab.y) * n.y);
        });
        half = Math.max(0, half);
        var middle = { x: plan.grab.x + n.x * half, y: plan.grab.y + n.y * half };
        var folded = clip(sheet, middle, back);
        var flap = reflect(folded, middle, n);
        // The back of the sheet rests on the opposite page, so it is the sheet mirrored in
        // the spine and then in the crease: two mirrors make a turn, and print stays readable.
        // The snapshot holds two double pages; shift picks the facing page of the next one.
        var shift = plan.dir > 0 ? -plan.totalWidth : 0;
        var a = 2 * n.x * n.x - 1;
        var b = 2 * n.x * n.y;
        var d = 2 * ((2 * plan.spine - middle.x) * n.x - middle.y * n.y);
        var face = folded.map(function (p) {
            return { x: 2 * plan.spine - p.x - shift, y: p.y };
        });
        /*
         * Paper bends round the crease instead of creasing: a band of light in fold
         * coordinates stands for that curve. Its radius grows with the pull and is wider
         * for an upright crease (a sheet pulled from mid-edge arcs more than a dog-ear),
         * and it closes as the sheet lands. Two radii of shadow fall on the uncovered page.
         */
        var radius = Math.min(length / 4, plan.width * (0.045 + 0.075 * n.x * n.x)) * strength;
        var light = EMPTY;
        var box = FLAT;
        if (radius > 0.5) {
            var origin = { x: middle.x - n.x * 2 * radius - tangent.x * reach, y: middle.y - n.y * 2 * radius - tangent.y * reach };
            var local = function (polygon) {
                return polygon.map(function (p) {
                    var x = p.x - origin.x;
                    var y = p.y - origin.y;
                    return { x: (x * n.x + y * n.y) * plan.totalWidth / (6 * radius), y: (x * tangent.x + y * tangent.y) * plan.height / (2 * reach) };
                });
            };
            light = path([local(flap), local(folded)]);
            box = matrix([n.x * 6 * radius / plan.totalWidth, n.y * 6 * radius / plan.totalWidth,
                tangent.x * 2 * reach / plan.height, tangent.y * 2 * reach / plan.height, origin.x, origin.y]);
        }
        return {
            sheet: { clipPath: path([clip(sheet, middle, n), other]) },
            face: { clipPath: face.length > 2 ? 'polygon(' + points(face) + ')' : EMPTY,
                transform: matrix([a, b, -b, 1 - 2 * n.y * n.y,
                    a * shift + 2 * plan.spine - d * n.x + (plan.dir > 0 ? 0 : plan.totalWidth), b * shift - d * n.y]) },
            flap: { clipPath: light, transform: box },
            // The loose edge floats highest: its shadow leads the hand and falls down-right of a light above.
            shadow: { filter: shadowOf((3 + n.x * 5) * strength, (5 + n.y * 5) * strength, 2 + 16 * strength, 0.34 * strength) },
        };
    }

    /*
     * grab: the point of a free edge where the sheet is held, in page coordinates
     * ({ x, y }; x null for the outer edge); omitted, the bottom outer corner is lifted.
     * faces: 3 when the back of the sheet can show its real print (see foldTo).
     */
    function turnPlan(forward, cols, width, height, grab, faces) {
        var page = width / cols;
        var spine = cols > 1 ? width / 2 : 0;
        var dir = cols > 1 && !forward ? -1 : 1;
        var lift = Math.min(page, height) * 0.32;
        var outer = spine + dir * page;
        var x = grab && grab.x !== null && grab.x !== undefined ? grab.x : outer;
        var y = grab ? grab.y : height;
        // The edge the held point is on: its inward normal, its direction, and how much
        // of it is left on either side (towards -along, towards +along).
        var onOuter = Math.abs(x - outer) < 0.5 || (y > 0 && y < height);
        return {
            inward: onOuter ? { x: -dir, y: 0 } : { x: 0, y: y > 0 ? -1 : 1 },
            along: onOuter ? { x: 0, y: 1 } : { x: 1, y: 0 },
            room: onOuter ? [y, height - y] : [x - Math.min(spine, outer), Math.max(spine, outer) - x],
            sheet: cols > 1 || forward ? 'old' : 'new',
            under: cols > 1 || forward ? 'new' : 'old',
            reverse: cols === 1 && !forward,
            columns: cols,
            totalWidth: width,
            width: page,
            height: height,
            spine: spine,
            dir: dir,
            edge: !!grab,
            grab: { x: x, y: y },
            bend: lift,
            lift: grab ? 0 : lift,
            faces: faces || 2,
        };
    }

    function duration() {
        var value = getComputedStyle(root).getPropertyValue('--book-turn').trim();
        var number = parseFloat(value);
        if (!number) return 700;
        return /ms$/.test(value) ? number : number * 1000;
    }

    /* ---------- Rendering and motion: one frame loop for whatever sheet is in the air ---------- */

    /*
     * layers: { key: [element, pseudo-element] } for each key of a foldTo() frame.
     * A paused animation per layer pins the snapshot where the geometry says; it also
     * keeps the view transition open while the sheet is held still.
     */
    function stage(plan, layers) {
        var animations = {};
        Object.keys(layers).forEach(function (key) {
            animations[key] = layers[key][0].animate([], { duration: 1000, fill: 'both', pseudoElement: layers[key][1] });
            animations[key].pause();
            animations[key].finished.catch(noop);
        });
        return {
            paint: function (to) {
                var frame = foldTo(plan, to);
                Object.keys(animations).forEach(function (key) {
                    animations[key].effect.setKeyframes([frame[key], frame[key]]);
                    animations[key].currentTime = 0;
                });
            },
            // Paused animations would latch onto the next transition's pseudo-elements and hold it open.
            stop: function () {
                Object.keys(animations).forEach(function (key) { animations[key].cancel(); });
            },
        };
    }

    // Pointer events only record where the hand is; the paper is drawn once per frame.
    function request() {
        if (!frame) frame = requestAnimationFrame(tick);
    }

    function tick(now) {
        frame = 0;
        var leaf = flying;
        if (!leaf || !leaf.paint) return;
        var glide = leaf.glide;
        if (!glide) {
            if (leaf.dirty) {
                leaf.dirty = false;
                leaf.paint(leaf.point);
            }
            return;
        }
        // The first frame of a glide is the last frame of the drag.
        if (glide.start === null) glide.start = now;
        var k = glide.time ? Math.min(1, (now - glide.start) / glide.time) : 1;
        // Cubic Hermite: leaves with the hand's velocity and arrives at rest.
        var out = k * k * k - 2 * k * k + k;
        var arrive = k * k * (3 - 2 * k);
        leaf.point = bound(leaf.plan, {
            x: glide.from.x + (glide.to.x - glide.from.x) * arrive + glide.speed.x * glide.time * out,
            y: glide.from.y + (glide.to.y - glide.from.y) * arrive + glide.speed.y * glide.time * out - glide.lift * Math.sin(Math.PI * arrive),
        });
        leaf.paint(k < 1 ? leaf.point : glide.to);
        if (k < 1) request();
        else {
            leaf.glide = null;
            glide.done();
        }
    }

    /*
     * Let the sheet go: it glides from where it is, as fast as it was moving, to rest
     * at `to`. lift raises an automatic turn along an arc. A slow release takes a time
     * in proportion to what is left; a flick arrives sooner, but never overshoots.
     */
    function glideTo(leaf, to, lift, done) {
        var from = leaf.point;
        var distance = Math.hypot(to.x - from.x, to.y - from.y);
        var speed = leaf.velocity || { x: 0, y: 0 };
        var time = duration();
        if (!lift) {
            var share = Math.sqrt(distance / (2 * leaf.plan.width));
            time = leaf.commit === false ? Math.max(180, Math.min(350, time * 0.6 * share)) : Math.max(120, Math.min(500, time * 0.75 * share));
            var along = distance ? (speed.x * (to.x - from.x) + speed.y * (to.y - from.y)) / distance : 0;
            if (along > 0) time = Math.max(120, Math.min(time, 3 * distance / along));
        }
        // More than three lengths of launch would carry a Hermite curve past its end.
        var launch = Math.hypot(speed.x, speed.y) * time;
        var limit = launch > 3 * distance ? 3 * distance / launch : 1;
        leaf.glide = { from: from, to: to, lift: lift, time: distance < 0.5 ? 0 : time, start: null,
            speed: { x: speed.x * limit, y: speed.y * limit }, done: done || noop };
        request();
    }

    // Give a sheet its stage once the snapshots exist, then hold it or let it go.
    function fly(leaf, layers) {
        var set = stage(leaf.plan, layers);
        flying = leaf;
        leaf.paint = set.paint;
        leaf.stop = set.stop;
        leaf.settle = function (from, to, lift, done) {
            leaf.point = from;
            glideTo(leaf, to, lift, done);
        };
        set.paint(leaf.point);
    }

    function sheetBack(light) {
        var back = element('div', 'book-sheet-back' + (light ? ' book-sheet-light' : ''));
        back.setAttribute('aria-hidden', 'true');
        return back;
    }

    function rollLayers(plan) {
        return {
            sheet: [root, '::view-transition-' + plan.sheet + '(book-page)'],
            under: [root, '::view-transition-' + plan.under + '(book-page)'],
            flap: [root, '::view-transition-' + (plan.back || 'old') + '(book-sheet-back)'],
            shadow: [root, '::view-transition-group(book-sheet-back)'],
        };
    }

    /* ---------- Turning between documents ---------- */

    // The outgoing page knows the table of contents, so it decides the direction.
    window.addEventListener('pageswap', function (event) {
        // A sheet let go here was turning onto blank paper: the snapshot is this page as it is.
        var held = handoff;
        handoff = null;
        clearHeld();
        if (!event.viewTransition || !event.activation || !main) return;
        var from = pageIndex(location.href);
        var to = pageIndex(event.activation.entry.url);
        if (from < 0 || to < 0 || from === to) {
            skip(event.viewTransition);
            return;
        }
        store(TURN_KEY, {
            forward: to > from, columns: columns, width: main.clientWidth, height: main.clientHeight,
            grab: held && held.plan.edge ? held.plan.grab : null, from: held ? held.point : null,
        });
    });

    // Leftovers of a turn: the back of the sheet and the blank paper under it.
    function clearHeld() {
        var backs = document.querySelectorAll('.book-sheet-back');
        for (var i = 0; i < backs.length; i++) backs[i].remove();
        if (book) book.classList.remove('book-blank');
    }

    window.addEventListener('pagereveal', function (event) {
        // A page left mid-turn may come back from the back/forward cache with its sheet.
        if (dragging) dragging.cancel();
        clearHeld();
        if (!event.viewTransition) return;
        var turn = take(TURN_KEY);
        // This page may reveal before init(), so find the book here.
        var target = document.querySelector('.exe-web-site .exe-content');
        if (!turn || !turn.width || !target) {
            skip(event.viewTransition);
            return;
        }
        var plan = turnPlan(turn.forward, turn.columns, turn.width, turn.height, turn.grab);
        // The outgoing page stays on screen until this one is ready, so the back of the
        // sheet is captured here, where the transition hides the live page.
        plan.back = 'new';
        var back = sheetBack();
        target.append(back);
        var transition = event.viewTransition;
        transition.finished.catch(noop).then(function () { back.remove(); });
        transition.types.add(plan.sheet === 'old' ? 'book-turn-old' : 'book-turn-new');
        transition.ready
            .then(function () {
                // The other document held the sheet at turn.from; this one lays it down.
                var leaf = { plan: plan, point: turn.from || pointAt(plan, 0, 0) };
                fly(leaf, rollLayers(plan));
                glideTo(leaf, pointAt(plan, 1, 0), turn.from ? 0 : plan.lift, function () {
                    leaf.stop();
                    if (flying === leaf) flying = null;
                });
            })
            .catch(function () {
                /* Skipped: the page is already shown. */
            });
    });

    function leave(href, backwards) {
        // Going back with the corner opens the previous section at its last page.
        store(LAND_KEY, backwards ? stripUrl(href) : null);
        location.assign(href);
    }

    // A sheet held towards another section: have that document in the cache by the time it lands.
    function prefetch(href) {
        if (!/^https?:/.test(href) || document.querySelector('link[rel="prefetch"][href="' + href + '"]')) return;
        var link = element('link');
        link.rel = 'prefetch';
        link.href = href;
        document.head.append(link);
    }

    /* ---------- Pagination ---------- */

    function measure() {
        var style = getComputedStyle(main);
        columns = parseInt(style.columnCount, 10) || 1;
        var step = main.clientWidth;
        var top = parseFloat(style.paddingTop) || 0;
        var bottom = parseFloat(style.paddingBottom) || 0;
        book.style.setProperty('--book-col-h', main.clientHeight - top - bottom + 'px');
        // The last column is where the end of the text falls.
        var left = parseFloat(style.paddingLeft) || 0;
        var x = sentinel.getBoundingClientRect().left - main.getBoundingClientRect().left + main.scrollLeft - left;
        var column = Math.max(0, Math.floor((x + 1) / (step / columns)));
        spreads = Math.floor(column / columns) + 1;
        rightEmpty = columns > 1 && column % columns === 0;
        if (spread > spreads - 1) spread = spreads - 1;
    }

    // Print the folios of a double page on a set of running elements.
    function dress(set, index) {
        var current = document.querySelector('.page-counter-current-page');
        // eXe only prints its page counter with "Add pagination"; the menu always knows the section.
        var section = current ? parseInt(current.textContent, 10) : pageIndex(location.href) + 1;
        var first = index * columns + 1;
        var prefix = section ? section + '·' : '';
        var last = index === spreads - 1;
        set.folioLeft.textContent = prefix + first;
        set.folioRight.textContent = columns > 1 ? prefix + (first + 1) : prefix + first;
        set.folioRight.hidden = columns > 1 && last && rightEmpty;
        set.end.hidden = !(last && rightEmpty);
        return section;
    }

    function show() {
        main.style.setProperty('--book-scroll', spread * main.clientWidth + 'px');
        main.scrollLeft = spread * main.clientWidth;
        var section = dress(parts, spread);
        var total = document.querySelector('.page-counter-total');
        var sections = total ? parseInt(total.textContent, 10) : document.querySelectorAll('#siteNav a[href]').length;
        var last = spread === spreads - 1;
        parts.prev.hidden = spread === 0 && !neighbour('left') && !(dragging && dragging.direction < 0);
        parts.next.hidden = last && !neighbour('right') && !(dragging && dragging.direction > 0);
        parts.prevEdge.hidden = parts.prev.hidden;
        parts.nextEdge.hidden = parts.next.hidden;
        var read = sections ? (section - 1 + (spread + 1) / spreads) / sections : (spread + 1) / spreads;
        book.style.setProperty('--book-read', Math.min(1, Math.max(0, read)).toFixed(3));
    }

    function layout() {
        scheduled = false;
        if (!main) return;
        // Activities restyle themselves at any time; measure once the sheet is down.
        if (dragging || running) {
            deferred = true;
            return;
        }
        measure();
        show();
    }

    function relayout() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(layout);
    }

    function settled() {
        if (!deferred || dragging || running) return;
        deferred = false;
        relayout();
    }

    function spreadOf(node) {
        var style = getComputedStyle(main);
        var left = parseFloat(style.paddingLeft) || 0;
        var x = node.getBoundingClientRect().left - main.getBoundingClientRect().left + main.scrollLeft - left;
        return Math.min(spreads - 1, Math.max(0, Math.floor((x + 1) / main.clientWidth)));
    }

    /* ---------- Turning inside a document ---------- */

    // The real back of the sheet needs a third picture of the pages: see openFold().
    function facesFor(outside) {
        return !outside && columns > 1 && !!window.Element && !!Element.prototype.startViewTransition &&
            !!document.startViewTransition && !reducedMotion() ? 3 : 2;
    }

    /*
     * For one frame main shows the neighbouring double page too, beside the current one
     * and clipped off by the book, so that a snapshot of it holds both.
     */
    function widen(target) {
        var step = main.clientWidth;
        var extras = {};
        ['headLeft', 'headRight', 'folioLeft', 'folioRight', 'end'].forEach(function (key) {
            // The running heads and folios of the neighbour: plain print, no activity DOM.
            extras[key] = parts[key].cloneNode(true);
            extras[key].style.setProperty('--book-scroll', target * step + 'px');
            extras[key].classList.add('book-extra');
            main.append(extras[key]);
        });
        dress(extras, target);
        wide = true;
        root.classList.add('book-wide');
        if (target < spread) {
            root.classList.add('book-wide-back');
            main.scrollLeft = target * step;
        }
    }

    function narrow() {
        if (!wide) return;
        var extras = main.querySelectorAll('.book-extra');
        for (var i = 0; i < extras.length; i++) extras[i].remove();
        root.classList.remove('book-wide', 'book-wide-back');
        main.scrollLeft = spread * main.clientWidth;
        wide = false;
    }

    // The sheet is down, or was dropped: no transition, class or leftover survives it.
    function close(leaf) {
        if (leaf.stop) leaf.stop();
        leaf.paint = leaf.settle = leaf.stop = leaf.glide = null;
        if (flying === leaf) flying = null;
        narrow();
        root.classList.remove('book-fold', 'book-leafing');
        clearHeld();
        (leaf.transitions || []).forEach(skip);
    }

    function turnTo(target, gesture) {
        if (dragging && dragging !== gesture) return;
        if (running) return;
        var outside = target < 0 || target > spreads - 1;
        if (outside && !gesture) {
            var href = neighbour(target < 0 ? 'left' : 'right');
            if (href) leave(href, target < 0);
            return;
        }
        if (target === spread) return;
        var source = spread;
        if (!document.startViewTransition || reducedMotion()) {
            spread = target;
            show();
            return;
        }
        var plan = gesture ? gesture.plan : turnPlan(target > spread, columns, main.clientWidth, main.clientHeight, null, facesFor(outside));
        // An automatic turn is a sheet nobody holds: it is let go as soon as it can fly.
        var leaf = gesture || { plan: plan, point: pointAt(plan, 0, 0), released: true, commit: true };
        leaf.transitions = [];
        var ready = function (layers) {
            if (leaf.cancelled) return;
            fly(leaf, layers);
            if (gesture) {
                if (gesture.released) gesture.finish();
            } else {
                glideTo(leaf, pointAt(plan, 1, 0), plan.lift, function () { close(leaf); });
            }
        };
        var failed = function () {
            if (gesture) gesture.cancel();
            else {
                leaf.cancelled = true;
                spread = leaf.landed ? target : source;
                close(leaf);
                show();
            }
        };
        var watch = function (transition) {
            leaf.transitions.push(transition);
            running = transition;
            transition.finished.catch(noop).then(function () {
                if (running === transition) running = null;
                if (gesture && dragging === gesture) gesture.cancel();
                settled();
            });
            return transition;
        };
        if (plan.faces === 3) openFold(leaf, target, watch, ready, failed);
        else openRoll(leaf, target, outside, watch, ready, failed);
    }

    // Two pictures: the double page before and after, with a plain back of paper between them.
    function openRoll(leaf, target, outside, watch, ready, failed) {
        var plan = leaf.plan;
        var update = function () {
            clearHeld();
            if (leaf.cancelled) return;
            // The next document is not here yet: a held sheet turns onto blank paper.
            if (outside) book.classList.add('book-blank');
            else spread = target;
            leaf.landed = true;
            show();
        };
        book.append(sheetBack());
        var transition;
        try {
            transition = document.startViewTransition({
                update: update,
                types: [plan.sheet === 'old' ? 'book-turn-old' : 'book-turn-new'],
            });
        } catch (e) {
            transition = document.startViewTransition(update);
        }
        watch(transition).ready.then(function () { ready(rollLayers(plan)); }).catch(failed);
    }

    /*
     * Three pictures, so the back of the sheet shows its real print. One element can only
     * be in one view transition, which gives two pictures of it, so two transitions share
     * the work:
     *
     * 1. A document transition photographs main while it is two double pages wide and
     *    then lets go of it. Its still picture, drawn above the page, is the back of
     *    the sheet: the facing page of the neighbouring double page.
     * 2. A transition scoped to the book takes main before and after the turn: the
     *    old picture is the sheet, clipped along the crease, and the new one is the
     *    live page underneath.
     */
    function openFold(leaf, target, watch, ready, failed) {
        var plan = leaf.plan;
        widen(target);
        book.append(sheetBack(true));
        var outer = watch(document.startViewTransition(function () {
            narrow();
            clearHeld();
            // From here on main belongs to the book's own transition.
            if (!leaf.cancelled) root.classList.add('book-fold');
        }));
        outer.ready.then(function () {
            if (leaf.cancelled) return;
            // Nothing moves yet: these keep the still pictures alive until the sheet can be drawn.
            var layers = {
                face: [root, '::view-transition-old(book-page)'],
                flap: [root, '::view-transition-old(book-sheet-back)'],
                shadow: [root, '::view-transition-group(book-page)'],
            };
            var waiting = stage(plan, layers);
            leaf.stop = waiting.stop;
            root.classList.add('book-leafing');
            var inner = book.startViewTransition(function () {
                if (leaf.cancelled) return;
                spread = target;
                leaf.landed = true;
                show();
            });
            leaf.transitions.push(inner);
            inner.finished.catch(noop);
            return inner.ready.then(function () {
                waiting.stop();
                layers.sheet = [book, '::view-transition-old(book-spread)'];
                ready(layers);
            });
        }).catch(failed);
    }

    /* A held sheet. Pointer drags and trackpad swipes move it the same way: the held
     * point stays under the hand. Snapshots may take a frame to become ready, so the
     * gesture keeps the latest point and release decision for the turn to pick up.
     * grab: the point of the free edges where the sheet is held ({ x, y } in page
     * coordinates, x null for the outer edge); null for the bottom corner.
     * corner: the button that curls when there is no view transition to show the fold.
     */
    function hold(direction, grab, x, y, corner) {
        if (running || dragging) return null;
        var source = spread;
        var target = source + direction;
        var outside = target < 0 || target > spreads - 1;
        var href = outside ? neighbour(direction < 0 ? 'left' : 'right') : null;
        if (outside && !href) return null;
        corner = corner || (direction > 0 ? parts.next : parts.prev);
        var plan = turnPlan(direction > 0, columns, main.clientWidth, main.clientHeight, grab, facesFor(outside));
        var rest = pointAt(plan, 0, 0);
        var gesture = {
            direction: direction, source: source, plan: plan, x: x, y: y, point: rest,
            progress: 0, speed: 0, velocity: { x: 0, y: 0 }, time: performance.now(), moved: false, released: false,
            interactive: !!document.startViewTransition && !reducedMotion(),
        };
        if (href) prefetch(href);
        var cleanup = function () {
            if (dragging === gesture) dragging = null;
            close(gesture);
            show();
            root.classList.remove('book-dragging');
            corner.style.removeProperty('--book-curl');
            if (gesture.end) gesture.end();
            settled();
        };
        gesture.move = function (x, y) {
            if (gesture.released) return;
            var dx = x - gesture.x;
            if (!gesture.moved && Math.hypot(dx, y - gesture.y) < 8) return;
            var now = performance.now();
            // On a phone the incoming sheet starts off the left edge, so it travels twice as far.
            var lifted = Math.max(0, Math.min(plan.height, rest.y + y - gesture.y));
            var point = bound(plan, { x: rest.x + (plan.reverse ? 2 : 1) * dx, y: lifted });
            var progress = progressOf(plan, point);
            if (gesture.moved) {
                // Velocity through a short low-pass filter: one late event must not decide a flick.
                var elapsed = Math.max(8, now - gesture.time);
                var keep = Math.exp(-elapsed / 40);
                gesture.velocity = {
                    x: gesture.velocity.x * keep + (point.x - gesture.point.x) / elapsed * (1 - keep),
                    y: gesture.velocity.y * keep + (point.y - gesture.point.y) / elapsed * (1 - keep),
                };
                gesture.speed = gesture.speed * keep + (progress - gesture.progress) * 2 * plan.width / elapsed * (1 - keep);
            }
            gesture.time = now;
            gesture.point = point;
            gesture.progress = progress;
            if (!gesture.moved) {
                gesture.moved = true;
                root.classList.add('book-dragging');
                if (gesture.interactive) turnTo(target, gesture);
            }
            if (gesture.paint) {
                gesture.dirty = true;
                request();
            }
            // Without view transitions the destination cannot be shown: lift the corner instead.
            if (!gesture.interactive && !reducedMotion()) corner.style.setProperty('--book-curl', 30 + progress * 90 + 'px');
        };
        // A flick turns the page however little it was pulled; a held stop decides by distance.
        gesture.release = function () {
            if (gesture.released) return;
            if (performance.now() - gesture.time > 100) {
                gesture.speed = 0;
                gesture.velocity = { x: 0, y: 0 };
            }
            gesture.released = true;
            gesture.commit = gesture.moved && (gesture.speed > 0.4 || (gesture.speed > -0.4 && gesture.progress >= 0.3));
            gesture.finish();
        };
        gesture.cancel = function () {
            gesture.released = true;
            gesture.cancelled = true;
            gesture.commit = false;
            if (gesture.interactive && gesture.moved) spread = source;
            cleanup();
        };
        gesture.finish = function () {
            if (!gesture.moved) {
                cleanup();
            } else if (!gesture.interactive) {
                cleanup();
                if (gesture.commit) turnTo(target);
            } else if (!gesture.settle) {
                /* Picked up by turnTo once the snapshots are ready. */
            } else if (gesture.commit && outside) {
                // The next document finishes the turn from where the sheet was let go.
                handoff = gesture;
                leave(href, direction < 0);
            } else {
                gesture.settle(gesture.point, pointAt(plan, gesture.commit ? 1 : 0, 0), 0, function () {
                    if (!gesture.commit) spread = source;
                    cleanup();
                });
            }
        };
        dragging = gesture;
        return gesture;
    }

    /*
     * A zone of the book that takes hold of a sheet. Pointer capture belongs only to
     * these zones, never to an iDevice.
     * grip(event): { direction, grab, corner } for a press there, or null. direction 0
     * waits for the hand to say which way it pulls.
     */
    function bindZone(zone, grip, click) {
        var suppressClick = false;
        var pending = null;
        var free = function (id) {
            if (zone.hasPointerCapture(id)) zone.releasePointerCapture(id);
        };
        var grasp = function (held, event, direction) {
            var gesture = hold(direction, held.grab, event.clientX, event.clientY, held.corner);
            if (!gesture) return null;
            gesture.id = event.pointerId;
            gesture.end = function () { free(gesture.id); };
            return gesture;
        };
        if (click) {
            zone.addEventListener('click', function (event) {
                if (suppressClick && event.detail) { suppressClick = false; return; }
                click();
            });
        }
        zone.addEventListener('pointerdown', function (event) {
            if (!event.isPrimary || event.button !== 0) return;
            suppressClick = false;
            pending = null;
            var held = grip(event);
            if (!held) return;
            if (!held.direction) pending = { held: held, id: event.pointerId, x: event.clientX, y: event.clientY };
            else if (!grasp(held, event, held.direction)) return;
            zone.setPointerCapture(event.pointerId);
        });
        zone.addEventListener('pointermove', function (event) {
            if (pending && pending.id === event.pointerId) {
                var dx = event.clientX - pending.x;
                if (Math.abs(dx) < 8) return;
                var start = pending;
                pending = null;
                // The sheet was taken where the press began, not where the pull became clear.
                if (!grasp(start.held, { clientX: start.x, clientY: start.y, pointerId: start.id }, dx < 0 ? 1 : -1)) free(start.id);
            }
            var gesture = dragging;
            if (!gesture || gesture.id !== event.pointerId) return;
            gesture.move(event.clientX, event.clientY);
            if (gesture.moved) suppressClick = true;
        });
        zone.addEventListener('pointerup', function (event) {
            if (pending && pending.id === event.pointerId) {
                pending = null;
                free(event.pointerId);
            }
            if (dragging && dragging.id === event.pointerId) dragging.release();
        });
        zone.addEventListener('pointercancel', function () {
            pending = null;
            if (dragging) dragging.cancel();
        });
        zone.addEventListener('lostpointercapture', function () {
            pending = null;
            if (dragging && !dragging.released) dragging.cancel();
        });
    }

    // A corner button, or (given the corner it lifts) the strip along the rest of that outer edge.
    function bindCorner(button, direction, corner) {
        bindZone(button, function (event) {
            if (!corner) return { direction: direction, grab: null, corner: button };
            var y = event.clientY - main.getBoundingClientRect().top;
            return { direction: direction, grab: { x: null, y: Math.max(0, Math.min(main.clientHeight, y)) }, corner: corner };
        }, function () { turnTo(spread + direction); });
    }

    // The strip along the top or bottom edge: either sheet, anywhere but next to the spine.
    function bindEdge(strip, top) {
        bindZone(strip, function (event) {
            var x = event.clientX - (main.getBoundingClientRect().left || 0);
            var grab = { x: x, y: top ? 0 : main.clientHeight };
            if (columns === 1) {
                // One page: the same edge turns forward or brings the last page back.
                grab.x = Math.max(SPINE, x);
                return { direction: 0, grab: grab };
            }
            var spine = main.clientWidth / 2;
            return Math.abs(x - spine) < SPINE ? null : { direction: x > spine ? 1 : -1, grab: grab };
        });
    }

    // A free edge lifts a little under the pointer, where it would be taken.
    function peek(strip, along) {
        strip.addEventListener('pointermove', function (event) {
            if (event.pointerType === 'touch' || dragging) return;
            var box = strip.getBoundingClientRect();
            strip.style.setProperty('--book-peek', (along === 'x' ? event.clientX - box.left : event.clientY - box.top).toFixed(0) + 'px');
        });
    }

    /* ---------- Index card ---------- */

    function setIndex(open, focusBack) {
        document.body.classList.toggle('book-index-open', open);
        parts.ribbon.setAttribute('aria-expanded', open ? 'true' : 'false');
        parts.index.inert = !open;
        if (open) {
            var target = parts.index.querySelector('#siteNav a.active') || parts.index.querySelector('a, input');
            if (target) target.focus();
        } else if (focusBack) {
            parts.ribbon.focus();
        }
    }

    function buildIndex() {
        var index = element('div', 'book-index');
        index.id = 'book-index';
        index.inert = true;
        var search = document.getElementById('exe-client-search-form');
        if (search) {
            index.append(element('p', 'book-index-label', label('search', 'Search')));
            index.append(search);
            search.addEventListener('submit', function () {
                // eXeLearning shows the results in place of the page: start reading them.
                setTimeout(function () {
                    setIndex(false);
                    spread = 0;
                    relayout();
                });
            });
            var reset = search.querySelector('#exe-client-search-reset');
            if (reset) reset.addEventListener('click', relayout);
        }
        var nav = document.getElementById('siteNav');
        if (nav) {
            index.append(element('p', 'book-index-label', label('menu', 'Menu')));
            index.append(nav);
        }
        var footer = document.getElementById('siteFooter');
        if (footer) index.append(footer);
        document.body.append(index);
        parts.index = index;

        var ribbon = element('button', 'book-ribbon');
        ribbon.type = 'button';
        ribbon.setAttribute('aria-controls', 'book-index');
        ribbon.setAttribute('aria-expanded', 'false');
        ribbon.append(element('span', '', label('menu', 'Menu')));
        ribbon.addEventListener('click', function () {
            setIndex(!document.body.classList.contains('book-index-open'));
        });
        document.body.append(ribbon);
        parts.ribbon = ribbon;

        document.addEventListener('click', function (event) {
            if (!document.body.classList.contains('book-index-open')) return;
            if (index.contains(event.target) || ribbon.contains(event.target)) return;
            setIndex(false);
        });
    }

    /* ---------- The book ---------- */

    function buildBook() {
        var packageTitle = document.querySelector('.package-title');
        var pageTitle = main.querySelector('.page-title');
        parts.headLeft = element('p', 'book-head book-head-left', packageTitle ? packageTitle.textContent.trim() : '');
        parts.headRight = element('p', 'book-head book-head-right', pageTitle ? pageTitle.textContent.trim() : '');
        parts.headLeft.setAttribute('aria-hidden', 'true');
        parts.headRight.setAttribute('aria-hidden', 'true');
        parts.folioLeft = element('p', 'book-folio book-folio-left');
        parts.folioRight = element('p', 'book-folio book-folio-right');

        // An empty right-hand page closes the section and points to the next one.
        parts.end = element('div', 'book-end');
        parts.end.hidden = true;
        parts.end.innerHTML =
            '<svg width="64" height="20" viewBox="0 0 64 20" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
            '<path d="M2 10h20M42 10h20"/><path d="M32 3c-5 0-8 3-8 7s3 7 8 7 8-3 8-7-3-7-8-7z"/><path d="M28 10c2-2 6-2 8 0"/></svg>';
        var nextHref = neighbour('right');
        var nextIndex = nextHref ? pageIndex(nextHref) : -1;
        if (nextIndex >= 0) {
            var nextTitle = document.querySelectorAll('#siteNav a[href]')[nextIndex].textContent.trim();
            var line = element('p', '', label('next', 'Next') + ': ');
            var link = element('a', '', nextTitle);
            link.href = nextHref;
            link.addEventListener('click', function (event) {
                event.preventDefault();
                leave(nextHref, false);
            });
            line.append(link);
            parts.end.append(line);
        }

        parts.prev = element('button', 'book-corner book-corner-prev');
        parts.next = element('button', 'book-corner book-corner-next');
        parts.prev.type = parts.next.type = 'button';
        parts.prev.append(element('span', '', label('previous', 'Previous')));
        parts.next.append(element('span', '', label('next', 'Next')));
        bindCorner(parts.prev, -1);
        bindCorner(parts.next, 1);
        // The rest of the outer edge pulls the sheet too, from the height where it is held.
        parts.prevEdge = element('div', 'book-edge book-edge-prev');
        parts.nextEdge = element('div', 'book-edge book-edge-next');
        parts.prevEdge.setAttribute('aria-hidden', 'true');
        parts.nextEdge.setAttribute('aria-hidden', 'true');
        bindCorner(parts.prevEdge, -1, parts.prev);
        bindCorner(parts.nextEdge, 1, parts.next);
        peek(parts.prevEdge, 'y');
        peek(parts.nextEdge, 'y');
        // So do the top and bottom edges, from the point where they are held.
        parts.topEdge = element('div', 'book-edge book-edge-top');
        parts.bottomEdge = element('div', 'book-edge book-edge-bottom');
        parts.topEdge.setAttribute('aria-hidden', 'true');
        parts.bottomEdge.setAttribute('aria-hidden', 'true');
        bindEdge(parts.topEdge, true);
        bindEdge(parts.bottomEdge, false);
        peek(parts.topEdge, 'x');
        peek(parts.bottomEdge, 'x');

        sentinel = element('span', 'book-end-of-text');
        sentinel.setAttribute('aria-hidden', 'true');
        main.append(sentinel, parts.headLeft, parts.headRight, parts.folioLeft, parts.folioRight, parts.end);
        book.append(parts.topEdge, parts.bottomEdge, parts.prevEdge, parts.nextEdge, parts.prev, parts.next);
    }

    function listen() {
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && dragging) { dragging.cancel(); return; }
            if (event.key === 'Escape' && document.body.classList.contains('book-index-open')) {
                setIndex(false, true);
                return;
            }
            if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
            var keys = { ArrowLeft: -1, PageUp: -1, ArrowRight: 1, PageDown: 1 };
            if (!keys[event.key]) return;
            if (event.target.closest && event.target.closest(CONTROLS + ', .book-index')) return;
            event.preventDefault();
            turnTo(spread + keys[event.key]);
        });

        // Tabbing or a link to an anchor reaches a hidden page: open that page.
        main.addEventListener('focusin', function (event) {
            var target = spreadOf(event.target);
            if (target !== spread) {
                spread = target;
                show();
            }
        });
        // Something scrolled the pages (find in page, an activity, scrollIntoView): open that page.
        main.addEventListener('scroll', function () {
            if (wide || main.scrollLeft === spread * main.clientWidth) return;
            spread = Math.min(spreads - 1, Math.max(0, Math.round(main.scrollLeft / main.clientWidth)));
            show();
        });

        // Swipe on touch screens.
        var start = null;
        main.addEventListener(
            'touchstart',
            function (event) {
                start = event.touches.length === 1 && !event.target.closest(CONTROLS) ? event.touches[0] : null;
            },
            { passive: true },
        );
        main.addEventListener(
            'touchend',
            function (event) {
                if (!start) return;
                var dx = event.changedTouches[0].clientX - start.clientX;
                var dy = event.changedTouches[0].clientY - start.clientY;
                start = null;
                if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) turnTo(spread + (dx < 0 ? 1 : -1));
            },
            { passive: true },
        );

        // A sideways two-finger swipe on a trackpad holds the sheet at that height, like a
        // pull from the edge; it lets go when the wheel goes quiet, momentum included.
        var swipe = null;
        var quiet = 0;
        // On the document: while the page turns, wheel events stop reaching the book.
        document.addEventListener(
            'wheel',
            function (event) {
                var sideways = !event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY);
                if (swipe === null && !(sideways && book.contains(event.target))) return;
                // Also keeps the browser's back/forward swipe off the book.
                event.preventDefault();
                clearTimeout(quiet);
                quiet = setTimeout(function () {
                    if (swipe) swipe.release();
                    swipe = null;
                }, 160);
                // ponytail: lines are taken as 16px; the 2 is how far the sheet travels per finger pixel.
                var dx = event.deltaX * (event.deltaMode === 1 ? 16 : 1) * 2;
                if (swipe === null) {
                    var direction = dx > 0 ? 1 : -1;
                    var top = main.getBoundingClientRect().top;
                    var grab = { x: null, y: Math.max(0, Math.min(main.clientHeight, event.clientY - top)) };
                    // false until the wheel is quiet: a swipe that could not turn is not retried by its momentum.
                    swipe = hold(direction, grab, 0, 0) || false;
                    if (swipe) swipe.travel = 0;
                }
                if (!swipe || swipe !== dragging) return;
                swipe.travel -= dx;
                swipe.move(swipe.travel, 0);
            },
            { passive: false },
        );

        // Content that changes size (images, opened boxes, activities) moves the pages.
        if (window.ResizeObserver) new ResizeObserver(relayout).observe(book);
        // The book's own heads, folios and scroll position are not content changes.
        new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
                var target = records[i].target;
                if (target.nodeType !== 1) target = target.parentNode;
                if (target.closest && target.closest('.book-head, .book-folio, .book-end')) continue;
                if (target === main) {
                    // On main itself only content coming or going counts, not its style or the book's own print.
                    var nodes = Array.prototype.concat.call([], Array.from(records[i].addedNodes), Array.from(records[i].removedNodes));
                    if (!nodes.some(function (node) { return !(node.matches && node.matches('.book-head, .book-folio, .book-end, .book-end-of-text')); })) continue;
                }
                relayout();
                return;
            }
        }).observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
        main.addEventListener('load', relayout, true);
        window.addEventListener('load', relayout);
        window.addEventListener('resize', function () {
            // A new page size invalidates the fold being held.
            if (dragging) dragging.cancel();
            relayout();
        });
        window.addEventListener('blur', function () { if (dragging) dragging.cancel(); });
        document.addEventListener('visibilitychange', function () {
            if (document.hidden && dragging) dragging.cancel();
        });
        if (document.fonts) document.fonts.ready.then(relayout);
    }

    function init() {
        if (!paged) return;
        book = document.querySelector('.exe-web-site .exe-content');
        main = book && book.querySelector('main.page');
        if (!main) {
            root.classList.remove('book-paged');
            return;
        }
        buildBook();
        buildIndex();
        listen();
        layout();
        var hash = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (take(LAND_KEY) === stripUrl(location.href)) spread = spreads - 1;
        else if (hash && main.contains(hash)) spread = spreadOf(hash);
        show();
    }

    // After eXeLearning's own ready handlers, which build the search form.
    if (window.jQuery) window.jQuery(init);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
