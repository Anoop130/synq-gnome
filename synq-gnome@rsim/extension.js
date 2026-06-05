import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DBUS_NAME = 'io.github.Synq.GnomeExtension';
const DBUS_PATH = '/io/github/Synq/GnomeExtension';
const DATA_DIR  = GLib.get_home_dir() + '/.local/share/synq-gnome';
const DATA_FILE = DATA_DIR + '/events.jsonl';
// sentinel title written when recording pauses (suspend, lid-close, or lock).
// the gap that follows it is away time and is excluded from all app totals.
const IDLE_SENTINEL = '__IDLE__';

const BAR_TRACK_PX = 160;
const BAR_HEIGHT_PX = 7;
const ACTIVITY_BAR_TRACK_PX = 135;
const ACTIVITY_BAR_HEIGHT_PX = 5;
const BAR_COLOR_COUNT = 5;

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

// splits a raw window title into [app_name, activity].
// convention on both X11 and Wayland: app name is always the last " - " segment.
// for 3+ parts ("file - project - App"): app=last, activity=second-to-last.
// for 2 parts ("Page - App"):            app=last, activity=first.
// input:  title (string) raw compositor window title
// output: [app_name (string), activity (string)]
function parseTitle(title) {
    if (!title) return ['', ''];
    const parts = title.split(' - ');
    if (parts.length >= 3)
        return [parts[parts.length - 1].trim(), parts[parts.length - 2].trim()];
    if (parts.length === 2)
        return [parts[1].trim(), parts[0].trim()];
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

// buckets events into 24 hourly slots by local clock hour.
// for week/month ranges the bucketing wraps (hours accumulate across days).
// input:  events (array of {title, ts}) sorted ascending
// output: array of 24 numbers, index = hour 0..23, value = seconds of activity
function computeHourlyBuckets(events) {
    const buckets = new Array(24).fill(0);
    for (let i = 0; i < events.length - 1; i++) {
        if (events[i].title === IDLE_SENTINEL) continue; // away gap, not activity
        const dur = events[i + 1].ts - events[i].ts;
        if (dur <= 0 || dur > 7200) continue; // skip gaps > 2h (idle/sleep)
        const hour = new Date(events[i].ts * 1000).getHours();
        buckets[hour] += dur;
    }
    return buckets;
}

// computes per-app usage totals and behaviour stats from a raw event array.
// events must be sorted ascending by ts.
// input:  events (array of {title, ts}) filtered to desired time range
// output: object with keys:
//   apps        -- array of {app, activities, secs, sessions, isBrowser}
//                  activities: map of activity_label --> seconds
//   switches    -- number, total focus changes
//   avgGapMin   -- number, avg minutes between focus changes
//   distracting -- string, app with shortest average session (may be null)
//   peakBlock   -- string, longest uninterrupted single-app run as "HH:MM-HH:MM"
//   peakSecs    -- number, duration of peakBlock in seconds
function computeStats(events) {
    const sessions = [];
    for (let i = 0; i < events.length - 1; i++) {
        if (events[i].title === IDLE_SENTINEL) continue; // away gap, not a session
        const dur = events[i + 1].ts - events[i].ts;
        if (dur <= 0 || dur > 7200) continue; // skip gaps > 2h (crash / unclean shutdown fallback)
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
                activities: {}
            };
        }
        appMap[s.app].secs += s.secs;
        appMap[s.app].sessions += 1;
        if (s.activity) {
            appMap[s.app].activities[s.activity] =
                (appMap[s.app].activities[s.activity] || 0) + s.secs;
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
        if (events[i].title === IDLE_SENTINEL) continue; // away gap is not focus
        const gap = events[i + 1].ts - events[i].ts;
        if (gap > peakSecs) {
            peakSecs = gap;
            const s = new Date(events[i].ts * 1000);
            const e = new Date(events[i + 1].ts * 1000);
            const fmt = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
            peakBlock = `${fmt(s)}-${fmt(e)}`;
        }
    }

    // switch and gap metrics count only real focus changes, not away markers
    const real = events.filter(e => e.title !== IDLE_SENTINEL);
    const switches = Math.max(0, real.length - 1);
    const totalMins = real.length >= 2
        ? (real[real.length - 1].ts - real[0].ts) / 60
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
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
    }
});

