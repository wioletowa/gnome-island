import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

/** Highest priority first; the island shows the first active kind. */
const PRIORITY = ['screencast', 'remote-recording', 'sharing', 'camera', 'microphone'];

export const PRIVACY_ICONS = {
    screencast: 'media-record-symbolic',
    'remote-recording': 'media-record-symbolic',
    sharing: 'screen-shared-symbolic',
    camera: 'camera-web-symbolic',
    microphone: 'audio-input-microphone-symbolic',
};

/** How long the microphone must stay unused before its icon goes away. */
const MIC_OFF_DELAY = 1500;

const SKIPPED_AUDIO_APPS = [
    'org.gnome.VolumeControl',
    'org.PulseAudio.pavucontrol',
    'gnome-island-visualizer',
];

/**
 * Watches screen recording, screen sharing, camera and microphone use.
 * Emits `changed`; `kind` is the most important active one and `since` is
 * when the current activity started (monotonic µs) for the timer.
 */
export const PrivacyMonitor = GObject.registerClass({
    Signals: {'changed': {}},
}, class PrivacyMonitor extends GObject.Object {
    _active = new Map();
    _handles = new Set();
    _micMuted = false;
    _micOffId = 0;

    constructor() {
        super();

        Main.screenshotUI.connectObject('notify::screencast-in-progress', () =>
            this._set('screencast', Main.screenshotUI.screencast_in_progress), this);
        this._set('screencast', Main.screenshotUI.screencast_in_progress, false);

        // Screen sharing / remote recording through the portal. Handles that
        // already exist are only known to GNOME's own indicators.
        const controller = global.backend.get_remote_access_controller?.();
        controller?.connectObject('new-handle', (_c, handle) =>
            this._addHandle(handle), this);
        const statusArea = Main.panel.statusArea;
        const existing = [
            ...(statusArea.screenSharing?._handles ?? []),
            ...(statusArea.quickSettings?._remoteAccess?._handles ?? []),
        ];
        for (const handle of existing)
            this._addHandle(handle, false);
        this._syncHandles(false);

        this._cameraMonitor = new Shell.CameraMonitor();
        this._cameraMonitor.connectObject('notify::cameras-in-use', () =>
            this._set('camera', !!this._cameraMonitor.cameras_in_use), this);
        this._set('camera', !!this._cameraMonitor.cameras_in_use, false);

        this._mixer = Volume.getMixerControl();
        this._mixer.connectObject(
            'stream-added', () => this._syncMicrophone(),
            'stream-removed', () => this._syncMicrophone(),
            'stream-changed', () => this._syncMicrophone(),
            this);
        this._syncMicrophone(false);
    }

    _addHandle(handle, sync = true) {
        if (this._handles.has(handle))
            return;
        this._handles.add(handle);
        handle.connectObject('stopped', () => {
            this._handles.delete(handle);
            this._syncHandles();
        }, this);
        if (sync)
            this._syncHandles();
    }

    _syncHandles(notify = true) {
        let sharing = 0;
        let recording = 0;
        for (const h of this._handles) {
            if (h.isRecording)
                recording++;
            else
                sharing++;
        }
        // The screenshot UI's own screencast also shows up as a recording
        // handle; it is reported through screenshotUI instead.
        if (Main.screenshotUI.screencast_in_progress)
            recording = Math.max(0, recording - 1);
        this._set('sharing', sharing > 0, notify);
        this._set('remote-recording', recording > 0, notify);
    }

    _syncMicrophone(notify = true) {
        let active = false;
        try {
            active =
                this._mixer.get_sources().some(s => s.state === Gvc.MixerStreamState.RUNNING) &&
                this._mixer.get_source_outputs().some(o =>
                    !SKIPPED_AUDIO_APPS.includes(o.get_application_id() ?? '') &&
                    !SKIPPED_AUDIO_APPS.includes(o.get_name() ?? ''));
        } catch (e) {
            logError(e, 'gnome-island: microphone state');
        }
        let muted = false;
        try {
            muted = !!this._mixer.get_default_source()?.is_muted;
        } catch {}
        const mutedChanged = muted !== this._micMuted;
        this._micMuted = muted;

        // Muting can briefly suspend the source; don't drop the indicator
        // for that blip, only when the app has really stopped.
        if (this._micOffId) {
            GLib.source_remove(this._micOffId);
            this._micOffId = 0;
        }
        if (!active && this._active.has('microphone') && notify) {
            this._micOffId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MIC_OFF_DELAY, () => {
                this._micOffId = 0;
                this._set('microphone', false);
                return GLib.SOURCE_REMOVE;
            });
            if (mutedChanged)
                this.emit('changed');
            return;
        }
        this._set('microphone', active, notify);
        if (mutedChanged && active && notify)
            this.emit('changed');
    }

    get microphoneMuted() {
        return this._micMuted;
    }

    _set(kind, on, notify = true) {
        if (on === this._active.has(kind))
            return;
        if (on)
            this._active.set(kind, GLib.get_monotonic_time());
        else
            this._active.delete(kind);
        if (notify)
            this.emit('changed');
    }

    /** All active kinds, most important first. */
    get kinds() {
        return PRIORITY.filter(k => this._active.has(k));
    }

    get kind() {
        return this.kinds[0] ?? null;
    }

    /** Start time (monotonic µs) of an active kind. */
    sinceOf(kind) {
        return this._active.get(kind) ?? 0;
    }

    /** Stops what can be stopped from the island: screencasts and screen sharing. */
    stop() {
        if (this._active.has('screencast'))
            Main.screenshotUI.stopScreencast();
        for (const h of [...this._handles]) {
            if (!h.isRecording)
                h.stop();
        }
    }

    destroy() {
        if (this._micOffId)
            GLib.source_remove(this._micOffId);
        this._micOffId = 0;
        Main.screenshotUI.disconnectObject(this);
        global.backend.get_remote_access_controller?.()?.disconnectObject(this);
        for (const h of this._handles)
            h.disconnectObject(this);
        this._handles.clear();
        this._cameraMonitor?.disconnectObject(this);
        this._cameraMonitor = null;
        this._mixer.disconnectObject(this);
    }
});
