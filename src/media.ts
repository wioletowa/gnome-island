import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

import {MprisPlayer} from 'resource:///org/gnome/shell/ui/mpris.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

export interface MediaState {
    player: any;
    playing: boolean;
    title: string;
    artists: string[];
    /** Local file URI of the cover art, or null while loading / missing. */
    coverUri: string | null;
}

/**
 * Tracks MPRIS players and picks the one to show: the player that most
 * recently started playing. Emits `changed` whenever the shown state changes.
 */
export const MediaWatcher = GObject.registerClass({
    Signals: {'changed': {}},
}, class MediaWatcher extends GObject.Object {
    private _players = new Map<string, any>();
    private _lastChange = new Map<any, number>();
    private _lastStatus = new Map<any, boolean>();
    private _subscription = 0;
    private _covers: CoverCache;
    private _coverUri: string | null = null;
    private _coverFor = '';
    private _destroyed = false;

    constructor() {
        super();
        this._covers = new CoverCache();
        const bus = Gio.DBus.session;
        this._subscription = bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack() as string[];
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, null, (_b, res) => {
                if (this._destroyed)
                    return;
                try {
                    const [names] = bus.call_finish(res).deepUnpack() as [string[]];
                    for (const name of names) {
                        if (name.startsWith(MPRIS_PREFIX))
                            this._addPlayer(name);
                    }
                } catch (e) {
                    logError(e as object, 'gnome-island: ListNames');
                }
            });
    }

    private _addPlayer(name: string) {
        if (this._players.has(name))
            return;
        const player = new MprisPlayer(name);
        this._players.set(name, player);
        player.connectObject(
            'changed', () => this._onPlayerChanged(player),
            'notify::can-play', () => this.emit('changed'),
            this);
    }

    private _removePlayer(name: string) {
        const player = this._players.get(name);
        if (!player)
            return;
        player.disconnectObject(this);
        this._players.delete(name);
        this._lastChange.delete(player);
        this._lastStatus.delete(player);
        this.emit('changed');
    }

    private _onPlayerChanged(player: any) {
        const playing = player.status === 'Playing';
        const last = this._lastStatus.get(player);
        if (last !== playing) {
            this._lastStatus.set(player, playing);
            this._lastChange.set(player, GLib.get_monotonic_time());
        }
        this.emit('changed');
    }

    /** The player to display: playing ones first, then most recently changed. */
    get activePlayer(): any {
        let best: any = null;
        let bestPlaying = false;
        let bestTime = -Infinity;
        for (const player of this._players.values()) {
            if (!player.canPlay)
                continue;
            const playing = player.status === 'Playing';
            const t = this._lastChange.get(player) ?? -1;
            if (!best || (playing && !bestPlaying) || (playing === bestPlaying && t > bestTime)) {
                best = player;
                bestPlaying = playing;
                bestTime = t;
            }
        }
        return best;
    }

    get state(): MediaState | null {
        const player = this.activePlayer;
        if (!player)
            return null;
        this._updateCover(player.trackCoverUrl ?? '');
        return {
            player,
            playing: player.status === 'Playing',
            title: player.trackTitle ?? '',
            artists: player.trackArtists ?? [],
            coverUri: this._coverUri,
        };
    }

    private _updateCover(url: string) {
        if (url === this._coverFor)
            return;
        this._coverFor = url;
        this._coverUri = null;
        if (!url)
            return;
        this._covers.resolve(url).then(uri => {
            if (this._destroyed || this._coverFor !== url)
                return;
            this._coverUri = uri;
            this.emit('changed');
        }).catch(e => logError(e as object, 'gnome-island: cover'));
    }

    destroy() {
        this._destroyed = true;
        if (this._subscription)
            Gio.DBus.session.signal_unsubscribe(this._subscription);
        this._subscription = 0;
        for (const player of this._players.values())
            player.disconnectObject(this);
        this._players.clear();
        this._lastChange.clear();
        this._lastStatus.clear();
        this._covers.destroy();
    }
});

export type MediaWatcherType = InstanceType<typeof MediaWatcher>;

/**
 * Turns MPRIS art URLs into local file URIs that St can use as a
 * background image. Remote art (e.g. Spotify) is downloaded once into the
 * user cache.
 */
class CoverCache {
    private _session: any = null;
    private _dir: string;
    private _cancellable = new Gio.Cancellable();

    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-island', 'covers']);
        GLib.mkdir_with_parents(this._dir, 0o700);
    }

    async resolve(url: string): Promise<string | null> {
        if (url.startsWith('file://'))
            return url;
        if (!url.startsWith('http://') && !url.startsWith('https://'))
            return null;

        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const path = GLib.build_filenamev([this._dir, name!]);
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null))
            return file.get_uri();

        this._session ??= new Soup.Session({timeout: 10});
        const msg = Soup.Message.new('GET', url);
        if (!msg)
            return null;
        const bytes = await new Promise<GLib.Bytes>((resolve, reject) => {
            this._session!.send_and_read_async(msg, GLib.PRIORITY_LOW, this._cancellable, (s, res) => {
                try {
                    resolve(s!.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (msg.get_status() !== Soup.Status.OK)
            return null;
        await new Promise<void>((resolve, reject) => {
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable, (f, res) => {
                    try {
                        f!.replace_contents_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        this._prune();
        return file.get_uri();
    }

    /** Keeps the cache small: drop the oldest files beyond 64 entries. */
    private _prune() {
        try {
            const dir = Gio.File.new_for_path(this._dir);
            const en = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            const files: [string, number][] = [];
            let info;
            while ((info = en.next_file(null)))
                files.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
            files.sort((a, b) => b[1] - a[1]);
            for (const [n] of files.slice(64))
                dir.get_child(n).delete(null);
        } catch (e) {
            logError(e as object, 'gnome-island: prune covers');
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._session?.abort();
        this._session = null;
    }
}
