import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Spring, SpringDriver, SpringParams} from './spring.js';

export interface IslandMetrics {
    topMargin: number;
    bottomGap: number;
    compactHeight: number;
    expandedHeight: number;
    hPadding: number;
    bubbleGap: number;
}

interface ViewEntry {
    actor: Clutter.Actor;
    presence: Spring;
    blur: Shell.BlurEffect | null;
    /** Extra height this view wants over the compact height (e.g. 2 lines). */
    height: number | null;
}

const BUBBLE_SIZE_RATIO = 1.0;

/**
 * The black capsule. Children (views) are allocated at their natural size
 * and centred, so when the capsule morphs the content is revealed or
 * clipped rather than squeezed.
 */
const IslandPill = GObject.registerClass(
class IslandPill extends St.Widget {
    constructor(styleClass: string) {
        super({
            style_class: styleClass,
            reactive: true,
            track_hover: true,
            can_focus: true,
            clip_to_allocation: true,
        });
    }

    vfunc_allocate(box: Clutter.ActorBox) {
        this.set_allocation(box);
        const w = box.get_width();
        const h = box.get_height();
        const child = new Clutter.ActorBox();
        for (const actor of this.get_children()) {
            if (!actor.visible)
                continue;
            const [, natW] = actor.get_preferred_width(-1);
            const [, natH] = actor.get_preferred_height(natW);
            const x = Math.round((w - natW) / 2);
            const y = Math.round((h - natH) / 2);
            child.set_origin(x, y);
            child.set_size(natW, natH);
            actor.allocate(child);
        }
    }
});

type PillType = InstanceType<typeof IslandPill>;

/**
 * One island per monitor. It owns a set of named views and morphs between
 * them with springs: capsule width/height and each view's presence (which
 * drives opacity, scale and blur for the crossfade).
 */
