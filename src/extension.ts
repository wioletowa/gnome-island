import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Config} from './config.js';
import {Island, IslandType} from './island.js';
import {ExpandedRow, ExpandedRowType, PanelBridge} from './bridge.js';
import {Odometer, OdometerType, SecondTicker} from './odometer.js';
import {MediaWatcher, MediaWatcherType} from './media.js';
import {SpectrumAnalyzer} from './visualizer.js';
import {PrivacyMonitor, PrivacyMonitorType} from './privacy.js';
import {IslandNotification, NotificationWatcher, NotificationWatcherType} from './notifications.js';
import {
    BubbleView, BubbleViewType, MediaView, MediaViewType, NotificationView,
    NotificationViewType, RecordingView, RecordingViewType,
} from './views.js';

interface IslandHost {
    island: IslandType;
    row: ExpandedRowType;
    clock: OdometerType;
    media: MediaViewType;
    recording: RecordingViewType;
    notification: NotificationViewType;
    bubble: BubbleViewType;
    /** Own chrome container for non-primary monitors; null on primary. */
    container: St.Widget | null;
    monitorIndex: number;
}

/** Notifications that waited longer than this (while expanded) are dropped. */
const NOTIFICATION_MAX_WAIT_US = 10_000_000;

export default class IslandExtension extends Extension {
    private _config: Config | null = null;
    private _bridge: PanelBridge | null = null;
    private _ticker: SecondTicker | null = null;
    private _media: MediaWatcherType | null = null;
    private _analyzer: SpectrumAnalyzer | null = null;
    private _privacy: PrivacyMonitorType | null = null;
    private _notifications: NotificationWatcherType | null = null;
    private _hosts: IslandHost[] = [];
    private _expanded: IslandHost | null = null;
    private _expandedClock: OdometerType | null = null;
    private _collapseId = 0;
    private _tickCb: ((now: GLib.DateTime) => void) | null = null;
    private _levelsCb: ((levels: number[]) => void) | null = null;
    private _origToggleCalendar: (() => void) | null = null;
    private _origToggleQuickSettings: (() => void) | null = null;

    private _pausedSince = 0;
    private _pausedTimeoutId = 0;
    private _notifQueue: [IslandNotification, number][] = [];
    private _notifActive = false;
    private _notifTimeoutId = 0;

    enable() {
        this._config = new Config(this.getSettings());
        this._ticker = new SecondTicker();

        Main.panel.hide();

        this._expandedClock = new Odometer({style_class: 'island-odometer clock'});

        this._analyzer = new SpectrumAnalyzer();
        this._analyzer.configure(this._config.visualizerBars, this._config.visualizerSensitivity);
        this._levelsCb = levels => {
            for (const host of this._hosts)
                host.media.bars.setLevels(levels);
        };
        this._analyzer.addListener(this._levelsCb);

        this._buildHosts();

        this._media = new MediaWatcher();
        this._media.connect('changed', () => this._updateViews());
        this._privacy = new PrivacyMonitor();
        this._privacy.connect('changed', () => this._updateViews());
        this._notifications = new NotificationWatcher();
        this._notifications.blockBanners = this._config.notificationsInIsland;
        this._notifications.connect('notification', (_w, n: IslandNotification) =>
            this._onNotification(n));

        this._tickCb = now => this._onTick(now);
        this._ticker.add(this._tickCb);

        this._patchPanel();

        Main.layoutManager.connectObject('monitors-changed', () => this._buildHosts(), this);
        global.stage.connectObject('captured-event', (_s: Clutter.Actor, e: Clutter.Event) =>
            this._onCapturedEvent(e), this);
        this._config.settings.connectObject('changed', (_s: unknown, key: string) =>
            this._onSettingChanged(key), this);

        this._updateViews();
    }

