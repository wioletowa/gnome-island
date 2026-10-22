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


/**
 * The black capsule. Children (views) are allocated at their natural size
 * and centred, so when the capsule morphs the content is revealed or
 * clipped rather than squeezed.
 */
const IslandPill = GObject.registerClass({
    Signals: {'pointer-changed': {}},
}, class IslandPill extends St.Widget {
    constructor(styleClass: string) {
        super({
            style_class: styleClass,
            reactive: true,
            // No track_hover: toggling the :hover pseudo-class restyles the
            // capsule and St drops the 999px radius for a frame (a square
            // flash on the small bubbles). Hover is tracked by hand below.
            can_focus: true,
            clip_to_allocation: true,
        });
    }

    pointerInside = false;

    vfunc_enter_event(event: Clutter.Event): boolean {
        this._setInside(true);
        return super.vfunc_enter_event(event);
    }

    vfunc_leave_event(event: Clutter.Event): boolean {
        const related = event.get_related();
        // Moving onto one of our own children is not leaving.
        if (!related || !this.contains(related))
            this._setInside(false);
        return super.vfunc_leave_event(event);
    }

    private _setInside(inside: boolean) {
        if (this.pointerInside === inside)
            return;
        this.pointerInside = inside;
        this.emit('pointer-changed');
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
            // The pill width is always even and centred on an integer pixel,
            // so floor(w/2) - floor(natW/2) keeps content fixed on screen
            // while the capsule grows around it.
            const x = Math.floor(w / 2) - Math.floor(natW / 2);
            const y = Math.floor(h / 2) - Math.floor(natH / 2);
            child.set_origin(x, y);
            child.set_size(natW, natH);
            actor.allocate(child);
        }
    }
});

type PillType = InstanceType<typeof IslandPill>;

export type BubbleSide = 'left' | 'right';

/**
 * A small capsule beside the island. It grows from a dot into a circle,
 * optionally widens (away from the island), and only then fades its
 * content in; hiding runs the same steps backwards.
 */
class SideBubble {
    readonly pill: PillType;
    readonly side: BubbleSide;
    readonly views = new Map<string, ViewEntry>();
    size: Spring;
    extra: Spring;
    current: string | null = null;
    wanted = false;

    constructor(side: BubbleSide, driver: SpringDriver, params: SpringParams) {
        this.side = side;
        this.pill = new IslandPill(`island-pill island-bubble island-bubble-${side}`);
        this.pill.visible = false;
        this.size = driver.add(new Spring(0, params));
        this.extra = driver.add(new Spring(0, params));
    }

    set(name: string | null) {
        if (name === (this.wanted ? this.current : null))
            return;
        if (name) {
            // Switching content while shown just crossfades inside.
            if (this.current && this.current !== name)
                this.views.get(this.current)!.presence.target = 0;
            this.current = name;
            this.pill.visible = true;
        }
        this.wanted = name !== null;
    }

    stage(diameter: number, padding: number) {
        const entry = this.current ? this.views.get(this.current) : null;
        let extra = 0;
        if (entry) {
            const [, natW] = entry.actor.get_preferred_width(-1);
            extra = Math.max(0, natW + padding - diameter);
        }
        if (this.wanted) {
            this.size.target = diameter;
            if (this.size.value > diameter * 0.85) {
                this.extra.target = extra;
                if (this.extra.value > extra - 2 && entry)
                    entry.presence.target = 1;
            }
        } else {
            if (entry)
                entry.presence.target = 0;
            if (!entry || entry.presence.value < 0.3)
                this.extra.target = 0;
            if (this.extra.value < 2)
                this.size.target = 0;
        }
    }

    /** Hides the capsule once it has shrunk back to nothing. */
    settle() {
        if (!this.wanted && this.size.value < 0.5 && this.size.target === 0) {
            this.pill.visible = false;
            this.current = null;
        }
    }

    /** Places the bubble next to the pill spanning [pillX1, pillX2]. */
    allocate(pillX1: number, pillX2: number, pillY: number, pillH: number, diameter: number, gap: number) {
        const s = Math.max(0, Math.min(diameter * 1.2, this.size.value));
        const extra = Math.max(0, this.extra.value);
        const w = s + extra;
        // The dot starts at the centre of where the circle will be; extra
        // width grows away from the island.
        const x = this.side === 'right'
            ? pillX2 + gap + (diameter - s) / 2
            : pillX1 - gap - (diameter - s) / 2 - w;
        const y = pillY + (pillH - s) / 2;
        const box = new Clutter.ActorBox();
        box.set_origin(Math.round(x), Math.round(y));
        box.set_size(Math.round(w), Math.round(s));
        this.pill.allocate(box);
    }
}

/**
 * One island per monitor. It owns a set of named views and morphs between
 * them with springs: capsule width/height and each view's presence (which
 * drives opacity, scale and blur for the crossfade).
 */