// ---- indicator (panel button + popup) ----
//
// layout patterns (branded header, pill range toggle, fixed-width bar track
// containing a child filled bar, the colour-cycled bars across the top rows)
// are adapted from WakaPanel: https://github.com/Anoop130/wakapanel

const SynqIndicator = GObject.registerClass(
class SynqIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Synq');
        this._ext = extension;
        this._range = 'today';
        this._expanded = new Set();
        this._rangeButtons = {};

        const panelBox = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'panel-status-indicators-box'
        });
        const icon = new St.Icon({
            icon_name: 'focus-windows-symbolic',
            icon_size: 20,
            style_class: 'system-status-icon synq-panel-icon',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._panelLabel = new St.Label({
            text: '0m',
            style_class: 'synq-panel-label',
            y_align: Clutter.ActorAlign.CENTER
        });
        panelBox.add_child(icon);
        panelBox.add_child(this._panelLabel);
        this.add_child(panelBox);

        this.menu.box.style_class = 'synq-menu-box';

        this._buildSkeleton();
        this._updatePanelLabel();

        this._menuOpenHandlerId = this.menu.connect('open-state-changed', (m, open) => {
            if (open) this._render();
        });
    }

    destroy() {
        if (this._menuOpenHandlerId) {
            this.menu.disconnect(this._menuOpenHandlerId);
            this._menuOpenHandlerId = 0;
        }
        super.destroy();
    }

    // builds the static menu skeleton (header with hero time, range pill,
    // heatmap container, app list container, insight cards container, export
    // button). dynamic sections are refilled by _render().
    // input:  none
    // output: none
    _buildSkeleton() {
        // header: title left, hero total time right
        const headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'synq-header-item'
        });
        const headerBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'synq-header-box'
        });
        const headerTitle = new St.Label({
            text: 'Synq',
            style_class: 'synq-header-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });
        this._heroLabel = new St.Label({
            text: '0m',
            style_class: 'synq-hero-time',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false
        });
        headerBox.add_child(headerTitle);
        headerBox.add_child(this._heroLabel);
        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // range pill
        const rangeItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'synq-range-item'
        });
        const rangeBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'synq-range-box'
        });
        const ranges = [
            { key: 'today', label: 'Today' },
            { key: 'week',  label: 'This Week' },
            { key: 'month', label: 'This Month' }
        ];
        for (const r of ranges) {
            const btn = new St.Button({
                label: r.label,
                style_class: 'synq-range-button',
                x_expand: true
            });
            btn.connect('clicked', () => {
                this._range = r.key;
                this._updateRangeButtons();
                this._render();
            });
            this._rangeButtons[r.key] = btn;
            rangeBox.add_child(btn);
        }
        rangeItem.add_child(rangeBox);
        this.menu.addMenuItem(rangeItem);
        this._updateRangeButtons();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // heatmap container
        const heatmapItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'synq-heatmap-item'
        });
        this._heatmapBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'synq-app-box'
        });
        heatmapItem.add_child(this._heatmapBox);
        this.menu.addMenuItem(heatmapItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // app list container
        const appItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'synq-app-item'
        });
        this._appBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'synq-app-box'
        });
        appItem.add_child(this._appBox);
        this.menu.addMenuItem(appItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // insight cards container (horizontal)
        const statsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'synq-stats-item'
        });
        this._statsBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'synq-stats-box'
        });
        statsItem.add_child(this._statsBox);
        this.menu.addMenuItem(statsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // export
        this._exportButton = new PopupMenu.PopupImageMenuItem(
            'Export CSV', 'document-save-symbolic'
        );
        this._exportButton.connect('activate', () => this._exportCSV());
        this.menu.addMenuItem(this._exportButton);
    }

    // applies the active style class to the currently selected range button
    // and clears it from the others.
    // input:  none
    // output: none
    _updateRangeButtons() {
        for (const key in this._rangeButtons) {
            const btn = this._rangeButtons[key];
            if (key === this._range)
                btn.add_style_class_name('synq-range-button-active');
            else
                btn.remove_style_class_name('synq-range-button-active');
        }
    }

    // computes today's total seconds and writes the formatted value to the
    // panel label next to the icon.
    // input:  none
    // output: none
    _updatePanelLabel() {
        const events = this._ext.getEventsForRange('today');
        const stats = computeStats(events);
        let total = 0;
        for (const a of stats.apps) total += a.secs;
        this._panelLabel.set_text(total > 0 ? fmtDuration(total) : '0m');
    }

    // refills all dynamic sections from the current event log and selected
    // range. called when the menu opens, when the range changes, or when an
    // app row is expanded or collapsed.
    // input:  none
    // output: none
    _render() {
        const events = this._ext.getEventsForRange(this._range);
        const stats  = computeStats(events);

        let total = 0;
        for (const a of stats.apps) total += a.secs;

        this._heroLabel.set_text(total > 0 ? fmtDuration(total) : '0m');

        this._heatmapBox.destroy_all_children();
        this._buildHeatmap(events);

        this._appBox.destroy_all_children();
        this._buildAppList(stats, total);

        this._statsBox.destroy_all_children();
        this._buildStats(stats);
    }

    // renders the 24-cell hourly heatmap strip and a sparse axis row below it.
    // cells are coloured by activity intensity in that local-clock hour.
    // for the 'today' range, hours after the current hour use synq-heat-future.
    // input:  events (array of {title, ts}) for the current range
    // output: none
    _buildHeatmap(events) {
        const buckets = computeHourlyBuckets(events);
        const currentHour = new Date().getHours();
        const isToday = this._range === 'today';

        const cellRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'synq-heatmap-row'
        });

        for (let h = 0; h < 24; h++) {
            let cls;
            if (isToday && h > currentHour) {
                cls = 'synq-heat-future';
            } else {
                const s = buckets[h];
                if (s === 0)         cls = 'synq-heat-0';
                else if (s < 300)    cls = 'synq-heat-1';
                else if (s < 1800)   cls = 'synq-heat-2';
                else if (s < 3600)   cls = 'synq-heat-3';
                else                 cls = 'synq-heat-4';
            }
            const cell = new St.Widget({
                style_class: `synq-heatmap-cell ${cls}`
            });
            cellRow.add_child(cell);
        }
        this._heatmapBox.add_child(cellRow);

        // sparse axis: labels at hours 0, 6, 12, 18 only
        const axisRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'synq-heatmap-axis-row'
        });
        const axisLabels = { 0: '12a', 6: '6a', 12: '12p', 18: '6p' };
        // each cell is 17px wide + 2px gap = 19px. label at hour h starts at h*19px.
        // we use a spacer-based approach: insert expanding spacers between labels.
        const labelHours = [0, 6, 12, 18];
        for (let i = 0; i < labelHours.length; i++) {
            const h = labelHours[i];
            if (i > 0) {
                const gap = labelHours[i] - labelHours[i - 1];
                const spacer = new St.Widget({ x_expand: false });
                spacer.set_width(gap * 19 - 14); // 19px per cell, minus label width
                axisRow.add_child(spacer);
            }
            const lbl = new St.Label({
                text: axisLabels[h],
                style_class: 'synq-heatmap-axis'
            });
            axisRow.add_child(lbl);
        }
        this._heatmapBox.add_child(axisRow);
    }

    // builds the per-app usage list. each app with at least one tracked
    // activity is clickable to expand a list of indented bullet sub-rows
    // (projects for editors, pages for browsers, etc.). bars use a five-step
    // colour cycle so the top rows are visually distinct. shows top 8 apps.
    // input:  stats (object) result of computeStats()
    //         totalSecs (number) sum of all app seconds for pct calculation
    // output: none
    _buildAppList(stats, totalSecs) {
        if (stats.apps.length === 0) {
            const empty = new St.Label({
                text: 'no data yet',
                style_class: 'synq-empty'
            });
            this._appBox.add_child(empty);
            return;
        }

        const maxSecs = stats.apps[0].secs || 1;
        const safeTotal = totalSecs || 1;
        const visibleApps = stats.apps.slice(0, 8);

        for (let i = 0; i < visibleApps.length; i++) {
            const a = visibleApps[i];
            const hasActivities = Object.keys(a.activities).length > 0;
            const expanded = this._expanded.has(a.app);
            const colorIdx = i % BAR_COLOR_COUNT;

            const row = new St.BoxLayout({
                style_class: 'synq-app-row',
                reactive: hasActivities,
                track_hover: hasActivities,
                x_expand: true
            });

            const nameLabel = new St.Label({
                text: a.app || 'Unknown',
                style_class: 'synq-app-name',
                y_align: Clutter.ActorAlign.CENTER
            });
            nameLabel.clutter_text.ellipsize = 3; // PANGO_ELLIPSIZE_END

            const track = new St.BoxLayout({
                vertical: false,
                x_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
                style: `width: ${BAR_TRACK_PX}px; height: ${BAR_HEIGHT_PX}px; ` +
                       `background-color: rgba(255,255,255,0.10); ` +
                       `border-radius: 4px;`
            });
            const barPx = Math.max(2, Math.round((a.secs / maxSecs) * BAR_TRACK_PX));
            const bar = new St.Widget({
                x_expand: false,
                y_expand: true,
                style_class: `synq-bar-${colorIdx}`,
                style: `width: ${barPx}px; border-radius: 4px;`
            });
            track.add_child(bar);

            const timeLabel = new St.Label({
                text: fmtDuration(a.secs),
                style_class: 'synq-app-time',
                y_align: Clutter.ActorAlign.CENTER
            });

            const pct = Math.round(a.secs / safeTotal * 100);
            const pctLabel = new St.Label({
                text: `${pct}%`,
                style_class: 'synq-app-pct',
                y_align: Clutter.ActorAlign.CENTER
            });

            row.add_child(nameLabel);
            row.add_child(track);
            row.add_child(timeLabel);
            row.add_child(pctLabel);

            if (hasActivities) {
                const chevron = new St.Label({
                    text: expanded ? '‹' : '›',
                    style_class: 'synq-chevron',
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(chevron);
                row.connect('button-press-event', () => {
                    if (this._expanded.has(a.app)) this._expanded.delete(a.app);
                    else this._expanded.add(a.app);
                    this._render();
                });
            }

            this._appBox.add_child(row);
            if (hasActivities && expanded) this._buildActivityRows(a, colorIdx);
        }
    }

    // builds indented bullet sub-rows for a single app. shows up to 10
    // activities sorted by time descending. child bars share the parent's
    // colour so the relation is obvious at a glance.
    // input:  app (object) entry from stats.apps with activities map
    //         colorIdx (number) parent app's bar colour index 0..4
    // output: none
    _buildActivityRows(app, colorIdx) {
        const sorted = Object.entries(app.activities).sort((a, b) => b[1] - a[1]);
        const parentMax = app.secs || 1;
        for (const [activity, secs] of sorted.slice(0, 10)) {
            const row = new St.BoxLayout({
                style_class: 'synq-activity-row',
                x_expand: true
            });
            const bullet = new St.Label({
                text: '•',
                style_class: 'synq-activity-bullet',
                y_align: Clutter.ActorAlign.CENTER
            });
            const name = new St.Label({
                text: activity,
                style_class: 'synq-activity-name',
                y_align: Clutter.ActorAlign.CENTER
            });
            name.clutter_text.ellipsize = 3;

            const track = new St.BoxLayout({
                vertical: false,
                x_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
                style: `width: ${ACTIVITY_BAR_TRACK_PX}px; ` +
                       `height: ${ACTIVITY_BAR_HEIGHT_PX}px; ` +
                       `background-color: rgba(255,255,255,0.06); ` +
                       `border-radius: 3px;`
            });
            const barPx = Math.max(2, Math.round((secs / parentMax) * ACTIVITY_BAR_TRACK_PX));
            const bar = new St.Widget({
                x_expand: false,
                y_expand: true,
                style_class: `synq-bar-${colorIdx} synq-activity-bar`,
                style: `width: ${barPx}px; border-radius: 3px;`
            });
            track.add_child(bar);

            const time = new St.Label({
                text: fmtDuration(secs),
                style_class: 'synq-activity-time',
                y_align: Clutter.ActorAlign.CENTER
            });

            row.add_child(bullet);
            row.add_child(name);
            row.add_child(track);
            row.add_child(time);
            this._appBox.add_child(row);
        }
    }

    // builds three horizontal insight cards: peak focus block, context switches,
    // and most distracting app. cards sit side-by-side in this._statsBox.
    // input:  stats (object) result of computeStats()
    // output: none
    _buildStats(stats) {
        const avgStr = stats.avgGapMin > 0
            ? `avg ${Math.round(stats.avgGapMin)}m gap`
            : 'no data yet';

        const cards = [
            {
                label: 'PEAK FOCUS',
                value: stats.peakBlock && stats.peakSecs >= 300
                    ? fmtDuration(stats.peakSecs)
                    : 'n/a',
                sub: stats.peakBlock && stats.peakSecs >= 300
                    ? stats.peakBlock
                    : 'not enough data'
            },
            {
                label: 'SWITCHES',
                value: String(stats.switches),
                sub: avgStr
            },
            {
                label: 'DISTRACTING',
                value: stats.distracting || 'none',
                sub: stats.distracting ? 'short sessions' : 'not enough data'
            }
        ];

        for (const c of cards) {
            const card = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'synq-insight-card'
            });

            const labelWidget = new St.Label({
                text: c.label,
                style_class: 'synq-insight-label'
            });
            const valueWidget = new St.Label({
                text: c.value,
                style_class: 'synq-insight-value'
            });
            valueWidget.clutter_text.ellipsize = 3;
            const subWidget = new St.Label({
                text: c.sub,
                style_class: 'synq-insight-sub'
            });
            subWidget.clutter_text.ellipsize = 3;

            card.add_child(labelWidget);
            card.add_child(valueWidget);
            card.add_child(subWidget);
            this._statsBox.add_child(card);
        }
    }

    // writes a CSV of all events in the selected range to
    // ~/.local/share/synq-gnome/export-YYYYMMDD-HHMMSS-<range>.csv.
    // columns: timestamp, app, activity, duration_secs, raw_title.
    // input:  none
    // output: none (side effect: writes file, shows notification)
    _exportCSV() {
        const events = this._ext.getEventsForRange(this._range);
        if (events.length === 0) {
            Main.notify('Synq', 'no events in selected range to export');
            return;
        }

        const esc = s => '"' + String(s).replace(/"/g, '""') + '"';
        const lines = ['timestamp,app,activity,duration_secs,raw_title'];
        for (let i = 0; i < events.length; i++) {
            const e   = events[i];
            if (e.title === IDLE_SENTINEL) continue; // away marker, not exported
            const dur = i < events.length - 1 ? events[i + 1].ts - e.ts : 0;
            const [app, activity] = parseTitle(e.title);
            const ts  = new Date(e.ts * 1000).toISOString();
            lines.push(`${ts},${esc(app)},${esc(activity)},${dur},${esc(e.title)}`);
        }

        const now  = new Date();
        const pad  = n => String(n).padStart(2, '0');
        const tag  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const path = GLib.get_home_dir() + `/.local/share/synq-gnome/export-${tag}-${this._range}.csv`;

        GLib.file_set_contents(path, lines.join('\n') + '\n');
        Main.notify('Synq', `exported ${events.length} events to ${path}`);
    }
});

