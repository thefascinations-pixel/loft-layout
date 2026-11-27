# Loft

![Preview (mock-up, dummy data)](preview.png)

A Herdr layout: projects, status and threads in a sidebar; floating top-bar islands; an office scene above the terminals; a Spend panel on the right. Renamed fork of Kanso v3.30.0 (see NOTICE.md).

## Install

```sh
cp layouts/loft.json ~/.config/herdr-app/layouts/
cp themes/*.json      ~/.config/herdr-app/themes/
cp -R mods/*         ~/.config/herdr-app/mods/   # loft-* plus office
herdr-app do layout.switch '{"name":"loft"}'
```

Switch back with `ctrl-shift-l`. Back up any existing `loft-*` mod folders first, because the copy overwrites them.

## Before you use it

- The Spend panel reads local agent logs (`~/.claude`, `~/.codex`, `~/.pi`, OpenCode's database). The sidebar probes (`outside.py`, `archive.py`) read the same places. Nothing is sent anywhere.
- `mods/loft-spend/main.js` line 33: `WS_NAME` names the remote workspace whose logs Spend mirrors with `au-sync` (a personal script, not included). Spend works without it; set it to your own workspace name or ignore it.
- Self-updaters are disabled on purpose.

## Status

- Every mod passes `herdr-app check`.
- `preview.png` is an illustrative mock-up with dummy data, not a screenshot of a live window.
