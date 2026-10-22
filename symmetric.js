import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/**
 * Three-part row whose centre child is always exactly in the middle: both
 * side boxes get the width of the wider one. With `hugEdges` the side
 * content sits against the outer edges (cover left, visualizer right);
 * otherwise it sits next to the centre.
 */
export const SymmetricBox = GObject.registerClass(
class SymmetricBox extends St.Widget {
    _center = null;

    constructor(params = {}) {
        super({
            style_class: params.style_class ?? '',
            name: params.name ?? null,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._hugEdges = params.hugEdges ?? false;
        this.left = new St.BoxLayout({style_class: 'island-sym-left', y_align: Clutter.ActorAlign.CENTER});
        this.right = new St.BoxLayout({style_class: 'island-sym-right', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.left);
        this.add_child(this.right);
    }

    get center() {
        return this._center;
    }

    set center(actor) {
        if (this._center)
            this.remove_child(this._center);
        this._center = actor;
        if (actor)
            this.add_child(actor);
    }

    _spacing() {
        return this.get_theme_node().get_length('spacing');
    }

    _sideWidth() {
        const [, l] = this.left.visible ? this.left.get_preferred_width(-1) : [0, 0];
        const [, r] = this.right.visible ? this.right.get_preferred_width(-1) : [0, 0];
        return Math.ceil(Math.max(l, r));
    }

    _centerWidth() {
        if (!this._center?.visible)
            return 0;
        return Math.ceil(this._center.get_preferred_width(-1)[1]);
    }

    vfunc_get_preferred_width(_forHeight) {
        const side = this._sideWidth();
        const gap = side > 0 ? this._spacing() : 0;
        const w = this._centerWidth() + 2 * (side + gap);
        return this.get_theme_node().adjust_preferred_width(w, w);
    }

    vfunc_get_preferred_height(_forWidth) {
        let h = 0;
        for (const child of this.get_children()) {
            if (child.visible)
                h = Math.max(h, child.get_preferred_height(-1)[1]);
        }
        return this.get_theme_node().adjust_preferred_height(h, h);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const w = content.get_width();
        const h = content.get_height();
        const cw = this._centerWidth();
        const gap = this._sideWidth() > 0 ? this._spacing() : 0;
        // Integer centre so the middle child never lands on a half pixel.
        const cx = content.x1 + Math.floor((w - cw) / 2);
        const child = new Clutter.ActorBox();

        const place = (actor, x, width) => {
            const [, natH] = actor.get_preferred_height(width);
            const y = content.y1 + Math.floor((h - natH) / 2);
            child.set_origin(x, y);
            child.set_size(width, natH);
            actor.allocate(child);
        };

        if (this._center?.visible)
            place(this._center, cx, cw);

        const [, lw] = this.left.get_preferred_width(-1);
        const [, rw] = this.right.get_preferred_width(-1);
        const lx = this._hugEdges ? content.x1 : cx - gap - lw;
        const rx = this._hugEdges ? content.x2 - rw : cx + cw + gap;
        place(this.left, Math.round(lx), Math.ceil(lw));
        place(this.right, Math.round(rx), Math.ceil(rw));
    }
});
