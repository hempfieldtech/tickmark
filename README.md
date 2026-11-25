# Tickmark

A self-hosted markdown notes PWA in the spirit of Obsidian, where tagged checklist items sync **both ways** with CalDAV task lists (Nextcloud, Radicale, Baïkal, Fastmail, iCloud, …).

- Notes are plain `.md` files in a folder (the vault). Edit them here or with any other tool.
- A SQLite index (`data/index.sqlite`) handles search, backlinks and sync state. You can delete it at any time and it will be rebuilt.
- Several CalDAV accounts at once, each fed by its own tags. Several users, each with their own notes, signing in with a password or SSO (OpenID Connect).
- No dependencies: Node ≥ 22.13 (uses the built-in `node:sqlite`). `marked` is vendored in `public/vendor/`.

## Run

```sh
node server/index.js                      # http://127.0.0.1:8087, vault in ./vault
TICKMARK_VAULT=~/Documents/Notes PORT=8087 node server/index.js
```

| Env var | Default | |
|---|---|---|
| `TICKMARK_VAULT` | `./vault` | folder of `.md` files |
| `TICKMARK_DATA` | `./data` | settings (`config.json`, holds CalDAV passwords, mode 600, encrypted when SSO is on), `index.sqlite`, users and sessions |
| `PORT` / `HOST` | `8087` / `127.0.0.1` | |
| `TICKMARK_USER` / `TICKMARK_PASS` | unset | HTTP Basic auth for single-user mode. Ignored once you add users. |

