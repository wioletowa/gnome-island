import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SLOT_LABELS: Record<string, () => string> = {
    'workspaces': () => _('Workspaces'),
    'clock': () => _('Clock and calendar'),
    'keyboard': () => _('Keyboard layout'),
    'tray': () => _('Tray (other indicators)'),
    'quick-settings': () => _('Quick Settings'),
};

const SLOT_ICONS: Record<string, string> = {
    'workspaces': 'view-grid-symbolic',
    'clock': 'x-office-calendar-symbolic',
    'keyboard': 'input-keyboard-symbolic',
    'tray': 'view-more-horizontal-symbolic',
    'quick-settings': 'emblem-system-symbolic',
};

interface SpringPreset {
    name: () => string;
    stiffness: number;
    damping: number;
    mass: number;
}

const PRESETS: SpringPreset[] = [
    {name: () => _('Default'), stiffness: 320, damping: 26, mass: 1},
    {name: () => _('Bouncy'), stiffness: 420, damping: 18, mass: 1},
    {name: () => _('Snappy'), stiffness: 700, damping: 48, mass: 1},
    {name: () => _('Smooth'), stiffness: 160, damping: 26, mass: 1},
];

function spinRow(settings: Gio.Settings, key: string, title: string, subtitle: string,
    lower: number, upper: number, step: number, digits = 0): Adw.SpinRow {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings: Gio.Settings, key: string, title: string, subtitle = ''): Adw.SwitchRow {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function entryRow(settings: Gio.Settings, key: string, title: string): Adw.EntryRow {
    const row = new Adw.EntryRow({title, show_apply_button: true});
    row.text = settings.get_string(key);
    row.connect('apply', () => settings.set_string(key, row.text));
    settings.connect(`changed::${key}`, () => {
        if (row.text !== settings.get_string(key))
            row.text = settings.get_string(key);
    });
    return row;
}

function colorRow(settings: Gio.Settings, key: string, title: string): Adw.ActionRow {
    const row = new Adw.ActionRow({title});
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: true}),
        valign: Gtk.Align.CENTER,
    });
    const load = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)))
            button.rgba = rgba;
    };
    load();
    button.connect('notify::rgba', () => {
        const value = button.rgba.to_string();
        if (value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    settings.connect(`changed::${key}`, load);
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

/** Reorderable list of expanded-island items, by drag and drop or buttons. */
function orderGroup(settings: Gio.Settings): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: _('Expanded island items'),
        description: _('Drag rows to change the order, left to right.'),
    });
    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    group.add(list);

    const read = (): string[] => {
        const order = settings.get_strv('item-order').filter(k => k in SLOT_LABELS);
        for (const k of Object.keys(SLOT_LABELS)) {
            if (!order.includes(k))
                order.push(k);
        }
        return order;
    };

    const move = (key: string, to: number) => {
        const order = read();
        const from = order.indexOf(key);
        if (from < 0 || to < 0 || to >= order.length || from === to)
            return;
        order.splice(from, 1);
        order.splice(to, 0, key);
        settings.set_strv('item-order', order);
    };

    const rebuild = () => {
        let child;
        while ((child = list.get_first_child()))
            list.remove(child);

        const order = read();
        order.forEach((key, index) => {
            const row = new Adw.ActionRow({title: SLOT_LABELS[key]()});
            row.add_prefix(new Gtk.Image({icon_name: 'list-drag-handle-symbolic', css_classes: ['dim-label']}));
            row.add_prefix(new Gtk.Image({icon_name: SLOT_ICONS[key]}));

            const up = new Gtk.Button({
                icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER,
                css_classes: ['flat'], sensitive: index > 0, tooltip_text: _('Move up'),
            });
            up.connect('clicked', () => move(key, index - 1));
            const down = new Gtk.Button({
                icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER,
                css_classes: ['flat'], sensitive: index < order.length - 1, tooltip_text: _('Move down'),
            });
            down.connect('clicked', () => move(key, index + 1));
            row.add_suffix(up);
            row.add_suffix(down);

            const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
            drag.connect('prepare', () => {
                const value = new GObject.Value();
                value.init(GObject.TYPE_STRING);
                value.set_string(key);
                return Gdk.ContentProvider.new_for_value(value);
            });
            drag.connect('drag-begin', (_src, dragObj) => {
                const paintable = new Gtk.WidgetPaintable({widget: row});
                Gtk.DragIcon.get_for_drag(dragObj).set_child(new Gtk.Picture({
                    paintable, width_request: row.get_width(), height_request: row.get_height(),
                    css_classes: ['card'],
                }));
            });
            row.add_controller(drag);

            const drop = new Gtk.DropTarget({actions: Gdk.DragAction.MOVE});
            drop.set_gtypes([GObject.TYPE_STRING]);
            drop.connect('drop', (_t, value) => {
                move(String(value), index);
                return true;
            });
            row.add_controller(drop);

            list.append(row);
        });
    };

    rebuild();
    settings.connect('changed::item-order', () => {
        // Rebuild after the drop handler has returned.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            rebuild();
            return GLib.SOURCE_REMOVE;
        });
    });

    const reset = new Gtk.Button({
        label: _('Reset order'), halign: Gtk.Align.END, margin_top: 12, css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset('item-order'));
    group.set_header_suffix(reset);
    return group;
}

