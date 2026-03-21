import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { prepareTestMode, restoreTestMode } from "./test-mode.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "datang-test-mode-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function withTempHome(testFn) {
  const previousHome = process.env.HOME;
  const tempHome = makeTempDir();
  process.env.HOME = tempHome;
  try {
    testFn(tempHome);
  } finally {
    process.env.HOME = previousHome;
  }
}

test("prepareTestMode enables only three provinces, syncs channel users to enabled speakers, and resets sessions", () => {
  withTempHome((tempHome) => {
    const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
    const controlFile = path.join(tempHome, ".openclaw", "control", "guard.json");
    const stateFile = path.join(tempHome, ".openclaw", "control", "test-mode.json");
    const silijianSessionsFile = path.join(
      tempHome,
      ".openclaw",
      "agents",
      "silijian",
      "sessions",
      "sessions.json",
    );
    const silijianSessionFile = path.join(
      tempHome,
      ".openclaw",
      "agents",
      "silijian",
      "sessions",
      "case-a.jsonl",
    );

    writeJson(configPath, {
      channels: {
        discord: {
          guilds: {
            "1482260119025614989": {
              channels: {
                "1482260425616789595": {
                  users: ["1476931252576850095"],
                },
              },
            },
          },
          accounts: {
            silijian: { enabled: true },
            neige: { enabled: true },
            shangshu: { enabled: true },
            gongbu: { enabled: true },
          },
        },
      },
      plugins: {
        entries: {
          "datang-chaotang-guard": {
            config: {
              controlFile,
              protectedAccounts: ["silijian", "neige", "shangshu", "gongbu"],
            },
          },
        },
      },
    });
    writeJson(controlFile, {
      globalMute: true,
      lastAction: "freeze",
      updatedAt: "2026-03-20T00:00:00.000Z",
      accountSnapshot: { silijian: true, neige: true, shangshu: true, gongbu: true },
    });
    writeJson(silijianSessionsFile, {
      "agent:silijian:discord:channel:1482260425616789595": {
        sessionId: "case-a",
        sessionFile: silijianSessionFile,
      },
    });
    fs.mkdirSync(path.dirname(silijianSessionFile), { recursive: true });
    fs.writeFileSync(silijianSessionFile, "[]\n", "utf8");

    const prepared = prepareTestMode({
      action: "prepare",
      scenario: "xuanzhengdian-three-province",
      configPath,
      controlFile,
      stateFile,
      restart: false,
    });

    assert.equal(prepared.accountStates.silijian, true);
    assert.equal(prepared.accountStates.neige, true);
    assert.equal(prepared.accountStates.shangshu, true);
    assert.equal(prepared.accountStates.gongbu, false);
    assert.deepEqual(prepared.channelUsers, [
      "1476931252576850095",
      "1478708449968656438",
      "1482003317327659049",
      "1482007277140709508",
      "1482262068760416317",
    ]);

    const nextConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(nextConfig.channels.discord.accounts.gongbu.enabled, false);
    assert.deepEqual(
      nextConfig.channels.discord.guilds["1482260119025614989"].channels["1482260425616789595"]
        .users,
      [
        "1476931252576850095",
        "1478708449968656438",
        "1482003317327659049",
        "1482007277140709508",
        "1482262068760416317",
      ],
    );

    const nextControl = JSON.parse(fs.readFileSync(controlFile, "utf8"));
    assert.equal(nextControl.globalMute, false);
    assert.equal(nextControl.lastAction, "test_prepare");

    const nextSessions = JSON.parse(fs.readFileSync(silijianSessionsFile, "utf8"));
    assert.equal(
      nextSessions["agent:silijian:discord:channel:1482260425616789595"],
      undefined,
    );
    assert.equal(fs.existsSync(silijianSessionFile), false);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.active, true);
    assert.equal(state.savedConfig.protectedAccountStates.gongbu, true);
  });
});

test("restoreTestMode restores prior protected-account states, channel users, and control state", () => {
  withTempHome((tempHome) => {
    const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
    const controlFile = path.join(tempHome, ".openclaw", "control", "guard.json");
    const stateFile = path.join(tempHome, ".openclaw", "control", "test-mode.json");

    writeJson(configPath, {
      channels: {
        discord: {
          guilds: {
            "1482260119025614989": {
              channels: {
                "1482260425616789595": {
                  users: ["1476931252576850095", "1478708449968656438"],
                },
              },
            },
          },
          accounts: {
            silijian: { enabled: true },
            neige: { enabled: true },
            shangshu: { enabled: true },
            gongbu: { enabled: false },
          },
        },
      },
      plugins: {
        entries: {
          "datang-chaotang-guard": {
            config: {
              controlFile,
              protectedAccounts: ["silijian", "neige", "shangshu", "gongbu"],
            },
          },
        },
      },
    });
    writeJson(controlFile, {
      globalMute: false,
      lastAction: "test_prepare",
      updatedAt: "2026-03-20T00:10:00.000Z",
      accountSnapshot: { silijian: true, neige: true, shangshu: true, gongbu: true },
    });
    writeJson(stateFile, {
      active: true,
      scenario: "xuanzhengdian-three-province",
      configPath,
      controlFile,
      savedConfig: {
        protectedAccountStates: {
          silijian: true,
          neige: false,
          shangshu: true,
          gongbu: true,
        },
        channelUsers: ["1476931252576850095"],
      },
      savedControlState: {
        globalMute: true,
        lastAction: "freeze",
        updatedAt: "2026-03-20T00:00:00.000Z",
        accountSnapshot: {
          silijian: true,
          neige: false,
          shangshu: true,
          gongbu: true,
        },
      },
    });

    const restored = restoreTestMode({
      action: "restore",
      configPath,
      controlFile,
      stateFile,
      restart: false,
    });

    assert.equal(restored.restored, true);
    const nextConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(nextConfig.channels.discord.accounts.neige.enabled, false);
    assert.equal(nextConfig.channels.discord.accounts.gongbu.enabled, true);
    assert.deepEqual(nextConfig.channels.discord.guilds["1482260119025614989"].channels["1482260425616789595"].users, [
      "1476931252576850095",
    ]);

    const nextControl = JSON.parse(fs.readFileSync(controlFile, "utf8"));
    assert.equal(nextControl.globalMute, true);
    assert.equal(nextControl.lastAction, "freeze");

    const nextState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(nextState.active, false);
  });
});
