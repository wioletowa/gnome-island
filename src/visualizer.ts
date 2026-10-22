import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const SPECTRUM_BANDS = 64;
const THRESHOLD_DB = -70;
const INTERVAL_NS = 30_000_000;
// Ignore the very top of the spectrum, which carries little musical energy.
const MAX_BAND_FRACTION = 0.6;

let Gst: any = null;

async function loadGst(): Promise<any> {
    if (Gst)
        return Gst;
    try {
        Gst = (await import('gi://Gst?version=1.0')).default;
        if (!Gst.is_initialized())
            Gst.init(null);
    } catch (e) {
        logError(e as object, 'gnome-island: GStreamer unavailable, visualizer disabled');
        Gst = null;
    }
    return Gst;
}

/**
 * Captures the monitor of the default output with GStreamer and posts
 * per-bar levels in [0, 1]. The pipeline only runs while started, so it
 * costs nothing when nothing is playing.
 */
export class SpectrumAnalyzer {
    private _pipeline: any = null;
    private _busId = 0;
    private _listeners = new Set<(levels: number[]) => void>();
    private _bars = 5;
    private _sensitivity = 1;
    private _wanted = false;
    private _destroyed = false;

    configure(bars: number, sensitivity: number) {
        this._bars = bars;
        this._sensitivity = sensitivity;
    }

    addListener(cb: (levels: number[]) => void) {
        this._listeners.add(cb);
    }

    removeListener(cb: (levels: number[]) => void) {
        this._listeners.delete(cb);
    }

    async start() {
        this._wanted = true;
        if (this._pipeline)
            return;
        const gst = await loadGst();
        if (!gst || !this._wanted || this._pipeline || this._destroyed)
            return;
        try {
            this._pipeline = gst.parse_launch(
                'pulsesrc device=@DEFAULT_MONITOR@ client-name=gnome-island-visualizer ' +
                'stream-properties="props,media.role=music,application.id=gnome-island-visualizer" ! ' +
                'audioconvert ! audio/x-raw,channels=1 ! ' +
                `spectrum bands=${SPECTRUM_BANDS} threshold=${THRESHOLD_DB} interval=${INTERVAL_NS} ` +
                'post-messages=true message-magnitude=true message-phase=false ! ' +
                'fakesink sync=false');
        } catch (e) {
            logError(e as object, 'gnome-island: could not build visualizer pipeline');
            this._pipeline = null;
            return;
        }
        const bus = this._pipeline.get_bus();
        bus.add_signal_watch();
        this._busId = bus.connect('message::element', (_b: any, msg: any) => this._onMessage(msg));
        this._pipeline.set_state(gst.State.PLAYING);
    }

    stop() {
        this._wanted = false;
        if (!this._pipeline)
            return;
        const bus = this._pipeline.get_bus();
        if (this._busId)
            bus.disconnect(this._busId);
        this._busId = 0;
        bus.remove_signal_watch();
        this._pipeline.set_state(Gst.State.NULL);
        this._pipeline = null;
        for (const cb of this._listeners)
            cb(new Array(this._bars).fill(0));
    }

    get running() {
        return this._pipeline !== null;
    }

    private _onMessage(msg: any) {
        const s = msg.get_structure();
        if (!s || s.get_name() !== 'spectrum')
            return;
        // GstValueList is awkward to unpack from GJS; the serialized form
        // is stable: "magnitude=(float){ -60.1, -59.3, ... }".
        const m = /magnitude=\(float\)\{([^}]*)\}/.exec(s.to_string());
        if (!m)
            return;
        const mags = m[1].split(',').map(v => parseFloat(v));
        const levels = this._group(mags);
        for (const cb of this._listeners)
            cb(levels);
    }

    /** Groups linear FFT bands into bars on a logarithmic frequency scale. */
    private _group(mags: number[]): number[] {
        const n = this._bars;
        const usable = Math.max(n, Math.floor(mags.length * MAX_BAND_FRACTION));
        const levels: number[] = [];
        for (let i = 0; i < n; i++) {
            const from = Math.floor(Math.pow(usable, i / n));
            const to = Math.max(from + 1, Math.floor(Math.pow(usable, (i + 1) / n)));
            let peak = THRESHOLD_DB;
            for (let b = from; b < to && b < mags.length; b++)
                peak = Math.max(peak, mags[b]);
            let v = (peak - THRESHOLD_DB) / -THRESHOLD_DB;
            // Higher bands are naturally quieter; lift them a little.
            v *= 1 + 0.35 * (i / Math.max(1, n - 1));
            levels.push(Math.max(0, Math.min(1, Math.pow(v, 1.6) * this._sensitivity * 1.4)));
        }
        return levels;
    }

    destroy() {
        this._destroyed = true;
        this.stop();
        this._listeners.clear();
    }
}

/**
 * A row of rounded bars. Heights chase the latest levels every frame with a
 * fast attack and a slower release, so 30 Hz analysis data looks fluid.
 */
export const VisualizerBars = GObject.registerClass(
class VisualizerBars extends St.BoxLayout {
    private _bars: St.Widget[] = [];
    private _targets: number[] = [];
    private _values: number[] = [];
    private _timeline: Clutter.Timeline;
    private _maxHeight = 16;
    private _minHeight = 3;
    private _color = '#ffffff';

    constructor(count: number) {
        super({
            style_class: 'island-visualizer',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        // Fixed outer height so bar movement never resizes the island.
        this.height = this._maxHeight;
        this.setCount(count);
        this.connect('destroy', () => this._timeline.stop());
    }

    setColor(color: string) {
        this._color = color;
        for (const bar of this._bars)
            bar.set_style(`background-color: ${color};`);
    }

    setCount(count: number) {
        for (const bar of this._bars)
            bar.destroy();
        this._bars = [];
        this._targets = new Array(count).fill(0);
        this._values = new Array(count).fill(0);
        for (let i = 0; i < count; i++) {
            const bar = new St.Widget({
                style_class: 'island-visualizer-bar',
                y_align: Clutter.ActorAlign.CENTER,
                style: `background-color: ${this._color};`,
            });
            bar.height = this._minHeight;
            this._bars.push(bar);
            this.add_child(bar);
        }
    }

    setLevels(levels: number[]) {
        for (let i = 0; i < this._targets.length; i++)
            this._targets[i] = levels[i] ?? 0;
        if (this.mapped && !this._timeline.is_playing())
            this._timeline.start();
    }

    private _tick() {
        const dt = Math.min(this._timeline.get_delta() / 1000, 0.05);
        let moving = false;
        for (let i = 0; i < this._bars.length; i++) {
            const target = this._targets[i];
            const cur = this._values[i];
            // Exponential smoothing; attack faster than release.
            const rate = target > cur ? 28 : 9;
            const next = cur + (target - cur) * (1 - Math.exp(-rate * dt));
            this._values[i] = next;
            if (Math.abs(next - target) > 0.002)
                moving = true;
            this._bars[i].height = Math.round(this._minHeight + next * (this._maxHeight - this._minHeight));
        }
        if (!moving || !this.mapped)
            this._timeline.stop();
    }
});

export type VisualizerBarsType = InstanceType<typeof VisualizerBars>;
