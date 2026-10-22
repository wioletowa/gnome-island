import Gio from 'gi://Gio';

import type {IslandMetrics} from './island.js';
import type {SpringParams} from './spring.js';
import type {SlotName} from './bridge.js';

/** Typed read access to the extension's GSettings. */
export class Config {
    readonly settings: Gio.Settings;

    constructor(settings: Gio.Settings) {
        this.settings = settings;
    }

    get metrics(): IslandMetrics {
        const s = this.settings;
        return {
            topMargin: s.get_int('top-margin'),
            bottomGap: s.get_int('bottom-gap'),
            compactHeight: s.get_int('compact-height'),
            expandedHeight: s.get_int('expanded-height'),
            hPadding: s.get_int('horizontal-padding'),
            bubbleGap: s.get_int('bubble-gap'),
        };
    }

    get spring(): SpringParams {
        const s = this.settings;
        return {
            stiffness: s.get_double('spring-stiffness'),
            damping: s.get_double('spring-damping'),
            mass: s.get_double('spring-mass'),
        };
    }

    get clockFormat() {
        return this.settings.get_string('clock-format');
    }

    get expandedClockFormat() {
        return this.settings.get_string('expanded-clock-format');
    }

    get collapseDelay() {
        return this.settings.get_int('collapse-delay');
    }

    get itemOrder(): SlotName[] {
        return this.settings.get_strv('item-order') as SlotName[];
    }

    get blurTransitions() {
        return this.settings.get_boolean('blur-transitions');
    }

    get allMonitors() {
        return this.settings.get_boolean('all-monitors');
    }

    get visualizerEnabled() {
        return this.settings.get_boolean('visualizer-enabled');
    }

    get visualizerBars() {
        return this.settings.get_int('visualizer-bars');
    }

    get visualizerSensitivity() {
        return this.settings.get_double('visualizer-sensitivity');
    }

    get notificationsInIsland() {
        return this.settings.get_boolean('notifications-in-island');
    }

    get notificationDuration() {
        return this.settings.get_int('notification-duration');
    }

    get pausedMediaTimeout() {
        return this.settings.get_int('paused-media-timeout');
    }

    get colors() {
        const s = this.settings;
        return {
            background: s.get_string('background-color'),
            foreground: s.get_string('foreground-color'),
            accent: s.get_string('accent-color'),
        };
    }
}
