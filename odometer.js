import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const ROLL_DURATION = 420;

/**
 * One character slot. When the character changes the old glyph rolls up and
 * out while the new one rolls in from below.
 */
const OdometerCell = GObject.registerClass(
class OdometerCell extends St.Widget {
    _char = '';

    constructor(char) {
        super({
            style_class: 'island-odometer-cell',
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = this._makeLabel(char);
        this._char = char;
        this.add_child(this._label);
    }

    _makeLabel(char) {
        return new St.Label({
            text: char,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    get char() {
        return this._char;
    }

    setChar(char, animate) {
        if (char === this._char)
            return;
        this._char = char;

        if (!animate || !this.mapped) {
            this._label.text = char;
            return;
        }

        const old = this._label;
        const h = Math.max(this.height, old.height, 1);
        const next = this._makeLabel(char);
        next.translation_y = h * 0.9;
        next.opacity = 0;
        this.add_child(next);
        this._label = next;

        old.remove_all_transitions();
        old.ease({
            translationY: -h * 0.9,
            opacity: 0,
            duration: ROLL_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            onStopped: () => old.destroy(),
        });
        next.ease({
            translationY: 0,
            opacity: 255,
            duration: ROLL_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
    }
});

/**
 * A label whose characters roll individually when the text changes.
 * Digits use tabular figures so the width stays stable while ticking.
 */
export const Odometer = GObject.registerClass(
class Odometer extends St.BoxLayout {
    _cells = [];

    constructor(params = {}) {
        super({
            style_class: 'island-odometer',
            y_align: Clutter.ActorAlign.CENTER,
            ...params,
        });
    }

    setText(text, animate = true) {
        const chars = [...text];

        // Trim or grow the cell list; new cells start empty and roll in.
        while (this._cells.length > chars.length)
            this._cells.pop().destroy();
        while (this._cells.length < chars.length) {
            const cell = new OdometerCell(animate ? '' : chars[this._cells.length]);
            this._cells.push(cell);
            this.add_child(cell);
        }

        chars.forEach((c, i) => this._cells[i].setChar(c, animate));
    }
});

/**
 * Fires once per wall-clock second, aligned to the second boundary so all
 * clocks tick together.
 */
export class SecondTicker {
    _id = 0;
    _listeners = new Set();

    add(cb) {
        this._listeners.add(cb);
        if (!this._id)
            this._schedule();
        cb(GLib.DateTime.new_now_local());
    }

    remove(cb) {
        this._listeners.delete(cb);
    }

    _schedule() {
        const usec = GLib.DateTime.new_now_local().get_microsecond();
        const delay = Math.max(1, Math.ceil((1_000_000 - usec) / 1000));
        this._id = GLib.timeout_add(GLib.PRIORITY_HIGH, delay, () => {
            const now = GLib.DateTime.new_now_local();
            for (const cb of this._listeners)
                cb(now);
            this._schedule();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
        this._listeners.clear();
    }
}
