# Synq GNOME Shell Extension

A GNOME Shell extension that tracks active application and window usage and
presents it in the top panel. It exposes a DBus API so an external collector
can forward activity to a server.

This is a standalone project. The main [Synq](https://github.com/Anoop130/synq)
activity tracking system consumes this repository as a git submodule.

![GNOME Shell Version](https://img.shields.io/badge/GNOME%20Shell-45%20|%2046%20|%2047-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- panel popup with Today, This Week, and This Month ranges
- 24 slot hourly activity heatmap
- per application and per activity time breakdown
- insight cards: peak focus block, context switches, most distracting app
- pauses tracking on suspend, lid-close, and screen lock, so away time is not
  attributed to the focused window
- CSV export of the selected range
- DBus API for external integrations
- configurable through the standard GNOME extension preferences dialog

## Requirements

GNOME Shell 45, 46, or 47.

## Install

```bash
# clone directly into the extensions directory under the uuid name
UUID=synq-gnome@anoop130.github.io
git clone https://github.com/Anoop130/synq-gnome.git
glib-compile-schemas synq-gnome/$UUID/schemas/
cp -r synq-gnome/$UUID ~/.local/share/gnome-shell/extensions/
gnome-extensions enable $UUID
```

Reload GNOME Shell afterwards (log out and back in on Wayland, or press
Alt+F2 then `r` on X11).

## Configuration

```bash
gnome-extensions prefs synq-gnome@anoop130.github.io
```

| key | type | default | effect |
|---|---|---|---|
| `pause-on-suspend` | bool | true | stop counting while suspended or the lid is closed |
| `pause-on-lock` | bool | true | stop counting while the screen is locked |
| `prune-days` | int | 31 | delete events older than this on startup |
| `panel-refresh-secs` | int | 60 | how often the panel total is recomputed |

## DBus API

Bus name `io.github.Synq.GnomeExtension`, object path
`/io/github/Synq/GnomeExtension`.

- signal `WindowChanged(s title, s timestamp)`
- method `GetCurrentWindow() -> s`
- method `GetEvents(x since_unix) -> s` returns a JSON array of `{title, ts}`

When tracking pauses, a `__IDLE__` sentinel title is emitted so subscribers can
exclude away time. The Synq server collector drops these before forwarding.

## Data

Events are stored as JSON lines at `~/.local/share/synq-gnome/events.jsonl` and
pruned to the `prune-days` window on startup.

## License

MIT. See [LICENSE](LICENSE).