// ---- main extension class ----

export default class SynqExtension extends Extension {
    // input:  metadata (object) extension metadata from metadata.json
    // output: none
    constructor(metadata) {
        super(metadata);
    }

    enable() {
        this._events = [];
        this._currentTitle = '';
        this._nameId = 0;
        this._dbusImpl = null;
        this._titleConn = null;
        this._trackedWindow = null;
        this._panelTimerId = 0;
        this._lockConn = null;
        this._sleepSubId = 0;
        this._locked = false;
        this._asleep = false;
        this._paused = false;
        this._settings = this.getSettings(
            'org.gnome.shell.extensions.synq-gnome'
        );
        this._refreshConn = 0;

        GLib.mkdir_with_parents(DATA_DIR, 0o755);
        this._loadEvents(() => {
            this._pruneOldEvents();
            if (this._indicator)
                this._indicator._updatePanelLabel();
        });

        this._indicator = new SynqIndicator(this);
        Main.panel.addToStatusArea('synq', this._indicator);

        this._focusConn = global.display.connect(
            'notify::focus-window',
            this._onFocusChanged.bind(this)
        );

        if (Main.screenShield) {
            this._locked = Main.screenShield.locked;
            this._lockConn = Main.screenShield.connect('locked-changed', () => {
                this._locked = Main.screenShield.locked;
                this._updatePauseState();
            });
        }

        // subscribe to logind PrepareForSleep on the system bus. it fires with
        // true just before suspend (including lid-close suspend) and false on
        // resume, so the focused window does not absorb the sleep duration.
        this._sleepSubId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.login1.Manager',
            'PrepareForSleep',
            '/org/freedesktop/login1',
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [aboutToSleep] = params.deep_unpack();
                this._asleep = aboutToSleep;
                this._updatePauseState();
            }
        );

        this._registerDBus();
        this._onFocusChanged();

        this._startPanelTimer();
        this._refreshConn = this._settings.connect(
            'changed::panel-refresh-secs',
            () => this._startPanelTimer()
        );
    }

    disable() {
        // close the open session at shutdown so the gap is not counted as activity
        if (!this._paused) {
            const ts = Math.floor(Date.now() / 1000);
            this._appendEventToDisk({ title: IDLE_SENTINEL, ts });
        }
        if (this._panelTimerId) {
            GLib.source_remove(this._panelTimerId);
            this._panelTimerId = 0;
        }
        if (this._titleConn && this._trackedWindow) {
            this._trackedWindow.disconnect(this._titleConn);
            this._titleConn = null;
            this._trackedWindow = null;
        }
        if (this._lockConn && Main.screenShield) {
            Main.screenShield.disconnect(this._lockConn);
            this._lockConn = null;
        }
        if (this._sleepSubId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSubId);
            this._sleepSubId = 0;
        }
        if (this._refreshConn && this._settings) {
            this._settings.disconnect(this._refreshConn);
            this._refreshConn = 0;
        }
        this._settings = null;
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
    // records the new focused window title, begins tracking title changes on
    // the new window (so browser page-load title updates are captured), and
    // appends an event to disk.
    // input:  none (reads global.display.focus_window internally)
    // output: none
    _onFocusChanged() {
        if (this._paused) return;

        if (this._titleConn && this._trackedWindow) {
            this._trackedWindow.disconnect(this._titleConn);
            this._titleConn = null;
            this._trackedWindow = null;
        }

        const win = global.display.focus_window;
        const title = win ? (win.get_title() || '') : '';
        this._currentTitle = title;

        if (win) {
            this._trackedWindow = win;
            this._titleConn = win.connect('notify::title', () => {
                if (this._paused) return;
                const newTitle = win.get_title() || '';
                if (newTitle === this._currentTitle) return;
                this._currentTitle = newTitle;
                this._recordEvent(newTitle);
            });
        }

        this._recordEvent(title);
    }

    // appends one event to memory and disk, emits the DBus signal, and
    // refreshes the panel label. shared by focus changes, title changes, and
    // the pause/resume markers.
    // input:  title (string) window title or IDLE_SENTINEL
    // output: none
    _recordEvent(title) {
        const ts = Math.floor(Date.now() / 1000);
        const event = { title, ts };
        this._events.push(event);
        this._appendEventToDisk(event);
        if (this._dbusImpl) {
            const iso = new Date(ts * 1000).toISOString();
            this._dbusImpl.emitWindowChanged(title, iso);
        }
        if (this._indicator) this._indicator._updatePanelLabel();
    }

    // recomputes whether recording is paused from the lock and sleep flags.
    // on the active-->paused edge it writes an idle sentinel so the open
    // session closes at the real boundary; on the paused-->active edge it
    // re-reads the focused window so counting resumes from the wake time.
    // input:  none (reads this._locked and this._asleep)
    // output: none
    _updatePauseState() {
        const shouldPause =
            (this._asleep && this._settings.get_boolean('pause-on-suspend')) ||
            (this._locked && this._settings.get_boolean('pause-on-lock'));
        if (shouldPause === this._paused) return;
        this._paused = shouldPause;

        if (shouldPause) {
            if (this._titleConn && this._trackedWindow) {
                this._trackedWindow.disconnect(this._titleConn);
                this._titleConn = null;
                this._trackedWindow = null;
            }
            this._recordEvent(IDLE_SENTINEL);
        } else {
            this._onFocusChanged();
        }
    }

    // starts or restarts the panel refresh timer using the configured interval.
    // input:  none (reads the panel-refresh-secs setting)
    // output: none
    _startPanelTimer() {
        if (this._panelTimerId) {
            GLib.source_remove(this._panelTimerId);
            this._panelTimerId = 0;
        }
        const secs = this._settings.get_int('panel-refresh-secs');
        this._panelTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            secs,
            () => {
                if (this._indicator) this._indicator._updatePanelLabel();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    // returns the current focused window title.
    // input:  none
    // output: string, may be empty
    getCurrentTitle() {
        return this._currentTitle;
    }

    // returns events scoped to the named range filtered to the current window
    // (today / week / month). always upper-bounded at the current wall clock.
    // input:  range (string) 'today', 'week', or 'month'
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
    // input:  onDone (function|undefined) called when load finishes or file missing
    // output: none (populates this._events)
    _loadEvents(onDone) {
        const done = () => {
            if (typeof onDone === 'function')
                onDone();
        };
        const file = Gio.File.new_for_path(DATA_FILE);
        if (!file.query_exists(null)) {
            this._events = [];
            done();
            return;
        }
        file.load_contents_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
            try {
                const [, bytes] = f.load_contents_finish(res);
                const text = new TextDecoder().decode(bytes);
                this._events = text.trim().split('\n')
                    .filter(l => l.trim())
                    .map(l => { try { return JSON.parse(l); } catch { return null; } })
                    .filter(Boolean);
            } catch (_) {
                this._events = [];
            }
            done();
        });
    }

    // removes events older than the prune-days setting from the in-memory log and rewrites
    // the file.
    // input:  none
    // output: none
    _pruneOldEvents() {
        const pruneDays = this._settings.get_int('prune-days');
        const cutoff = Math.floor(Date.now() / 1000) - pruneDays * 86400;
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
