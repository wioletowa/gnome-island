import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Odometer, OdometerType} from './odometer.js';
import {SymmetricBox} from './symmetric.js';
import {VisualizerBars, VisualizerBarsType} from './visualizer.js';
import {PRIVACY_ICONS, PrivacyKind} from './privacy.js';

const COVER_SIZE = 22;

/**
 * The time, always centred, with an optional date on the left and the
 * unread-messages dot on the right. Used for every clock in the island so
 * the time sits on the same pixels collapsed and expanded.
 */
export const ClockWidget = GObject.registerClass(
class ClockWidget extends SymmetricBox {
    time: OdometerType;
    date: St.Label;

    constructor() {
        super({style_class: 'island-clock'});
        this.time = new Odometer({style_class: 'island-odometer island-time'});
        this.center = this.time;
        this.date = new St.Label({style_class: 'island-date', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this.left.add_child(this.date);
    }

    setDate(text: string | null) {
        this.date.visible = !!text;
        if (text)
            this.date.text = text;
    }

    /** Puts an indicator actor (GNOME's own dot, or a mirror of it) on the right. */
    setIndicator(actor: Clutter.Actor | null) {
        for (const child of this.right.get_children())
            this.right.remove_child(child);
        if (actor)
            this.right.add_child(actor);
    }
});

export type ClockWidgetType = InstanceType<typeof ClockWidget>;

/**
 * A copy of GNOME's unread-messages dot that follows the real one's
 * visibility and icon, for the collapsed island.
 */
export const MessagesDotMirror = GObject.registerClass(
class MessagesDotMirror extends St.Icon {
    constructor(source: St.Icon | null) {
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
    private _uri: string | null = null;
    private _fallback: St.Icon;

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

    setUri(uri: string | null) {
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

export type CoverArtType = InstanceType<typeof CoverArt>;

/** Collapsed media: cover at the left edge, clock centred, visualizer at the right edge. */
export const MediaView = GObject.registerClass(
class MediaView extends SymmetricBox {
    cover: CoverArtType;
    clock: ClockWidgetType;
    bars: VisualizerBarsType;

    constructor(barCount: number) {
        super({style_class: 'island-view island-media-view', hugEdges: true});
        this.cover = new CoverArt();
        this.clock = new ClockWidget();
        this.bars = new VisualizerBars(barCount);
        this.left.add_child(this.cover);
        this.center = this.clock;
        this.right.add_child(this.bars);
    }
});

export type MediaViewType = InstanceType<typeof MediaView>;

export function formatElapsed(us: number): string {
    const total = Math.max(0, Math.floor(us / 1_000_000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Kinds that show an elapsed timer next to the icon. */
const TIMED_KINDS: PrivacyKind[] = ['screencast', 'sharing'];

/** Privacy activity in the side bubble: icon, plus a timer for recordings. */
export const BubbleView = GObject.registerClass(
class BubbleView extends St.BoxLayout {
    icon: St.Icon;
    timer: OdometerType;
    private _kind: PrivacyKind | null = null;

    constructor() {
        super({style_class: 'island-view island-bubble-view', y_align: Clutter.ActorAlign.CENTER});
        this.icon = new St.Icon({style_class: 'island-privacy-icon', icon_size: 15, y_align: Clutter.ActorAlign.CENTER});
        this.timer = new Odometer({style_class: 'island-odometer island-timer', visible: false});
        this.add_child(this.icon);
        this.add_child(this.timer);
    }

    update(kind: PrivacyKind | null, since: number) {
        if (kind !== this._kind) {
            if (this._kind)
                this.remove_style_class_name(`island-privacy-${this._kind}`);
            this._kind = kind;
            if (kind) {
                this.icon.icon_name = PRIVACY_ICONS[kind];
                this.add_style_class_name(`island-privacy-${kind}`);
            }
        }
        const timed = kind !== null && TIMED_KINDS.includes(kind);
        this.timer.visible = timed;
        if (timed)
            this.timer.setText(formatElapsed(GLib.get_monotonic_time() - since));
    }
});

export type BubbleViewType = InstanceType<typeof BubbleView>;

/** Incoming notification: app icon at the left edge, name centred, a pulsing dot at the right. */
export const NotificationView = GObject.registerClass(
class NotificationView extends SymmetricBox {
    private _icon: St.Icon;
    private _label: St.Label;
    private _dot: St.Widget;

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

    setAccent(color: string) {
        this._dot.set_style(`background-color: ${color};`);
    }

    show_(appName: string, icon: Gio.Icon | null) {
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

export type NotificationViewType = InstanceType<typeof NotificationView>;
