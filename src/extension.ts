import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Config} from './config.js';
import {Island, IslandType} from './island.js';
import {ExpandedRow, ExpandedRowType, PanelBridge} from './bridge.js';
import {Odometer, OdometerType, SecondTicker} from './odometer.js';

interface IslandHost {
    island: IslandType;
    row: ExpandedRowType;
    clock: OdometerType;
    /** Own chrome container for non-primary monitors; null on primary. */
    container: St.Widget | null;
    monitorIndex: number;
}

export default class IslandExtension extends Extension {
    private _config: Config | null = null;
    private _bridge: PanelBridge | null = null;
    private _ticker: SecondTicker | null = null;
    private _hosts: IslandHost[] = [];
    private _expanded: IslandHost | null = null;
    private _expandedClock: OdometerType | null = null;
    private _collapseId = 0;
    private _tickCb: ((now: GLib.DateTime) => void) | null = null;
    private _origToggleCalendar: (() => void) | null = null;
    private _origToggleQuickSettings: (() => void) | null = null;

    enable() {
        this._config = new Config(this.getSettings());
        this._ticker = new SecondTicker();
        this._bridge = new PanelBridge();

        Main.panel.hide();

        this._expandedClock = new Odometer({style_class: 'island-odometer clock'});
        this._bridge.setClockActor(this._expandedClock);

        this._buildHosts();

        this._tickCb = now => this._onTick(now);
        this._ticker.add(this._tickCb);

        this._patchPanel();

        Main.layoutManager.connectObject('monitors-changed', () => this._buildHosts(), this);
        global.stage.connectObject('captured-event', (_s: Clutter.Actor, e: Clutter.Event) =>
            this._onCapturedEvent(e), this);
        this._config.settings.connectObject('changed', (_s: unknown, key: string) =>
            this._onSettingChanged(key), this);
    }

    disable() {
        this._cancelCollapse();
        this._unpatchPanel();
        Main.layoutManager.disconnectObject(this);
        global.stage.disconnectObject(this);
        this._config?.settings.disconnectObject(this);

        // Return indicators before their island rows are destroyed.
        this._bridge?.destroy();
        this._bridge = null;
        this._destroyHosts();

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
        // Keep indicators alive while islands are rebuilt.
        this._bridge!.destroy();
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

        for (const host of this._hosts) {
            host.island.setView('clock');
            host.island.snap();
        }
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
        this._applyColors(island);

        const clock = new Odometer({style_class: 'island-odometer island-compact-clock'});
        island.addView('clock', clock);

        const row = new ExpandedRow();
        row.setOrder(config.itemOrder);
        row.set_style(`height: ${config.metrics.expandedHeight}px;`);
        island.addView('expanded', row);

        const host: IslandHost = {island, row, clock, container: null, monitorIndex};

        island.connect('pill-clicked', (_i, button: number) => this._onPillClicked(host, button));
        island.connect('hover-changed', (_i, hovered: boolean) => this._onHoverChanged(host, hovered));
        island.connect('key-escape', () => this._collapse());
        island.pill.connect('key-focus-out', () => this._onKeyFocusOut(host));
        return host;
    }

    private _destroyHosts() {
        for (const host of this._hosts) {
            if (host.container) {
                host.container.destroy();
            } else {
                host.island.destroy();
            }
        }
        this._hosts = [];
    }

    private _primaryHost(): IslandHost | undefined {
        return this._hosts.find(h => h.monitorIndex === Main.layoutManager.primaryIndex) ??
            this._hosts[0];
    }

    private _applyColors(island: IslandType) {
        const {background, foreground} = this._config!.colors;
        const style = `background-color: ${background}; color: ${foreground};`;
        island.pill.set_style(style);
        island.bubble.set_style(style);
    }

    // --- Clock -------------------------------------------------------------

    private _onTick(now: GLib.DateTime) {
        const config = this._config!;
        const compact = now.format(config.clockFormat) ?? '';
        for (const host of this._hosts)
            host.clock.setText(compact);
        this._expandedClock?.setText(now.format(config.expandedClockFormat) ?? '');
    }

    // --- Expand / collapse -------------------------------------------------

    private _onPillClicked(host: IslandHost, button: number) {
        if (button !== Clutter.BUTTON_PRIMARY && button !== Clutter.BUTTON_SECONDARY)
            return;
        if (this._expanded !== host)
            this._expand(host);
    }

    private _expand(host: IslandHost) {
        if (this._expanded && this._expanded !== host)
            this._expanded.island.setView('clock');
        this._expanded = host;
        this._bridge!.attach(host.row);
        host.island.setView('expanded');
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
        host.island.setView('clock');
        if (global.stage.key_focus && host.island.contains(global.stage.key_focus))
            global.stage.set_key_focus(null);
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
        // so expand the primary island first.
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
            for (const host of this._hosts)
                this._applyColors(host.island);
            break;
        case 'clock-format':
        case 'expanded-clock-format':
            this._onTick(GLib.DateTime.new_now_local());
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
