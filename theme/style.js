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
     * A sheet of width W hinged on the spine x0, lifted by its bottom outer corner C.
     * The corner travels in an arc to the far side of the spine; the paper folds along
     * the perpendicular bisector of C and the corner, and the folded part, reflected
     * across that line, is the back of the sheet (the flap).
     */
    function foldFrames(x0, width, dir, height) {
        var sheet = dir > 0 ? rect(x0, x0 + width, height) : rect(x0 - width, x0, height);
        var other = dir > 0 ? rect(x0 - width, x0, height) : rect(x0, x0 + width, height);
        var corner = { x: x0 + dir * width, y: height };
        var end = { x: x0 - dir * width, y: height };
        var lift = Math.min(width, height) * 0.2;
        var frames = { sheet: [], under: [], flap: [] };
        for (var i = 0; i <= FRAMES; i++) {
            var t = i / FRAMES;
            var e = (1 - Math.cos(Math.PI * t)) / 2;
            var late = t >= 0.85;
            var to = { x: corner.x + (end.x - corner.x) * e, y: height - lift * Math.sin(Math.PI * e) };
            var dx = to.x - corner.x;
            var dy = to.y - corner.y;
            var length = Math.hypot(dx, dy);
            var shade = { offset: t, filter: 'brightness(' + (0.82 + 0.18 * e).toFixed(3) + ')' };
            if (length < 0.5) {
                frames.sheet.push({ offset: t, clipPath: path([sheet, other]) });
                frames.under.push(Object.assign({ clipPath: path([]) }, shade));
                frames.flap.push({ offset: t, clipPath: 'polygon(0 0, 0 0, 0 0)', transform: 'matrix(1, 0, 0, 1, 0, 0)', opacity: 1 });
                continue;
            }
            var n = { x: dx / length, y: dy / length };
            var middle = { x: (corner.x + to.x) / 2, y: (corner.y + to.y) / 2 };
            var keep = clip(sheet, middle, n);
            var fold = clip(sheet, middle, { x: -n.x, y: -n.y });
            // Reflection across the fold: X' = X - 2((X - M) · n) n
            var d = 2 * (middle.x * n.x + middle.y * n.y);
            var matrix = [1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.y, 1 - 2 * n.y * n.y, d * n.x, d * n.y];
            frames.sheet.push({ offset: t, clipPath: path(late ? [keep] : [keep, other]) });
            frames.under.push(Object.assign({ clipPath: path(late ? [fold, other] : [fold]) }, shade));
            frames.flap.push({
                offset: t,
                clipPath: fold.length > 2 ? 'polygon(' + points(fold) + ')' : 'polygon(0 0, 0 0, 0 0)',
                transform:
                    'matrix(' +
                    matrix
                        .map(function (v) {
                            return v.toFixed(4);
                        })
                        .join(', ') +
                    ')',
                // The sheet lies down on the other page and becomes it.
                opacity: late ? (1 - t) / 0.15 : 1,
            });
        }
        return frames;
    }

    /*
     * Two pages: going forward the right-hand sheet turns to the left, going back the
     * left-hand sheet turns to the right; the outgoing page is the sheet. One page:
     * going back, the previous page comes in from the left, so the incoming page is
     * the sheet and the turn plays backwards.
     */
    function turnPlan(forward, cols, width, height) {
        if (cols > 1) {
            return {
                sheet: 'old',
                under: 'new',
                reverse: false,
                frames: foldFrames(width / 2, width / 2, forward ? 1 : -1, height),
            };
        }
        return {
            sheet: forward ? 'old' : 'new',
            under: forward ? 'new' : 'old',
            reverse: !forward,
            frames: foldFrames(0, width, 1, height),
        };
    }

    function duration() {
        var value = getComputedStyle(root).getPropertyValue('--book-turn').trim();
        var number = parseFloat(value);
        if (!number) return 700;
        return /ms$/.test(value) ? number : number * 1000;
    }

    function animateTurn(plan) {
        var timing = { duration: duration(), easing: 'linear', fill: 'both', direction: plan.reverse ? 'reverse' : 'normal' };
        var run = function (keyframes, pseudo) {
            root.animate(keyframes, Object.assign({ pseudoElement: pseudo }, timing));
        };
        run(plan.frames.sheet, '::view-transition-' + plan.sheet + '(book-page)');
        run(plan.frames.under, '::view-transition-' + plan.under + '(book-page)');
        run(plan.frames.flap, '::view-transition-old(book-sheet-back)');
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
        book.append(sheetBack());
    });

    window.addEventListener('pagereveal', function (event) {
        // A page restored from the back/forward cache still holds the back of the sheet.
        var backs = document.querySelectorAll('.book-sheet-back');
        for (var i = 0; i < backs.length; i++) backs[i].remove();
        if (!event.viewTransition) return;
        var turn = take(TURN_KEY);
        if (!turn || !turn.width) {
            skip(event.viewTransition);
            return;
        }
        var plan = turnPlan(turn.forward, turn.columns, turn.width, turn.height);
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
        var section = current ? parseInt(current.textContent, 10) : 0;
        var sections = total ? parseInt(total.textContent, 10) : 0;
        var first = spread * columns + 1;
        var prefix = section ? section + '·' : '';
        var last = spread === spreads - 1;
        parts.folioLeft.textContent = prefix + first;
        parts.folioRight.textContent = columns > 1 ? prefix + (first + 1) : prefix + first;
        parts.folioRight.hidden = columns > 1 && last && rightEmpty;
        parts.end.hidden = !(last && rightEmpty);
        parts.prev.hidden = spread === 0 && !neighbour('left');
        parts.next.hidden = last && !neighbour('right');
        var read = sections ? (section - 1 + (spread + 1) / spreads) / sections : (spread + 1) / spreads;
        book.style.setProperty('--book-read', Math.min(1, Math.max(0, read)).toFixed(3));
    }

    function layout() {
        scheduled = false;
        if (!main) return;
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

    function turnTo(target) {
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
            spread = target;
            show();
        };
        if (!document.startViewTransition || reducedMotion()) {
            update();
            return;
        }
        if (running) skip(running);
        var plan = turnPlan(forward, columns, main.clientWidth, main.clientHeight);
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
                animateTurn(plan);
            })
            .catch(function () {
                /* Skipped: the new page is already shown. */
            });
        transition.finished
            .catch(noop)
            .then(function () {
                if (running === transition) running = null;
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
        parts.prev.addEventListener('click', function () {
            turnTo(spread - 1);
        });
        parts.next.addEventListener('click', function () {
            turnTo(spread + 1);
        });

        sentinel = element('span', 'book-end-of-text');
        sentinel.setAttribute('aria-hidden', 'true');
        main.append(sentinel, parts.headLeft, parts.headRight, parts.folioLeft, parts.folioRight, parts.end);
        book.append(parts.prev, parts.next);
    }

    function listen() {
        document.addEventListener('keydown', function (event) {
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
        window.addEventListener('resize', relayout);
        if (document.fonts) document.fonts.ready.then(relayout);
    }

    function init() {
        addOpenLink();
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

    /* ---------- "Edit with eXeLearning" link of the published example ---------- */

    function addOpenLink() {
        if (!document.querySelector('.exe-export') || document.querySelector('.exe-open-exelearning')) return;
        if (window.self !== window.top) return;
        var script = document.querySelector('script[src$="theme/style.js"]');
        var link = element('a', 'exe-open-exelearning');
        link.href = 'https://static.exelearning.dev/?url=https://github-proxy.exelearning.dev/?repo=ateeducacion/exelearning-style-book&branch=main';
        link.target = '_blank';
        link.rel = 'noopener';
        var logo = element('img', 'exe-open-logo');
        logo.alt = '';
        logo.src = new URL('icons/exe-logo.svg', script ? script.src : location.href).href;
        link.append(logo, element('span', '', 'Edit with eXeLearning'));
        link.setAttribute('aria-label', 'Abrir este recurso en eXeLearning');
        var close = element('button', 'exe-open-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', 'Ocultar enlace de eXeLearning');
        close.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            link.remove();
        });
        link.append(close);
        document.body.append(link);
    }

    // After eXeLearning's own ready handlers, which build the search form.
    if (window.jQuery) window.jQuery(init);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
