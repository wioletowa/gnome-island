import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export interface IslandNotification {
    appName: string;
    icon: Gio.Icon | null;
    title: string;
    urgency: number;
}

/**
 * Listens for notifications that would show a banner, re-emits them as
 * `notification` and (when `blockBanners` is set) keeps the stock banners
 * from appearing. Notifications still land in the calendar's list.
 */
export const NotificationWatcher = GObject.registerClass({
    Signals: {'notification': {param_types: [GObject.TYPE_JSOBJECT]}},
}, class NotificationWatcher extends GObject.Object {
    private _sources = new Set<any>();
    private _blockBanners = false;
    private _externalBlocked = false;

    constructor() {
        super();
        const tray = Main.messageTray as any;
        tray.connectObject(
            'source-added', (_t: unknown, source: any) => this._addSource(source),
            'source-removed', (_t: unknown, source: any) => this._removeSource(source),
            this);
        for (const source of tray.getSources())
            this._addSource(source);

        // The date menu toggles bannerBlocked when it opens and closes;
        // route that through us so our own block is not lost.
        this._externalBlocked = tray._bannerBlocked;
        Object.defineProperty(tray, 'bannerBlocked', {
            configurable: true,
            get: () => this._externalBlocked,
            set: (v: boolean) => {
                this._externalBlocked = v;
                this._applyBlock();
            },
        });
    }

    set blockBanners(v: boolean) {
        this._blockBanners = v;
        this._applyBlock();
    }

    private _applyBlock() {
        const tray = Main.messageTray as any;
        const blocked = this._externalBlocked || this._blockBanners;
        if (tray._bannerBlocked === blocked)
            return;
        // Drop anything queued while we were blocking so stale banners do
        // not pop up later.
        if (!blocked && this._blockBanners === false && tray._notificationQueue)
            tray._notificationQueue.length = 0;
        tray._bannerBlocked = blocked;
        tray._updateState();
    }

    private _addSource(source: any) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject('notification-request-banner',
            (_s: unknown, n: any) => this._onBanner(n), this);
    }

    private _removeSource(source: any) {
        source.disconnectObject(this);
        this._sources.delete(source);
    }

    private _onBanner(n: any) {
        // Same filtering as the message tray uses for banners.
        if (n.acknowledged || n.urgency === MessageTray.Urgency.LOW)
            return;
        if (!n.source.policy.showBanners && n.urgency !== MessageTray.Urgency.CRITICAL)
            return;
        const tray = Main.messageTray as any;
        if (tray._busy && n.urgency !== MessageTray.Urgency.CRITICAL && !n.forFeedback)
            return;
        // Drop it from the banner queue right away when we are replacing
        // banners; the tray handler runs after ours.
        if (this._blockBanners) {
            const queue: any[] | undefined = tray._notificationQueue;
            const later = () => {
                const i = queue?.indexOf(n) ?? -1;
                if (i >= 0) {
                    queue!.splice(i, 1);
                    // GNOME's unread dot subtracts queued banners; let it recount.
                    tray.emit('queue-changed');
                }
            };
            Promise.resolve().then(later);
        }
        this.emit('notification', {
            appName: n.source.title ?? '',
            icon: n.source.icon ?? n.gicon ?? null,
            title: n.title ?? '',
            urgency: n.urgency,
        } as IslandNotification);
    }

    destroy() {
        const tray = Main.messageTray as any;
        tray.disconnectObject(this);
        for (const s of this._sources)
            s.disconnectObject(this);
        this._sources.clear();
        this._blockBanners = false;
        delete tray.bannerBlocked;
        if (tray._notificationQueue)
            tray._notificationQueue.length = 0;
        tray.bannerBlocked = this._externalBlocked;
    }
});

export type NotificationWatcherType = InstanceType<typeof NotificationWatcher>;
