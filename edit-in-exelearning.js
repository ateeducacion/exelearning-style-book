/* "Edit with eXeLearning" link of the published example. Not part of the style:
   package.py adds it to the example's HTML only, so exported resources never carry it. */
(function () {
    if (document.querySelector('.exe-open-exelearning')) return;
    var style = document.createElement('style');
    style.textContent = '.exe-open-exelearning { position: fixed; z-index: 40; left: 16px; top: 4px; padding: 7px 12px; display: flex; align-items: center; gap: 7px; border-radius: 4px; background: var(--book-paper); color: var(--book-ink) !important; border: 1px solid var(--book-accent); box-shadow: 0 6px 16px -6px #3b2a1a66; font: bold 13px/1.2 Helvetica, Arial, sans-serif; text-decoration: none !important; }'
        + '.exe-open-exelearning svg { width: 20px; height: 20px; }'
        + '.exe-open-exelearning:focus, .exe-open-exelearning:hover { background: #f3ecdd; outline: 2px solid var(--book-accent); }'
        + '.exe-open-close { position: absolute; right: -9px; top: -9px; width: 22px; height: 22px; padding: 0; border: 1px solid var(--book-accent); border-radius: 50%; background: var(--book-paper); color: var(--book-ink); font: bold 14px/19px Helvetica, Arial, sans-serif; cursor: pointer; }'
        + '@media (max-width: 899.98px) { .exe-open-exelearning { display: none; } }';
    var link = document.createElement('a');
    link.className = 'exe-open-exelearning';
    link.href = 'https://static.exelearning.dev/?url=https://github-proxy.exelearning.dev/?repo=ateeducacion/exelearning-style-book&branch=main';
    link.target = '_blank';
    link.rel = 'noopener';
    link.setAttribute('aria-label', 'Abrir este recurso en eXeLearning');
    link.innerHTML = '<svg viewBox="0 -0.519 60.17152 60.17152" aria-hidden="true"><path transform="translate(-109.80208,-121.17917)" fill="#26ddc7" d="m 120.63912,121.17916 c 2.50296,0 5.17684,0.9102 8.02111,2.7306 2.78765,1.7635 6.62755,4.89233 11.5197,9.38644 8.4193,-7.05406 12.91034,-8.64301 17.23363,-8.64301 2.78765,0 5.17684,0.76798 7.16783,2.30394 3.66792,2.80477 4.27963,9.21022 1.71,13.42157 -2.04787,3.35637 -4.72175,6.96873 -8.02111,10.83701 7.50914,8.53308 11.70332,14.673 11.70332,18.88279 0,3.01492 -0.93874,5.31892 -2.81596,6.91171 -1.93411,1.59279 -4.35187,2.38919 -7.25303,2.38919 -4.38044,0 -11.24849,-3.3237 -19.72468,-10.43464 -4.83526,4.2664 -8.64685,7.22471 -11.43424,8.87439 -2.84453,1.64967 -5.54672,2.47465 -8.10657,2.47465 -3.41323,0 -6.0585,-1.1094 -7.93578,-3.32793 -1.93418,-2.27568 -2.90126,-4.9493 -2.90126,-8.02111 0,-1.99126 0.28443,-3.72613 0.85331,-5.20541 0.56888,-1.47903 1.62129,-3.1287 3.15725,-4.94904 1.53596,-1.87748 3.98213,-4.46563 7.33845,-7.76525 -3.24254,-3.29936 -5.63181,-5.94471 -7.1678,-7.93576 -1.59284,-2.04795 -2.67369,-3.83992 -3.24257,-5.37588 -0.62577,-1.53596 -0.93864,-3.24257 -0.93864,-5.11987 0,-1.99107 0.42664,-3.8399 1.27995,-5.54651 0.85334,-1.76353 2.10484,-3.18572 3.7546,-4.26658 1.64973,-1.08087 3.58391,-1.6213 5.80249,-1.6213 z"/></svg><span>Edit with eXeLearning</span>';
    var close = document.createElement('button');
    close.className = 'exe-open-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Ocultar enlace de eXeLearning');
    close.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        link.remove();
    });
    link.append(close);
    document.head.append(style);
    document.body.append(link);
})();
