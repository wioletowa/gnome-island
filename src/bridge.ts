import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export type SlotName = 'workspaces' | 'clock' | 'keyboard' | 'tray' | 'quick-settings';

export const ALL_SLOTS: SlotName[] = ['workspaces', 'clock', 'keyboard', 'tray', 'quick-settings'];

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
 * The row of panel indicators shown inside the expanded island. It is named
 * "panel" so the stock `#panel .panel-button` theme rules keep applying to
 * the indicators we move into it.
 */
export const ExpandedRow = GObject.registerClass(
class ExpandedRow extends St.BoxLayout {
    slots!: Map<SlotName, St.BoxLayout>;

    constructor() {
        super({
            name: 'panel',
            style_class: 'island-expanded-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.slots = new Map();
        for (const name of ALL_SLOTS) {
            const box = new St.BoxLayout({
                style_class: `island-slot island-slot-${name}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.slots.set(name, box);
            this.add_child(box);
        }
    }

    setOrder(order: SlotName[]) {
        const seen = new Set<SlotName>();
        let i = 0;
        for (const name of [...order, ...ALL_SLOTS]) {
            if (seen.has(name) || !this.slots.has(name))
                continue;
            seen.add(name);
            this.set_child_at_index(this.slots.get(name)!, i++);
        }
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
    private _clockReplacement: Clutter.Actor | null = null;

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

    /** Replaces the date menu's label with our own clock actor. */
    setClockActor(actor: Clutter.Actor | null) {
        const dateMenu = (Main.panel.statusArea as any).dateMenu;
        if (!dateMenu)
            return;
        const label: Clutter.Actor = dateMenu._clockDisplay;
        if (this._clockReplacement) {
            this._clockReplacement.get_parent()?.remove_child(this._clockReplacement);
            this._clockReplacement = null;
        }
        if (actor) {
            label.get_parent()!.insert_child_above(actor, label);
            label.hide();
            this._clockReplacement = actor;
        } else {
            label.show();
        }
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
        this.setClockActor(null);

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
