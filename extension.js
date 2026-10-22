import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import {Config} from './config.js';
import {Island} from './island.js';
import {ExpandedRow, PanelBridge} from './bridge.js';
import {SecondTicker} from './odometer.js';
import {MediaWatcher} from './media.js';
import {PrivacyMonitor} from './privacy.js';
import {captureUsers} from './pipewire.js';
import {NotificationWatcher} from './notifications.js';
import {
    BubbleView, ClockWidget, CoverArt, MediaView, MessagesDotMirror,
    NotificationView, OsdView, WorkspaceDots,
} from './views.js';
import {SpectrumAnalyzer, VisualizerBars} from './visualizer.js';

/** Same as GNOME's OSD hide timeout. */
const OSD_TIMEOUT = 1500;
/** How long the workspace dots replace the collapsed island. */
const WORKSPACE_TIMEOUT = 1000;

/** Hover delay before the privacy tooltip appears. */
const TOOLTIP_DELAY = 250;

/** Notifications that waited longer than this (while expanded) are dropped. */
const NOTIFICATION_MAX_WAIT_US = 10_000_000;

export default class IslandExtension extends Extension {
    _config = null;
    _bridge = null;
    _ticker = null;
    _media = null;
    _analyzer = null;
    _privacy = null;
    _notifications = null;
    _hosts = [];
    _expanded = null;
    _expandedClock = null;
    _collapseId = 0;
    _tickCb = null;
    _levelsCb = null;
    _origToggleCalendar = null;
    _origToggleQuickSettings = null;

    _pausedSince = 0;
    _pausedTimeoutId = 0;
    _notifQueue = [];
    _notifActive = false;
    _notifTimeoutId = 0;
    _wsActive = false;
    _tooltip = null;
    _tooltipId = 0;
    _tooltipKind = null;
    _tooltipCancel = null;
    _wsTimeoutId = 0;
    _origShowOsd = null;
    _origWsDisplay = null;

    enable() {
        this._config = new Config(this.getSettings());
        this._ticker = new SecondTicker();

        Main.panel.hide();

        this._expandedClock = new ClockWidget();
        // GNOME's hover/checked highlight targets `.clock` inside the button.
        this._expandedClock.add_style_class_name('clock');

        this._analyzer = new SpectrumAnalyzer();
        this._analyzer.configure(this._config.visualizerBars, this._config.visualizerSensitivity);
        this._levelsCb = levels => {
            for (const host of this._hosts) {
                host.media.bars.setLevels(levels);
                host.rowBars.setLevels(levels);
            }
        };
        this._analyzer.addListener(this._levelsCb);

        this._buildHosts();

        this._media = new MediaWatcher();
        this._media.connect('changed', () => this._updateViews());
        this._privacy = new PrivacyMonitor();
        this._privacy.connect('changed', () => this._updateViews());
        this._notifications = new NotificationWatcher();
        this._notifications.blockBanners = this._config.notificationsInIsland;
        this._notifications.connect('notification', (_w, n) =>
            this._onNotification(n));

        this._tickCb = now => this._onTick(now);
        this._ticker.add(this._tickCb);

        this._patchPanel();
        this._patchOsd();
        this._patchWorkspacePopup();
        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._onWorkspaceChanged(), this);

        Main.layoutManager.connectObject('monitors-changed', () => this._buildHosts(), this);
        global.stage.connectObject('captured-event', (_s, e) =>
            this._onCapturedEvent(e), this);
        this._config.settings.connectObject('changed', (_s, key) =>
            this._onSettingChanged(key), this);

