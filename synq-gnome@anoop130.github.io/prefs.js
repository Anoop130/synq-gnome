import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SynqPreferences extends ExtensionPreferences {
    // builds the preferences window bound to the extension GSettings schema.
    // input:  window (Adw.PreferencesWindow) the dialog to populate
    // output: none
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const tracking = new Adw.PreferencesGroup({ title: 'Tracking' });

        const suspendRow = new Adw.SwitchRow({
            title: 'Pause on suspend',
            subtitle: 'Stop counting while suspended or the lid is closed'
        });
        settings.bind('pause-on-suspend', suspendRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        tracking.add(suspendRow);

        const lockRow = new Adw.SwitchRow({
            title: 'Pause on screen lock',
            subtitle: 'Stop counting while the screen is locked'
        });
        settings.bind('pause-on-lock', lockRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        tracking.add(lockRow);

        const data = new Adw.PreferencesGroup({ title: 'Data' });

        const pruneRow = new Adw.SpinRow({
            title: 'Retention (days)',
            subtitle: 'Delete events older than this on startup',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 365, step_increment: 1
            })
        });
        settings.bind('prune-days', pruneRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        data.add(pruneRow);

        const refreshRow = new Adw.SpinRow({
            title: 'Panel refresh (seconds)',
            subtitle: 'How often the panel total updates',
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 3600, step_increment: 5
            })
        });
        settings.bind('panel-refresh-secs', refreshRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        data.add(refreshRow);

        page.add(tracking);
        page.add(data);
        window.add(page);
    }
}