export const Island = GObject.registerClass({
    Signals: {
        'pill-clicked': {param_types: [GObject.TYPE_UINT]},
        'hover-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'key-escape': {},
    },
}, class Island extends St.Widget {
    pill!: PillType;
    bubble!: PillType;
    private _metrics!: IslandMetrics;
    private _driver!: SpringDriver;
    private _views = new Map<string, ViewEntry>();
    private _bubbleViews = new Map<string, ViewEntry>();
    private _current: string | null = null;
    private _currentBubble: string | null = null;
    private _w!: Spring;
    private _h!: Spring;
    private _bw!: Spring;
    private _gap!: Spring;
    private _blurEnabled = true;
    private _destroyed = false;
    private _relayoutId = 0;

    constructor(metrics: IslandMetrics, params: SpringParams) {
        super({
            style_class: 'island-bar',
            reactive: false,
            x_expand: true,
        });
        this._metrics = metrics;

        this.pill = new IslandPill('island-pill');
        this.bubble = new IslandPill('island-pill island-bubble');
        this.add_child(this.bubble);
        this.add_child(this.pill);

        this._driver = new SpringDriver(this, () => this._onFrame());
        this._w = this._driver.add(new Spring(metrics.compactHeight * 3, params));
        this._h = this._driver.add(new Spring(metrics.compactHeight, params));
        this._bw = this._driver.add(new Spring(0, params));
        this._gap = this._driver.add(new Spring(0, params));

        for (const p of [this.pill, this.bubble]) {
            p.connect('button-release-event', (_a, event: Clutter.Event) => {
                this.emit('pill-clicked', event.get_button());
                return Clutter.EVENT_PROPAGATE;
            });
            p.connect('touch-event', (_a, event: Clutter.Event) => {
                if (event.type() === Clutter.EventType.TOUCH_END)
                    this.emit('pill-clicked', 1);
                return Clutter.EVENT_PROPAGATE;
            });
            p.connect('notify::hover', () => this.emit('hover-changed', this.hovered));
            p.connect('key-press-event', (_a, event: Clutter.Event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    this.emit('key-escape');
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
        this.bubble.visible = false;

        this.connect('destroy', () => {
            this._destroyed = true;
            if (this._relayoutId)
                GLib.source_remove(this._relayoutId);
            this._driver.destroy();
        });
    }

    get hovered(): boolean {
        return this.pill.hover || this.bubble.hover;
    }

    get currentView() {
        return this._current;
    }

    setMetrics(metrics: IslandMetrics) {
        this._metrics = metrics;
        this.queue_relayout();
        this.retarget();
    }

    setSpringParams(params: SpringParams) {
        this._driver.setParams(params);
    }

    setBlurEnabled(enabled: boolean) {
        this._blurEnabled = enabled;
        for (const e of [...this._views.values(), ...this._bubbleViews.values()]) {
            if (e.blur)
                e.blur.enabled = enabled;
        }
    }

    vfunc_get_preferred_height(_forWidth: number): [number, number] {
        const m = this._metrics;
        const h = m.topMargin + Math.max(m.compactHeight, m.expandedHeight) + m.bottomGap;
        return [h, h];
    }

    vfunc_get_preferred_width(_forHeight: number): [number, number] {
        return [0, 0];
    }

    vfunc_allocate(box: Clutter.ActorBox) {
        this.set_allocation(box);
        const width = box.get_width();
        const m = this._metrics;

        const pw = Math.max(0, Math.round(this._w.value));
        const ph = Math.max(0, Math.round(this._h.value));
        const bw = Math.max(0, Math.round(this._bw.value));
        const gap = Math.max(0, this._gap.value);
        const total = pw + gap + bw;
        const x0 = Math.round((width - total) / 2);
        const y = m.topMargin;

        const child = new Clutter.ActorBox();
        child.set_origin(x0, y);
        child.set_size(pw, ph);
        this.pill.allocate(child);

        // The bubble is a circle that grows out of the right edge of the pill.
        const bh = Math.min(ph, Math.round(m.compactHeight * BUBBLE_SIZE_RATIO));
        child.set_origin(x0 + pw + gap, y + Math.round((ph - bh) / 2));
        child.set_size(bw, bh);
        this.bubble.allocate(child);
    }

    addView(name: string, actor: Clutter.Actor, opts: {bubble?: boolean, height?: number} = {}) {
        const map = opts.bubble ? this._bubbleViews : this._views;
        const parent = opts.bubble ? this.bubble : this.pill;
        const presence = this._driver.add(new Spring(0));
        presence.params = this._w.params;
        let blur: Shell.BlurEffect | null = null;
        blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1});
        blur.enabled = false;
        actor.add_effect_with_name('island-blur', blur);
        actor.set_pivot_point(0.5, 0.5);
        actor.visible = false;
        actor.opacity = 0;
        parent.add_child(actor);
        map.set(name, {actor, presence, blur, height: opts.height ?? null});

        // Natural size changes (new track title, clock width) retarget the capsule.
        actor.connect('notify::allocation', () => this._queueRetarget());
    }

    setViewHeight(name: string, height: number | null) {
        const e = this._views.get(name);
        if (!e)
            return;
        e.height = height;
        this.retarget();
    }

    setView(name: string) {
        if (this._current === name)
            return;
        this._current = name;
        for (const [n, e] of this._views) {
            e.presence.target = n === name ? 1 : 0;
            // Map the incoming view right away so its widgets (and menus
            // anchored to them) are usable before the morph finishes.
            if (n === name)
                e.actor.visible = true;
        }
        this.retarget();
    }

    setBubbleView(name: string | null) {
        if (this._currentBubble === name)
            return;
        this._currentBubble = name;
        for (const [n, e] of this._bubbleViews)
            e.presence.target = n === name ? 1 : 0;
        if (name)
            this.bubble.visible = true;
        this.retarget();
    }

    private _queueRetarget() {
        if (this._relayoutId || this._destroyed)
            return;
        this._relayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._relayoutId = 0;
            if (!this._destroyed)
                this.retarget();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Recomputes capsule size targets from the active views' natural sizes. */
    retarget() {
        const m = this._metrics;
        const entry = this._current ? this._views.get(this._current) : null;
        if (entry) {
            const [, natW] = entry.actor.get_preferred_width(-1);
            const expanded = this._current === 'expanded';
            const baseH = expanded ? m.expandedHeight : m.compactHeight;
            const h = Math.max(baseH, entry.height ?? 0);
            const maxW = Math.max(h, this.width - 2 * m.hPadding);
            const pad = expanded ? 4 : m.hPadding;
            this._w.target = Math.min(maxW, Math.max(h, natW + 2 * pad));
            this._h.target = h;
        }

        const bubbleEntry = this._currentBubble ? this._bubbleViews.get(this._currentBubble) : null;
        if (bubbleEntry) {
            const [, natW] = bubbleEntry.actor.get_preferred_width(-1);
            const bh = m.compactHeight * BUBBLE_SIZE_RATIO;
            this._bw.target = Math.max(bh, natW + m.hPadding);
            this._gap.target = m.bubbleGap;
        } else {
            this._bw.target = 0;
            this._gap.target = 0;
        }
        this._driver.kick();
    }

    private _applyPresence(e: ViewEntry) {
        const p = Math.max(0, Math.min(1, e.presence.value));
        const visible = p > 0.01 || e.presence.target > 0;
        e.actor.visible = visible;
        if (!visible) {
            if (e.blur)
                e.blur.enabled = false;
            return;
        }
        e.actor.opacity = Math.round(255 * p * p);
        const s = 0.82 + 0.18 * Math.max(0, e.presence.value);
        e.actor.set_scale(s, s);
        if (e.blur) {
            const r = (1 - p) * 10;
            e.blur.enabled = this._blurEnabled && r > 0.5;
            e.blur.radius = r;
        }
    }

    private _onFrame() {
        for (const e of this._views.values())
            this._applyPresence(e);
        for (const e of this._bubbleViews.values())
            this._applyPresence(e);
        if (!this._currentBubble && this._bw.value < 0.5 && this._bw.target === 0)
            this.bubble.visible = false;
        this.queue_relayout();
    }

    /** Jump to the current targets without animating (first show). */
    snap() {
        this.retarget();
        this._w.snap();
        this._h.snap();
        this._bw.snap();
        this._gap.snap();
        for (const e of [...this._views.values(), ...this._bubbleViews.values()]) {
            e.presence.snap();
            this._applyPresence(e);
        }
        this.queue_relayout();
    }
});

export type IslandType = InstanceType<typeof Island>;
