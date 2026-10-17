#!/usr/bin/env node
"use strict";

// Reconciles Uptime Kuma monitors over the internal socket.io API, reusing the
// socket.io-client already shipped with the application (no extra dependency).
//
// Monitors are matched by name: existing monitors are edited, missing ones are
// added and monitors marked "absent" are removed. Only fields that are actually
// managed by the role are compared, so values changed in the web UI are left
// untouched unless the role also sets them.
//
// Required environment variables:
//   UK_USER             Admin username.
//   UK_PASS             Admin password.
// Optional:
//   UK_DIR              Path to the Uptime Kuma checkout (default /opt/uptime-kuma).
//   UK_URL              Server URL (default http://127.0.0.1:3001).
//   UK_TOKEN            TOTP token, when the account has 2FA enabled.
//   UK_MONITORS         JSON array of desired monitors (default []).
//   UK_MONITOR_DEFAULTS JSON object merged into every monitor (default {}).
//
// Only "CHANGED" or "UNCHANGED" is printed on stdout so Ansible can drive
// changed_when; all diagnostics go to stderr.

const path = require("path");

const appDir = process.env.UK_DIR || "/opt/uptime-kuma";
const url = process.env.UK_URL || "http://127.0.0.1:3001";
const username = process.env.UK_USER;
const password = process.env.UK_PASS;
const totpToken = process.env.UK_TOKEN;

let desired;
let defaults;
try {
    desired = JSON.parse(process.env.UK_MONITORS || "[]");
    defaults = JSON.parse(process.env.UK_MONITOR_DEFAULTS || "{}");
} catch (e) {
    console.error(`invalid JSON in UK_MONITORS/UK_MONITOR_DEFAULTS: ${e.message}`);
    process.exit(2);
}

if (!username || !password) {
    console.error("UK_USER and UK_PASS must be set");
    process.exit(2);
}

if (!Array.isArray(desired)) {
    console.error("UK_MONITORS must be a JSON array");
    process.exit(2);
}

const { io } = require(path.join(appDir, "node_modules", "socket.io-client"));

const ACK_TIMEOUT = 30000;
const READY_TIMEOUT = 60000;

// Base object mirroring Uptime Kuma's own frontend monitor defaults. The "add"
// event needs a fairly complete object to store a valid monitor; fields that are
// not managed by the role keep these values on creation.
const BASE_MONITOR = {
    type: "http",
    name: "",
    parent: null,
    url: "",
    wsSubprotocol: "",
    method: "GET",
    protocol: null,
    location: "world",
    ipFamily: null,
    interval: 60,
    retryInterval: 60,
    resendInterval: 0,
    maxretries: 0,
    retryOnlyOnStatusCodeFailure: false,
    notificationIDList: {},
    ignoreTls: false,
    upsideDown: false,
    expiryNotification: false,
    domainExpiryNotification: true,
    maxredirects: 10,
    accepted_statuscodes: ["200-299"],
    saveResponse: false,
    saveErrorResponse: true,
    responseMaxLength: 1024,
    dns_resolve_type: "A",
    dns_resolve_server: "",
    docker_container: "",
    docker_host: null,
    proxyId: null,
    basic_auth_user: "",
    basic_auth_pass: "",
    bearer_token: "",
    mqttUsername: "",
    mqttPassword: "",
    mqttTopic: "",
    mqttWebsocketPath: "",
    mqttSuccessMessage: "",
    mqttCheckType: "keyword",
    authMethod: null,
    httpBodyEncoding: "json",
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: {
        mechanism: "None",
    },
    cacheBust: false,
    kafkaProducerSsl: false,
    kafkaProducerAllowAutoTopicCreation: false,
    gamedigGivenPortOnly: true,
    gamedigToken: "",
    remote_browser: null,
    screenshot_delay: 0,
    rabbitmqNodes: [],
    rabbitmqUsername: "",
    rabbitmqPassword: "",
    conditions: [],
    system_service_name: "",
    sshAuthMethod: "password",
    ntpStratumThreshold: 5,
    ntpTimeOffsetThreshold: 1000,
    ntpRootDispersionThreshold: 500,
};

