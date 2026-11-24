// Applies the saved theme before the page paints (loaded as a blocking script in <head>).
// The choice is per device: it lives in localStorage, outside any signed-in user's keys.
(() => {
  const KEY = 'tickmark:theme';
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  const pref = () => { try { return JSON.parse(localStorage.getItem(KEY)) || 'system'; } catch { return 'system'; } };
  // Custom themes (Settings → Appearance → Theme editor): saved per user, cached here so a custom
  // theme is there before the page paints. Each becomes a [data-theme="my-…"] rule like the built-in ones.
  const THEMES_KEY = 'tickmark:customThemes';
  const VARS = { bg: 'bg', panel: 'panel', surface: 'surface', line: 'line', text: 'text', muted: 'muted', accent: 'accent',
    accentSoft: 'accent-soft', danger: 'danger', warn: 'warn', mark: 'mark', codeBg: 'code-bg' };
  const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : null);
  const themeCss = (list) => (Array.isArray(list) ? list : []).filter((t) => /^(my-[a-z0-9]{4,16}|__draft)$/.test(t?.id || ''))
    .map((t) => `[data-theme="${t.id}"] { ${Object.entries(VARS).map(([k, v]) => hex(t.colors?.[k]) ? `--${v}: ${t.colors[k]};` : '').join(' ')} ` +
      `color-scheme: ${t.dark ? 'dark' : 'light'}; }`).join('\n');
  let customThemes = [];
  const themeStyle = document.createElement('style');
  themeStyle.id = 'custom-themes';
  function setThemes(list, draft) {
    customThemes = Array.isArray(list) ? list : [];
    themeStyle.textContent = themeCss(draft ? [...customThemes, { ...draft, id: '__draft' }] : customThemes);
    if (!themeStyle.isConnected) (document.head || document.documentElement).append(themeStyle);
  }
  try { setThemes(JSON.parse(localStorage.getItem(THEMES_KEY)) || []); } catch { setThemes([]); }
  // After the stylesheet (which loads later in <head>), so these rules win ties with its :root defaults.
  addEventListener('DOMContentLoaded', () => document.head.append(themeStyle));
  window.tickmarkThemes = {
    list: () => customThemes,
    /** Use `list` now; `save` also caches it for the next page load. `draft` previews an unsaved theme as "__draft". */
    apply(list, { save = true, draft = null } = {}) {
      setThemes(list, draft);
      if (save) try { localStorage.setItem(THEMES_KEY, JSON.stringify(customThemes)); } catch {}
      apply();
    },
  };
  function apply() {
    let p = pref();
    if (/^my-/.test(p) && !customThemes.some((t) => t.id === p)) p = 'system'; // that custom theme is gone
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
