#!/usr/bin/env node
"use strict";

// Thin client that creates the initial Uptime Kuma admin user over the
// internal socket.io API, reusing the socket.io-client already shipped with
// the application (no extra dependency is required).
//
// Required environment variables:
//   UK_DIR   Path to the Uptime Kuma checkout (contains node_modules).
//   UK_USER  Admin username.
//   UK_PASS  Admin password (must not be "Too weak").
// Optional:
//   UK_URL   Server URL (default http://127.0.0.1:3001).
//
// Outputs "CHANGED" or "UNCHANGED" on stdout so Ansible can drive
// changed_when.

const path = require("path");

const appDir = process.env.UK_DIR || "/opt/uptime-kuma";
const url = process.env.UK_URL || "http://127.0.0.1:3001";
const username = process.env.UK_USER;
const password = process.env.UK_PASS;

const ACK_TIMEOUT = 10000;
const RETRY_INTERVAL = 1000;
const READY_TIMEOUT = 60000;

if (!username || !password) {
    console.error("UK_USER and UK_PASS must be set");
    process.exit(2);
}

const { io } = require(path.join(appDir, "node_modules", "socket.io-client"));

const socket = io(url, {
    transports: ["websocket"],
    reconnection: false,
    timeout: ACK_TIMEOUT,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Emit an event and wait for its acknowledgement, with a timeout.
function call(event, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
        socket.emit(event, ...args, (res) => {
            clearTimeout(timer);
            resolve(res);
        });
    });
}

// The server registers its socket handlers asynchronously after the
// connection is established, and socket.io does not buffer incoming events.
// The first "needSetup" emit can therefore be dropped before the server is
// ready, so retry until it answers or the overall deadline is reached.
async function waitForServerReady() {
    const deadline = Date.now() + READY_TIMEOUT;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return await call("needSetup", [], 3000);
        } catch (err) {
            lastError = err;
            await sleep(RETRY_INTERVAL);
        }
    }
    throw lastError || new Error("timeout waiting for needSetup");
}

// Fail cleanly instead of hanging Ansible forever if we never connect.
const globalTimeout = setTimeout(() => {
    console.error("timeout connecting to Uptime Kuma");
    process.exit(1);
}, READY_TIMEOUT + 30000);

socket.on("connect_error", (err) => {
    console.error(`connection error: ${err.message}`);
    process.exit(1);
});

socket.on("connect", async () => {
    try {
        if (!(await waitForServerReady())) {
            console.log("UNCHANGED");
            process.exit(0);
        }

        const res = await call("setup", [username, password], 30000);
        if (!res || !res.ok) {
            console.error((res && res.msg) || "setup failed");
            process.exit(1);
        }

        clearTimeout(globalTimeout);
        console.log("CHANGED");
        process.exit(0);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
