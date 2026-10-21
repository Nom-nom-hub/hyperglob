/* hyperglob documentation site — progressive enhancement.
   Everything here is optional: the site is fully readable without JS. */

(function () {
  'use strict';

  /* ---------------------------------------------------------- theme */
  var STORAGE_KEY = 'hyperglob-theme';
  var root = document.documentElement;

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    try {
      if (theme === 'auto') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {
      /* storage unavailable (private mode) — the theme still applies */
    }
  }

  function readTheme() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (e) { /* ignore */ }
    return 'auto';
  }

  applyTheme(readTheme());

  var toggle = document.querySelector('[data-theme-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var current = root.getAttribute('data-theme') || 'auto';
      var isDark =
        current === 'dark' ||
        (current === 'auto' &&
          window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      applyTheme(isDark ? 'light' : 'dark');
    });
  }

  /* ---------------------------------------------------------- copy */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for insecure contexts and older browsers.
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  function wireCopyButton(btn) {
    var block = btn.closest('.code-block') || btn.closest('.install');
    var source = block ? block.querySelector('code') : null;
    if (!source) return;
    btn.textContent = 'Copy';
    btn.addEventListener('click', function () {
      copyText(source.textContent).then(
        function () {
          btn.textContent = 'Copied';
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 1600);
        },
        function () {
          btn.textContent = 'Failed';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
        }
      );
    });
  }

  var copyButtons = document.querySelectorAll('[data-copy]');
  for (var i = 0; i < copyButtons.length; i++) {
    wireCopyButton(copyButtons[i]);
  }

  /* ------------------------------------------------- table of contents */
  var toc = document.querySelector('.toc');
  if (toc) {
    var links = toc.querySelectorAll('a');
    var targets = [];
    for (var j = 0; j < links.length; j++) {
      var id = links[j].getAttribute('href');
      if (!id || id.charAt(0) !== '#') continue;
      var el = document.getElementById(id.slice(1));
      if (el) targets.push({ link: links[j], el: el });
    }

    if (targets.length && 'IntersectionObserver' in window) {
      var visible = new Set();

      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) visible.add(entry.target);
            else visible.delete(entry.target);
          });
          // Highlight the topmost section currently in view.
          var active = null;
          for (var k = 0; k < targets.length; k++) {
            if (visible.has(targets[k].el)) {
              active = targets[k];
              break;
            }
          }
          for (var m = 0; m < targets.length; m++) {
            targets[m].link.style.color = '';
            targets[m].link.style.fontWeight = '';
          }
          if (active) {
            active.link.style.color = 'var(--accent)';
            active.link.style.fontWeight = '600';
          }
        },
        { rootMargin: '-72px 0px -70% 0px', threshold: 0 }
      );

      for (var t = 0; t < targets.length; t++) observer.observe(targets[t].el);
    }
  }
})();
