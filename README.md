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

### Docker

```sh
mkdir -p vault data                 # create these yourself first, or Docker makes them owned by root
docker compose up -d --build        # http://127.0.0.1:8087, notes in ./vault, settings in ./data
```

A ready-made image is published as `ghcr.io/hempfieldtech/tickmark:latest` (set `image:` to it in `compose.yaml` and drop `build:` to use it instead of building).

Edit `compose.yaml` to point `./vault` at an existing notes folder or set your timezone (`TZ`). The container runs as uid 1000 by default; set `UID`/`GID` if your files belong to someone else.

Local settings go in a `.env` file next to `compose.yaml` (git ignores it). Compose reads it, and so does the container:

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

After that, admins add and remove people in Settings → **Users**, and everyone can change their own password in Settings → **Your account**. Removing a user leaves their files on disk. Sessions last 30 days; changing a password signs out the user's other devices. Ten wrong passwords from one address lock it out for 15 minutes.

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

Sync runs on the server, since the server holds the files. The app triggers it a few seconds after you save, when the window regains focus, every *N* minutes while open (5 by default), and from the sync button. There's also an optional server-side timer.

- **Three-way, per field.** The last synced state of each task is stored. If a field changed on only one side, that change wins. If the same field changed on both sides, the note wins. Different fields merge, e.g. you rename the task in the note while your phone marks it done.
- **Already done before it ever synced** (e.g. the completed copies recurring tasks leave behind): stays in the note, isn't uploaded.
- **Created elsewhere → the account's inbox note** (`Inbox.md` by default), tagged so it keeps syncing. Old completed todos are not imported.
- **Deletes propagate** both ways, but only when the other side hasn't changed since the last sync. If it has, the surviving copy is recreated so nothing is lost. Removing the tag from a line counts as deleting it.
- **Deleted tasks can be restored for 30 days.** The **⋯** menu (top right) → **Deleted tasks** lists synced tasks that sync deleted, whether the line was removed from a note or the todo was deleted in a task app, and after any sync that deletes something a notice offers **Review**. Each entry shows the note and the heading it was under, so two tasks with the same name are easy to tell apart. *Restore* puts the line back in its note, under that heading if it still exists (or in the inbox if the note is gone), and the todo back on the server, the exact copy where Tickmark kept one, so details other apps added survive. A line whose tag you removed, or that moved to another account, isn't counted as deleted. The list lives in the search index, so deleting `index.sqlite` empties it.
- **Remote edits are patched, not replaced.** Properties other clients add (alarms, descriptions, timezones, X- props) are kept.
- **Mass-deletion guard.** If more than half the tasks seem to have disappeared on one side (wrong calendar, server hiccup), sync stops and asks you to confirm with "Sync anyway".
- **Editor vs. sync.** Saves send the version the editor started from. If the file changed on disk meanwhile (sync, another device, another editor), the server does a line-level three-way merge. Real clashes get git-style conflict markers and a banner in the note.

## Editor

Source / split / preview (Ctrl+E cycles). Preview checkboxes are clickable and edit the source line; checking an item stamps `✅ date`. Tasks live in your notes: there is no separate task list view. `[[wikilinks]]` (clicking a missing one creates the note), backlinks, #tag search, full-text search, and drag-and-drop in the file tree.

| Key | |
|---|---|
| Ctrl+P / Ctrl+O | quick switcher (type a new name to create a note) |
| Ctrl+L | make the line a checklist item / toggle it |
| Enter / Tab / Shift+Tab | continue, indent, or outdent lists |
| Ctrl+S, Ctrl+E, Ctrl+\\, Ctrl+Shift+F | save, cycle view, toggle sidebar, search |

The app works offline. Notes you've opened are cached, and edits are queued on the device and merged when the server is reachable again.

## Tests

```sh
node --test test/                                           # unit, server, sign-in and SSO (mock provider) tests
CALDAV_TEST_URL=http://127.0.0.1:5232/ CALDAV_TEST_USER=test node --test test/    # + end-to-end sync against a CalDAV server (e.g. Radicale, auth=none)
```

## Known limits

- Recurring rules using `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY` or hourly parts sync, and show as the raw rule, but Tickmark can't work out their next date, so completing one ends the series. Calendar events (VEVENT) aren't synced, only todos.
- CalDAV auth is Basic or Digest (MD5/SHA-256, `qop=auth`), whichever the server asks for. Basic is sent up front only over HTTPS or to localhost. No OAuth; for iCloud or Fastmail, use an app password.
- Notes aren't shared between users.
- Renaming a note doesn't rewrite `[[links]]` to it.
