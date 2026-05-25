import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DBUS_NAME = 'io.github.Synq.GnomeExtension';
const DBUS_PATH = '/io/github/Synq/GnomeExtension';
const DATA_DIR  = GLib.get_home_dir() + '/.local/share/synq-gnome';
const DATA_FILE = DATA_DIR + '/events.jsonl';
const PRUNE_DAYS = 31;

const KNOWN_BROWSERS = [
    'Google Chrome', 'Chromium', 'Firefox',
    'Microsoft Edge', 'Brave', 'Opera', 'Vivaldi'
];

const DBUS_IFACE = `
<node>
  <interface name="${DBUS_NAME}">
    <signal name="WindowChanged">
      <arg type="s" name="title"/>
      <arg type="s" name="timestamp"/>
    </signal>
    <method name="GetCurrentWindow">
      <arg direction="out" type="s" name="title"/>
    </method>
    <method name="GetEvents">
      <arg direction="in"  type="x" name="since_unix"/>
      <arg direction="out" type="s" name="events_json"/>
    </method>
  </interface>
</node>`;

// splits a raw window title into [app_name, activity] using the same
// 2-part / 3-part delimiter logic as the server-side parser.
// input:  title (string) raw X11 or compositor window title
// output: [app_name (string), activity (string)]
function parseTitle(title) {
    if (!title) return ['', ''];
    const parts = title.split(' - ');
    if (parts.length >= 3)
        return [parts[parts.length - 1].trim(), parts[parts.length - 2].trim()];
    if (parts.length === 2)
        return [parts[0].trim(), parts[1].trim()];
    return [title.trim(), ''];
}

// formats a duration in seconds as "Xh Ym" or "Ym" or "Xs".
// input:  secs (number) non-negative integer seconds
// output: string, human readable duration
function fmtDuration(secs) {
    if (secs >= 3600) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    if (secs >= 60) return `${Math.floor(secs / 60)}m`;
    return `${Math.floor(secs)}s`;
}

// returns unix timestamp for the start of the current day in local time.
// input:  none
// output: number, unix seconds
function todayStart() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() / 1000;
}

// returns unix timestamp for the most recent Monday 00:00 in local time.
// input:  none
// output: number, unix seconds
function weekStart() {
    const d = new Date();
    const day = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - ((day + 6) % 7));
    d.setHours(0, 0, 0, 0);
    return d.getTime() / 1000;
}

// returns unix timestamp for the first of the current month 00:00 in local time.
// input:  none
// output: number, unix seconds
function monthStart() {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.getTime() / 1000;
}

// computes per-app usage totals and behaviour stats from a raw event array.
// events must be sorted ascending by ts.
// input:  events (array of {title, ts}) filtered to desired time range
// output: object with keys:
//   apps       -- array of {app, activity, secs, sessions, isBrowser, pages}
//   switches   -- number, total context switches
//   avgGapMin  -- number, avg minutes between switches
//   distracting -- string, app with shortest average session (may be null)
//   peakBlock  -- string, longest uninterrupted focus run as "HH:MM-HH:MM"
function computeStats(events) {
    const sessions = [];
    for (let i = 0; i < events.length - 1; i++) {
        const dur = events[i + 1].ts - events[i].ts;
        if (dur <= 0) continue;
        const [app, activity] = parseTitle(events[i].title);
        sessions.push({ app, activity, secs: dur, ts: events[i].ts });
    }

    const appMap = {};
    for (const s of sessions) {
        if (!appMap[s.app]) {
            appMap[s.app] = {
                app: s.app,
                secs: 0,
                sessions: 0,
                isBrowser: KNOWN_BROWSERS.includes(s.app),
                pages: {}
            };
        }
        appMap[s.app].secs += s.secs;
        appMap[s.app].sessions += 1;
        if (appMap[s.app].isBrowser && s.activity) {
            appMap[s.app].pages[s.activity] = (appMap[s.app].pages[s.activity] || 0) + s.secs;
        }
    }

    const apps = Object.values(appMap).sort((a, b) => b.secs - a.secs);

    // distraction: shortest average session among apps with at least 3 sessions
    let distracting = null;
    let minAvg = Infinity;
    for (const a of apps) {
        if (a.sessions >= 3) {
            const avg = a.secs / a.sessions;
            if (avg < minAvg) { minAvg = avg; distracting = a.app; }
        }
    }

    // peak focus block: longest gap between consecutive events
    let peakBlock = null;
    let peakSecs = 0;
    for (let i = 0; i < events.length - 1; i++) {
        const gap = events[i + 1].ts - events[i].ts;
        if (gap > peakSecs) {
            peakSecs = gap;
            const s = new Date(events[i].ts * 1000);
            const e = new Date(events[i + 1].ts * 1000);
            const fmt = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
            peakBlock = `${fmt(s)}-${fmt(e)}`;
        }
    }

    const switches = Math.max(0, events.length - 1);
    const totalMins = switches > 0 && events.length >= 2
        ? (events[events.length - 1].ts - events[0].ts) / 60
        : 0;
    const avgGapMin = switches > 0 ? (totalMins / switches) : 0;

    return { apps, switches, avgGapMin, distracting, peakBlock, peakSecs };
}

