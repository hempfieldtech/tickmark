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
  window.tickmarkTheme = {
    get: pref,
    set(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} apply(); },
  };
})();
