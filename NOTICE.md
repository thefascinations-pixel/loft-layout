# Notice

Fork of **Kanso** by jlopezlira (https://github.com/jlopezlira/herdr-kanso, tag v3.30.0), licensed Apache-2.0.
Kanso derives from the `spaces` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app), with changes by 0OZ, José Gutiérrez and Iván Campaña. The original copyright and "Modified by" lines are kept in each file.

Changes in this fork:

- Top bar: tab pills removed. Two floating islands sit on the office block (current agent title on the left; panel buttons on the right).
- Each terminal header shows a descriptive name instead of the program name.
- Sidebar: agents running outside Herdr (VS Code, tmux) listed per machine; an Archive of past Claude Code, Codex, pi and OpenCode sessions that can be resumed; Wake/Forget buttons on sleeping rows; machine latency tags; OpenCode status.
- Spend panel: restyled, with a monthly quota view and a heatmap.
- Self-updaters (`kanso-chrome/update.js`, `kanso-tabs/update.js`) are no-op stubs.

Not included: the `office` mod (DustyPolk/herdr-office). The layout expects it. Install it from herdr.dev/mods.

Apache-2.0 licence text: https://www.apache.org/licenses/LICENSE-2.0