// ---- DBus implementation object ----

const SynqDBusImpl = GObject.registerClass(
class SynqDBusImpl extends GObject.Object {
    _init(getEventsFn, getCurrentTitleFn) {
        super._init();
        this._getEvents = getEventsFn;
        this._getCurrentTitle = getCurrentTitleFn;
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE, this);
    }

    // DBus method: returns all events since since_unix as a JSON string.
    // input:  since_unix (int64) unix timestamp lower bound
    // output: string, JSON array of {title, ts} objects
    GetEvents(since_unix) {
        const events = this._getEvents(since_unix);
        return JSON.stringify(events);
    }

    // DBus method: returns the title of the currently focused window.
    // input:  none
    // output: string, window title or empty string
    GetCurrentWindow() {
        return this._getCurrentTitle() || '';
    }

    // emits the WindowChanged signal on the DBus connection.
    // input:  title (string) new window title
    //         timestamp (string) ISO 8601 datetime
    // output: none
    emitWindowChanged(title, timestamp) {
        this._dbusImpl.emit_signal('WindowChanged',
            new GLib.Variant('(ss)', [title, timestamp]));
    }

    export(connection) {
        this._dbusImpl.export(connection, DBUS_PATH);
    }

    unexport() {
        this._dbusImpl.unexport();
    }
});

// ---- indicator (panel button + popup) ----

const SynqIndicator = GObject.registerClass(
class SynqIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Synq');
        this._ext = extension;
        this._range = 'today';
        this._expanded = new Set();

        const icon = new St.Label({
            text: '⏱',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'synq-panel-icon'
        });
        this.add_child(icon);

        this._popup = new St.BoxLayout({
            vertical: true,
            style_class: 'synq-popup',
            reactive: true
        });

        this.menu.box.add_child(this._popup);
        this.menu.connect('open-state-changed', (m, open) => {
            if (open) this._render();
        });
    }

    // rebuilds the popup content from the current event log and selected range.
    // input:  none
    // output: none
    _render() {
        this._popup.destroy_all_children();
        const events = this._ext.getEventsForRange(this._range);
        const stats  = computeStats(events);
        this._buildTabs();
        this._buildAppList(stats);
        this._buildStats(stats);
    }

    // builds the Today / This Week / This Month tab row.
    // input:  none
    // output: none
    _buildTabs() {
        const row = new St.BoxLayout({ style_class: 'synq-tabs' });
        const tabs = [
            { key: 'today', label: 'Today' },
            { key: 'week',  label: 'This Week' },
            { key: 'month', label: 'This Month' }
        ];
        for (const t of tabs) {
            const btn = new St.Button({
                label: t.label,
                style_class: 'synq-tab' + (this._range === t.key ? ' synq-tab-active' : ''),
                reactive: true
            });
            btn.connect('clicked', () => { this._range = t.key; this._render(); });
            row.add_child(btn);
        }
        this._popup.add_child(row);
    }

    // builds the per-app usage list with optional browser sub-rows.
    // input:  stats (object) result of computeStats()
    // output: none
    _buildAppList(stats) {
        if (stats.apps.length === 0) {
            const empty = new St.Label({ text: 'no data yet', style_class: 'synq-empty' });
            this._popup.add_child(empty);
            return;
        }

        const maxSecs = stats.apps[0].secs || 1;

        for (const a of stats.apps) {
            const row = new St.BoxLayout({ style_class: 'synq-app-row', reactive: true });

            const nameLabel = new St.Label({
                text: a.app || 'Unknown',
                style_class: 'synq-app-name'
            });

            const barWidth = Math.max(4, Math.round((a.secs / maxSecs) * 120));
            const bar = new St.Widget({
                style_class: 'synq-bar',
                width: barWidth
            });

            const timeLabel = new St.Label({
                text: fmtDuration(a.secs),
                style_class: 'synq-app-time'
            });

            row.add_child(nameLabel);
            row.add_child(bar);
            row.add_child(timeLabel);
            this._popup.add_child(row);

            if (a.isBrowser) {
                if (this._expanded.has(a.app)) {
                    this._buildPageRows(a);
                    row.connect('button-press-event', () => {
                        this._expanded.delete(a.app);
                        this._render();
                    });
                } else {
                    row.connect('button-press-event', () => {
                        this._expanded.add(a.app);
                        this._render();
                    });
                }
            }
        }
    }

    // builds indented sub-rows for browser page titles.
    // input:  app (object) entry from stats.apps with pages map
    // output: none
    _buildPageRows(app) {
        const sorted = Object.entries(app.pages).sort((a, b) => b[1] - a[1]);
        for (const [page, secs] of sorted.slice(0, 10)) {
            const row = new St.BoxLayout({ style_class: 'synq-page-row' });
            const indent = new St.Label({ text: '  └ ', style_class: 'synq-page-indent' });
            const name   = new St.Label({ text: page, style_class: 'synq-page-name' });
            const time   = new St.Label({ text: fmtDuration(secs), style_class: 'synq-page-time' });
            row.add_child(indent);
            row.add_child(name);
            row.add_child(time);
            this._popup.add_child(row);
        }
    }

    // builds the behaviour stats section (always scoped to today).
    // input:  stats (object) result of computeStats()
    // output: none
    _buildStats(stats) {
        const sep = new St.Widget({ style_class: 'synq-sep' });
        this._popup.add_child(sep);

        const avgStr = stats.avgGapMin > 0
            ? `avg 1 per ${Math.round(stats.avgGapMin)}m`
            : 'none yet';

        const lines = [
            `Context switches today:  ${stats.switches}  (${avgStr})`,
            stats.distracting
                ? `Most distracting:  ${stats.distracting}`
                : 'Most distracting:  not enough data',
            stats.peakBlock && stats.peakSecs >= 300
                ? `Peak focus block:  ${stats.peakBlock}  (${fmtDuration(stats.peakSecs)})`
                : 'Peak focus block:  not enough data'
        ];

        for (const line of lines) {
            const label = new St.Label({ text: line, style_class: 'synq-stat' });
            this._popup.add_child(label);
        }
    }
});

