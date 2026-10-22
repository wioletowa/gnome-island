import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

// Streams that are ours or only meter levels, not real users.
const IGNORED_STREAMS = ['gnome-island-visualizer'];

/** A readable application name for a PipeWire stream's properties. */
function appName(props) {
    const apps = Shell.AppSystem.get_default();
    const portalId = props['pipewire.access.portal.app_id'];
    const binary = props['application.process.binary'];
    const app = (portalId && apps.lookup_app(`${portalId}.desktop`)) ||
        (binary && apps.lookup_desktop_wmclass(binary)) ||
        (binary && apps.lookup_startup_wmclass(binary));
    if (app)
        return app.get_name();
    // The binary ("discord", "firefox") reads better than application.name,
    // which is often an engine name like "WEBRTC VoiceEngine".
    const name = binary || props['application.name'] || props['node.name'] || '';
    return name ? name[0].toUpperCase() + name.slice(1) : '';
}

function isCamera(props) {
    const name = props['node.name'] ?? '';
    return !!props['device.api'] || name.startsWith('v4l2') || name.startsWith('libcamera');
}

/**
 * Asks PipeWire (via pw-dump) which applications are capturing the
 * microphone, the camera and the screen. Run on demand only (tooltips).
 * Resolves to {microphone, camera, screen} arrays of app names.
 */
export async function captureUsers(cancellable = null) {
    const result = {microphone: new Set(), camera: new Set(), screen: new Set()};
    let objects;
    try {
        const proc = Gio.Subprocess.new(['pw-dump'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const stdout = await new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                try {
                    resolve(p.communicate_utf8_finish(res)[1]);
                } catch (e) {
                    reject(e);
                }
            });
        });
        objects = JSON.parse(stdout);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            logError(e, 'gnome-island: pw-dump');
        return {microphone: [], camera: [], screen: []};
    }

    const nodes = new Map();
    for (const o of objects) {
        if (o.type === 'PipeWire:Interface:Node')
            nodes.set(o.id, o.info?.props ?? {});
    }
    for (const o of objects) {
        if (o.type !== 'PipeWire:Interface:Link')
            continue;
        const out = nodes.get(o.info?.['output-node-id']);
        const input = nodes.get(o.info?.['input-node-id']);
        if (!out || !input || IGNORED_STREAMS.includes(input['node.name']))
            continue;
        const outClass = out['media.class'] ?? '';
        const inClass = input['media.class'] ?? '';
        const name = appName(input);
        if (!name)
            continue;
        // Microphone: a real source (not a sink monitor) feeding a stream.
        if (outClass.startsWith('Audio/Source') && inClass.startsWith('Stream/Input/Audio'))
            result.microphone.add(name);
        else if (outClass === 'Video/Source' && inClass.startsWith('Stream/Input/Video'))
            (isCamera(out) ? result.camera : result.screen).add(name);
    }
    return {
        microphone: [...result.microphone],
        camera: [...result.camera],
        screen: [...result.screen],
    };
}
