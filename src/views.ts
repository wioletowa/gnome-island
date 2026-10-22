import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Odometer, OdometerType} from './odometer.js';
import {VisualizerBars, VisualizerBarsType} from './visualizer.js';
import {PRIVACY_ICONS, PrivacyKind} from './privacy.js';

const COVER_SIZE = 22;

/** Cover art thumbnail with rounded corners; falls back to a note icon. */
const CoverArt = GObject.registerClass(
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

/** Compact media: cover · clock · visualizer. */
export const MediaView = GObject.registerClass(
class MediaView extends St.BoxLayout {
    cover: InstanceType<typeof CoverArt>;
    clock: OdometerType;
    bars: VisualizerBarsType;

    constructor(barCount: number) {
        super({style_class: 'island-view island-media-view', y_align: Clutter.ActorAlign.CENTER});
        this.cover = new CoverArt();
        this.clock = new Odometer({style_class: 'island-odometer island-compact-clock'});
        this.bars = new VisualizerBars(barCount);
        this.add_child(this.cover);
        this.add_child(this.clock);
        this.add_child(this.bars);
    }
});

export type MediaViewType = InstanceType<typeof MediaView>;

function formatElapsed(us: number): string {
    const total = Math.max(0, Math.floor(us / 1_000_000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Icon for the active privacy activity with a pulsing dot animation. */
const PrivacyIcon = GObject.registerClass(
class PrivacyIcon extends St.Icon {
    private _kind: PrivacyKind | null = null;

    constructor() {
        super({style_class: 'island-privacy-icon', icon_size: 15, y_align: Clutter.ActorAlign.CENTER});
        this.set_pivot_point(0.5, 0.5);
        this.connect('notify::mapped', () => this._pulse());
    }

    setKind(kind: PrivacyKind | null) {
        if (kind === this._kind)
            return;
        if (this._kind)
            this.remove_style_class_name(`island-privacy-${this._kind}`);
        this._kind = kind;
        if (kind) {
            this.icon_name = PRIVACY_ICONS[kind];
            this.add_style_class_name(`island-privacy-${kind}`);
        }
    }

    private _pulse() {
        this.remove_all_transitions();
        this.opacity = 255;
        if (!this.mapped)
            return;
        // Gentle breathing so it reads as "live" without being distracting.
        this.ease({
            opacity: 110,
            duration: 900,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            autoReverse: true,
            repeatCount: -1,
        });
    }
});

/** Privacy activity in the main pill: icon · clock · elapsed timer. */
export const RecordingView = GObject.registerClass(
class RecordingView extends St.BoxLayout {
    icon: InstanceType<typeof PrivacyIcon>;
    clock: OdometerType;
    timer: OdometerType;

    constructor() {
        super({style_class: 'island-view island-recording-view', y_align: Clutter.ActorAlign.CENTER});
        this.icon = new PrivacyIcon();
        this.clock = new Odometer({style_class: 'island-odometer island-compact-clock'});
        this.timer = new Odometer({style_class: 'island-odometer island-timer'});
        this.add_child(this.icon);
        this.add_child(this.clock);
        this.add_child(this.timer);
    }

    update(kind: PrivacyKind | null, since: number) {
        this.icon.setKind(kind);
        this.timer.setText(kind ? formatElapsed(GLib.get_monotonic_time() - since) : '');
    }
});

export type RecordingViewType = InstanceType<typeof RecordingView>;

/** Privacy activity in the side bubble: just the icon. */
export const BubbleView = GObject.registerClass(
class BubbleView extends St.Bin {
    icon: InstanceType<typeof PrivacyIcon>;

    constructor() {
        super({style_class: 'island-view island-bubble-view'});
        this.icon = new PrivacyIcon();
        this.set_child(this.icon);
    }

    update(kind: PrivacyKind | null) {
        this.icon.setKind(kind);
    }
});

export type BubbleViewType = InstanceType<typeof BubbleView>;

/** Incoming notification: app icon · app name. */
export const NotificationView = GObject.registerClass(
class NotificationView extends St.BoxLayout {
    private _icon: St.Icon;
    private _label: St.Label;

    constructor() {
        super({style_class: 'island-view island-notification-view', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'island-notification-icon', icon_size: 18, y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({style_class: 'island-notification-app', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        this.add_child(this._icon);
        this.add_child(this._label);
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
    }
});

export type NotificationViewType = InstanceType<typeof NotificationView>;