// ---- main extension class ----

export default class SynqExtension extends Extension {
    enable() {
        this._events = [];
        this._currentTitle = '';
        this._nameId = 0;
        this._dbusImpl = null;

        GLib.mkdir_with_parents(DATA_DIR, 0o755);
        this._loadEvents();
        this._pruneOldEvents();

        this._indicator = new SynqIndicator(this);
        Main.panel.addToStatusArea('synq', this._indicator);

        this._focusConn = global.display.connect(
            'notify::focus-window',
            this._onFocusChanged.bind(this)
        );

        this._registerDBus();
        this._onFocusChanged();
    }

    disable() {
        if (this._focusConn) {
            global.display.disconnect(this._focusConn);
            this._focusConn = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }
        this._events = [];
    }

    // called by the compositor on every window focus change.
    // records the new focused window title and appends an event to disk.
    // input:  none (reads global.display.focus_window internally)
    // output: none
    _onFocusChanged() {
        const win = global.display.focus_window;
        const title = win ? (win.get_title() || '') : '';
        this._currentTitle = title;

        const ts = Math.floor(Date.now() / 1000);
        const event = { title, ts };
        this._events.push(event);
        this._appendEventToDisk(event);

        if (this._dbusImpl) {
            const iso = new Date(ts * 1000).toISOString();
            this._dbusImpl.emitWindowChanged(title, iso);
        }
    }

    // returns the current focused window title.
    // input:  none
    // output: string, may be empty
    getCurrentTitle() {
        return this._currentTitle;
    }

    // returns events since the given unix timestamp from the in-memory log.
    // input:  since (number) unix timestamp lower bound, 0 for all
    // output: array of {title, ts} objects sorted ascending by ts
    getEventsForRange(range) {
        const now = Math.floor(Date.now() / 1000);
        let since;
        if (range === 'week')       since = weekStart();
        else if (range === 'month') since = monthStart();
        else                        since = todayStart();
        return this._events.filter(e => e.ts >= since && e.ts <= now);
    }

    // returns events since the given unix timestamp (used by DBus GetEvents).
    // input:  since (number) unix timestamp lower bound
    // output: array of {title, ts} objects
    getEventsSince(since) {
        return this._events.filter(e => e.ts >= since);
    }

    // loads all events from the JSONL file into memory on startup.
    // input:  none
    // output: none (populates this._events)
    _loadEvents() {
        try {
            const [ok, bytes] = GLib.file_get_contents(DATA_FILE);
            if (!ok) return;
            const text = new TextDecoder().decode(bytes);
            this._events = text.trim().split('\n')
                .filter(l => l.trim())
                .map(l => { try { return JSON.parse(l); } catch { return null; } })
                .filter(Boolean);
        } catch (_) {
            this._events = [];
        }
    }

    // removes events older than PRUNE_DAYS from the in-memory log and rewrites the file.
    // input:  none
    // output: none
    _pruneOldEvents() {
        const cutoff = Math.floor(Date.now() / 1000) - PRUNE_DAYS * 86400;
        this._events = this._events.filter(e => e.ts >= cutoff);
        const content = this._events.map(e => JSON.stringify(e)).join('\n') + '\n';
        GLib.file_set_contents(DATA_FILE, content);
    }

    // appends one event as a JSON line to the data file.
    // input:  event ({title, ts}) the event to persist
    // output: none
    _appendEventToDisk(event) {
        try {
            const line = JSON.stringify(event) + '\n';
            const file = Gio.File.new_for_path(DATA_FILE);
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(new TextEncoder().encode(line), null);
            stream.close(null);
        } catch (e) {
            console.error(`[ERROR] synq: failed to write event: ${e}`);
        }
    }

    // registers the DBus service on the session bus.
    // input:  none
    // output: none
    _registerDBus() {
        this._dbusImpl = new SynqDBusImpl(
            since => this.getEventsSince(since),
            ()    => this.getCurrentTitle()
        );

        this._nameId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            DBUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            (conn) => {
                this._dbusImpl.export(conn);
            },
            null,
            () => console.error('[ERROR] synq: could not own DBus name')
        );
    }
}
