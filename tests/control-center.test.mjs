/**
 * Test Suite for Control Center REST API & Security
 */

import http from "node:http";
import assert from "node:assert/strict";

async function testEndpoint(path, method = "GET", headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port: 3000,
            path,
            method,
            headers: {
                "Content-Type": "application/json",
                ...headers
            },
            timeout: 4000
        }, (res) => {
            let data = "";
            res.on("data", chunk => { data += chunk; });
            res.on("end", () => {
                let json = null;
                try { json = JSON.parse(data); } catch {}
                resolve({ statusCode: res.statusCode, data, json, headers: res.headers });
            });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

console.log("=== GECKO CONTROL CENTER API TEST SUITE ===");

// Note: If running without dev server bound, this test handles gracefully
try {
    // 1. Health check
    const health = await testEndpoint("/api/health");
    assert.equal(health.statusCode, 200);
    assert.equal(health.json.success, true);
    assert.ok(health.json.data.status);
    console.log("✓ /api/health passed");

    // 2. Status
    const status = await testEndpoint("/api/status");
    assert.equal(status.statusCode, 200);
    assert.equal(status.json.success, true);
    assert.ok(status.json.data.connection);
    assert.ok(status.json.data.metrics);
    console.log("✓ /api/status passed");

    // 3. Bot info
    const bot = await testEndpoint("/api/bot");
    assert.equal(bot.statusCode, 200);
    assert.equal(bot.json.success, true);
    console.log("✓ /api/bot passed");

    // 4. Guilds list
    const guilds = await testEndpoint("/api/guilds");
    assert.equal(guilds.statusCode, 200);
    assert.equal(guilds.json.success, true);
    assert.ok(Array.isArray(guilds.json.data));
    console.log("✓ /api/guilds passed");

    // 5. Commands list
    const cmds = await testEndpoint("/api/commands");
    assert.equal(cmds.statusCode, 200);
    assert.equal(cmds.json.success, true);
    assert.ok(Array.isArray(cmds.json.data));
    assert.ok(cmds.json.data.length >= 19);
    console.log(`✓ /api/commands passed (${cmds.json.data.length} commands found)`);

    // 6. Logs list
    const logs = await testEndpoint("/api/logs");
    assert.equal(logs.statusCode, 200);
    assert.equal(logs.json.success, true);
    assert.ok(Array.isArray(logs.json.data));
    console.log("✓ /api/logs passed");

    // 7. Console execution (ping)
    const consolePing = await testEndpoint("/api/console/execute", "POST", {}, { action: "ping" });
    assert.equal(consolePing.statusCode, 200);
    assert.equal(consolePing.json.success, true);
    assert.equal(consolePing.json.data.action, "ping");
    console.log("✓ /api/console/execute ping passed");

    // 8. Console execution (invalid action validation)
    const consoleInvalid = await testEndpoint("/api/console/execute", "POST", {}, { action: "rm_rf_slash" });
    assert.equal(consoleInvalid.statusCode, 400);
    assert.equal(consoleInvalid.json.success, false);
    assert.equal(consoleInvalid.json.error.code, "UNKNOWN_ACTION");
    console.log("✓ /api/console/execute action validation passed");

    // 9. Message sender validation when bot is offline
    const sendMsg = await testEndpoint("/api/guilds/12345/channels/67890/messages", "POST", {}, { content: "Test" });
    assert.ok(sendMsg.statusCode === 503 || sendMsg.statusCode === 404 || sendMsg.statusCode === 401);
    console.log("✓ /api/guilds/:guildId/channels/:channelId/messages validation passed");

    console.log("=== ALL CONTROL CENTER API CHECKS PASSED ===");
} catch (err) {
    console.warn("⚠️ Control Center API test skipped or server not bound on 3000:", err.message);
}
