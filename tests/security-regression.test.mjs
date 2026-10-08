import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url);

const fakeReq = (remoteAddress, headers = {}, url = "/api/console/execute") => ({
  socket: { remoteAddress },
  headers,
  method: "POST",
  url,
});

{
  const { SecurityManager } = await import("../dist/utils/security.js");

  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ]) {
    assert.equal(SecurityManager.isPrivateIp(ip), true, `private/reserved IP must be rejected: ${ip}`);
  }

  assert.equal(SecurityManager.isPrivateIp("8.8.8.8"), false);

  await assert.rejects(
    SecurityManager.assertPublicHttpUrl("http://127.0.0.1"),
    /private or reserved/i,
  );
  await assert.rejects(
    SecurityManager.assertPublicHttpUrl("http://example.com"),
    /allowlisted/i,
  );

  SecurityManager.clearAllCooldowns();
  assert.equal(SecurityManager.checkCooldown("user-1", "play", 10_000, "guild-a").onCooldown, false);
  assert.equal(SecurityManager.checkCooldown("user-1", "play", 10_000, "guild-a").onCooldown, true);
  assert.equal(SecurityManager.checkCooldown("user-1", "play", 10_000, "guild-b").onCooldown, false);
  SecurityManager.clearAllCooldowns();
}

{
  const { verifyAdminAuth } = await import("../dist/control-center/auth.js");

  // Development compatibility is socket-based, not Host-based.
  assert.equal(
    verifyAdminAuth(fakeReq("8.8.8.8", { host: "127.0.0.1:3000" })),
    false,
    "forged Host must never create local trust",
  );
  assert.equal(
    verifyAdminAuth(fakeReq("127.0.0.1", { host: "attacker.example" })),
    true,
    "real loopback peer remains supported in development",
  );
  assert.equal(
    verifyAdminAuth(fakeReq("::ffff:127.0.0.1", { host: "attacker.example" })),
    true,
    "IPv4-mapped loopback remains supported",
  );
}

{
  const script = [
    'process.env.NODE_ENV="production";',
    'delete process.env.CONTROL_CENTER_KEY;',
    'import("./dist/control-center/auth.js").then(()=>process.exit(0)).catch(()=>process.exit(7));',
  ].join("");
  let missingKeyExit = 0;
  try { execFileSync(process.execPath, ["-e", script], { cwd: new URL(repoRoot).pathname }); }
  catch (error) { missingKeyExit = error.status ?? -1; }
  assert.equal(missingKeyExit, 7, "production without CONTROL_CENTER_KEY must fail closed");
}

{
  const { handleControlCenterApi } = await import("../dist/control-center/api.js");
  const makeRes = () => ({
    statusCode: 0,
    body: "",
    headers: {},
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end(body = "") { this.body = String(body); },
    write() {},
    on() {},
  });

  const client = {
    isReady: () => false,
    config: { token: "", devGuildId: "", defaultVolume: 100, idleTimeout: 300_000, emptyVoiceTimeout: 180_000, maxQueueSize: 500, maxPlaylistSize: 100 },
    commands: new Map(),
    queues: new Map(),
    guilds: { cache: new Map() },
  };

  const req = fakeReq("8.8.8.8", { host: "127.0.0.1:3000" });
  const res = makeRes();
  await handleControlCenterApi(req, res, client);
  assert.equal(res.statusCode, 401, "forged Host must not bypass API authentication");

  const sseReq = fakeReq("8.8.8.8", { host: "localhost:3000" }, "/api/logs/stream");
  const sseRes = makeRes();
  await handleControlCenterApi(sseReq, sseRes, client);
  assert.equal(sseRes.statusCode, 401, "SSE must require authentication");
}

console.log("Security regression suite passed.");
