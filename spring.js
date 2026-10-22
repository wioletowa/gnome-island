import Clutter from 'gi://Clutter';

export const DEFAULT_SPRING = {stiffness: 320, damping: 26, mass: 1};

const REST_VELOCITY = 0.5;
const REST_DISTANCE = 0.05;
// Integration step in seconds; small enough to stay stable for stiff springs.
const MAX_STEP = 1 / 480;

/**
 * A damped harmonic oscillator. Retargeting keeps the current velocity, so
 * an animation can be interrupted mid-flight without a visible jump.
 */
export class Spring {
    velocity = 0;

    constructor(value, params = DEFAULT_SPRING) {
        this.value = value;
        this.target = value;
        this.params = params;
    }

    get settled() {
        return Math.abs(this.velocity) < REST_VELOCITY &&
            Math.abs(this.target - this.value) < REST_DISTANCE;
    }

    snap(value = this.target) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
    }

    step(dt) {
        if (this.settled) {
            this.value = this.target;
            this.velocity = 0;
            return;
        }
        const {stiffness, damping, mass} = this.params;
        let remaining = dt;
        while (remaining > 0) {
            const h = Math.min(remaining, MAX_STEP);
            const force = -stiffness * (this.value - this.target) - damping * this.velocity;
            this.velocity += (force / mass) * h;
            this.value += this.velocity * h;
            remaining -= h;
        }
    }
}

/**
 * Drives a set of springs from the stage frame clock of an actor and calls
 * `onFrame` after each step. Stops itself once everything is at rest.
 */
export class SpringDriver {
    _springs = new Set();

    constructor(actor, onFrame) {
        this._onFrame = onFrame;
        this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
    }

    add(spring) {
        this._springs.add(spring);
        return spring;
    }

    remove(spring) {
        this._springs.delete(spring);
    }

    setParams(params) {
        for (const s of this._springs)
            s.params = params;
    }

    /** Call after changing any target. */
    kick() {
        if (!this._timeline.is_playing())
            this._timeline.start();
    }

    _tick() {
        // Clamp so a stalled frame (e.g. after a VT switch) does not explode.
        const dt = Math.min(this._timeline.get_delta() / 1000, 1 / 20);
        for (const s of this._springs)
            s.step(dt);
        // onFrame may retarget springs (staged animations), so decide about
        // stopping only afterwards.
        this._onFrame();
        let settled = true;
        for (const s of this._springs) {
            if (!s.settled)
                settled = false;
        }
        if (settled)
            this._timeline.stop();
    }

    destroy() {
        this._timeline.stop();
        this._timeline.run_dispose();
        this._springs.clear();
    }
}
