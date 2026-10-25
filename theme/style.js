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
     * Independent paper geometry: the perpendicular bisector of the resting and
     * lifted corner is the fold. A narrow, opaque band describes the curved back;
     * the part already laid down reveals the destination snapshot. The band gets
     * narrower as the paper flattens, rather than fading a whole blank sheet out.
     * No activity DOM is copied: both faces remain browser-owned snapshots.
     */
    function foldAt(plan, progress, lift) {
        var t = plan.reverse ? 1 - progress : progress;
        var width = plan.width;
        var height = plan.height;
        var dir = plan.dir;
        var x0 = plan.spine;
        var sheet = dir > 0 ? rect(x0, x0 + width, height) : rect(x0 - width, x0, height);
        var other = plan.columns > 1 ? (dir > 0 ? rect(0, x0, height) : rect(x0, 2 * width, height)) : [];
        var corner = { x: x0 + dir * width, y: plan.grab };
        var to = { x: corner.x - dir * 2 * width * t, y: plan.grab - lift * Math.sin(Math.PI * t) };
        var dx = to.x - corner.x;
        var dy = to.y - corner.y;
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
        var middle = { x: (corner.x + to.x) / 2, y: (corner.y + to.y) / 2 };
        var keep = clip(sheet, middle, n);
        var folded = clip(sheet, middle, { x: -n.x, y: -n.y });
        var reflected = folded.map(function (p) {
            var d = 2 * ((p.x - middle.x) * n.x + (p.y - middle.y) * n.y);
            return { x: p.x - d * n.x, y: p.y - d * n.y };
        });
        // A sheet pulled level from its edge still bends as much as a lifted corner.
        var bend = plan.edge ? Math.max(Math.abs(lift), plan.bend) : lift;
        var curl = Math.max(0.01, Math.min(width * 0.24, bend * 0.65) * Math.sin(Math.PI * t));
        var edge = { x: middle.x + n.x * curl, y: middle.y + n.y * curl };
        var band = clip(reflected, edge, { x: -n.x, y: -n.y });
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
        var resting = clip(other, to, { x: -dir, y: 0 });
        var landed = clip(other, to, { x: dir, y: 0 });
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

    function animateTurn(plan, gesture) {
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
        var paint = function (progress, lift) {
            var frame = foldAt(plan, progress, lift);
            Object.keys(animations).forEach(function (key) {
                animations[key].effect.setKeyframes([frame[key], frame[key]]);
                animations[key].currentTime = 0;
            });
        };
        var settle = function (from, to, lift, done) {
            var frames = { sheet: [], under: [], flap: [], shadow: [] };
            for (var i = 0; i <= FRAMES; i++) {
                var ratio = i / FRAMES;
                var frame = foldAt(plan, from + (to - from) * ratio, lift + (plan.lift - lift) * ratio);
                Object.keys(frames).forEach(function (key) { frames[key].push(frame[key]); });
            }
            Object.keys(animations).forEach(function (key) {
                var animation = animations[key];
                animation.effect.setKeyframes(frames[key]);
                animation.effect.updateTiming({ duration: Math.max(140, duration() * Math.abs(to - from)), easing: 'cubic-bezier(.3, 0, .2, 1)' });
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
            paint(gesture.progress, gesture.lift);
            if (gesture.released) gesture.finish();
        } else settle(0, 1, plan.lift);
    }

    function sheetBack() {
        var back = element('div', 'book-sheet-back');
        back.setAttribute('aria-hidden', 'true');
        return back;
    }

    /* ---------- Turning between documents ---------- */

    // The outgoing page knows the table of contents, so it decides the direction.
    window.addEventListener('pageswap', function (event) {
        if (!event.viewTransition || !event.activation || !main) return;
        var from = pageIndex(location.href);
        var to = pageIndex(event.activation.entry.url);
        if (from < 0 || to < 0 || from === to) {
            skip(event.viewTransition);
            return;
        }
        store(TURN_KEY, { forward: to > from, columns: columns, width: main.clientWidth, height: main.clientHeight });
    });

    window.addEventListener('pagereveal', function (event) {
        // A page left mid-turn may come back from the back/forward cache with its sheet.
        var backs = document.querySelectorAll('.book-sheet-back');
        for (var i = 0; i < backs.length; i++) backs[i].remove();
        if (!event.viewTransition) return;
        var turn = take(TURN_KEY);
        // This page may reveal before init(), so find the book here.
        var target = document.querySelector('.exe-web-site .exe-content');
        if (!turn || !turn.width || !target) {
            skip(event.viewTransition);
            return;
        }
        var plan = turnPlan(turn.forward, turn.columns, turn.width, turn.height);
        // The outgoing page stays on screen until this one is ready, so the back of the
        // sheet is captured here, where the transition hides the live page.
        plan.back = 'new';
        var back = sheetBack();
        target.append(back);
        event.viewTransition.finished.catch(noop).then(function () { back.remove(); });
        event.viewTransition.types.add(plan.sheet === 'old' ? 'book-turn-old' : 'book-turn-new');
        event.viewTransition.ready
            .then(function () {
                animateTurn(plan);
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
        if (target < 0) {
            var previous = neighbour('left');
            if (previous) leave(previous, true);
            return;
        }
        if (target > spreads - 1) {
            var next = neighbour('right');
            if (next) leave(next, false);
            return;
        }
        if (target === spread) return;
        var forward = target > spread;
        var update = function () {
            var back = book.querySelector('.book-sheet-back');
            if (back) back.remove();
            spread = gesture && gesture.cancelled ? gesture.source : target;
            show();
        };
        if (!document.startViewTransition || reducedMotion()) {
            update();
            return;
        }
        var plan = turnPlan(forward, columns, main.clientWidth, main.clientHeight, gesture && gesture.grab);
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

    /* Pointer capture belongs only to the corner buttons, never to an iDevice.
     * Snapshots may take a frame to become ready; the gesture keeps the latest
     * position and release decision so a quick drag cannot get stuck in between.
     */
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
            if (!event.isPrimary || event.button !== 0 || running || dragging) return;
            suppressClick = false;
            var source = spread;
            var target = source + direction;
            var grab = edge ? Math.max(0, Math.min(main.clientHeight, event.clientY - main.getBoundingClientRect().top)) : null;
            var plan = turnPlan(direction > 0, columns, main.clientWidth, main.clientHeight, grab);
            var gesture = {
                button: button, direction: direction, source: source, id: event.pointerId, x: event.clientX, y: event.clientY,
                grab: grab, base: edge ? 0 : Math.min(main.clientWidth / columns, main.clientHeight) * 0.32,
                progress: 0, lift: plan.lift, moved: false, released: false,
                interactive: target >= 0 && target < spreads && !!document.startViewTransition && !reducedMotion(),
            };
            var cleanup = function () {
                if (dragging === gesture) dragging = null;
                show();
                root.classList.remove('book-dragging');
                corner.style.removeProperty('--book-curl');
                if (button.hasPointerCapture(gesture.id)) button.releasePointerCapture(gesture.id);
                if (deferred) {
                    deferred = false;
                    relayout();
                }
            };
            gesture.cancel = function () {
                gesture.released = true;
                gesture.cancelled = true;
                gesture.commit = false;
                if (gesture.moved) suppressClick = true;
                if (gesture.interactive && gesture.moved) {
                    spread = source;
                    show();
                    if (running) skip(running);
                }
                if (gesture.stop) gesture.stop();
                cleanup();
            };
            gesture.finish = function () {
                if (gesture.interactive && gesture.moved) {
                    if (!gesture.settle) return;
                    gesture.settle(gesture.progress, gesture.commit ? 1 : 0, gesture.lift, function () {
                        if (!gesture.commit) { spread = source; show(); }
                        cleanup();
                    });
                } else {
                    cleanup();
                    if (gesture.moved && gesture.commit) turnTo(target);
                }
            };
            dragging = gesture;
            button.setPointerCapture(event.pointerId);
        });
        button.addEventListener('pointermove', function (event) {
            var gesture = dragging;
            if (!gesture || gesture.id !== event.pointerId || gesture.released) return;
            var distance = direction * (gesture.x - event.clientX);
            if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 8) return;
            gesture.progress = Math.max(0, Math.min(1, distance / main.clientWidth));
            var lift = gesture.base + gesture.y - event.clientY;
            // The held point of an edge stays on the page; a corner always rises a little.
            gesture.lift = edge ? Math.max(gesture.grab - main.clientHeight, Math.min(gesture.grab, lift))
                : Math.max(12, Math.min(main.clientHeight * 0.65, lift));
            if (!gesture.moved) {
                gesture.moved = true;
                suppressClick = true;
                root.classList.add('book-dragging');
                if (gesture.interactive) turnTo(spread + direction, gesture);
            }
            if (gesture.paint) gesture.paint(gesture.progress, gesture.lift);
            // At a document boundary the destination does not exist yet. Lift the
            // corner, then let the browser's navigation transition turn the page.
            if (!gesture.interactive && !reducedMotion()) corner.style.setProperty('--book-curl', 30 + gesture.progress * 90 + 'px');
        });
        button.addEventListener('pointerup', function (event) {
            var gesture = dragging;
            if (!gesture || gesture.id !== event.pointerId || gesture.released) return;
            gesture.released = true;
            gesture.commit = gesture.progress >= 0.35;
            gesture.finish();
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