const DEFAULT_TAG_COLOR = "#4B5563";

// Keys consumed by this script and never sent to Uptime Kuma as monitor fields.
const HELPER_KEYS = new Set(["state", "notifications", "tags"]);

// "active" is not persisted by editMonitor (it is toggled with pause/resume),
// so it is excluded from the edit diff and handled separately.
const EDIT_EXCLUDED = new Set(["active", "id"]);

// Map-like fields that must be replaced as a whole instead of deep-merged.
const REPLACE_KEYS = new Set(["notificationIDList"]);

let changed = false;
let socket;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
    const out = isPlainObject(base) ? { ...base } : Array.isArray(base) ? base.slice() : {};
    for (const [key, value] of Object.entries(override || {})) {
        if (!REPLACE_KEYS.has(key) && isPlainObject(out[key]) && isPlainObject(value)) {
            out[key] = deepMerge(out[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

// Stable representation used for deep comparison (key order independent).
function canonical(value) {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (isPlainObject(value)) {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonical(value[key]);
        }
        return out;
    }
    return value;
}

function deepEqual(a, b) {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function call(event, args, timeoutMs = ACK_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
        socket.emit(event, ...args, (res) => {
            clearTimeout(timer);
            resolve(res);
        });
    });
}

async function mustCall(event, args, timeoutMs = ACK_TIMEOUT) {
    const res = await call(event, args, timeoutMs);
    if (!res || !res.ok) {
        throw new Error(`${event} failed: ${(res && res.msg) || "no response"}`);
    }
    return res;
}

async function waitFor(getter, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = getter();
        if (value !== null && value !== undefined) {
            return value;
        }
        await sleep(200);
    }
    throw new Error(`timeout waiting for ${label}`);
}

async function login() {
    const data = { username, password };
    if (totpToken) {
        data.token = totpToken;
    }
    const res = await call("login", [data]);
    if (!res) {
        throw new Error("no response to login");
    }
    if (res.tokenRequired) {
        throw new Error("2FA token required; set UK_TOKEN");
    }
    if (!res.ok) {
        throw new Error(`login failed: ${res.msg || "unknown error"}`);
    }
}

// Returns { ok, parent } where parent is a monitor id (or null). If a
// human-readable parent name cannot be resolved yet, ok is false so the caller
// can retry after other monitors have been created.
function resolveParent(item, idByName) {
    const raw = item.parent;
    if (raw === undefined || raw === null) {
        return { ok: true, parent: null };
    }
    if (typeof raw === "number") {
        return { ok: true, parent: raw };
    }
    if (typeof raw === "string") {
        if (/^\d+$/.test(raw)) {
            return { ok: true, parent: parseInt(raw, 10) };
        }
        if (idByName.has(raw)) {
            return { ok: true, parent: idByName.get(raw) };
        }
        return { ok: false };
    }
    return { ok: true, parent: raw };
}

function normalizeTagSpecs(tagSpecs, monitorName) {
    return tagSpecs.map((tag) => {
        if (typeof tag === "string") {
            return { name: tag, value: "" };
        }
        if (isPlainObject(tag) && tag.name) {
            return { name: tag.name, value: tag.value || "" };
        }
        throw new Error(`invalid tag entry for monitor '${monitorName}'`);
    });
}

const tagKey = (tag) => `${tag.name}\u0000${tag.value}`;

async function addTagId(name, tagIdByName) {
    let tagId = tagIdByName.get(name);
    if (tagId !== undefined) {
        return tagId;
    }
    const res = await mustCall("addTag", [{ name, color: DEFAULT_TAG_COLOR }]);
    tagId = res.tag.id;
    tagIdByName.set(name, tagId);
    return tagId;
}

// Reconcile the tags of a single monitor. "current" entries must carry a tag_id
// so they can be removed; "desired" entries only need name/value.
async function reconcileTags(monitorID, desiredTags, currentTags, tagIdByName, monitorName) {
    const desired = normalizeTagSpecs(desiredTags, monitorName);
    const desiredKeys = new Set(desired.map(tagKey));
    const currentKeys = new Set(currentTags.map(tagKey));

    for (const tag of desired) {
        if (currentKeys.has(tagKey(tag))) {
            continue;
        }
        const tagId = await addTagId(tag.name, tagIdByName);
        await mustCall("addMonitorTag", [tagId, monitorID, tag.value]);
        changed = true;
    }

    for (const tag of currentTags) {
        if (desiredKeys.has(tagKey(tag)) || tag.tag_id === undefined) {
            continue;
        }
        await mustCall("deleteMonitorTag", [tag.tag_id, monitorID, tag.value]);
        changed = true;
    }
}

async function processItem(item, parent, byName, idByName, notifIdByName, tagIdByName) {
    const state = item.state || "present";
    const existing = byName.get(item.name);

    if (state === "absent") {
        if (existing) {
            await mustCall("deleteMonitor", [existing.id, false]);
            byName.delete(item.name);
            idByName.delete(item.name);
            changed = true;
        }
        return;
    }
    if (state !== "present") {
        throw new Error(`invalid state '${state}' for monitor '${item.name}'`);
    }

    // Build the fields the role actually manages (role defaults + item).
    const fields = { ...defaults };
    for (const [key, value] of Object.entries(item)) {
        if (HELPER_KEYS.has(key)) {
            continue;
        }
        fields[key] = value;
    }
    fields.parent = parent;
    if (Array.isArray(fields.accepted_statuscodes)) {
        fields.accepted_statuscodes = fields.accepted_statuscodes.map(String);
    }
    // Uptime Kuma stores headers as a JSON string; accept a mapping for convenience.
    if (isPlainObject(fields.headers)) {
        fields.headers = JSON.stringify(fields.headers);
    }

    // Resolve notification names to the notificationIDList object.
    if (Object.prototype.hasOwnProperty.call(item, "notifications")) {
        if (!Array.isArray(item.notifications)) {
            throw new Error(`notifications for monitor '${item.name}' must be a list`);
        }
        const ids = {};
        for (const name of item.notifications) {
            if (!notifIdByName.has(name)) {
                throw new Error(`notification '${name}' referenced by monitor '${item.name}' does not exist`);
            }
            ids[notifIdByName.get(name)] = true;
        }
        fields.notificationIDList = ids;
    }

    const hasTags = Object.prototype.hasOwnProperty.call(item, "tags");

    if (!existing) {
        const payload = deepMerge(BASE_MONITOR, fields);
        delete payload.tags;
        const res = await mustCall("add", [payload]);
        const monitorID = res.monitorID;
        idByName.set(item.name, monitorID);
        byName.set(item.name, {
            id: monitorID,
            name: item.name,
            active: payload.active !== false,
            forceInactive: false,
            tags: [],
        });
        changed = true;
        if (hasTags) {
            await reconcileTags(monitorID, item.tags, [], tagIdByName, item.name);
        }
        return;
    }

    // Edit only when a managed field actually differs.
    let needsEdit = false;
    for (const key of Object.keys(fields)) {
        if (EDIT_EXCLUDED.has(key)) {
            continue;
        }
        if (!deepEqual(existing[key], fields[key])) {
            needsEdit = true;
            break;
        }
    }
    if (needsEdit) {
        const payload = deepMerge(existing, fields);
        delete payload.tags;
        await mustCall("editMonitor", [payload]);
        changed = true;
    }

    // Toggle the running state separately, unless the parent controls it.
    if (Object.prototype.hasOwnProperty.call(fields, "active") && !existing.forceInactive) {
        const wantActive = Boolean(fields.active);
        if (wantActive !== Boolean(existing.active)) {
            await mustCall(wantActive ? "resumeMonitor" : "pauseMonitor", [existing.id]);
            changed = true;
        }
    }

    if (hasTags) {
        const currentTags = (existing.tags || []).map((tag) => ({
            tag_id: tag.tag_id,
            name: tag.name,
            value: tag.value || "",
        }));
        await reconcileTags(existing.id, item.tags, currentTags, tagIdByName, item.name);
    }
}

async function reconcile(monitorList, notificationList, tagIdByName) {
    const byName = new Map();
    const idByName = new Map();
    for (const monitor of Object.values(monitorList)) {
        if (!byName.has(monitor.name)) {
            byName.set(monitor.name, monitor);
        }
        if (!idByName.has(monitor.name)) {
            idByName.set(monitor.name, monitor.id);
        }
    }

    const notifIdByName = new Map();
    for (const notification of notificationList) {
        if (!notifIdByName.has(notification.name)) {
            notifIdByName.set(notification.name, notification.id);
        }
    }

    const seen = new Set();
    for (const item of desired) {
        if (!isPlainObject(item)) {
            throw new Error("each monitor must be a mapping");
        }
        if (!item.name) {
            throw new Error("each monitor requires a name");
        }
        if (seen.has(item.name)) {
            throw new Error(`duplicate monitor name: ${item.name}`);
        }
        seen.add(item.name);
    }

    // Process in passes so a monitor can reference a parent that is defined
    // later in the list (or created during this run).
    const pending = [...desired];
    let progress = true;
    while (pending.length && progress) {
        progress = false;
        for (let i = 0; i < pending.length; ) {
            const item = pending[i];
            // Monitors being removed do not need a resolvable parent.
            const resolved =
                (item.state || "present") === "absent"
                    ? { ok: true, parent: null }
                    : resolveParent(item, idByName);
            if (!resolved.ok) {
                i++;
                continue;
            }
            await processItem(item, resolved.parent, byName, idByName, notifIdByName, tagIdByName);
            pending.splice(i, 1);
            progress = true;
        }
    }
    if (pending.length) {
        throw new Error(`could not resolve parent for: ${pending.map((entry) => entry.name).join(", ")}`);
    }
}

function main() {
    socket = io(url, {
        transports: ["websocket"],
        reconnection: false,
        timeout: ACK_TIMEOUT,
    });

    // afterLogin emits these lists right after a successful login; keep the
    // latest values so the reconciliation can use them.
    let monitorList = null;
    let notificationList = null;
    socket.on("monitorList", (list) => {
        monitorList = list;
    });
    socket.on("notificationList", (list) => {
        notificationList = list;
    });

    socket.on("connect_error", (err) => {
        console.error(`connection error: ${err.message}`);
        process.exit(1);
    });

    const globalTimeout = setTimeout(() => {
        console.error("timeout connecting to Uptime Kuma");
        process.exit(1);
    }, READY_TIMEOUT + 60000);

    socket.on("connect", async () => {
        try {
            await login();
            const monitors = await waitFor(() => monitorList, READY_TIMEOUT, "monitorList");
            const notifications = await waitFor(() => notificationList, READY_TIMEOUT, "notificationList");

            const tagsRes = await mustCall("getTags", []);
            const tagIdByName = new Map();
            for (const tag of tagsRes.tags) {
                if (!tagIdByName.has(tag.name)) {
                    tagIdByName.set(tag.name, tag.id);
                }
            }

            await reconcile(monitors, notifications, tagIdByName);

            clearTimeout(globalTimeout);
            console.log(changed ? "CHANGED" : "UNCHANGED");
            process.exit(0);
        } catch (err) {
            console.error(err.message);
            process.exit(1);
        }
    });
}

main();