Sign-in and SSO settings are under [Users and sign-in](#users-and-sign-in).

To run it as a service, see `contrib/tickmark.service`.

To sync every user's notes right now from the host (scripts, cron), send the server `SIGUSR2`: `kill -USR2 <pid>`, or `docker kill -s USR2 tickmark`. It logs a `sync on signal: …` line per user and `sync on signal: finished` at the end.

### Docker

```sh
mkdir -p vault data                 # create these yourself first, or Docker makes them owned by root
docker compose up -d --build        # http://127.0.0.1:8087, notes in ./vault, settings in ./data
```

A ready-made image is published as `ghcr.io/hempfieldtech/tickmark:latest`, with each release also tagged by version (for example `:0.4.0`). `compose.example.yaml` runs it instead of building (`docker compose -f compose.example.yaml up -d`, or copy it next to your own `vault/` and `data/`); pin a version tag if you want to choose when to upgrade. The image is built for amd64 and arm64 by GitHub Actions (`.github/workflows/docker.yml`): every push to `master` updates `:latest`, and pushing a `v1.2.3` tag publishes `:1.2.3` and `:1.2`, after the tests pass (including sync against a throwaway Radicale). In a fork it pushes to your own `ghcr.io/<you>/tickmark` with the built-in `GITHUB_TOKEN`; the comments at the top of the workflow say what to do if the push is denied.

Edit `compose.yaml` to point `./vault` at an existing notes folder or set your timezone (`TZ`). The container runs as uid 1000 by default; set `UID`/`GID` if your files belong to someone else.

Local settings go in a `.env` file next to `compose.yaml` (git ignores it). Compose reads it, and so does the container. `.env.example` lists every setting with a short explanation; copy it to `.env` and uncomment what you need:

```sh
TICKMARK_BIND=0.0.0.0            # reachable from your network, not just this machine; turn on sign-in first
TICKMARK_OIDC_ISSUER=…           # SSO, see below
```

Without compose:

```sh
docker build -t tickmark .
docker run -d --name tickmark -p 127.0.0.1:8087:8087 -e TZ=Etc/UTC \
  -v "$PWD/vault:/vault" -v "$PWD/data:/data" tickmark
```

Browsers only allow installing a PWA from `localhost` or over HTTPS. To use it from other devices, put it behind HTTPS, e.g. `tailscale serve --bg 8087` or a reverse proxy.

Open **Settings** (gear icon), enter the server URL and credentials, click **Find calendars**, pick a task list and save.

## Several CalDAV accounts

Settings → **+ Add account** connects another server or task list. Each account has its own tags and its own inbox note, and every synced item goes to exactly one account:

1. an item tag on the line (`- [ ] Expense report #work`) decides first;
2. otherwise the innermost heading with a section tag (`## Sprint #job`);
3. otherwise a section tag in the note's frontmatter.

Each tag belongs to one account, and two accounts can't share a task list. Retagging a line moves its todo from one account's list to the other's. If one server is unreachable, the others still sync.

## Users and sign-in

With no users, Tickmark is single-user, as above, and anyone who can reach it can open it. To require sign-in, open Settings → **Users** → *Create admin and turn on sign-in*. It takes effect right away, with no restart, and takes you to the sign-in screen, like everyone else. From then on everyone signs in, and each person gets their own notes (`<vault>/<name>/`), settings and CalDAV accounts (`<data>/users/<name>/`). The first admin takes over the existing notes and settings, which are moved into their folders.

The same from the command line:

```sh
node server/users.js add alex                         # prompts for a password; restart Tickmark afterwards
docker exec -it tickmark node server/users.js add alex   # the same, in Docker (then: docker compose restart)
node server/users.js passwd|remove <name>, or list
node server/users.js sso-off                          # escape hatch: turn off SSO set up in Settings
```

After that, admins add and remove people in Settings → **Users**, and everyone can change their own password in Settings → **Account** (shown to accounts that have a password; **Sign out** is at the bottom of the Settings list). Removing a user leaves their files on disk. Sessions last 30 days; changing a password signs out the user's other devices. Ten wrong passwords from one address lock it out for 15 minutes. Behind a reverse proxy, set `TICKMARK_TRUST_PROXY=true` so that address is the visitor's, not the proxy's.

**Security notes.** The app's pages only run Tickmark's own scripts (a Content-Security-Policy), links in notes can't run code, and requests that change anything must be JSON from Tickmark's own pages, so other websites can't act for you. With no sign-in at all, Tickmark answers only to IP addresses and local names (set `TICKMARK_ALLOWED_HOSTS` for others), so a web page can't reach it through a name of its own. With several users, only admins can connect a CalDAV account to an address inside the network, unless `TICKMARK_ALLOW_PRIVATE_CALDAV=true`; the address is checked when connecting, whichever way it's written (IPv4 inside IPv6 included). A saved CalDAV password is only ever sent to that account's own server: pointing an account at a different server needs the password typed again. Sync intervals are 0 (off) or at least a minute. Public links allow 30 open pages each; removing a link or making it read-only closes the ones open.

`--vault /path` on `users.js add` puts a user's notes somewhere other than `<vault>/<name>`, e.g. an existing Obsidian folder. Vault folders must not overlap.

### SSO (OpenID Connect)

Works with any OIDC provider: Authelia, Authentik, Keycloak, Pocket ID, Zitadel, Google, Entra ID, …. Register Tickmark as a confidential client with the redirect URI `<public URL>/auth/oidc/callback`.

**From Settings → Single sign-on** (admins, once sign-in is on): the pane shows the redirect URI to register. Enter the issuer URL (*Test* checks it), client ID, client secret and who may sign in, then save. It applies immediately. To store the client secret there, first put a master key in `.env`; the secret is kept encrypted with it in `<data>/tickmark.sqlite`, so a copy of the data folder alone can't reveal it:

```sh
echo "TICKMARK_SECRET_KEY=$(openssl rand -base64 32)" >> .env && docker compose up -d
```

The pane won't let you lock yourself out: password sign-in can only be turned off by an admin who has signed in with SSO, and SSO can only be turned off by an admin with a password. Changing the secret in the pane keeps the old one, so encrypted settings are re-keyed instead of lost.

**Or with environment variables**, which take priority over the pane (fields set here show as locked there):

| Env var | |
|---|---|
| `TICKMARK_OIDC_ISSUER` | the provider's issuer URL (its `/.well-known/openid-configuration` must exist) |
| `TICKMARK_OIDC_CLIENT_ID` / `_CLIENT_SECRET` | from the provider (leave the secret out for a public client). The secret also encrypts saved settings, see below. |
| `TICKMARK_OIDC_PREVIOUS_CLIENT_SECRET` | the old secret, while rotating it |
| `TICKMARK_PUBLIC_URL` | the URL people open Tickmark at, e.g. `https://notes.example.com` |
| `TICKMARK_OIDC_ALLOWED_GROUPS` | comma list; only members may sign in |
| `TICKMARK_OIDC_ADMIN_GROUPS` | comma list; admin rights follow membership at each sign-in |
| `TICKMARK_OIDC_SCOPES` | default `openid profile email`; add `groups` if your provider needs it for the groups claim |
| `TICKMARK_OIDC_USERNAME_CLAIM` / `_GROUPS_CLAIM` | default `preferred_username` / `groups` |
| `TICKMARK_OIDC_AUTO_CREATE` | default `true`: the first SSO sign-in creates the user |
| `TICKMARK_OIDC_MATCH_USERNAME` | default `false`; `true` links a first SSO sign-in to an existing password user of the same name. Only turn this on if you control user names at the provider. |
| `TICKMARK_OIDC_LABEL` | button text, default "Sign in with SSO" |
| `TICKMARK_LOCAL_LOGIN` | `false` hides password sign-in, so SSO is the only way in |
| `TICKMARK_SECRET_KEY` | master key for the client secret saved in Settings (not needed if the secret is in `.env`) |

Setting the issuer turns on multi-user mode even with no users. **If neither group setting is set, the first person to sign in becomes admin**, so set `TICKMARK_OIDC_ALLOWED_GROUPS` or `TICKMARK_OIDC_ADMIN_GROUPS` before exposing it. SSO users are matched by the provider's subject ID, never by name, unless you turn on `TICKMARK_OIDC_MATCH_USERNAME`.

**With SSO configured, each user's CalDAV accounts are encrypted on disk** (AES-256-GCM, with a key derived from `TICKMARK_OIDC_CLIENT_SECRET`): server URLs, user names, passwords, task lists and tags. Without SSO they're stored as before, in plain JSON readable only by the Tickmark user. The search index never stores server URLs or user names either way. This protects the data folder on its own (backups, a copied folder, another container mounting it). It doesn't protect against someone who can also read the `.env` on the same machine, since the key comes from there.

- **Rotating the client secret:** set the new one, and put the old one in `TICKMARK_OIDC_PREVIOUS_CLIENT_SECRET` until everyone has signed in once. Each user's settings are re-encrypted with the new secret when their workspace opens. If the old secret is lost, the CalDAV accounts have to be entered again; notes aren't affected.
- **Turning SSO off:** leave `TICKMARK_OIDC_CLIENT_SECRET` set for one start, and settings are decrypted back to plain JSON.
- A public client (no client secret) means no encryption; Tickmark warns about this at startup.

Tickmark uses the authorization-code flow with PKCE and checks the ID token's signature, issuer, audience, expiry and nonce. Signing out ends the Tickmark session, not your session at the provider.

## Demo mode

`TICKMARK_DEMO=true` makes a public try-it-out instance. There's no sign-in: each visitor gets a private sandbox, a copy of the sample notes in `demo/` (or of `TICKMARK_DEMO_SEED`), kept under `TICKMARK_DATA/demo/` and wiped after `TICKMARK_DEMO_IDLE_MINUTES` (default 60) unused. `TICKMARK_DEMO_MAX_SESSIONS` (default 50) caps how many exist at once (the longest-unused one makes room for a new one) and `TICKMARK_DEMO_MAX_MB` (default 5) how much each can hold. CalDAV sync, users, SSO, branding and public links are off, and sandboxes start fresh when the server restarts. Your own vault isn't touched.

## What syncs

```markdown
- [ ] Call dentist #task 📅 2026-11-25      ← item tag
- [ ] Not synced

## Groceries #sync                         ← section tag: every checklist under this heading
- [ ] Oat milk
  - [ ] nested items too
```

A note whose frontmatter `tags:` includes a section tag syncs all of its checklists. You can change the tag names in Settings.

Inline metadata (compatible with the Obsidian Tasks plugin):

| | maps to |
|---|---|
| `📅 2026-11-25`, `due:2026-11-25`, `📅 2026-11-25 14:30` | `DUE` (date, or floating local time) |
| `⏫` / `🔼` / `🔽` (`🔺`, `⏬` also accepted) | `PRIORITY` 1 / 5 / 9 |
| `🔁 every week` and friends, see below | `RRULE` (with `DTSTART` on the due date) |
| `[x]` + `✅ 2026-11-21` | `STATUS:COMPLETED` + `COMPLETED` |
| the rest of the line (other `#tags` included) | `SUMMARY` |

### Recurring tasks

```markdown
- [ ] Water plants #task 🔁 every week 📅 2026-11-24
```

Checking it off moves the line on to the next date (`📅 2026-12-01`) and leaves a completed copy just below it as a record: `- [x] Water plants #task 📅 2026-11-24 ✅ 2026-11-21`. The open line stays linked to the same CalDAV todo, and the completed copy stays in the note only. Completing it in another app does the same: Tickmark moves the todo on and writes the record into the note. That works whether the app ticks the whole todo off, advances the date itself, or completes just that occurrence as an exception.

| Write | Means |
|---|---|
| `every day`, `every 3 days`, `every other week`, `every 2 months`, `every year` | a fixed interval |
| `every weekday`, `every weekend`, `every Monday and Thursday`, `every 2 weeks on Saturday` | particular days of the week |
| `every month on the 15th`, `on the 1st and 15th`, `on the last day`, `on the last Friday`, `on the 2nd Tuesday` | particular days of the month |
| `every year on March 3` | a yearly date |
| `… until 2027-06-01` | stop after that date |
| `… when done` | count from the day you complete it, not from the due date |
| `FREQ=MONTHLY;BYDAY=-1FR` | any raw `RRULE`, e.g. one written by another app |

A rule Tickmark doesn't understand stays in the task's text and isn't treated as recurring. "Every month" from the 31st lands on the last day of shorter months. Without a due date, the next one is set from the day you complete it. When a series ends (`until`, or a `COUNT` that runs out), the task simply stays completed.

On first sync each synced line gets a block id such as `^t3k9x2ab`. That id links the line to its todo, so you can move the line around or into another note. The preview hides the ids.

## How sync works

Sync runs on the server, since the server holds the files. The editor saves when you pause typing for 8 seconds (or leave the note), and sync runs right after that save, so a task is never sent half-written. The app also syncs when the window regains focus, every *N* minutes while open (5 by default), and from the sync button. Notes changed outside Tickmark (another editor, a file sync tool) are synced a few seconds after the change. There's also an optional server-side timer.

- **Three-way, per field.** The last synced state of each task is stored. If a field changed on only one side, that change wins. If the same field changed on both sides, the note wins. Different fields merge, e.g. you rename the task in the note while your phone marks it done.
- **Already done before it ever synced** (e.g. the completed copies recurring tasks leave behind): stays in the note, isn't uploaded.
- **Created elsewhere → the account's inbox note** (`Inbox.md` by default), tagged so it keeps syncing. Old completed todos are not imported. A todo whose description says `From note: Work/Plan.md` (as Tickmark writes them) goes back to that note instead. If the note doesn't exist it's created, along with its folders; a folder or note whose name differs only in case (`work/plan.md`) is the existing one.
- **Deletes propagate** both ways, but only when the other side hasn't changed since the last sync. If it has, the surviving copy is recreated so nothing is lost. Removing the tag from a line counts as deleting it.
- **Deleted tasks can be restored for 30 days.** The **⋯** menu (top right) → **Deleted tasks…** lists the open note's synced tasks that sync deleted (Settings → **Deleted tasks** lists every note's), whether the line was removed from a note or the todo was deleted in a task app, and after any sync that deletes something a notice offers **Review**. Each entry shows the note and the heading it was under, so two tasks with the same name are easy to tell apart. *Restore* puts the line back in its note, under that heading if it still exists (at the end of the heading's own lines, before its subheadings and any closing `---`) (otherwise under a **Restored tasks** heading, in the inbox if the note is gone), and the todo back on the server, the exact copy where Tickmark kept one, so details other apps added survive. A line whose tag you removed, or that moved to another account, isn't counted as deleted and brings no notice. The list lives in the search index, so deleting `index.sqlite` empties it.
- **Remote edits are patched, not replaced.** Properties other clients add (alarms, descriptions, timezones, X- props) are kept.
- **Mass-deletion guard.** If more than half the tasks seem to have disappeared on one side (a server hiccup, or most of a list deleted in a task app), sync stops and asks you to confirm with "Sync anyway". Choosing a different task list in Settings doesn't trigger it: that starts afresh and copies every task to the new list.
- **Cancelling a recurring task ends the series.** Its `🔁` rule is dropped (here, or when it's cancelled in a task app), so it doesn't move on to a next date like a completed one does.
- **Sync history.** Each account's **Sync history** button (Settings → CalDAV accounts) shows its last 30 syncs: when, whether it worked, and every task sent or received with what changed (e.g. `done: not done → done`).
- **Editor vs. sync.** Saves send the version the editor started from. If the file changed on disk meanwhile (sync, another device, another editor), the server does a line-level three-way merge. Real clashes get git-style conflict markers and a banner in the note.

## Editor

Source / split / preview (Ctrl+E cycles). Preview checkboxes are clickable and edit the source line; checking an item stamps `✅ date` and moves it, with its sub-items, under a **Complete** heading at the end of its section, and a cancelled item goes under a **Cancelled** heading after that (reopening moves it back up; Settings → CalDAV accounts turns this off). That happens for items checked in a task app too. Besides `[ ]` and `[x]`, items can be in progress `[/]` (synced as IN-PROCESS) or cancelled `[-]` (synced as CANCELLED; it counts as finished). An item with unchecked sub-items can't be completed or cancelled until they are (synced or not). Tasks live in your notes: there is no separate task list view. `[[wikilinks]]` (clicking a missing one creates the note; renaming or moving a note or folder updates links to it), backlinks, embedded notes (`![[Other note]]` shows it inline, `![[Other note#Heading]]` just that section; its checkboxes work and change the other note, and its headings fold), collapsible headings in the preview and in the editor (see below), `[[` suggestions while typing, #tag search, full-text search, and drag-and-drop in the file tree. To work on several notes or folders at once, Ctrl+click (Cmd+click) them (the open note counts as already picked), or Shift+click to take a run of rows; on a phone, pick **Select** from a row's ⋯ menu and tap the rest. A line above the tree then shows how many are selected, with buttons to move them to a folder, trash them or clear the selection; right-clicking a selected row gives the same, and dragging one moves them all. Esc or **Done** clears the selection.

**HTML and CSS in notes.** Raw HTML and `<style>` blocks render in the preview, cleaned so they can't run code or restyle the app. See [HTML and CSS in notes](#html-and-css-in-notes) for what's allowed and what's removed.

**Live collaboration.** When a note is open in more than one place (another device, another tab, or someone else signed in to the same account), round badges in the top bar show who's there, on which device and which line, and their cursor shows in the editor as a coloured caret with their name (an arrow at the top or bottom edge when it's out of view). Edits then save within about a second instead of waiting for a pause, and theirs merge into yours as they arrive (line by line, so two people changing the same line at once still get conflict markers). It's on in multi-user mode, and in single-user mode for notes with an active public link; public link pages update live as you type, and a 👁 badge counts their viewers. Public links are read-only unless you let them edit (see Public links); someone editing through such a link shows up as a **Guest** badge with their own caret, and sees yours while they edit.

**Task shortcuts.** Typing `:` and a few letters in the editor offers the task markers: `:calendar:` (or `:due:`) puts in `📅` with today's date selected so you can type over it, `:tomorrow:` and `:nextweek:` other dates, `:recur:` `🔁 every `, `:high:` `:medium:` `:low:` (and `:highest:` `:lowest:`) the priorities, `:done:` `✅` with today. Pick one with ↑/↓ and Enter, or type the closing colon.

**Code blocks.** A fenced block with a language (` ```js `, ` ```python `, ` ```bash `, ` ```json `, ` ```css `, ` ```html `, ` ```sql `, ` ```yaml `, ` ```go `, ` ```rust `, ` ```diff ` and about twenty more) gets syntax colours, the language's name on its top edge and an accent colour for that language. Other languages show their name, uncoloured.

**Search.** The sidebar search looks in note names and text. Opening a result goes to the first place the search appears: selected in the editor and marked in the preview.

**Command palette.** Ctrl+Shift+P (or F1) lists everything Tickmark can do by name: note actions, views, settings sections, themes, sync, Vim, line numbers and zen mode, and the notes matching what you type. Commands you used last come first.

**Help.** The **?** button (top right) → **Help** shows this README with its sections as a tree on the left (with a filter), and **Keybindings** lists every shortcut, grouped, with a search (Ctrl+/ opens it too).

**Editor settings.** Settings → **Editor** turns on **Vim mode** (normal, insert, visual and replace modes; motions, operators, text objects, counts, registers including the clipboard, marks, `/` search, `.` repeat and `:w` (save and sync) `:q :s :%s :sort :{line} :e note` — the bottom bar shows the mode and takes `:` commands; Keybindings has the full list), **line numbers** (beside the text, matching wrapped lines, plus the note's line count in the bottom bar) and **zen mode** (just the text: the sidebar and bottom bar go away and the top bar hides until you point at the top edge; Ctrl+Shift+Enter, Esc when Vim mode is off, the top bar's exit button or the palette's "Editor: Leave zen mode" turn it off).

**Folding in the editor.** An arrow beside each heading that has something under it folds its section: the heading stays and the rest becomes one `⋯ 12 lines` line. Ctrl+Shift+[ folds the section the cursor is in and Ctrl+Shift+] opens it; the command palette can fold or open them all, and Vim mode has `za` `zc` `zo` `zM` `zR` (`j`/`k` step over a fold as one line). Clicking the `⋯` line, typing on it, or deleting into it opens the fold rather than changing hidden text, and so does jumping into it (a search result). Folding only changes what the editor shows: the note, saving, sync and collaborators always get the full text, copying a fold copies its lines, and a sync that changes a folded line keeps it folded. Folds are remembered per note on each device.

**The bottom bar** shows the note's words and characters (and, on a desktop with the sidebar hidden, the sync status at its far right), its checklist items by state (to do, in progress, done, cancelled), and **Public link** when the note (or its folder) is shared; click that to manage the link.

**Properties.** The **⋯** menu → **Properties…** opens the note's frontmatter as a form in a panel on the right: change values, add or remove properties, and nothing is written until **Save**. Lists (`tags: [a, b]` or one `- item` per line) are edited comma-separated and keep their style; anything more complicated (nested values) shows as YAML and is kept as written.

**History.** Every note's past versions are kept with git: the **⋯** menu → **History…** lists them, shows what changed between a version and the note now, and can restore it (the current text stays in the history too). Changes are recorded about 30 seconds after you stop editing, including edits made outside Tickmark. The repository lives in the data folder (`history.git`, per user), not in the vault, so a vault that's already a git repo is left alone. It needs `git` on the server; the Docker image includes it.

**Templates.** Notes in a `Templates` folder are templates. Settings → **Templates** lists them and creates, edits, renames and deletes them; the folder itself is hidden from the sidebar, search and the switcher. The **⋯** menu → **Apply template…** opens a search box in the menu and puts the chosen one into the open note (an empty note takes it whole, otherwise it goes in at the cursor), and Settings → Templates → **+ From “note”** saves the open note as one. `{{date}}`, `{{time}}`, `{{datetime}}` and `{{title}}` are filled in when it's applied. Checklist items in templates never sync, so a template can hold `#task` items safely.

**Public links.** A note's **⋯** menu, or a folder's menu in the sidebar, → **Share…** makes a read-only link anyone can open without signing in (a folder link shows every note in it, including ones added later, and `[[links]]` between them work). Ticking **Anyone with the link can edit** lets them change what's shared too: checkboxes work on the page, and **Edit** opens the note's markdown, saved as they type and merged with your edits (they can't create, rename or delete notes). Embedded notes aren't shown on public pages; a notice stands in for them. Links follow renames, stop when the note goes to the trash, and are listed under Settings → **Public links**, where you can stop sharing. Admins also see **Everyone's links** there, grouped by user, and can stop any of them. They're only offered when `TICKMARK_PUBLIC_URL` is a domain name (not an IP address or localhost), and links are built from it. Shared notes show their HTML and CSS like the preview does (cleaned the same way).

**Trash.** Moving a note or folder to the trash puts it in the vault's `.trash` folder. The **Trash** button at the bottom of the sidebar (with a count) lists what's there, puts an item back where it was (beside it, numbered, if that name is taken now), and deletes items, or everything, for good.

**The ⋯ menu** holds only things to do with the open note, A to Z: Apply template, Deleted tasks, History, Move to trash, Properties, Share. Rename a note by clicking its name; sync by clicking the sync status; themes and templates are in Settings. Drag the sidebar's edge to make it wider or narrower (double-click the edge to reset).

**Settings → About** shows the versions of the server and of the app you have open, what the server runs on, and which optional features (public links, note history, sign-in) are available. Below that, **Tasks** lists every checklist item in your notes (templates aside), grouped by note, with its state: filter by to do, in progress, done or cancelled, or type to search; due dates show, overdue ones in red, and ⇅ marks the ones that sync. Click one to open its note at that line.

**Updates.** The server fingerprints the app's files when it starts. An open app (an installed one on a phone especially) checks the fingerprint whenever you come back to it, and reloads into the new version after saving your note, so it never keeps running old code or styles.

Settings → **Appearance** has themes, **Custom theme** for making your own without any CSS, and **custom CSS** (per user, on every device; open Tickmark with `?nocss` to load it without). Custom theme opens a dialog: pick a theme to start from, light or dark, and a colour for the page, sidebar, text, accent and so on (with a colour picker or a hex code); the whole app shows the result as you go, and a readability check warns when text gets hard to read. Cancel puts everything back. Your themes are saved with your settings, so they follow you to every device; they show in the theme list with a ✎ button to edit or delete them. **Make a theme from it…** under Custom CSS (available once your CSS sets theme colours) turns the theme colours your CSS sets (`--accent`, `--bg` and the rest, on `:root`) into a theme, and then offers to take them out of the CSS so they stop overriding every other theme. Settings → Appearance → **Branding** sets the name, logo and favicon everyone sees, including on the sign-in screen and as the installed app (admins only once sign-in is on). Your theme choice and the Editor options (Vim mode, line numbers, zen mode) are saved on the server with your account, so they survive clearing the browser's cache and follow you between devices; a change on one open device shows on the others straight away.

Custom CSS can restyle anything, but the theme colours and fonts all come from these variables on `:root`, so overriding them is usually enough (e.g. `:root { --accent: hotpink; }`). Each theme sets them under `[data-theme="…"]`; to change one theme only, use that selector (`:root[data-theme="dark"] { … }`).

| Variable | What it colours / sets |
|---|---|
| `--bg` | page background, editor and preview |
| `--panel` | sidebar, settings navigation, top bar of shared pages |
| `--surface` | dialogs, menus, cards, checkboxes |
| `--line` | borders and dividers |
| `--text` | main text |
| `--muted` | secondary text: hints, dates, completed items |
| `--accent` | links, buttons, checked boxes, the active item |
| `--accent-soft` | background behind the active item, selected tags |
| `--danger` | delete buttons, errors, overdue dates |
| `--warn` | warnings, "offline" save status |
| `--mark` | search highlights (`<mark>`) |
| `--code-bg` | code blocks and inline code |
| `--hl-kw` `--hl-str` `--hl-num` `--hl-fn` `--hl-type` `--hl-attr` `--hl-com` | code block colours: keywords, strings, numbers and literals, functions, types and decorators, keys/attributes/variables, comments |
| `--radius` | corner rounding (`8px`; Terminal uses `0`) |
| `--sans` | interface and preview font |
| `--mono` | editor and code font |

Useful selectors: `#editor` (the source editor), `.codeblock[data-family="py"]` (code blocks by language), `#preview` / `.md` (rendered notes), `#sidebar`, `#tree`, `.tag`, `.task-cb` (checkboxes), `.done-item`, `.cancelled-item`, `.progress-item`, `.due.overdue`.

### Example CSS

Paste any of these into Settings → Appearance → Custom CSS. They can be combined.

A pink accent, rounder corners, a tinted sidebar, a serif preview and accent-coloured headings:

```css
:root {
  --accent: #d6336c;
  --accent-soft: color-mix(in srgb, #d6336c 15%, transparent);
  --radius: 14px;
}
:root[data-theme="dark"] { --accent: #ff8fb8; }

#sidebar { background: color-mix(in srgb, var(--accent) 6%, var(--panel)); }
#editor  { font-size: 15.5px; line-height: 1.8; }
.md      { font-family: Georgia, "Iowan Old Style", serif; }
.md h1, .md h2 { color: var(--accent); letter-spacing: -0.01em; }
.md blockquote { border-left: 4px solid var(--accent); background: var(--accent-soft); border-radius: 0 var(--radius) var(--radius) 0; }
.md li.done-item { opacity: .55; }
.tag { border-radius: 999px; }
```

A bigger, more spaced-out editor for long writing:

```css
#editor { font-size: 17px; line-height: 1.9; }
.md { font-size: 17px; line-height: 1.75; max-width: 46rem; }
```

Make overdue and finished items stand out more:

```css
.due.overdue { font-weight: 700; text-decoration: underline wavy; }
.md li.done-item { opacity: .45; text-decoration: line-through; }
.md li.cancelled-item { opacity: .35; }
```

A different font everywhere (it must be installed on the device):

```css
:root {
  --sans: "Inter", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, monospace;
}
```

Change only the dark theme, leaving the others alone:

```css
:root[data-theme="dark"] {
  --bg: #11141a;
  --panel: #0c0f14;
  --accent: #7cc4ff;
}
```

Square, flat look:

```css
:root { --radius: 0; }
.tag, .btn { border-radius: 0; }
```

| Key | |
|---|---|
| Ctrl+P / Ctrl+O | quick switcher (type a new name to create a note) |
| Ctrl+Shift+P / F1 | command palette |
| Ctrl+/ | keybindings |
| Ctrl+L | make the line a checklist item; again turns it back into a plain line |
| right-click a checkbox (preview) | set it to to do `[ ]`, in progress `[/]`, done `[x]` or cancelled `[-]` |
| Enter / Tab / Shift+Tab | continue, indent, or outdent lists |
| Ctrl+S, Ctrl+E, Ctrl+\\, Ctrl+Shift+F | save, cycle view, toggle sidebar, search |
| Ctrl+Shift+Enter | zen mode on or off (Esc also leaves it while Vim mode is off) |

### HTML and CSS in notes

A note can hold HTML and its own CSS alongside the markdown. They render in the preview, in embeds and on public pages; the editor still shows the source.

**Markdown inside HTML.** A block that starts with an HTML tag runs until the next blank line, and markdown inside it isn't parsed (that's standard markdown). Leave a blank line after the opening tag and before the closing one to use markdown inside:

```html
<div class="callout">

**Markdown** works here, and so do [[wikilinks]].

</div>
```

Inline tags (`<kbd>`, `<mark>`, `<span style="…">`, `<sub>`, `<sup>`, `<u>`…) work in the middle of a markdown line.

**What renders.** Any ordinary HTML element: `<div>`, `<span>`, `<p>`, headings, `<details>`/`<summary>`, `<table>` and its parts, `<kbd>`, `<mark>`, `<abbr>`, `<figure>`/`<figcaption>`, `<img>`, `<video>`/`<audio>` (with `controls`), `<svg>` drawings, `<br>`, `<hr>`, `<center>`, and so on. Attributes are kept (`class`, `id`, `style`, `title`, `width`, `open`, `colspan`, `data-…`, `aria-…`), apart from the ones listed below.

**What's removed**, so nothing in a note can run code, send data or cover the app:

| Removed | Why |
|---|---|
| `<script>`, `<noscript>`, `<template>` | code |
| `<iframe>`, `<frame>`, `<object>`, `<embed>`, `<portal>` | other pages inside the note (use `![[Note]]` to embed a note) |
| `<form>`, `<input>`, `<button>`, `<select>`, `<textarea>` | forms could post your data elsewhere; use `- [ ]` for checkboxes |
| `<link>`, `<meta>`, `<base>`, `<title>`, `<dialog>` | would change the page itself |
| SVG `<script>`, `<foreignObject>`, `<use>`, `<animate>`, `<set>` | code, or content pulled in from elsewhere |
| `on…` attributes (`onclick`, `onerror`…) | code |
| `href`/`src` (and similar) with a scheme other than `http`, `https`, `mailto`, `tel`, `obsidian` or `tickmark` | `javascript:` and `data:` links; relative links are fine |
| `srcset`, `name`, `formtarget` | can load other images, or confuse the app |
| `for`, `form`, `popovertarget`, `commandfor`, `command`, `accesskey`, `autofocus`, `loading` | could press or focus the app's own controls, or load an image only when CSS shows it |
| an `id` the app itself uses (`editor`, `preview`…) | would confuse the app; any other `id` is kept |

If the cleaned HTML would come out differently when the browser reads it again (a trick some sanitizer bypasses rely on), the note shows as plain text instead. The page's Content-Security-Policy also blocks scripts, as a second wall.

**CSS.** Use `style="…"` on an element, or a `<style>` block anywhere in the note:

```html
<style>
h1 { color: tomato; }
.callout { border-left: 4px solid var(--accent); background: var(--accent-soft); padding: 8px 14px; border-radius: 6px; }
</style>
```

- A `<style>` block styles only its own note: Tickmark wraps it in `@scope (#preview)`, so `body`, `:root` and the app's own parts (sidebar, top bar, settings) are out of reach. `:scope` is the note's container, e.g. `:scope { font-family: Georgia, serif; }`.
- An embedded note (`![[Note]]`) keeps its own CSS: its `<style>` applies only inside the embed, the embedding note's CSS stops at the embed, and the embed doesn't inherit the surrounding paragraph's colour or font.
- `:scope` and `&` work at the start of a selector (`:scope > p`, `& .x`). Rules that put something before them (`body:has(…) :scope`), check the container's neighbours (`:scope:has(+ …)`), or open their own `@scope` are dropped: they could test the app around the note and report it through a `url()`.
- `@media`, `@supports`, `@container` and nested rules work. `@keyframes`, `@font-face` and `@property` work too and apply by name. `@import` is ignored.
- Fixed-position elements (`position: fixed`) stay inside the preview, so a note can't pin something over the app.
- The theme variables ([listed above](#editor), `var(--accent)`, `var(--muted)`, `var(--surface)`…) work, so a note's styles can follow the theme.
- Malformed CSS is dropped rule by rule; a stray `}` can't escape the scope.
- [Custom CSS](#example-css) in Settings is different: it styles the whole app, on every note.

Example: a two-column note with a highlighted box.

```html
<style>
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.box { background: var(--accent-soft); border-radius: 8px; padding: 10px 14px; }
</style>

<div class="cols">
<div class="box">Left column</div>
<div class="box">Right column</div>
</div>
```

The app works offline. Notes you've opened are cached, and edits are queued on the device and merged when the server is reachable again.

## Tests

```sh
node --test 'test/*.test.js'                                         # unit, server, sign-in and SSO (mock provider) tests
CALDAV_TEST_URL=http://127.0.0.1:5232/ CALDAV_TEST_USER=test node --test 'test/*.test.js'  # + end-to-end sync against a CalDAV server (e.g. Radicale, auth=none)
```

## Known limits

- Recurring rules using `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY` or hourly parts sync, and show as the raw rule, but Tickmark can't work out their next date, so completing one ends the series. Calendar events (VEVENT) aren't synced, only todos.
- CalDAV auth is Basic or Digest (MD5/SHA-256, `qop=auth`), whichever the server asks for. Basic is sent up front only over HTTPS or to localhost. No OAuth; for iCloud or Fastmail, use an app password.
- Notes aren't shared between users.
- Renaming updates `[[wikilinks]]`, not relative markdown links like `[text](Other.md)`.
