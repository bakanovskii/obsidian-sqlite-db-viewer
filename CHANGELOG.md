# Changelog

## 0.7.0 (05 Aug 2026)

### Features

- Share a single database connection per file across the DB explorer, embeds and codeblocks
- Refresh every open table automatically when the same database is changed somewhere else
- Reload a database from disk when it is modified by Obsidian Sync, another device or an external tool
- Add rotating safety backups (3 slots), written next to the database and taken once per
  session before its first write, so the state a database had when it was opened is recoverable
- Name backups after the database's own extension (`stats.backup-1.db`), so Obsidian lists them
  in the file explorer and they open straight into the SQLite view
- Add "Backup folder" setting to collect backups in a chosen folder instead, mirroring the
  database's own folder structure so same-named files cannot collide
- Add "Safety backups" setting to turn those backups off
- Keep backups out of the database picker when importing a table, and never back up a backup
- Allow storing the literal text `NULL` in a cell by escaping it as `\NULL`
- Serialize database writes so two saves can never interleave into one file
- Refuse to save when the file changed on disk since it was read, instead of overwriting it

### Bugfixes

- Fix rows silently disappearing when a database is open in more than one table at once —
  every table kept its own full copy of the file and each save rewrote the whole database
  from that copy, discarding everything written by the others
- Fix `SELECT` in the DB explorer terminal rewriting the database file
- Fix exporting a database writing the whole underlying buffer instead of just the database bytes
- Fix table import overwriting changes made in an already open view of the same database
- Fix table import leaving a half-written table behind when a row fails to insert
- Fix editing a cell containing the text `NULL` replacing the value with a real SQL NULL
- Fix a cell re-submitting its value on every focus loss after the first edit
- Fix embedded tables leaking a renderer, and its database, when scrolled out of the editor viewport
- Fix the DB explorer leaking the previous grid renderer on every re-render and file switch
- Fix a fast file switch in the DB explorer rendering the previously opened database
- Fix an embed unloaded mid-load never releasing its database
- Fix table and column names not being escaped in generated SQL
- Fix table names containing regex characters breaking view rename and cascade drop
- Fix view rename and lookup building SQL string literals without escaping
- Fix the DB explorer erroring out when its open table was dropped or renamed elsewhere
- Fix the temporary connection used to create a database never being closed
- Fix save errors being reported while the UI still showed the change as saved

## 0.6.0 (10 Jun 2026)

### Features

- Add cursor moving in table using arrows
- Insert nothing instead of NULL on "New row" button 
- Make unique items `LIMIT` in filters constant
- When Open DB is clicked, now opens the table rendered not the dashboard
- Optimize column sorting a little

### Bugfixes

- Fix page reset to 1 when edit-mode enabled in db explorer
- Fix text highlighting in DB explorer tables

## 0.5.2 (08 Jun 2026)

### Features

- Bump version to rerun autotests

## 0.5.1 (08 Jun 2026)

### Bugfixes

- Fix obsidian autoreview issues

## 0.5.0 (08 Jun 2026)

### Features

- Add column filters
- Add markdown copy button

## 0.4.0 (07 Jun 2026)

### Features

- Remove live-preview config features
- Make refresh button in explorer smoother
- Update `README.md`

### Bugfixes

- Fix live rendering option for codeblocks

## 0.3.0 (06 Jun 2026)

### Features

- Add path select when creating DB

### Bugfixes

- Fix table render with other styles
- Fix embed rendered tables autoexpand to the right
- Fix WASM loading when creating DB

## 0.2.0 (05 Jun 2026)

### Features

- Add artifact attestation
- Load WASM SQL directly to plugin using base64 injection

## 0.1.1 (05 Jun 2026)

### Features

- Make lint rules more strict
- Update `minAppVersion`

### Bugfixes

- Fix auto-review obsidian issues

## 0.1.0 (05 Jun 2026)

### Features

- Add first working version

### Improvements

### Bugfixes

### CI/CD
