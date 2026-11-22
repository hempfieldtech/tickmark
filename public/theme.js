// Applies the saved theme before the page paints (loaded as a blocking script in <head>).
// The choice is per device: it lives in localStorage, outside any signed-in user's keys.
(() => {
  const KEY = 'tickmark:theme';
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  const pref = () => { try { return JSON.parse(localStorage.getItem(KEY)) || 'system'; } catch { return 'system'; } };
  function apply() {
    const p = pref();
    root.dataset.themePref = p;
    root.dataset.theme = p === 'system' ? (dark.matches ? 'dark' : 'light') : p;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && document.body) meta.content = getComputedStyle(document.body).backgroundColor;
  }
  apply();
  dark.addEventListener('change', apply);
  addEventListener('storage', (e) => { if (e.key === KEY) apply(); }); // other tabs
  addEventListener('DOMContentLoaded', apply);                     // sets theme-color once styles exist
  // Custom CSS (Settings → Appearance), cached on this device so it applies before the page paints.
  // Open Tickmark with ?nocss to skip it, should a style ever make the page unusable.
  const CSS_KEY = 'tickmark:customCss';
  const noCss = /[?&]nocss\b/.test(location.search);
  const style = document.createElement('style');
  style.id = 'custom-css';
  function setCss(css) {
    style.textContent = noCss ? '' : css || '';
    if (!style.isConnected) (document.head || document.documentElement).append(style);
  }
  try { setCss(JSON.parse(localStorage.getItem(CSS_KEY)) || ''); } catch { setCss(''); }
  addEventListener('DOMContentLoaded', () => document.head.append(style)); // last in <head>, so it wins ties
  window.tickmarkCss = {
    disabled: noCss,
    /** Show `css` now; `save` also caches it for the next page load. */
    apply(css, { save = true } = {}) {
      setCss(css);
      if (save) try { localStorage.setItem(CSS_KEY, JSON.stringify(css || '')); } catch {}
    },
  };
  window.tickmarkTheme = {
    get: pref,
    set(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} apply(); },
  };
})();
