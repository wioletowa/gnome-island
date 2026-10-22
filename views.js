import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Odometer} from './odometer.js';
import {SymmetricBox} from './symmetric.js';
import {VisualizerBars} from './visualizer.js';
import {PRIVACY_ICONS} from './privacy.js';

const COVER_SIZE = 22;

/**
 * The time, always centred, with an optional date on the left and the
 * unread-messages dot on the right. Used for every clock in the island so
 * the time sits on the same pixels collapsed and expanded.
 */
export const ClockWidget = GObject.registerClass(
class ClockWidget extends SymmetricBox {
    constructor() {
        super({style_class: 'island-clock'});
        this.time = new Odometer({style_class: 'island-odometer island-time'});
        this.center = this.time;
        this.date = new St.Label({style_class: 'island-date', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this.left.add_child(this.date);
    }

    setDate(text) {
        this.date.visible = !!text;
        if (text)
            this.date.text = text;
    }

    /** Puts an indicator actor (GNOME's own dot, or a mirror of it) on the right. */
    setIndicator(actor) {
        for (const child of this.right.get_children())
            this.right.remove_child(child);
        if (actor)
            this.right.add_child(actor);
    }
});

/**
 * A copy of GNOME's unread-messages dot that follows the real one's
 * visibility and icon, for the collapsed island.
 */
export const MessagesDotMirror = GObject.registerClass(
class MessagesDotMirror extends St.Icon {
    constructor(source) {
        super({
            style_class: 'messages-indicator island-messages-dot',
            icon_name: 'message-indicator-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        if (source) {
            source.bind_property('visible', this, 'visible', GObject.BindingFlags.SYNC_CREATE);
            source.bind_property('gicon', this, 'gicon', GObject.BindingFlags.SYNC_CREATE);
        }
    }
});

/** Cover art thumbnail with rounded corners; falls back to a note icon. */
export const CoverArt = GObject.registerClass(
class CoverArt extends St.Bin {
    _uri = null;

    constructor() {
        super({
            style_class: 'island-cover',
            width: COVER_SIZE,
            height: COVER_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fallback = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 14,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._fallback);
    }

    setUri(uri) {
        if (uri === this._uri)
            return;
        this._uri = uri;
        if (uri) {
            const escaped = uri.replace(/"/g, '\\"');
            this.set_style(`background-image: url("${escaped}"); background-size: cover;`);
            this._fallback.hide();
        } else {
            this.set_style(null);
            this._fallback.show();
        }
    }
});

/** Collapsed media: cover at the left edge, clock centred, visualizer at the right edge. */
export const MediaView = GObject.registerClass(
class MediaView extends SymmetricBox {
    constructor(barCount) {
        super({style_class: 'island-view island-media-view', hugEdges: true});
        this.cover = new CoverArt();
        this.clock = new ClockWidget();
        this.bars = new VisualizerBars(barCount);
        this.left.add_child(this.cover);
        this.center = this.clock;
        this.right.add_child(this.bars);
    }
});

export function formatElapsed(us) {
    const total = Math.max(0, Math.floor(us / 1_000_000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Kinds that show an elapsed timer. */
const TIMED_KINDS = ['screencast', 'remote-recording', 'sharing'];

/**
 * Every active privacy activity in the side bubble: one icon per kind
 * (recording, sharing, camera, microphone) plus a timer for recordings.
 */
export const BubbleView = GObject.registerClass(
class BubbleView extends St.BoxLayout {
    _icons = new Map();

    constructor() {
        super({style_class: 'island-view island-bubble-view', y_align: Clutter.ActorAlign.CENTER});
        this._iconBox = new St.BoxLayout({style_class: 'island-privacy-icons', y_align: Clutter.ActorAlign.CENTER});
        this.timer = new Odometer({style_class: 'island-odometer island-timer', visible: false});
        this.add_child(this._iconBox);
        this.add_child(this.timer);
    }

    update(state) {
        const kinds = state?.kinds ?? [];
        for (const [kind, icon] of this._icons) {
            if (!kinds.includes(kind)) {
                icon.destroy();
                this._icons.delete(kind);
            }
        }
        kinds.forEach((kind, index) => {
            let icon = this._icons.get(kind);
            if (!icon) {
                icon = new St.Icon({
                    style_class: `island-privacy-icon island-privacy-${kind}`,
                    icon_size: 15,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this._icons.set(kind, icon);
                this._iconBox.add_child(icon);
                if (this.mapped) {
                    // New activity pops in next to the existing ones.
                    icon.set_pivot_point(0.5, 0.5);
                    icon.set_scale(0.2, 0.2);
                    icon.opacity = 0;
                    icon.ease({
                        scaleX: 1, scaleY: 1, opacity: 255,
                        duration: 380, mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    });
                }
            }
            this._iconBox.set_child_at_index(icon, index);
            const muted = kind === 'microphone' && state.microphoneMuted;
            icon.icon_name = muted ? 'microphone-sensitivity-muted-symbolic' : PRIVACY_ICONS[kind];
            if (muted)
                icon.add_style_class_name('island-privacy-muted');
            else
                icon.remove_style_class_name('island-privacy-muted');
        });

        const timed = kinds.find(k => TIMED_KINDS.includes(k));
        this.timer.visible = !!timed;
        if (timed) {
            this.timer.setText(formatElapsed(GLib.get_monotonic_time() - state.sinceOf(timed)));
            // Colour the timer like the activity it times.
            for (const k of TIMED_KINDS)
                this.timer.remove_style_class_name(`island-privacy-${k}`);
            this.timer.add_style_class_name(`island-privacy-${timed}`);
        }
    }
});

/** Incoming notification: app icon at the left edge, name centred, a pulsing dot at the right. */
export const NotificationView = GObject.registerClass(
class NotificationView extends SymmetricBox {
    constructor() {
        super({style_class: 'island-view island-notification-view', hugEdges: true});
        this._icon = new St.Icon({style_class: 'island-notification-icon', icon_size: 20, y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({style_class: 'island-notification-app', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._label.clutter_text.y_align = Clutter.ActorAlign.CENTER;
        this._dot = new St.Widget({style_class: 'island-notification-dot', y_align: Clutter.ActorAlign.CENTER});
        this._dot.set_pivot_point(0.5, 0.5);
        this.left.add_child(this._icon);
        this.center = this._label;
        this.right.add_child(this._dot);
    }

    setAccent(color) {
        this._dot.set_style(`background-color: ${color};`);
    }

    show_(appName, icon) {
        this._icon.gicon = icon ?? new Gio.ThemedIcon({name: 'preferences-system-notifications-symbolic'});
        this._label.text = appName;
        // A small pop on arrival.
        this._icon.set_pivot_point(0.5, 0.5);
        this._icon.set_scale(0.4, 0.4);
        this._icon.remove_all_transitions();
        this._icon.ease({
            scaleX: 1,
            scaleY: 1,
            duration: 550,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        this._dot.remove_all_transitions();
        this._dot.set_scale(1, 1);
        this._dot.ease({
            scaleX: 0.55,
            scaleY: 0.55,
            duration: 700,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            autoReverse: true,
            repeatCount: -1,
        });
    }

    stop() {
        this._dot.remove_all_transitions();
    }
});

const LEVEL_WIDTH = 64;

/**
 * Replacement for GNOME's OSD popups (volume, brightness, microphone…):
 * icon and level bar, without the device label.
 */
export const OsdView = GObject.registerClass(
class OsdView extends St.BoxLayout {
    constructor() {
        super({style_class: 'island-view island-osd-view', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'island-osd-icon', icon_size: 16, y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({
            style_class: 'island-osd-track',
            width: LEVEL_WIDTH,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        this._fill = new St.Widget({style_class: 'island-osd-fill'});
        // Part of the bar above 100% (volume over-amplification).
        this._over = new St.Widget({style_class: 'island-osd-fill island-osd-over', visible: false});
        this._track.add_child(this._fill);
        this._track.add_child(this._over);
        this.add_child(this._icon);
        this.add_child(this._track);
        this._track.connect('notify::height', () => {
            this._fill.height = this._track.height;
            this._over.height = this._track.height;
        });
    }

    setAccent(color) {
        this._over.set_style(`background-color: ${color};`);
    }

    show_(icon, level, maxLevel) {
        this._icon.gicon = icon;
        const hasLevel = typeof level === 'number' && level >= 0;
        this._track.visible = hasLevel;
        if (!hasLevel)
            return;
        const max = typeof maxLevel === 'number' && maxLevel > 0 ? maxLevel : 1;
        const frac = Math.max(0, Math.min(1, level / max));
        // Mark the over-amplified range like GNOME does, relative to 100%.
        const normal = Math.min(1, 1 / max);
        const fillW = Math.round(LEVEL_WIDTH * Math.min(frac, normal));
        const overW = Math.round(LEVEL_WIDTH * Math.max(0, frac - normal));
        const animate = this.mapped;
        const ease = (actor, props) => {
            actor.remove_all_transitions();
            if (!animate) {
                actor.set(props);
                return;
            }
            actor.ease({...props, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };
        ease(this._fill, {width: fillW});
        this._over.visible = overW > 0;
        ease(this._over, {width: overW, x: fillW});
    }
});

const DOT = 7;
const ACTIVE_DOT = 22;

/** Workspace switch feedback: dots with the active one stretched, like GNOME's top bar. */
export const WorkspaceDots = GObject.registerClass(
class WorkspaceDots extends St.BoxLayout {
    _dots = [];
    _active = -1;

    constructor() {
        super({style_class: 'island-view island-workspace-dots', y_align: Clutter.ActorAlign.CENTER});
    }

    show_(active, count) {
        const animate = this.mapped && this._dots.length === count;
        if (this._dots.length !== count) {
            for (const d of this._dots)
                d.destroy();
            this._dots = [];
            for (let i = 0; i < count; i++) {
                const dot = new St.Widget({
                    style_class: 'island-workspace-dot',
                    y_align: Clutter.ActorAlign.CENTER,
                    width: DOT,
                    height: DOT,
                    opacity: 110,
                });
                this._dots.push(dot);
                this.add_child(dot);
            }
            // Start from the previous workspace so the stretch slides over.
            if (this._active >= 0 && this._active < count) {
                this._dots[this._active].width = ACTIVE_DOT;
                this._dots[this._active].opacity = 255;
            }
        }
        this._active = active;
        this._dots.forEach((dot, i) => {
            const on = i === active;
            const props = {width: on ? ACTIVE_DOT : DOT, opacity: on ? 255 : 110};
            dot.remove_all_transitions();
            if (animate || dot.mapped)
                dot.ease({...props, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            else
                dot.set(props);
        });
    }
});
