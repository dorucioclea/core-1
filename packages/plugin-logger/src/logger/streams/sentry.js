"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const Sentry = require("@sentry/node");
const lsmod = require("lsmod");
const pino = require("pino");
const core_1 = require("@microfleet/core");
// keys to be banned
const BAN_LIST = {
    msg: true,
    time: true,
    hostname: true,
    name: true,
    level: true,
};
const parsers_1 = require("@sentry/node/dist/parsers");
const { hasOwnProperty } = Object.prototype;
/**
 * Sentry stream for Pino
 */
class SentryStream {
    constructor(opts) {
        this.env = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV;
        this.modules = lsmod();
        this[_a] = true;
        this.release = opts.release;
    }
    /**
     * Method call by Pino to save log record
     * msg is a stringified set of data
     */
    write(msg) {
        const event = JSON.parse(msg);
        const extra = Object.create(null);
        for (const [key, value] of Object.entries(event)) {
            if (hasOwnProperty.call(BAN_LIST, key) === true)
                continue;
            extra[key] = value;
        }
        (async () => {
            let stacktrace = undefined;
            if (event.err && event.err.stack) {
                try {
                    const stack = parsers_1.extractStackFromError(event.err);
                    const frames = await parsers_1.parseStack(stack);
                    stacktrace = { frames: parsers_1.prepareFramesForEvent(frames) };
                }
                catch (e) { /* ignore */ }
            }
            Sentry.captureEvent({
                extra,
                stacktrace,
                message: event.msg,
                timestamp: event.time / 1e3,
                level: this.getSentryLevel(event.level),
                platform: 'node',
                // eslint-disable-next-line @typescript-eslint/camelcase
                server_name: event.hostname,
                logger: event.name,
                release: this.release,
                environment: this.env,
                sdk: {
                    name: Sentry.SDK_NAME,
                    version: Sentry.SDK_VERSION,
                },
                modules: this.modules,
                fingerprint: ['{{ default }}'],
            });
        })();
        return true;
    }
    /**
     * Error deserialiazing function. Bunyan serialize the error to object:
     * https://github.com/trentm/node-bunyan/blob/master/lib/bunyan.js#L1089
     * @param  {object} data serialized Bunyan
     * @return {Error}      the deserialiazed error
     */
    deserializeError(data) {
        if (data instanceof Error)
            return data;
        const error = new Error(data.message);
        error.name = data.name;
        error.stack = data.stack;
        error.code = data.code;
        error.signal = data.signal;
        return error;
    }
    /**
     * Convert Bunyan level number to Sentry level label.
     * Rule : >50=error ; 40=warning ; info otherwise
     */
    getSentryLevel(level) {
        if (level >= 50)
            return Sentry.Severity.Error;
        if (level === 40)
            return Sentry.Severity.Warning;
        return Sentry.Severity.Info;
    }
}
_a = pino.symbols.needsMetadataGsym;
function sentryStreamFactory(config) {
    const { logLevel, dsn } = config;
    assert(dsn, '"dsn" property must be set');
    Sentry.init({
        ...config,
        defaultIntegrations: false,
        ...process.env.NODE_ENV === 'test' && {
            integrations: [
                new Sentry.Integrations.Console(),
            ],
        },
    });
    const dest = new SentryStream({
        release: core_1.Microfleet.version,
    });
    return {
        level: logLevel || 'error',
        stream: dest,
    };
}
exports.default = sentryStreamFactory;
//# sourceMappingURL=sentry.js.map