    disable() {
        this._cancelCollapse();
        for (const id of [this._pausedTimeoutId, this._notifTimeoutId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._pausedTimeoutId = 0;
        this._notifTimeoutId = 0;
        this._notifQueue = [];
        this._notifActive = false;
        this._pausedSince = 0;

        this._unpatchPanel();
        Main.layoutManager.disconnectObject(this);
        global.stage.disconnectObject(this);
        this._config?.settings.disconnectObject(this);

        this._notifications?.destroy();
        this._notifications = null;
        this._privacy?.destroy();
        this._privacy = null;
        this._media?.destroy();
        this._media = null;
        this._analyzer?.destroy();
        this._analyzer = null;
        this._levelsCb = null;

        // Return indicators before their island rows are destroyed.
        this._bridge?.destroy();
        this._bridge = null;
        this._destroyHosts();
        this._expanded = null;

        this._expandedClock?.destroy();
        this._expandedClock = null;
        this._ticker?.destroy();
        this._ticker = null;
        this._tickCb = null;

        Main.panel.show();
        this._config = null;
    }

    // --- Hosts (one island per monitor) ---------------------------------

    private _buildHosts() {
        const config = this._config!;
        const expandedMonitor = this._expanded?.monitorIndex ?? null;
        this._expanded = null;
        // Hand indicators back to the panel while the islands are rebuilt.
        this._bridge?.destroy();
        this._destroyHosts();
        this._bridge = new PanelBridge();
        this._bridge.setClockActor(this._expandedClock);

        const layout = Main.layoutManager;
        const monitors = config.allMonitors ? layout.monitors : [layout.primaryMonitor];
        for (const monitor of monitors) {
            if (!monitor)
                continue;
            const host = this._createHost(monitor.index);
            if (monitor.index === layout.primaryIndex) {
                layout.panelBox.add_child(host.island);
            } else {
                const container = new St.Widget({
                    layout_manager: new Clutter.BinLayout(),
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                });
                container.add_child(host.island);
                layout.addChrome(container, {affectsStruts: true, trackFullscreen: true});
                host.container = container;
            }
            this._hosts.push(host);
        }

        const primary = this._primaryHost();
        if (primary)
            this._bridge.attach(primary.row);

        if (this._tickCb)
            this._onTick(GLib.DateTime.new_now_local());
        this._updateViews();
        for (const host of this._hosts)
            host.island.snap();

        if (expandedMonitor !== null) {
            const host = this._hosts.find(h => h.monitorIndex === expandedMonitor);
            if (host)
                this._expand(host);
        }
    }

    private _createHost(monitorIndex: number): IslandHost {
        const config = this._config!;
        const island = new Island(config.metrics, config.spring);
        island.setBlurEnabled(config.blurTransitions);

        const clock = new Odometer({style_class: 'island-odometer island-compact-clock'});
        island.addView('clock', clock);

        const media = new MediaView(config.visualizerBars);
        media.bars.visible = config.visualizerEnabled;
        island.addView('media', media);

        const recording = new RecordingView();
        island.addView('recording', recording);

        const notification = new NotificationView();
        island.addView('notification', notification);

        const row = new ExpandedRow();
        row.setOrder(config.itemOrder);
        row.set_style(`height: ${config.metrics.expandedHeight}px;`);
        island.addView('expanded', row);

        const bubble = new BubbleView();
        island.addView('privacy', bubble, {bubble: true});

        const host: IslandHost = {
            island, row, clock, media, recording, notification, bubble,
            container: null, monitorIndex,
        };
        this._applyColors(host);

        island.connect('pill-clicked', (_i, button: number) => this._onPillClicked(host, button));
        island.connect('bubble-clicked', () => this._onBubbleClicked(host));
        island.connect('hover-changed', (_i, hovered: boolean) => this._onHoverChanged(host, hovered));
        island.connect('key-escape', () => this._collapse());
        island.pill.connect('key-focus-out', () => this._onKeyFocusOut(host));
        return host;
    }

    private _destroyHosts() {
        for (const host of this._hosts) {
            if (host.container)
                host.container.destroy();
            else
                host.island.destroy();
        }
        this._hosts = [];
    }

    private _primaryHost(): IslandHost | undefined {
        return this._hosts.find(h => h.monitorIndex === Main.layoutManager.primaryIndex) ??
            this._hosts[0];
    }

    private _applyColors(host: IslandHost) {
        const {background, foreground, accent} = this._config!.colors;
        const style = `background-color: ${background}; color: ${foreground};`;
        host.island.pill.set_style(style);
        host.island.bubble.set_style(style);
        host.media.bars.setColor(accent);
    }

    // --- State → views -----------------------------------------------------

    private _mediaVisible(): boolean {
        const state = this._media?.state;
        if (!state) {
            this._pausedSince = 0;
            return false;
        }
        if (state.playing) {
            this._pausedSince = 0;
            return true;
        }
        // Keep a paused player around for a while, then fall back to the clock.
        const timeout = this._config!.pausedMediaTimeout;
        const now = GLib.get_monotonic_time();
        if (!this._pausedSince) {
            this._pausedSince = now;
            if (this._pausedTimeoutId)
                GLib.source_remove(this._pausedTimeoutId);
            this._pausedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout + 50, () => {
                this._pausedTimeoutId = 0;
                this._updateViews();
                return GLib.SOURCE_REMOVE;
            });
        }
        return now - this._pausedSince < timeout * 1000;
    }

    private _updateViews() {
        if (!this._config)
            return;
        const state = this._media?.state ?? null;
        const mediaVisible = this._mediaVisible();
        const kind = this._privacy?.kind ?? null;
        const since = this._privacy?.since ?? 0;

        for (const host of this._hosts) {
            host.media.cover.setUri(state?.coverUri ?? null);
            host.recording.update(kind, since);
            host.bubble.update(kind);

            if (host === this._expanded) {
                host.island.setView('expanded');
                host.island.setBubbleView(null);
                continue;
            }
            let view = 'clock';
            if (this._notifActive)
                view = 'notification';
            else if (mediaVisible)
                view = 'media';
            else if (kind)
                view = 'recording';
            host.island.setView(view);
            host.island.setBubbleView(
                !this._notifActive && mediaVisible && kind ? 'privacy' : null);
        }

        const anyMedia = this._hosts.some(h => h.island.currentView === 'media');
        if (this._config.visualizerEnabled && state?.playing && anyMedia)
            this._analyzer?.start();
        else
            this._analyzer?.stop();
    }

    // --- Clock -------------------------------------------------------------

    private _onTick(now: GLib.DateTime) {
        const config = this._config!;
        const compact = now.format(config.clockFormat) ?? '';
        for (const host of this._hosts) {
            host.clock.setText(compact);
            host.media.clock.setText(compact);
            host.recording.clock.setText(compact);
            if (this._privacy)
                host.recording.update(this._privacy.kind, this._privacy.since);
        }
        this._expandedClock?.setText(now.format(config.expandedClockFormat) ?? '');
    }

    // --- Notifications -----------------------------------------------------

    private _onNotification(n: IslandNotification) {
        if (!this._config!.notificationsInIsland)
            return;
        this._notifQueue.push([n, GLib.get_monotonic_time()]);
        this._showNextNotification();
    }

    private _showNextNotification() {
        if (this._notifActive || this._expanded)
            return;
        const now = GLib.get_monotonic_time();
        this._notifQueue = this._notifQueue.filter(([, t]) => now - t < NOTIFICATION_MAX_WAIT_US);
        const next = this._notifQueue.shift();
        if (!next)
            return;
        const [n] = next;
        for (const host of this._hosts)
            host.notification.show_(n.appName, n.icon);
        this._notifActive = true;
        this._updateViews();
        this._notifTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._config!.notificationDuration, () => {
                this._notifTimeoutId = 0;
                this._endNotification();
                return GLib.SOURCE_REMOVE;
            });
    }