export default class IslandPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow) {
        const settings = this.getSettings();
        window.set_default_size(640, 760);
        window.search_enabled = true;

        // --- Appearance ----------------------------------------------------
        const look = new Adw.PreferencesPage({title: _('Appearance'), icon_name: 'applications-graphics-symbolic'});
        window.add(look);

        const size = new Adw.PreferencesGroup({title: _('Size and position')});
        look.add(size);
        size.add(spinRow(settings, 'compact-height', _('Collapsed height'), _('Height of the island at rest, in pixels'), 20, 64, 1));
        size.add(spinRow(settings, 'expanded-height', _('Expanded height'), _('Height when showing indicators'), 20, 64, 1));
        size.add(spinRow(settings, 'top-margin', _('Top margin'), _('Gap above the island'), 0, 40, 1));
        size.add(spinRow(settings, 'bottom-gap', _('Bottom gap'), _('Space reserved under the island for windows'), 0, 40, 1));
        size.add(spinRow(settings, 'horizontal-padding', _('Inner padding'), _('Horizontal padding inside the island'), 0, 40, 1));
        size.add(spinRow(settings, 'bubble-gap', _('Bubble gap'), _('Distance between the island and the side bubble'), 0, 40, 1));
        size.add(switchRow(settings, 'all-monitors', _('Show on all monitors')));

        const colors = new Adw.PreferencesGroup({title: _('Colors')});
        look.add(colors);
        colors.add(colorRow(settings, 'background-color', _('Background')));
        colors.add(colorRow(settings, 'foreground-color', _('Text')));
        colors.add(colorRow(settings, 'accent-color', _('Accent (visualizer)')));

        // --- Behaviour -----------------------------------------------------
        const behaviour = new Adw.PreferencesPage({title: _('Behavior'), icon_name: 'preferences-system-symbolic'});
        window.add(behaviour);

        const clock = new Adw.PreferencesGroup({
            title: _('Clock'),
            description: _('strftime format, e.g. %H:%M:%S or %a %e %b %H:%M'),
        });
        behaviour.add(clock);
        clock.add(entryRow(settings, 'clock-format', _('Collapsed clock format')));
        clock.add(entryRow(settings, 'expanded-clock-format', _('Expanded clock format')));

        const expand = new Adw.PreferencesGroup({title: _('Expanding')});
        behaviour.add(expand);
        expand.add(spinRow(settings, 'collapse-delay', _('Collapse delay'), _('Milliseconds after the pointer leaves'), 0, 10000, 100));

        const notif = new Adw.PreferencesGroup({title: _('Notifications')});
        behaviour.add(notif);
        notif.add(switchRow(settings, 'notifications-in-island', _('Show notifications in the island'),
            _('When off, the standard GNOME banners are used')));
        notif.add(spinRow(settings, 'notification-duration', _('Notification duration'), _('Milliseconds'), 500, 20000, 250));

        const media = new Adw.PreferencesGroup({title: _('Media')});
        behaviour.add(media);
        media.add(switchRow(settings, 'visualizer-enabled', _('Audio visualizer'), _('Real spectrum of the current output')));
        media.add(spinRow(settings, 'visualizer-bars', _('Bars'), '', 2, 12, 1));
        media.add(spinRow(settings, 'visualizer-sensitivity', _('Sensitivity'), '', 0.1, 5, 0.1, 1));
        media.add(spinRow(settings, 'paused-media-timeout', _('Keep paused player'), _('Milliseconds before returning to the clock'), 0, 600000, 1000));

        // --- Animation -----------------------------------------------------
        const anim = new Adw.PreferencesPage({title: _('Animation'), icon_name: 'media-playlist-repeat-symbolic'});
        window.add(anim);

        const presets = new Adw.PreferencesGroup({title: _('Presets')});
        anim.add(presets);
        const box = new Gtk.Box({spacing: 8, homogeneous: true});
        for (const p of PRESETS) {
            const b = new Gtk.Button({label: p.name(), css_classes: ['pill']});
            b.connect('clicked', () => {
                settings.set_double('spring-stiffness', p.stiffness);
                settings.set_double('spring-damping', p.damping);
                settings.set_double('spring-mass', p.mass);
            });
            box.append(b);
        }
        presets.add(box);

        const physics = new Adw.PreferencesGroup({
            title: _('Spring physics'),
            description: _('Higher stiffness is faster; lower damping overshoots more.'),
        });
        anim.add(physics);
        physics.add(spinRow(settings, 'spring-stiffness', _('Stiffness'), '', 20, 2000, 10, 0));
        physics.add(spinRow(settings, 'spring-damping', _('Damping'), '', 1, 200, 1, 1));
        physics.add(spinRow(settings, 'spring-mass', _('Mass'), '', 0.1, 10, 0.1, 2));
        physics.add(switchRow(settings, 'blur-transitions', _('Blur during transitions')));

        // --- Layout --------------------------------------------------------
        const layout = new Adw.PreferencesPage({title: _('Layout'), icon_name: 'view-list-symbolic'});
        window.add(layout);
        layout.add(orderGroup(settings));
    }
}
