import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Spring, SpringDriver} from './spring.js';

/**
 * The black capsule. Children (views) are allocated at their natural size
 * and centred, so when the capsule morphs the content is revealed or
 * clipped rather than squeezed.
 */
const IslandPill = GObject.registerClass({
    Signals: {'pointer-changed': {}},
}, class IslandPill extends St.Widget {
    constructor(styleClass) {
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
    edgeActor = null;
    edgePadding = 0;

    vfunc_enter_event(event) {
        this._setInside(true);
        return super.vfunc_enter_event(event);
    }

    vfunc_leave_event(event) {
        const related = event.get_related();
        // Moving onto one of our own children is not leaving.
        if (!related || !this.contains(related))
            this._setInside(false);
        return super.vfunc_leave_event(event);
    }

    _setInside(inside) {
        if (this.pointerInside === inside)
            return;
        this.pointerInside = inside;
        this.emit('pointer-changed');
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const w = box.get_width();
        const h = box.get_height();
        const child = new Clutter.ActorBox();
        for (const actor of this.get_children()) {
            if (!actor.visible)
                continue;
            const [, natW] = actor.get_preferred_width(-1);
            const [, natH] = actor.get_preferred_height(natW);
            if (actor === this.edgeActor) {
                // Centred in the right padding, so it never changes the
                // capsule's size or moves the content.
                const x = Math.round(w - this.edgePadding / 2 - natW / 2);
                child.set_origin(x, Math.floor(h / 2) - Math.floor(natH / 2));
                child.set_size(natW, natH);
                actor.allocate(child);
                continue;
            }
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

/**
 * A small capsule beside the island. It grows from a dot into a circle,
 * optionally widens (away from the island), and only then fades its
 * content in; hiding runs the same steps backwards.
 */
class SideBubble {
    views = new Map();
    current = null;
    wanted = false;

    constructor(side, driver, params, mode = 'grow') {
        this.side = side;
        this.mode = mode;
        this.pill = new IslandPill(`island-pill island-bubble island-bubble-${side}`);
        this.pill.visible = false;
        this.size = driver.add(new Spring(0, params));
        this.extra = driver.add(new Spring(0, params));
    }

    set(name) {
        if (name === (this.wanted ? this.current : null))
            return;
        if (name) {
            // Switching content while shown just crossfades inside.
            if (this.current && this.current !== name)
                this.views.get(this.current).presence.target = 0;
            this.current = name;
            this.pill.visible = true;
        }
        this.wanted = name !== null;
    }

    stage(diameter, padding) {
        const entry = this.current ? this.views.get(this.current) : null;
        let extra = 0;
        if (entry) {
            const [, natW] = entry.actor.get_preferred_width(-1);
            extra = Math.max(0, natW + padding - diameter);
        }
        if (this.mode === 'height') {
            this._stageHeight(entry, diameter, extra);
            return;
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

    /**
     * The capsule has its final width from the first frame and opens from a
     * thin line to full height; content fades in once it is mostly open.
     */
    _stageHeight(entry, diameter, extra) {
        if (this.wanted) {
            // Width only animates when the content changes while shown.
            if (this.size.value < 0.5)
                this.extra.snap(extra);
            else
                this.extra.target = extra;
            this.size.target = diameter;
            if (this.size.value > diameter * 0.6 && entry)
                entry.presence.target = 1;
        } else {
            if (entry)
                entry.presence.target = 0;
            if (!entry || entry.presence.value < 0.3)
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
    allocate(pillX1, pillX2, pillY, pillH, diameter, gap) {
        const s = Math.max(0, Math.min(diameter * 1.2, this.size.value));
        const extra = Math.max(0, this.extra.value);
        if (this.mode === 'height') {
            const w = diameter + extra;
            const x = this.side === 'right' ? pillX2 + gap : pillX1 - gap - w;
            const box = new Clutter.ActorBox();
            box.set_origin(Math.round(x), Math.round(pillY + (pillH - s) / 2));
            box.set_size(Math.round(w), Math.round(s));
            this.pill.allocate(box);
            return;
        }
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
    _views = new Map();
    _edgeViews = [];
    _allocWidth = 0;
    _current = null;
    _blurEnabled = true;
    _destroyed = false;
    _relayoutId = 0;

    constructor(metrics, params) {
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
            left: new SideBubble('left', this._driver, params, 'height'),
            right: new SideBubble('right', this._driver, params),
        };
        this.add_child(this._bubbles.left.pill);
        this.add_child(this._bubbles.right.pill);
        this.add_child(this.pill);

        const emitClick = (p, button) => {
            if (p === this.pill)
                this.emit('pill-clicked', button);
            else
                this.emit('bubble-clicked', p === this._bubbles.left.pill ? 'left' : 'right');
        };
        for (const p of this.capsules) {
            p.connect('button-release-event', (_a, event) => {
                emitClick(p, event.get_button());
                return Clutter.EVENT_PROPAGATE;
            });
            p.connect('touch-event', (_a, event) => {
                if (event.type() === Clutter.EventType.TOUCH_END)
                    emitClick(p, 1);
                return Clutter.EVENT_PROPAGATE;
            });
            p.connect('pointer-changed', () => this.emit('hover-changed', this.hovered));
            p.connect('key-press-event', (_a, event) => {
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
    get capsules() {
        return [this.pill, this._bubbles.left.pill, this._bubbles.right.pill];
    }

    get hovered() {
        return this.capsules.some(p => p.pointerInside);
    }

    _allViews() {
        return [...this._views.values(), ...this._bubbles.left.views.values(),
            ...this._bubbles.right.views.values()];
    }

    get currentView() {
        return this._current;
    }

    setMetrics(metrics) {
        this._metrics = metrics;
        this.pill.edgePadding = metrics.hPadding;
        this.queue_relayout();
        this.retarget();
    }

    setSpringParams(params) {
        this._driver.setParams(params);
    }

    setBlurEnabled(enabled) {
        this._blurEnabled = enabled;
        for (const e of this._allViews()) {
            if (e.blur)
                e.blur.enabled = enabled;
        }
    }

    vfunc_get_preferred_height(_forWidth) {
        const m = this._metrics;
        const h = m.topMargin + Math.max(m.compactHeight, m.expandedHeight) + m.bottomGap;
        return [h, h];
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const width = box.get_width();
        const m = this._metrics;
        this._allocWidth = width;

        // Even sizes around an integer centre: both edges move by the same
        // whole pixel each frame, so nothing wobbles.
        const even = (v) => Math.max(0, 2 * Math.round(v / 2));
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

    addView(name, actor, opts = {}) {
        const map = opts.bubble ? this._bubbles[opts.bubble].views : this._views;
        const parent = opts.bubble ? this._bubbles[opts.bubble].pill : this.pill;
        const presence = this._driver.add(new Spring(0));
        presence.params = this._w.params;
        let blur = null;
        blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1});
        blur.enabled = false;
        actor.add_effect_with_name('island-blur', blur);
        actor.set_pivot_point(0.5, 0.5);
        actor.visible = false;
        actor.opacity = 0;
        parent.add_child(actor);
        map.set(name, {actor, presence, blur, height: opts.height ?? null, keepSize: !!opts.keepSize});

        // Natural size changes (new track title, clock width) retarget the capsule.
        actor.connect('notify::allocation', () => this._queueRetarget());
    }

    /** Room for content inside the capsule at its current target size. */
    get contentWidth() {
        return Math.max(0, 2 * Math.round(this._w.target / 2) - 2 * this._metrics.hPadding);
    }

    /**
     * An actor drawn in the pill's right padding (the unread dot), shown
     * only while one of `views` is the active view.
     */
    setEdgeActor(actor, views) {
        this._edgeViews = views;
        this.pill.edgeActor = actor;
        this.pill.edgePadding = this._metrics.hPadding;
        this.pill.add_child(actor);
        this._applyEdge();
    }

    _applyEdge() {
        const actor = this.pill.edgeActor;
        if (!actor)
            return;
        let p = 0;
        for (const name of this._edgeViews)
            p += Math.max(0, this._views.get(name)?.presence.value ?? 0);
        actor.opacity = Math.round(255 * Math.min(1, p));
    }

    setViewHeight(name, height) {
        const e = this._views.get(name);
        if (!e)
            return;
        e.height = height;
        this.retarget();
    }

    setView(name) {
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

    setBubbleView(side, name) {
        this._bubbles[side].set(name);
        this.retarget();
    }

    _queueRetarget() {
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
            // Use the last real allocation: while a relayout is pending,
            // this.width reports our preferred width (0) and would clamp the
            // capsule to a circle for a frame, kicking the spring.
            const maxW = this._allocWidth > 0
                ? Math.max(h, this._allocWidth - 2 * m.hPadding) : Infinity;
            const pad = expanded ? 4 : m.hPadding;
            const w = Math.min(maxW, Math.max(h, natW + 2 * pad));
            if (entry.keepSize) {
                // Transient views (workspace switch) keep the current
                // capsule exactly; they fit themselves into contentWidth.
            } else {
                this._w.target = w;
                this._h.target = h;
            }
        }

        this._stageBubbles();
        this._driver.kick();
    }

    _applyPresence(e) {
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

    _stageBubbles() {
        for (const b of Object.values(this._bubbles))
            b.stage(this._metrics.compactHeight, this._metrics.hPadding);
        this._driver.kick();
    }

    _onFrame() {
        for (const e of this._views.values())
            this._applyPresence(e);
        this._applyEdge();
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
        this._applyEdge();
        this.queue_relayout();
    }
});
