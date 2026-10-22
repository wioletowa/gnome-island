import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

export type PrivacyKind = 'screencast' | 'sharing' | 'camera' | 'microphone';

/** Highest priority first; the island shows the first active kind. */
const PRIORITY: PrivacyKind[] = ['screencast', 'sharing', 'camera', 'microphone'];

export const PRIVACY_ICONS: Record<PrivacyKind, string> = {
    screencast: 'media-record-symbolic',
    sharing: 'screen-shared-symbolic',
    camera: 'camera-web-symbolic',
    microphone: 'audio-input-microphone-symbolic',
};

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
    private _active = new Map<PrivacyKind, number>();
    private _cameraMonitor: any;
    private _mixer: Gvc.MixerControl;
    private _handles = new Set<any>();

    constructor() {
        super();

        Main.screenshotUI.connectObject('notify::screencast-in-progress', () =>
            this._set('screencast', (Main.screenshotUI as any).screencast_in_progress), this);
        this._set('screencast', (Main.screenshotUI as any).screencast_in_progress, false);

        // Screen sharing / remote recording through the portal.
        const controller = (global.backend as any).get_remote_access_controller?.();
        controller?.connectObject('new-handle', (_c: unknown, handle: any) => {
            this._handles.add(handle);
            handle.connectObject('stopped', () => {
                this._handles.delete(handle);
                this._syncHandles();
            }, this);
            this._syncHandles();
        }, this);

        this._cameraMonitor = new (Shell as any).CameraMonitor();
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

    private _syncHandles() {
        // The screenshot UI's own screencast is reported separately.
        let n = 0;
        for (const h of this._handles) {
            if (h.is_recording !== false)
                n++;
        }
        if ((Main.screenshotUI as any).screencast_in_progress)
            n = Math.max(0, n - 1);
        this._set('sharing', n > 0);
    }

    private _syncMicrophone(notify = true) {
        let active = false;
        try {
            active =
                this._mixer.get_sources().some(s => s.state === Gvc.MixerStreamState.RUNNING) &&
                this._mixer.get_source_outputs().some(o =>
                    !SKIPPED_AUDIO_APPS.includes(o.get_application_id() ?? '') &&
                    !SKIPPED_AUDIO_APPS.includes(o.get_name() ?? ''));
        } catch (e) {
            logError(e as object, 'gnome-island: microphone state');
        }
        this._set('microphone', active, notify);
    }

    private _set(kind: PrivacyKind, on: boolean, notify = true) {
        if (on === this._active.has(kind))
            return;
        if (on)
            this._active.set(kind, GLib.get_monotonic_time());
        else
            this._active.delete(kind);
        if (notify)
            this.emit('changed');
    }

    get kind(): PrivacyKind | null {
        return PRIORITY.find(k => this._active.has(k)) ?? null;
    }

    get since(): number {
        const k = this.kind;
        return k ? this._active.get(k)! : 0;
    }

    /** Stops what can be stopped from the island (our own screencast). */
    stop() {
        if (this.kind === 'screencast')
            (Main.screenshotUI as any).stopScreencast();
    }

    destroy() {
        Main.screenshotUI.disconnectObject(this);
        (global.backend as any).get_remote_access_controller?.()?.disconnectObject(this);
        for (const h of this._handles)
            h.disconnectObject(this);
        this._handles.clear();
        this._cameraMonitor?.disconnectObject(this);
        this._cameraMonitor = null;
        this._mixer.disconnectObject(this);
    }
});

export type PrivacyMonitorType = InstanceType<typeof PrivacyMonitor>;
