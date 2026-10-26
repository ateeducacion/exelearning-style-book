/*!
 * Libro (Book) — eXeLearning style script
 * Cuts each page into book pages, turns them from the corners with a paper fold,
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
    var FRAMES = 40;
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

    /* ---------- Fold geometry ---------- */

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

    /*
     * Independent paper geometry: the reader holds the outer edge of the curl and
     * the crease runs perpendicular to the pull, one curl behind. A narrow, opaque band describes the curved back;
     * the part already laid down reveals the destination snapshot. The band gets
     * narrower as the paper flattens, rather than fading a whole blank sheet out.
     * No activity DOM is copied: both faces remain browser-owned snapshots.
     */
    function foldAt(plan, progress, lift) {
        return foldTo(plan, pointAt(plan, progress, lift));
    }

    // Where the held point of the sheet rests before it turns.
    function cornerOf(plan) {
        return { x: plan.spine + plan.dir * plan.width, y: plan.grab };
    }

    // The held point at a given progress, raised along an arc of height lift.
    function pointAt(plan, progress, lift) {
        var t = plan.reverse ? 1 - progress : progress;
        var corner = cornerOf(plan);
        return { x: corner.x - plan.dir * 2 * plan.width * t, y: plan.grab - lift * Math.sin(Math.PI * t) };
    }

    function progressOf(plan, to) {
        var t = Math.max(0, Math.min(1, plan.dir * (cornerOf(plan).x - to.x) / (2 * plan.width)));
        return plan.reverse ? 1 - t : t;
    }

    // The sheet is bound at the spine: the held point stays as far from the spine's ends as it rests.
    // ponytail: one pass per end, so a far pull can overshoot one circle by a pixel or two.
    function bound(plan, to) {
        var corner = cornerOf(plan);
        [0, plan.height].forEach(function (y) {
            var reach = Math.hypot(plan.width, corner.y - y);
            var dx = to.x - plan.spine;
            var dy = to.y - y;
            var distance = Math.hypot(dx, dy);
            if (distance > reach) to = { x: plan.spine + dx * reach / distance, y: y + dy * reach / distance };
        });
        return to;
    }

    // hand: the outer edge of the curl, the paper the reader holds.
    function foldTo(plan, hand) {
        var width = plan.width;
        var height = plan.height;
        var dir = plan.dir;
        var x0 = plan.spine;
        var sheet = dir > 0 ? rect(x0, x0 + width, height) : rect(x0 - width, x0, height);
        var other = plan.columns > 1 ? (dir > 0 ? rect(0, x0, height) : rect(x0, 2 * width, height)) : [];
        var corner = cornerOf(plan);
        var t = Math.max(0, Math.min(1, dir * (corner.x - hand.x) / (2 * width)));
        var dx = hand.x - corner.x;
        var dy = hand.y - corner.y;
        var length = Math.hypot(dx, dy);
        var empty = 'polygon(0px 0px, 0px 0px, 0px 0px)';
        if (length < 0.01 || t >= 1) {
            return {
                sheet: { clipPath: path(t < 0.5 ? [sheet, other] : []) },
                under: { clipPath: path(t < 0.5 ? [] : [sheet, other]) },
                flap: { clipPath: empty, transform: 'matrix(1, 0, 0, 1, 0, 0)' },
                shadow: { filter: 'drop-shadow(0px 0px 0px rgba(59, 42, 26, 0))' },
            };
        }
        var n = { x: dx / length, y: dy / length };
        var tangent = { x: -n.y, y: n.x };
        // A sheet pulled level still bends as much as a lifted corner.
        var bend = Math.max(Math.abs(plan.grab - hand.y), plan.bend);
        var curl = Math.max(0.01, Math.min(width * 0.24, bend * 0.65, length / 2) * Math.sin(Math.PI * t));
        // The crease sits one curl behind the hand.
        var middle = { x: hand.x - n.x * curl, y: hand.y - n.y * curl };
        var keep = clip(sheet, middle, n);
        var folded = clip(sheet, middle, { x: -n.x, y: -n.y });
        var reflected = folded.map(function (p) {
            var d = 2 * ((p.x - middle.x) * n.x + (p.y - middle.y) * n.y);
            return { x: p.x - d * n.x, y: p.y - d * n.y };
        });
        var band = clip(reflected, hand, { x: -n.x, y: -n.y });
        var reach = Math.hypot(plan.totalWidth, height);
        var origin = { x: middle.x - tangent.x * reach, y: middle.y - tangent.y * reach };
        // Put a fixed paper gradient in fold coordinates. Its light and dark edges
        // rotate with the crease, including left turns and single-page reverse turns.
        var local = band.map(function (p) {
            var x = p.x - origin.x;
            var y = p.y - origin.y;
            return { x: (x * n.x + y * n.y) * plan.totalWidth / curl, y: (x * tangent.x + y * tangent.y) * height / (2 * reach) };
        });
        var matrix = [n.x * curl / plan.totalWidth, n.y * curl / plan.totalWidth,
            tangent.x * 2 * reach / height, tangent.y * 2 * reach / height, origin.x, origin.y];
        var resting = clip(other, hand, { x: -dir, y: 0 });
        var landed = clip(other, hand, { x: dir, y: 0 });
        var strength = Math.sin(Math.PI * t);
        var blur = 1 + 12 * strength;
        return {
            sheet: { clipPath: path([keep, resting]) },
            under: { clipPath: path([folded, landed]) },
            flap: { clipPath: local.length > 2 ? 'polygon(' + points(local) + ')' : empty,
                transform: 'matrix(' + matrix.map(function (v) { return v.toFixed(6); }).join(', ') + ')' },
            shadow: { filter: 'drop-shadow(' + (-n.x * 8 * strength).toFixed(2) + 'px ' +
                (-n.y * 8 * strength).toFixed(2) + 'px ' + blur.toFixed(2) + 'px rgba(59, 42, 26, ' +
                (0.38 * strength).toFixed(3) + '))' },
        };
    }

    // grab: height where the outer edge is held; omitted, the bottom corner is lifted.
    function turnPlan(forward, cols, width, height, grab) {
        var lift = Math.min(width / cols, height) * 0.32;
        var edge = grab !== undefined && grab !== null;
        return {
            sheet: cols > 1 || forward ? 'old' : 'new',
            under: cols > 1 || forward ? 'new' : 'old',
            reverse: cols === 1 && !forward,
            columns: cols,
            totalWidth: width,
            width: width / cols,
            height: height,
            spine: cols > 1 ? width / 2 : 0,
            dir: cols > 1 && !forward ? -1 : 1,
            edge: edge,
            grab: edge ? grab : height,
            bend: lift,
            lift: edge ? 0 : lift,
        };
    }

    function duration() {
        var value = getComputedStyle(root).getPropertyValue('--book-turn').trim();
        var number = parseFloat(value);
        if (!number) return 700;
        return /ms$/.test(value) ? number : number * 1000;
    }

    // from: where a held sheet was let go on the previous document.
    function animateTurn(plan, gesture, from) {
        var pseudos = {
            sheet: '::view-transition-' + plan.sheet + '(book-page)',
            under: '::view-transition-' + plan.under + '(book-page)',
            flap: '::view-transition-' + (plan.back || 'old') + '(book-sheet-back)',
            shadow: '::view-transition-group(book-sheet-back)',
        };
        var animations = {};
        Object.keys(pseudos).forEach(function (key) {
            animations[key] = root.animate([], { duration: duration(), fill: 'both', pseudoElement: pseudos[key] });
            animations[key].pause();
            animations[key].finished.catch(noop);
        });
        var paint = function (to) {
            var frame = foldTo(plan, to);
            Object.keys(animations).forEach(function (key) {
                animations[key].effect.setKeyframes([frame[key], frame[key]]);
                animations[key].currentTime = 0;
            });
        };
        // The held point travels straight to its end, raised along an arc of height lift.
        var settle = function (from, to, lift, done) {
            var frames = { sheet: [], under: [], flap: [], shadow: [] };
            for (var i = 0; i <= FRAMES; i++) {
                var ratio = i / FRAMES;
                var frame = foldTo(plan, {
                    x: from.x + (to.x - from.x) * ratio,
                    y: from.y + (to.y - from.y) * ratio - lift * Math.sin(Math.PI * ratio),
                });
                Object.keys(frames).forEach(function (key) { frames[key].push(frame[key]); });
            }
            var share = Math.abs(to.x - from.x) / (2 * plan.width);
            Object.keys(animations).forEach(function (key) {
                var animation = animations[key];
                animation.effect.setKeyframes(frames[key]);
                animation.effect.updateTiming({ duration: Math.max(140, duration() * share), easing: 'cubic-bezier(.3, 0, .2, 1)' });
                animation.currentTime = 0;
                animation.play();
            });
            Promise.all(Object.keys(animations).map(function (key) { return animations[key].finished; })).then(done || noop).catch(noop);
        };
        if (gesture) {
            gesture.paint = paint;
            gesture.settle = settle;
            // Paused animations would latch onto the next transition's pseudo-elements and hold it open.
            gesture.stop = function () {
                Object.keys(animations).forEach(function (key) { animations[key].cancel(); });
            };
            paint(gesture.point);
            if (gesture.released) gesture.finish();
        } else settle(from || pointAt(plan, 0, 0), pointAt(plan, 1, 0), from ? 0 : plan.lift);
    }

    function sheetBack() {
        var back = element('div', 'book-sheet-back');
        back.setAttribute('aria-hidden', 'true');
        return back;
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
            grab: held ? held.plan.grab : null, from: held ? held.point : null,
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
        event.viewTransition.finished.catch(noop).then(function () { back.remove(); });
        event.viewTransition.types.add(plan.sheet === 'old' ? 'book-turn-old' : 'book-turn-new');
        event.viewTransition.ready
            .then(function () {
                animateTurn(plan, null, turn.from);
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

    function show() {
        main.style.setProperty('--book-scroll', spread * main.clientWidth + 'px');
        main.scrollLeft = spread * main.clientWidth;
        var current = document.querySelector('.page-counter-current-page');
        var total = document.querySelector('.page-counter-total');
        // eXe only prints its page counter with "Add pagination"; the menu always knows the section.
        var section = current ? parseInt(current.textContent, 10) : pageIndex(location.href) + 1;
        var sections = total ? parseInt(total.textContent, 10) : document.querySelectorAll('#siteNav a[href]').length;
        var first = spread * columns + 1;
        var prefix = section ? section + '·' : '';
        var last = spread === spreads - 1;
        parts.folioLeft.textContent = prefix + first;
        parts.folioRight.textContent = columns > 1 ? prefix + (first + 1) : prefix + first;
        parts.folioRight.hidden = columns > 1 && last && rightEmpty;
        parts.end.hidden = !(last && rightEmpty);
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
        // Activities restyle themselves at any time; measure once the held page is let go.
        if (dragging) {
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

    function spreadOf(node) {
        var style = getComputedStyle(main);
        var left = parseFloat(style.paddingLeft) || 0;
        var x = node.getBoundingClientRect().left - main.getBoundingClientRect().left + main.scrollLeft - left;
        return Math.min(spreads - 1, Math.max(0, Math.floor((x + 1) / main.clientWidth)));
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
        var forward = target > spread;
        var update = function () {
            var back = book.querySelector('.book-sheet-back');
            if (back) back.remove();
            if (gesture && gesture.cancelled) spread = gesture.source;
            // The next document is not here yet: a held sheet turns onto blank paper.
            else if (outside) book.classList.add('book-blank');
            else spread = target;
            show();
        };
        if (!document.startViewTransition || reducedMotion()) {
            update();
            return;
        }
        var plan = gesture ? gesture.plan : turnPlan(forward, columns, main.clientWidth, main.clientHeight);
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
        running = transition;
        transition.ready
            .then(function () {
                if (!gesture || !gesture.cancelled) animateTurn(plan, gesture);
            })
            .catch(function () {
                if (gesture) gesture.cancel();
            });
        transition.finished
            .catch(noop)
            .then(function () {
                if (running === transition) running = null;
                if (gesture && dragging === gesture) gesture.cancel();
            });
    }

    /* A held sheet. Pointer drags and trackpad swipes move it the same way: the held
     * point stays under the hand. Snapshots may take a frame to become ready, so the
     * gesture keeps the latest point and release decision for the turn to pick up.
     * grab: height where the outer edge is held; null for the bottom corner.
     * corner: the button that curls when there is no view transition to show the fold.
     */
    function hold(direction, grab, x, y, corner) {
        if (running || dragging) return null;
        var source = spread;
        var target = source + direction;
        var outside = target < 0 || target > spreads - 1;
        var href = outside ? neighbour(direction < 0 ? 'left' : 'right') : null;
        if (outside && !href) return null;
        var plan = turnPlan(direction > 0, columns, main.clientWidth, main.clientHeight, grab);
        var rest = pointAt(plan, 0, 0);
        var gesture = {
            direction: direction, source: source, plan: plan, x: x, y: y, point: rest,
            progress: 0, speed: 0, time: performance.now(), moved: false, released: false,
            interactive: !!document.startViewTransition && !reducedMotion(),
        };
        var cleanup = function () {
            if (dragging === gesture) dragging = null;
            book.classList.remove('book-blank');
            show();
            root.classList.remove('book-dragging');
            corner.style.removeProperty('--book-curl');
            if (gesture.end) gesture.end();
            if (deferred) {
                deferred = false;
                relayout();
            }
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
            gesture.speed = gesture.moved ? (progress - gesture.progress) * 2 * plan.width / Math.max(8, now - gesture.time) : 0;
            gesture.time = now;
            gesture.point = point;
            gesture.progress = progress;
            if (!gesture.moved) {
                gesture.moved = true;
                root.classList.add('book-dragging');
                if (gesture.interactive) turnTo(target, gesture);
            }
            if (gesture.paint) gesture.paint(point);
            // Without view transitions the destination cannot be shown: lift the corner instead.
            if (!gesture.interactive && !reducedMotion()) corner.style.setProperty('--book-curl', 30 + progress * 90 + 'px');
        };
        // A flick turns the page however little it was pulled; a held stop decides by distance.
        gesture.release = function () {
            if (gesture.released) return;
            var speed = performance.now() - gesture.time > 100 ? 0 : gesture.speed;
            gesture.released = true;
            gesture.commit = gesture.moved && (speed > 0.4 || (speed > -0.4 && gesture.progress >= 0.3));
            gesture.finish();
        };
        gesture.cancel = function () {
            gesture.released = true;
            gesture.cancelled = true;
            gesture.commit = false;
            if (gesture.interactive && gesture.moved) {
                spread = source;
                if (running) skip(running);
            }
            if (gesture.stop) gesture.stop();
            cleanup();
        };
        gesture.finish = function () {
            if (!gesture.moved) {
                cleanup();
            } else if (!gesture.interactive) {
                cleanup();
                if (gesture.commit) turnTo(target);
            } else if (!gesture.settle) {
                /* Picked up by animateTurn once the snapshots are ready. */
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

    /* Pointer capture belongs only to the corner buttons, never to an iDevice. */
    // An outer-edge strip passes the corner it lifts at a section boundary.
    function bindCorner(button, direction, corner) {
        var edge = !!corner;
        corner = corner || button;
        var suppressClick = false;
        button.addEventListener('click', function (event) {
            if (suppressClick && event.detail) { suppressClick = false; return; }
            turnTo(spread + direction);
        });
        button.addEventListener('pointerdown', function (event) {
            if (!event.isPrimary || event.button !== 0) return;
            suppressClick = false;
            var grab = edge ? Math.max(0, Math.min(main.clientHeight, event.clientY - main.getBoundingClientRect().top)) : null;
            var gesture = hold(direction, grab, event.clientX, event.clientY, corner);
            if (!gesture) return;
            gesture.id = event.pointerId;
            gesture.end = function () {
                if (button.hasPointerCapture(gesture.id)) button.releasePointerCapture(gesture.id);
            };
            button.setPointerCapture(event.pointerId);
        });
        button.addEventListener('pointermove', function (event) {
            var gesture = dragging;
            if (!gesture || gesture.id !== event.pointerId) return;
            gesture.move(event.clientX, event.clientY);
            if (gesture.moved) suppressClick = true;
        });
        button.addEventListener('pointerup', function (event) {
            if (dragging && dragging.id === event.pointerId) dragging.release();
        });
        button.addEventListener('pointercancel', function () { if (dragging) dragging.cancel(); });
        button.addEventListener('lostpointercapture', function () {
            if (dragging && !dragging.released) dragging.cancel();
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

        sentinel = element('span', 'book-end-of-text');
        sentinel.setAttribute('aria-hidden', 'true');
        main.append(sentinel, parts.headLeft, parts.headRight, parts.folioLeft, parts.folioRight, parts.end);
        book.append(parts.prevEdge, parts.nextEdge, parts.prev, parts.next);
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
            if (main.scrollLeft === spread * main.clientWidth) return;
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
                    var grab = Math.max(0, Math.min(main.clientHeight, event.clientY - top));
                    // false until the wheel is quiet: a swipe that could not turn is not retried by its momentum.
                    swipe = hold(direction, grab, 0, 0, direction > 0 ? parts.next : parts.prev) || false;
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
                if (target === main || (target.closest && target.closest('.book-head, .book-folio, .book-end'))) continue;
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
