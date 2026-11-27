# Kanso (modified)

A Herdr layout: projects, status and threads in a sidebar; floating top-bar islands; an office scene above the terminals; a Spend panel on the right. Fork of Kanso v3.30.0 (see NOTICE.md).

## Install

Install the `office` mod from herdr.dev/mods first, then:

```sh
cp layouts/kanso.json ~/.config/herdr-app/layouts/kanso-modded.json
cp themes/*.json      ~/.config/herdr-app/themes/
cp -R mods/kanso-*    ~/.config/herdr-app/mods/
herdr-app do layout.switch '{"name":"kanso-modded"}'
```

Switch back with `ctrl-shift-l`. Back up any existing `kanso-*` mod folders first, because the copy overwrites them.

## Before you use it

- The Spend panel reads local agent logs (`~/.claude`, `~/.codex`, `~/.pi`, OpenCode's database). The sidebar probes (`outside.py`, `archive.py`) read the same places. Nothing is sent anywhere.
- `mods/kanso-spend/main.js` line 33: `WS_NAME` names the remote workspace whose logs Spend mirrors with `au-sync` (a personal script, not included). Spend works without it; set it to your own workspace name or ignore it.
- Self-updaters are disabled on purpose.

## Status

- Every mod passes `herdr-app check`.
- `preview.png` is not included yet. Take one with `herdr-app shot` on a window without personal sessions, then add the repo topic `herdr-layout`.
