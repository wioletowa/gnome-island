import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SymmetricBox} from './symmetric.js';
import type {ClockWidgetType} from './views.js';

export type SlotName = 'workspaces' | 'clock' | 'keyboard' | 'tray' | 'quick-settings';

/** Slots that can go on either side; the clock is always in the middle. */
export type SideSlot = Exclude<SlotName, 'clock'>;
export const SIDE_SLOTS: SideSlot[] = ['workspaces', 'keyboard', 'tray', 'quick-settings'];

const ROLE_SLOTS: Record<string, SlotName> = {
    activities: 'workspaces',
    dateMenu: 'clock',
    keyboard: 'keyboard',
    quickSettings: 'quick-settings',
};

interface Origin {
    box: St.BoxLayout;
    index: number;
}

/**
 * The row of panel indicators shown inside the expanded island: the clock
 * slot sits exactly in the middle with equally wide sides. It is named
 * "panel" so the stock `#panel .panel-button` theme rules keep applying to
 * the indicators we move into it. Optional `leading`/`trailing` actors sit
 * at the outer ends (media cover and visualizer).
 */
export const ExpandedRow = GObject.registerClass(
class ExpandedRow extends SymmetricBox {
    slots!: Map<SlotName, St.BoxLayout>;
    private _leading: Clutter.Actor | null = null;
    private _trailing: Clutter.Actor | null = null;

    constructor() {
        // Side items stack against the outer corners, the clock stays centred.
        super({name: 'panel', style_class: 'island-expanded-row', hugEdges: true});
        this.slots = new Map();
        for (const name of [...SIDE_SLOTS, 'clock' as SlotName]) {
            const box = new St.BoxLayout({
                style_class: `island-slot island-slot-${name}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.slots.set(name, box);
        }
        this.center = this.slots.get('clock')!;
        this.setLayout(['workspaces'], ['keyboard', 'tray', 'quick-settings']);
    }

    setLayout(left: SideSlot[], right: SideSlot[]) {
        const seen = new Set<SideSlot>();
        const clean = (list: SideSlot[]) => list.filter(n => {
            if (seen.has(n) || !SIDE_SLOTS.includes(n))
                return false;
            seen.add(n);
            return true;
        });
        const l = clean(left);
        const r = clean(right);
        // Anything missing from both lists goes to the right.
        for (const n of SIDE_SLOTS) {
            if (!seen.has(n))
                r.push(n);
        }
        for (const box of this.slots.values()) {
            if (box !== this.center)
                box.get_parent()?.remove_child(box);
        }
        for (const n of l)
            this.left.add_child(this.slots.get(n)!);
        for (const n of r)
            this.right.add_child(this.slots.get(n)!);
        if (this._leading)
            this.left.set_child_below_sibling(this._leading, null);
        if (this._trailing)
            this.right.set_child_above_sibling(this._trailing, null);
    }

    setEnds(leading: Clutter.Actor, trailing: Clutter.Actor) {
        this._leading = leading;
        this._trailing = trailing;
        this.left.insert_child_at_index(leading, 0);
        this.right.add_child(trailing);
    }
});

export type ExpandedRowType = InstanceType<typeof ExpandedRow>;

/**
 * Takes every indicator out of the hidden top bar and moves it into the
 * expanded row of whichever island is active. Indicators added later by
 * other extensions are picked up too, and everything is put back on
 * disable.
 */
export class PanelBridge {
    private _origins = new Map<Clutter.Actor, Origin>();
    private _row: ExpandedRowType | null = null;
    private _boxes: St.BoxLayout[];
    private _signals: [GObject.Object, number][] = [];
    private _idleId = 0;
    private _clock: ClockWidgetType | null = null;
    private _pad: Clutter.Actor | null = null;

    constructor() {
        const panel = Main.panel as any;
        this._boxes = [panel._leftBox, panel._centerBox, panel._rightBox];
        for (const box of this._boxes) {
            this._signals.push([box, box.connect('child-added', () => this._queueSync())]);
        }
    }

    /** Moves all indicators into `row` (called when an island expands). */
    attach(row: ExpandedRowType) {
        if (this._row === row) {
            this._sync();
            return;
        }
        const previous = this._row;
        this._row = row;
        this._sync();
        if (previous) {
            for (const [name, box] of previous.slots) {
                const target = row.slots.get(name)!;
                for (const child of box.get_children()) {
                    box.remove_child(child);
                    target.add_child(child);
                }
            }
        }
    }

    /**
     * Puts our clock into the date menu button in place of GNOME's label.
     * GNOME's own unread-messages dot moves into the clock's right side so
     * it keeps working exactly as before.
     */
    setClock(clock: ClockWidgetType | null) {
        const dateMenu = (Main.panel.statusArea as any).dateMenu;
        if (!dateMenu)
            return;
        const label: St.Label = dateMenu._clockDisplay;
        const dot: St.Icon = dateMenu._indicator;
        const box = label.get_parent() as St.BoxLayout;

        if (this._clock) {
            this._clock.setIndicator(null);
            box.remove_child(this._clock);
            this._clock = null;
        }
        if (clock) {
            // indicatorPad (first child) has its visibility bound to the dot,
            // so take it out of the box rather than hiding it.
            if (!this._pad) {
                this._pad = box.get_first_child();
                if (this._pad)
                    box.remove_child(this._pad);
            }
            box.remove_child(dot);
            clock.setIndicator(dot);
            box.add_child(clock);
            label.hide();
            this._clock = clock;
        } else {
            if (dot.get_parent())
                dot.get_parent()!.remove_child(dot);
            box.add_child(dot);
            if (this._pad)
                box.insert_child_at_index(this._pad, 0);
            this._pad = null;
            label.show();
        }
    }

    /** GNOME's unread-messages dot, for mirroring in the collapsed island. */
    get messagesDot(): St.Icon | null {
        return (Main.panel.statusArea as any).dateMenu?._indicator ?? null;
    }

    private _queueSync() {
        if (this._idleId)
            return;
        // Let addToStatusArea finish registering the role first.
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _slotFor(actor: Clutter.Actor): SlotName {
        const statusArea = Main.panel.statusArea as Record<string, any>;
        for (const role in statusArea) {
            if (statusArea[role]?.container === actor)
                return ROLE_SLOTS[role] ?? 'tray';
        }
        return 'tray';
    }

    private _sync() {
        if (!this._row)
            return;
        for (const box of this._boxes) {
            const children = box.get_children();
            children.forEach((child, index) => {
                if (!this._origins.has(child)) {
                    this._origins.set(child, {box, index});
                    child.connectObject('destroy', () => this._origins.delete(child), this);
                }
                const slot = this._row!.slots.get(this._slotFor(child))!;
                box.remove_child(child);
                slot.add_child(child);
            });
        }
    }

    destroy() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this.setClock(null);

        // Put indicators back in their original boxes, in original order.
        const entries = [...this._origins.entries()]
            .sort((a, b) => a[1].index - b[1].index);
        for (const [child, {box, index}] of entries) {
            child.disconnectObject(this);
            child.get_parent()?.remove_child(child);
            box.insert_child_at_index(child, Math.min(index, box.get_n_children()));
        }
        this._origins.clear();
        this._row = null;
    }
}