    private _endNotification() {
        if (this._notifTimeoutId)
            GLib.source_remove(this._notifTimeoutId);
        this._notifTimeoutId = 0;
        if (!this._notifActive)
            return;
        this._notifActive = false;
        this._updateViews();
        // Leave a beat between consecutive notifications.
        if (this._notifQueue.length) {
            this._notifTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this._notifTimeoutId = 0;
                this._showNextNotification();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // --- Expand / collapse -------------------------------------------------

    private _onPillClicked(host: IslandHost, button: number) {
        if (button !== Clutter.BUTTON_PRIMARY && button !== Clutter.BUTTON_SECONDARY)
            return;
        if (this._expanded === host)
            return;
        if (this._notifActive) {
            // Clicking a notification opens the notification list.
            this._endNotification();
            this._expand(host);
            this._origToggleCalendar?.call(Main.panel);
            return;
        }
        this._expand(host);
    }

    private _onBubbleClicked(host: IslandHost) {
        if (this._privacy?.kind === 'screencast')
            this._privacy.stop();
        else
            this._expand(host);
    }

    private _expand(host: IslandHost) {
        const previous = this._expanded;
        this._expanded = host;
        this._bridge!.attach(host.row);
        if (previous && previous !== host)
            this._updateViews();
        host.island.setView('expanded');
        host.island.setBubbleView(null);
        this._updateViews();
        host.island.pill.grab_key_focus();
        this._cancelCollapse();
        if (!host.island.hovered)
            this._scheduleCollapse();
    }

    private _collapse() {
        this._cancelCollapse();
        const host = this._expanded;
        if (!host)
            return;
        const menu = (Main.panel.menuManager as any).activeMenu;
        if (menu)
            menu.close();
        this._expanded = null;
        this._updateViews();
        if (global.stage.key_focus && host.island.contains(global.stage.key_focus))
            global.stage.set_key_focus(null);
        this._showNextNotification();
    }

    private _scheduleCollapse() {
        this._cancelCollapse();
        this._collapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._config!.collapseDelay, () => {
            this._collapseId = 0;
            const host = this._expanded;
            if (!host)
                return GLib.SOURCE_REMOVE;
            if ((Main.panel.menuManager as any).activeMenu || host.island.hovered) {
                // A menu is open or the pointer came back; check again later.
                this._scheduleCollapse();
                return GLib.SOURCE_REMOVE;
            }
            this._collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _cancelCollapse() {
        if (this._collapseId)
            GLib.source_remove(this._collapseId);
        this._collapseId = 0;
    }

    private _onHoverChanged(host: IslandHost, hovered: boolean) {
        if (this._expanded !== host)
            return;
        if (hovered)
            this._cancelCollapse();
        else
            this._scheduleCollapse();
    }

    private _onKeyFocusOut(host: IslandHost) {
        if (this._expanded !== host)
            return;
        // Focus moving into a menu or one of our indicators is fine; focus
        // going to a window means the user clicked elsewhere.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._expanded !== host)
                return GLib.SOURCE_REMOVE;
            const focus = global.stage.key_focus;
            if ((Main.panel.menuManager as any).activeMenu)
                return GLib.SOURCE_REMOVE;
            if (focus && host.island.contains(focus))
                return GLib.SOURCE_REMOVE;
            if (global.display.focus_window)
                this._collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _onCapturedEvent(event: Clutter.Event) {
        const host = this._expanded;
        if (!host)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if ((Main.panel.menuManager as any).activeMenu)
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        if (target && host.island.contains(target))
            return Clutter.EVENT_PROPAGATE;
        this._collapse();
        return Clutter.EVENT_PROPAGATE;
    }

    // --- Panel API patches -------------------------------------------------

    private _patchPanel() {
        const panel = Main.panel as any;
        this._origToggleCalendar = panel.toggleCalendar;
        this._origToggleQuickSettings = panel.toggleQuickSettings;
        // Keyboard shortcuts (Super+V, Super+S) need the indicator mapped,
        // so expand an island first.
        panel.toggleCalendar = () => {
            this._expandForMenu();
            this._origToggleCalendar!.call(panel);
        };
        panel.toggleQuickSettings = () => {
            this._expandForMenu();
            this._origToggleQuickSettings!.call(panel);
        };
    }

    private _unpatchPanel() {
        const panel = Main.panel as any;
        if (this._origToggleCalendar)
            panel.toggleCalendar = this._origToggleCalendar;
        if (this._origToggleQuickSettings)
            panel.toggleQuickSettings = this._origToggleQuickSettings;
        this._origToggleCalendar = null;
        this._origToggleQuickSettings = null;
    }

    private _expandForMenu() {
        const host = this._expanded ?? this._primaryHost();
        if (host && this._expanded !== host)
            this._expand(host);
    }

    // --- Settings ----------------------------------------------------------

    private _onSettingChanged(key: string) {
        const config = this._config!;
        switch (key) {
        case 'all-monitors':
            this._buildHosts();
            break;
        case 'item-order':
            for (const host of this._hosts)
                host.row.setOrder(config.itemOrder);
            break;
        case 'spring-stiffness':
        case 'spring-damping':
        case 'spring-mass':
            for (const host of this._hosts)
                host.island.setSpringParams(config.spring);
            break;
        case 'blur-transitions':
            for (const host of this._hosts)
                host.island.setBlurEnabled(config.blurTransitions);
            break;
        case 'background-color':
        case 'foreground-color':
        case 'accent-color':
            for (const host of this._hosts)
                this._applyColors(host);
            break;
        case 'clock-format':
        case 'expanded-clock-format':
            this._onTick(GLib.DateTime.new_now_local());
            break;
        case 'visualizer-enabled':
            for (const host of this._hosts)
                host.media.bars.visible = config.visualizerEnabled;
            this._updateViews();
            break;
        case 'visualizer-bars':
        case 'visualizer-sensitivity':
            this._analyzer?.configure(config.visualizerBars, config.visualizerSensitivity);
            for (const host of this._hosts)
                host.media.bars.setCount(config.visualizerBars);
            break;
        case 'notifications-in-island':
            this._notifications!.blockBanners = config.notificationsInIsland;
            break;
        case 'paused-media-timeout':
            this._pausedSince = 0;
            this._updateViews();
            break;
        default:
            if (/height|margin|gap|padding/.test(key)) {
                for (const host of this._hosts) {
                    host.island.setMetrics(config.metrics);
                    host.row.set_style(`height: ${config.metrics.expandedHeight}px;`);
                }
            }
        }
    }
}