        this._updateViews();
    }

    disable() {
        this._cancelCollapse();
        for (const id of [this._pausedTimeoutId, this._notifTimeoutId, this._wsTimeoutId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._pausedTimeoutId = 0;
        this._notifTimeoutId = 0;
        this._wsTimeoutId = 0;
        this._wsActive = false;
        global.workspace_manager.disconnectObject(this);
        this._unpatchWorkspacePopup();
        this._unpatchOsd();
        this._notifQueue = [];
        this._notifActive = false;
        this._pausedSince = 0;

        this._hideTooltip();
        this._tooltip?.destroy();
        this._tooltip = null;
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

    _buildHosts() {
        const config = this._config;
        const expandedMonitor = this._expanded?.monitorIndex ?? null;
        this._expanded = null;
        // Hand indicators back to the panel while the islands are rebuilt.
        this._bridge?.destroy();
        this._destroyHosts();
        this._bridge = new PanelBridge();
        this._bridge.setClock(this._expandedClock);

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

    _createHost(monitorIndex) {
        const config = this._config;
        const island = new Island(config.metrics, config.spring);
        island.setBlurEnabled(config.blurTransitions);

        const dot = this._bridge.messagesDot;
        const clock = new ClockWidget();
        island.addView('clock', clock);

        const media = new MediaView(config.visualizerBars);
        media.bars.visible = config.visualizerEnabled;
        island.addView('media', media);

        const notification = new NotificationView();
        island.addView('notification', notification);

        const row = new ExpandedRow();
        const rowCover = new CoverArt();
        const rowBars = new VisualizerBars(config.visualizerBars);
        row.setEnds(rowCover, rowBars);
        row.setLayout(config.itemsLeft, config.itemsRight);
        row.set_style(`height: ${config.metrics.expandedHeight}px;`);
        island.addView('expanded', row);

        const workspaces = new WorkspaceDots();
        island.addView('workspaces', workspaces, {keepSize: true});

        // GNOME's unread dot, mirrored into the right padding of the
        // collapsed island so it never changes its size.
        island.setEdgeActor(new MessagesDotMirror(dot), ['clock', 'media']);

        const bubble = new BubbleView();
        island.addView('privacy', bubble, {bubble: 'right'});
        bubble.connect('icon-hover', (_b, kind, hovered) => {
            if (hovered)
                this._showTooltip(host, kind);
            else
                this._hideTooltip();
        });

        const osd = new OsdView();
        island.addView('osd', osd, {bubble: 'left'});

        const host = {
            island, row, rowCover, rowBars, clock, media, notification, bubble,
            osd, osdTimeoutId: 0, workspaces, container: null, monitorIndex,
        };
        this._applyColors(host);

        island.connect('pill-clicked', (_i, button) => this._onPillClicked(host, button));
        island.connect('bubble-clicked', (_i, side) => {
            if (side === 'right')
                this._onBubbleClicked(host);
        });
        island.connect('destroy', () => {
            if (host.osdTimeoutId)
                GLib.source_remove(host.osdTimeoutId);
            host.osdTimeoutId = 0;
        });
        island.connect('hover-changed', (_i, hovered) => this._onHoverChanged(host, hovered));
        island.connect('key-escape', () => this._collapse());
        island.pill.connect('key-focus-out', () => this._onKeyFocusOut(host));
        return host;
    }

    _destroyHosts() {
        for (const host of this._hosts) {
            if (host.container)
                host.container.destroy();
            else
                host.island.destroy();
        }
        this._hosts = [];
    }

    _primaryHost() {
        return this._hosts.find(h => h.monitorIndex === Main.layoutManager.primaryIndex) ??
            this._hosts[0];
    }

    _applyColors(host) {
        const {background, foreground, accent} = this._config.colors;
        const style = `background-color: ${background}; color: ${foreground};`;
        for (const capsule of host.island.capsules)
            capsule.set_style(style);
        host.osd.setAccent(accent);
        host.media.bars.setColor(accent);
        host.rowBars.setColor(accent);
        host.notification.setAccent(accent);
    }

    // --- State → views -----------------------------------------------------

    _mediaVisible() {
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
        const timeout = this._config.pausedMediaTimeout;
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

    _updateViews() {
        if (!this._config)
            return;
        const state = this._media?.state ?? null;
        const mediaVisible = this._mediaVisible();
        const kind = this._privacy?.kind ?? null;

        for (const host of this._hosts) {
            host.media.cover.setUri(state?.coverUri ?? null);
            host.rowCover.setUri(state?.coverUri ?? null);
            const showEnds = mediaVisible;
            host.rowCover.visible = showEnds;
            host.rowBars.visible = showEnds && this._config.visualizerEnabled;
            host.bubble.update(this._privacy);
            // The privacy bubble always lives beside the island, never inside it.
            host.island.setBubbleView('right', kind ? 'privacy' : null);

            if (host === this._expanded) {
                host.island.setView('expanded');
                continue;
            }
            let view = 'clock';
            if (this._wsActive)
                view = 'workspaces';
            else if (this._notifActive)
                view = 'notification';
            else if (mediaVisible)
                view = 'media';
            host.island.setView(view);
        }

        const anyMedia = this._hosts.some(h =>
            h.island.currentView === 'media' || (h.island.currentView === 'expanded' && mediaVisible));
        if (this._config.visualizerEnabled && state?.playing && anyMedia)
            this._analyzer?.start();
        else
            this._analyzer?.stop();
    }

    // --- Clock -------------------------------------------------------------

    _onTick(now) {
        const config = this._config;
        const time = now.format(config.clockFormat) ?? '';
        for (const host of this._hosts) {
            host.clock.time.setText(time);
            host.media.clock.time.setText(time);
            if (this._privacy)
                host.bubble.update(this._privacy);
        }
        this._expandedClock?.time.setText(time);
        const date = config.dateFormat ? now.format(config.dateFormat) : null;
        this._expandedClock?.setDate(date || null);
    }

    // --- Notifications -----------------------------------------------------

    _onNotification(n) {
        if (!this._config.notificationsInIsland)
            return;
        this._notifQueue.push([n, GLib.get_monotonic_time()]);
        this._showNextNotification();
    }

    _showNextNotification() {
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
            this._config.notificationDuration, () => {
                this._notifTimeoutId = 0;
                this._endNotification();
                return GLib.SOURCE_REMOVE;
            });
    }

    _endNotification() {
        if (this._notifTimeoutId)
            GLib.source_remove(this._notifTimeoutId);
        this._notifTimeoutId = 0;
        if (!this._notifActive)
            return;
        this._notifActive = false;
        for (const host of this._hosts)
            host.notification.stop();
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

    _onPillClicked(host, button) {
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

    _onBubbleClicked(host) {
        if (this._privacy?.kind === 'screencast')
            this._privacy.stop();
        else
            this._expand(host);
    }

    _expand(host) {
        const previous = this._expanded;
        this._expanded = host;
        this._bridge.attach(host.row);
        if (previous && previous !== host)
            this._updateViews();
        host.island.setView('expanded');
        this._updateViews();
        host.island.pill.grab_key_focus();
        this._cancelCollapse();
        if (!host.island.hovered)
            this._scheduleCollapse();
    }

    _collapse() {
        this._cancelCollapse();
        const host = this._expanded;
        if (!host)
            return;
        const menu = Main.panel.menuManager.activeMenu;
        if (menu)
            menu.close();
        this._expanded = null;
        this._updateViews();
        if (global.stage.key_focus && host.island.contains(global.stage.key_focus))
            global.stage.set_key_focus(null);
        this._showNextNotification();
    }

    _scheduleCollapse() {
        this._cancelCollapse();
        this._collapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._config.collapseDelay, () => {
            this._collapseId = 0;
            const host = this._expanded;
            if (!host)
                return GLib.SOURCE_REMOVE;
            if (Main.panel.menuManager.activeMenu || host.island.hovered) {
                // A menu is open or the pointer came back; check again later.
                this._scheduleCollapse();
                return GLib.SOURCE_REMOVE;
            }
            this._collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelCollapse() {
        if (this._collapseId)
            GLib.source_remove(this._collapseId);
        this._collapseId = 0;
    }

    _onHoverChanged(host, hovered) {
        if (this._expanded !== host)
            return;
        if (hovered)
            this._cancelCollapse();
        else
            this._scheduleCollapse();
    }

    _onKeyFocusOut(host) {
        if (this._expanded !== host)
            return;
        // With focus-follows-mouse a window takes focus as soon as the
        // pointer reaches it, so losing focus only starts the normal
        // collapse delay. Clicks outside collapse immediately (see below).
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._expanded !== host)
                return GLib.SOURCE_REMOVE;
            const focus = global.stage.key_focus;
            if (focus && host.island.contains(focus))
                return GLib.SOURCE_REMOVE;
            if (!host.island.hovered)
                this._scheduleCollapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onCapturedEvent(event) {
        const host = this._expanded;
        if (!host)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (Main.panel.menuManager.activeMenu)
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        if (target && host.island.contains(target))
            return Clutter.EVENT_PROPAGATE;
        this._collapse();
        return Clutter.EVENT_PROPAGATE;
    }

    // --- Privacy tooltip ---------------------------------------------------

    _privacyTitle(kind) {
        switch (kind) {
        case 'screencast':
        case 'remote-recording':
            return _('Screen recording');
        case 'sharing':
            return _('Screen sharing');
        case 'camera':
            return _('Camera');
        default:
            return this._privacy?.microphoneMuted ? _('Microphone (muted)') : _('Microphone');
        }
    }

    _showTooltip(host, kind) {
        this._hideTooltip();
        this._tooltipKind = kind;
        this._tooltipId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_DELAY, () => {
            this._tooltipId = 0;
            const icon = host.bubble.iconFor(kind);
            if (!icon || this._tooltipKind !== kind)
                return GLib.SOURCE_REMOVE;
            if (!this._tooltip) {
                this._tooltip = new St.Label({style_class: 'island-tooltip', opacity: 0});
                // Plain uiGroup child: drawn above windows, never takes input.
                Main.layoutManager.uiGroup.add_child(this._tooltip);
            }
            const title = this._privacyTitle(kind);
            this._setTooltipText(icon, title);
            this._tooltip.show();
            this._tooltip.remove_all_transitions();
            this._tooltip.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

            // Who is using it comes from PipeWire; fill it in when known.
            this._tooltipCancel = new Gio.Cancellable();
            captureUsers(this._tooltipCancel).then(users => {
                if (this._tooltipKind !== kind || !this._tooltip)
                    return;
                const apps = kind === 'microphone' ? users.microphone
                    : kind === 'camera' ? users.camera
                        : kind === 'screencast' ? [] : users.screen;
                if (apps.length)
                    this._setTooltipText(icon, `${title}: ${apps.join(', ')}`);
            }).catch(e => logError(e, 'gnome-island: tooltip'));
            return GLib.SOURCE_REMOVE;
        });
    }

    _setTooltipText(icon, text) {
        const tip = this._tooltip;
        tip.text = text;
        const [x, y] = icon.get_transformed_position();
        const [, tipW] = tip.get_preferred_width(-1);
        const monitor = Main.layoutManager.findMonitorForActor(icon) ?? Main.layoutManager.primaryMonitor;
        const bottom = this._config.metrics.topMargin + this._config.metrics.expandedHeight + 8;
        let tx = Math.round(x + icon.width / 2 - tipW / 2);
        tx = Math.max(monitor.x + 8, Math.min(tx, monitor.x + monitor.width - tipW - 8));
        tip.set_position(tx, Math.max(Math.round(y + icon.height + 12), monitor.y + bottom));
    }

    _hideTooltip() {
        this._tooltipKind = null;
        if (this._tooltipId)
            GLib.source_remove(this._tooltipId);
        this._tooltipId = 0;
        this._tooltipCancel?.cancel();
        this._tooltipCancel = null;
        const tip = this._tooltip;
        if (tip?.visible) {
            tip.remove_all_transitions();
            tip.ease({
                opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => tip.hide(),
            });
        }
    }

    // --- OSD (volume, brightness, microphone…) ------------------------------

    _patchOsd() {
        const mgr = Main.osdWindowManager;
        this._origShowOsd = mgr._showOsdWindow;
        // Every OSD (showOne/showAll/D-Bus) ends up here, per monitor.
        mgr._showOsdWindow = (monitorIndex, icon, label,
            level, maxLevel) => {
            const host = this._hosts.find(h => h.monitorIndex === monitorIndex);
            if (!host) {
                this._origShowOsd.call(mgr, monitorIndex, icon, label, level, maxLevel);
                return;
            }
            this._showOsd(host, icon, level, maxLevel);
        };
    }

    _unpatchOsd() {
        if (this._origShowOsd)
            Main.osdWindowManager._showOsdWindow = this._origShowOsd;
        this._origShowOsd = null;
    }

    _showOsd(host, icon, level, maxLevel) {
        host.osd.show_(icon, level, maxLevel);
        host.island.setBubbleView('left', 'osd');
        if (host.osdTimeoutId)
            GLib.source_remove(host.osdTimeoutId);
        host.osdTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_TIMEOUT, () => {
            host.osdTimeoutId = 0;
            host.island.setBubbleView('left', null);
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Workspace switching ---------------------------------------------

    _patchWorkspacePopup() {
        const proto = WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype;
        this._origWsDisplay = proto.display;
        // Keep the popup's lifetime (the window manager waits for it to be
        // destroyed) but never show it; the island shows the switch instead.
        proto.display = function (index) {
            this._activeWorkspaceIndex = index;
            if (this._timeoutId)
                GLib.source_remove(this._timeoutId);
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                this._timeoutId = 0;
                this.destroy();
                return GLib.SOURCE_REMOVE;
            });
        };
    }

    _unpatchWorkspacePopup() {
        if (this._origWsDisplay)
            WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype.display = this._origWsDisplay;
        this._origWsDisplay = null;
    }

    _onWorkspaceChanged() {
        if (Main.overview.visible)
            return;
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace_index();
        for (const host of this._hosts)
            host.workspaces.show_(active, wm.n_workspaces);
        this._wsActive = true;
        this._updateViews();
        if (this._wsTimeoutId)
            GLib.source_remove(this._wsTimeoutId);
        this._wsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WORKSPACE_TIMEOUT, () => {
            this._wsTimeoutId = 0;
            this._wsActive = false;
            this._updateViews();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Panel API patches -------------------------------------------------

    _patchPanel() {
        const panel = Main.panel;
        this._origToggleCalendar = panel.toggleCalendar;
        this._origToggleQuickSettings = panel.toggleQuickSettings;
        // Keyboard shortcuts (Super+V, Super+S) need the indicator mapped,
        // so expand an island first.
        panel.toggleCalendar = () => {
            this._expandForMenu();
            this._origToggleCalendar.call(panel);
        };
        panel.toggleQuickSettings = () => {
            this._expandForMenu();
            this._origToggleQuickSettings.call(panel);
        };
    }

    _unpatchPanel() {
        const panel = Main.panel;
        if (this._origToggleCalendar)
            panel.toggleCalendar = this._origToggleCalendar;
        if (this._origToggleQuickSettings)
            panel.toggleQuickSettings = this._origToggleQuickSettings;
        this._origToggleCalendar = null;
        this._origToggleQuickSettings = null;
    }

    _expandForMenu() {
        const host = this._expanded ?? this._primaryHost();
        if (host && this._expanded !== host)
            this._expand(host);
    }

    // --- Settings ----------------------------------------------------------

    _onSettingChanged(key) {
        const config = this._config;
        switch (key) {
        case 'all-monitors':
            this._buildHosts();
            break;
        case 'items-left':
        case 'items-right':
            for (const host of this._hosts)
                host.row.setLayout(config.itemsLeft, config.itemsRight);
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
        case 'date-format':
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
            for (const host of this._hosts) {
                host.media.bars.setCount(config.visualizerBars);
                host.rowBars.setCount(config.visualizerBars);
            }
            break;
        case 'notifications-in-island':
            this._notifications.blockBanners = config.notificationsInIsland;
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
