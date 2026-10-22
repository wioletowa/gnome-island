import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
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

/**
 * Every active privacy activity in the side bubble: one icon per kind
 * (recording, sharing, camera, microphone). Hovering an icon emits
 * `icon-hover` so the extension can show who is using it.
 */
export const BubbleView = GObject.registerClass({
    Signals: {'icon-hover': {param_types: [GObject.TYPE_STRING, GObject.TYPE_BOOLEAN]}},
}, class BubbleView extends St.BoxLayout {
    _icons = new Map();

    constructor() {
        super({style_class: 'island-view island-bubble-view', y_align: Clutter.ActorAlign.CENTER});
        this._iconBox = new St.BoxLayout({style_class: 'island-privacy-icons', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._iconBox);
    }

    /** The icon actor for an active kind (to anchor a tooltip). */
    iconFor(kind) {
        return this._icons.get(kind) ?? null;
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
                    reactive: true,
                    track_hover: true,
                });
                icon.connect('notify::hover', () => this.emit('icon-hover', kind, icon.hover));
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
const DOT_SPACING = 6;

/**
 * Workspace switch feedback: dots with the active one stretched, like
 * GNOME's top bar. Everything scales down to fit `maxWidth`, so showing it
 * never changes the island's size.
 */
export const WorkspaceDots = GObject.registerClass(
class WorkspaceDots extends St.BoxLayout {
    _dots = [];
    _active = -1;
    _sizes = {dot: DOT, active: ACTIVE_DOT};

    constructor() {
        super({style_class: 'island-view island-workspace-dots', y_align: Clutter.ActorAlign.CENTER});
    }

    _fit(count, maxWidth) {
        const full = ACTIVE_DOT + (count - 1) * (DOT + DOT_SPACING);
        const k = Math.min(1, maxWidth / full);
        const dot = Math.max(3, Math.floor(DOT * k));
        const spacing = Math.max(2, Math.floor(DOT_SPACING * k));
        // Whatever is left goes to the active dot, but never less than 2 dots.
        const active = Math.max(dot * 2, Math.min(ACTIVE_DOT, Math.floor(maxWidth - (count - 1) * (dot + spacing))));
        this.set_style(`spacing: ${spacing}px;`);
        this._sizes = {dot, active};
    }

    show_(active, count, maxWidth = Infinity) {
        this._fit(count, maxWidth);
        const {dot: dotSize, active: activeSize} = this._sizes;
        const animate = this.mapped && this._dots.length === count;
        if (this._dots.length !== count) {
            for (const d of this._dots)
                d.destroy();
            this._dots = [];
            for (let i = 0; i < count; i++) {
                const dot = new St.Widget({
                    style_class: 'island-workspace-dot',
                    y_align: Clutter.ActorAlign.CENTER,
                    width: dotSize,
                    height: dotSize,
                    opacity: 110,
                });
                this._dots.push(dot);
                this.add_child(dot);
            }
            // Start from the previous workspace so the stretch slides over.
            if (this._active >= 0 && this._active < count) {
                this._dots[this._active].width = activeSize;
                this._dots[this._active].opacity = 255;
            }
        }
        this._active = active;
        this._dots.forEach((dot, i) => {
            const on = i === active;
            dot.height = dotSize;
            const props = {width: on ? activeSize : dotSize, opacity: on ? 255 : 110};
            dot.remove_all_transitions();
            if (animate || dot.mapped)
                dot.ease({...props, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            else
                dot.set(props);
        });
    }
});

/**
 * Keyboard layout switch feedback: the new language replaces the clock for
 * a moment. Uses the full name when it fits the capsule, else the short one.
 */
export const LanguageView = GObject.registerClass(
class LanguageView extends St.Bin {
    constructor() {
        super({style_class: 'island-view island-language-view', y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({style_class: 'island-language', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.set_child(this._label);
    }

    show_(displayName, shortName, maxWidth = Infinity) {
        this._label.text = displayName;
        // Measure without the previous max-width, or it never looks too wide.
        this._label.set_style(null);
        const [, natW] = this._label.get_preferred_width(-1);
        if (natW > maxWidth)
            this._label.text = shortName.toUpperCase();
        this._label.set_style(Number.isFinite(maxWidth) ? `max-width: ${Math.floor(maxWidth)}px;` : null);
        // A quick pop so the change is noticeable.
        this._label.set_pivot_point(0.5, 0.5);
        this._label.remove_all_transitions();
        this._label.set_scale(0.7, 0.7);
        this._label.ease({scaleX: 1, scaleY: 1, duration: 420, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }
});