export const Island = GObject.registerClass({
    Signals: {
        'pill-clicked': {param_types: [GObject.TYPE_UINT]},
        'bubble-clicked': {param_types: [GObject.TYPE_STRING]},
        'hover-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'key-escape': {},
    },
}, class Island extends St.Widget {
    pill!: PillType;
    private _bubbles!: Record<BubbleSide, SideBubble>;
    private _metrics!: IslandMetrics;
    private _driver!: SpringDriver;
    private _views = new Map<string, ViewEntry>();
    private _current: string | null = null;
    private _w!: Spring;
    private _h!: Spring;
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

        this._driver = new SpringDriver(this, () => this._onFrame());
        this._w = this._driver.add(new Spring(metrics.compactHeight * 3, params));
        this._h = this._driver.add(new Spring(metrics.compactHeight, params));

        this.pill = new IslandPill('island-pill');
        this._bubbles = {
            left: new SideBubble('left', this._driver, params),
            right: new SideBubble('right', this._driver, params),
        };
        this.add_child(this._bubbles.left.pill);
        this.add_child(this._bubbles.right.pill);
        this.add_child(this.pill);

        const emitClick = (p: PillType, button: number) => {
            if (p === this.pill)
                this.emit('pill-clicked', button);
            else
                this.emit('bubble-clicked', p === this._bubbles.left.pill ? 'left' : 'right');
        };
        for (const p of this.capsules) {
            p.connect('button-release-event', (_a, event: Clutter.Event) => {
                emitClick(p, event.get_button());
                return Clutter.EVENT_PROPAGATE;
            });
            p.connect('touch-event', (_a, event: Clutter.Event) => {
                if (event.type() === Clutter.EventType.TOUCH_END)
                    emitClick(p, 1);
                return Clutter.EVENT_PROPAGATE;
            });
            p.connect('pointer-changed', () => this.emit('hover-changed', this.hovered));
            p.connect('key-press-event', (_a, event: Clutter.Event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    this.emit('key-escape');
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
        this.connect('destroy', () => {
            this._destroyed = true;
            if (this._relayoutId)
                GLib.source_remove(this._relayoutId);
            this._driver.destroy();
        });
    }

    /** The main pill and both bubbles (for styling and hover). */
    get capsules(): PillType[] {
        return [this.pill, this._bubbles.left.pill, this._bubbles.right.pill];
    }

    get hovered(): boolean {
        return this.capsules.some(p => p.pointerInside);
    }

    private _allViews(): ViewEntry[] {
        return [...this._views.values(), ...this._bubbles.left.views.values(),
            ...this._bubbles.right.views.values()];
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
        for (const e of this._allViews()) {
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

        // Even sizes around an integer centre: both edges move by the same
        // whole pixel each frame, so nothing wobbles.
        const even = (v: number) => Math.max(0, 2 * Math.round(v / 2));
        const pw = even(this._w.value);
        const ph = even(this._h.value);
        const cx = Math.floor(width / 2);
        const x0 = cx - pw / 2;
        const y0 = m.topMargin;

        const child = new Clutter.ActorBox();
        child.set_origin(x0, y0);
        child.set_size(pw, ph);
        this.pill.allocate(child);

        // Bubbles sit beside the pill and follow its edges.
        for (const b of Object.values(this._bubbles))
            b.allocate(x0, x0 + pw, y0, ph, m.compactHeight, m.bubbleGap);
    }

    addView(name: string, actor: Clutter.Actor, opts: {bubble?: BubbleSide, height?: number} = {}) {
        const map = opts.bubble ? this._bubbles[opts.bubble].views : this._views;
        const parent = opts.bubble ? this._bubbles[opts.bubble].pill : this.pill;
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

    setBubbleView(side: BubbleSide, name: string | null) {
        this._bubbles[side].set(name);
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

        this._stageBubbles();
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
        // Subtle zoom; at rest the scale is exactly 1 so text is pixel-aligned.
        const s = p > 0.999 ? 1 : 0.9 + 0.1 * Math.max(0, e.presence.value);
        e.actor.set_scale(s, s);
        if (e.blur) {
            // Keep the effect on for the whole transition so it never pops
            // in or out mid-animation; radius goes smoothly to 0.
            e.blur.enabled = this._blurEnabled && p < 0.999;
            e.blur.radius = (1 - p) * 8;
        }
    }

    private _stageBubbles() {
        for (const b of Object.values(this._bubbles))
            b.stage(this._metrics.compactHeight, this._metrics.hPadding);
        this._driver.kick();
    }

    private _onFrame() {
        for (const e of this._views.values())
            this._applyPresence(e);
        this._stageBubbles();
        for (const b of Object.values(this._bubbles)) {
            for (const e of b.views.values())
                this._applyPresence(e);
            b.settle();
        }
        this.queue_relayout();
    }

    /** Jump to the current targets without animating (first show). */
    snap() {
        this.retarget();
        this._w.snap();
        this._h.snap();
        for (const e of this._allViews()) {
            e.presence.snap();
            this._applyPresence(e);
        }
        this.queue_relayout();
    }
});

export type IslandType = InstanceType<typeof Island>;
