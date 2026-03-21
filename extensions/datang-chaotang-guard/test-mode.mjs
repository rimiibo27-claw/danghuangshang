import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CONTROL_FILE,
  DEFAULT_PROTECTED_ACCOUNTS,
  DEFAULT_XUANZHENGDIAN_CHANNEL_ID,
  readControlState,
  readJsonFile,
  resolvePluginConfig,
  timestampNow,
  writeJsonFile,
} from "./shared.mjs";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const DEFAULT_TEST_STATE_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "control",
  "datang-chaotang-test-mode.json",
);
const DEFAULT_GUILD_ID = "1482260119025614989";
const DEFAULT_DEFAULT_BOT_USER_ID = "1478708449968656438";
const HANYUANDIAN_CHANNEL_ID = "1482260119457632359";

const SCENARIOS = {
  "xuanzhengdian-three-province": {
    guildId: DEFAULT_GUILD_ID,
    channelId: DEFAULT_XUANZHENGDIAN_CHANNEL_ID,
    enabledAccounts: ["silijian", "neige", "shangshu"],
    sessionAgents: ["silijian", "neige", "shangshu"],
    injectUserIds: [DEFAULT_DEFAULT_BOT_USER_ID],
  },
  "xuanzhengdian-three-province-autonomous": {
    guildId: DEFAULT_GUILD_ID,
    channelId: DEFAULT_XUANZHENGDIAN_CHANNEL_ID,
    enabledAccounts: ["dianzhongsheng", "silijian", "neige", "shangshu"],
    sessionAgents: ["dianzhongsheng", "silijian", "neige", "shangshu"],
    injectUserIds: [DEFAULT_DEFAULT_BOT_USER_ID],
  },
  "hanyuandian-rollcall": {
    guildId: DEFAULT_GUILD_ID,
    channelId: HANYUANDIAN_CHANNEL_ID,
    enabledAccounts: ["dianzhongsheng", "silijian", "neige", "shangshu"],
    sessionAgents: ["dianzhongsheng", "silijian", "neige", "shangshu"],
    injectUserIds: [DEFAULT_DEFAULT_BOT_USER_ID],
  },
};

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function parseArgs(argv) {
  const args = [...argv];
  const action = args.shift();
  if (!action) {
    throw new Error(
      "usage: prepare|restore|status [--scenario <name>] [--config <path>] [--control <path>] [--state <path>] [--no-restart]",
    );
  }

  const options = {
    action,
    scenario: "xuanzhengdian-three-province",
    configPath: DEFAULT_CONFIG_PATH,
    controlFile: "",
    stateFile: DEFAULT_TEST_STATE_FILE,
    restart: action !== "status",
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--scenario") {
      options.scenario = args.shift() ?? "";
      continue;
    }
    if (arg === "--config") {
      options.configPath = args.shift() ?? "";
      continue;
    }
    if (arg === "--control") {
      options.controlFile = args.shift() ?? "";
      continue;
    }
    if (arg === "--state") {
      options.stateFile = args.shift() ?? "";
      continue;
    }
    if (arg === "--no-restart") {
      options.restart = false;
      continue;
    }
    if (arg === "--restart") {
      options.restart = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!options.configPath) throw new Error("missing --config value");
  if (!options.stateFile) throw new Error("missing --state value");
  return options;
}

function loadConfig(configPath) {
  const config = readJsonFile(configPath);
  if (!config || typeof config !== "object") {
    throw new Error(`invalid openclaw config: ${configPath}`);
  }
  return config;
}

function getPluginEntry(config) {
  const entries = config.plugins?.entries;
  if (!entries || typeof entries !== "object") return {};
  const entry = entries["datang-chaotang-guard"];
  return entry && typeof entry === "object" ? entry : {};
}

function getProtectedAccounts(config) {
  const pluginEntry = getPluginEntry(config);
  const accounts = pluginEntry.config?.protectedAccounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return [...DEFAULT_PROTECTED_ACCOUNTS];
  }
  return uniqueStrings(accounts);
}

function getGuardConfig(config) {
  const pluginEntry = getPluginEntry(config);
  return resolvePluginConfig(pluginEntry.config ?? {});
}

function getControlFile(config, overrideControlFile) {
  if (overrideControlFile) return overrideControlFile;
  const pluginEntry = getPluginEntry(config);
  const configured = pluginEntry.config?.controlFile;
  return typeof configured === "string" && configured.trim() ? configured.trim() : DEFAULT_CONTROL_FILE;
}

function getScenario(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    throw new Error(`unknown scenario: ${name}`);
  }
  return scenario;
}

function getDiscordAccounts(config) {
  const accounts = config.channels?.discord?.accounts;
  if (!accounts || typeof accounts !== "object") {
    throw new Error("channels.discord.accounts is missing from openclaw config");
  }
  return accounts;
}

function getAccountStates(config, protectedAccounts) {
  const discordAccounts = getDiscordAccounts(config);
  const snapshot = {};
  for (const accountId of protectedAccounts) {
    const current = discordAccounts[accountId];
    snapshot[accountId] = current?.enabled !== false;
  }
  return snapshot;
}

function applyProtectedAccountStates(config, protectedAccounts, nextStates) {
  const discordAccounts = getDiscordAccounts(config);
  for (const accountId of protectedAccounts) {
    if (!discordAccounts[accountId] || typeof discordAccounts[accountId] !== "object") continue;
    discordAccounts[accountId].enabled = nextStates[accountId] !== false;
  }
}

function buildScenarioAccountStates(protectedAccounts, enabledAccounts) {
  const enabledSet = new Set(enabledAccounts);
  const nextStates = {};
  for (const accountId of protectedAccounts) {
    nextStates[accountId] = enabledSet.has(accountId);
  }
  return nextStates;
}

function getChannelEntry(config, guildId, channelId) {
  const guilds = config.channels?.discord?.guilds;
  if (!guilds || typeof guilds !== "object") {
    throw new Error("channels.discord.guilds is missing from openclaw config");
  }
  const guild = guilds[guildId];
  if (!guild || typeof guild !== "object") {
    throw new Error(`discord guild is missing from openclaw config: ${guildId}`);
  }
  const channels = guild.channels;
  if (!channels || typeof channels !== "object") {
    throw new Error(`discord guild channels are missing from openclaw config: ${guildId}`);
  }
  const channel = channels[channelId];
  if (!channel || typeof channel !== "object") {
    throw new Error(`discord channel is missing from openclaw config: ${guildId}/${channelId}`);
  }
  return channel;
}

function setChannelUsers(channelEntry, nextUsers) {
  if (nextUsers === null) {
    delete channelEntry.users;
    return;
  }
  channelEntry.users = [...nextUsers];
}

function buildScenarioChannelUsers(guardConfig, scenario) {
  const enabledAccountUserIds = scenario.enabledAccounts
    .map((accountId) => guardConfig.accountUserIds[accountId])
    .filter(Boolean);
  return uniqueStrings([
    ...guardConfig.humanUserIds,
    ...scenario.injectUserIds,
    ...enabledAccountUserIds,
  ]);
}

function renameIfExists(filePath, suffix) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const nextPath = `${filePath}${suffix}`;
  fs.renameSync(filePath, nextPath);
  return nextPath;
}

function resetAgentChannelSession(agentId, channelId, timestampLabel) {
  const sessionsDir = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
  const sessionsFile = path.join(sessionsDir, "sessions.json");
  const sessionKey = `agent:${agentId}:discord:channel:${channelId}`;
  const sessions = readJsonFile(sessionsFile);
  if (!sessions || typeof sessions !== "object") {
    return { agentId, sessionKey, removed: false };
  }

  const entry = sessions[sessionKey];
  if (!entry || typeof entry !== "object") {
    return { agentId, sessionKey, removed: false };
  }

  const storeBackupPath = `${sessionsFile}.bak-${timestampLabel}`;
  if (!fs.existsSync(storeBackupPath)) {
    fs.copyFileSync(sessionsFile, storeBackupPath);
  }

  delete sessions[sessionKey];
  writeJsonFile(sessionsFile, sessions);

  const sessionFile =
    typeof entry.sessionFile === "string" && entry.sessionFile.trim() ? entry.sessionFile.trim() : "";
  const movedSessionFile = renameIfExists(sessionFile, `.reset.${timestampLabel}`);

  return {
    agentId,
    sessionKey,
    removed: true,
    sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
    movedSessionFile,
    storeBackupPath,
  };
}

function restartGatewayIfNeeded(shouldRestart) {
  if (!shouldRestart) return { restarted: false };

  const result = spawnSync("openclaw", ["gateway", "restart"], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`openclaw gateway restart failed with code ${result.status ?? "unknown"}`);
  }

  return { restarted: true };
}

function restoreFromState(state, options = {}) {
  if (!state || typeof state !== "object" || state.active !== true) {
    return {
      action: "restore",
      active: false,
      restored: false,
      restarted: false,
      stateFile: options.stateFile ?? DEFAULT_TEST_STATE_FILE,
    };
  }

  const configPath =
    typeof state.configPath === "string" && state.configPath.trim()
      ? state.configPath.trim()
      : DEFAULT_CONFIG_PATH;
  const controlFile =
    typeof state.controlFile === "string" && state.controlFile.trim()
      ? state.controlFile.trim()
      : DEFAULT_CONTROL_FILE;
  const scenario = getScenario(state.scenario ?? "xuanzhengdian-three-province");
  const config = loadConfig(configPath);
  const protectedAccounts = getProtectedAccounts(config);
  applyProtectedAccountStates(
    config,
    protectedAccounts,
    state.savedConfig?.protectedAccountStates ?? {},
  );

  const channelEntry = getChannelEntry(config, scenario.guildId, scenario.channelId);
  const savedUsers = Array.isArray(state.savedConfig?.channelUsers)
    ? state.savedConfig.channelUsers
    : null;
  setChannelUsers(channelEntry, savedUsers);
  writeJsonFile(configPath, config);

  writeJsonFile(controlFile, state.savedControlState ?? readControlState(controlFile));

  const nextState = {
    ...state,
    active: false,
    restoredAt: timestampNow(),
  };
  writeJsonFile(options.stateFile ?? state.stateFile ?? DEFAULT_TEST_STATE_FILE, nextState);

  const restart = restartGatewayIfNeeded(options.restart === true);
  return {
    action: "restore",
    active: false,
    restored: true,
    restarted: restart.restarted,
    stateFile: options.stateFile ?? state.stateFile ?? DEFAULT_TEST_STATE_FILE,
    scenario: state.scenario,
    restoredAccounts: state.savedConfig?.protectedAccountStates ?? {},
  };
}

export function prepareTestMode(options) {
  const stateFile = options.stateFile || DEFAULT_TEST_STATE_FILE;
  const existingState = readJsonFile(stateFile);
  if (existingState?.active === true) {
    restoreFromState(existingState, { stateFile, restart: false });
  }

  const config = loadConfig(options.configPath);
  const scenario = getScenario(options.scenario);
  const guardConfig = getGuardConfig(config);
  const protectedAccounts = getProtectedAccounts(config);
  const controlFile = getControlFile(config, options.controlFile);
  const currentControlState = readControlState(controlFile);
  const channelEntry = getChannelEntry(config, scenario.guildId, scenario.channelId);
  const savedChannelUsers = Array.isArray(channelEntry.users) ? [...channelEntry.users] : null;

  const savedProtectedAccountStates = getAccountStates(config, protectedAccounts);
  const nextAccountStates = buildScenarioAccountStates(protectedAccounts, scenario.enabledAccounts);
  applyProtectedAccountStates(config, protectedAccounts, nextAccountStates);

  const nextUsers = buildScenarioChannelUsers(guardConfig, scenario);
  setChannelUsers(channelEntry, nextUsers);
  writeJsonFile(options.configPath, config);

  writeJsonFile(controlFile, {
    ...currentControlState,
    globalMute: false,
    lastAction: "test_prepare",
    updatedAt: timestampNow(),
  });

  if (guardConfig.stateFile) {
    const currentGuardState = readJsonFile(guardConfig.stateFile);
    const channels =
      currentGuardState && typeof currentGuardState.channels === "object" && currentGuardState.channels
        ? { ...currentGuardState.channels }
        : {};
    delete channels[scenario.channelId];
    writeJsonFile(guardConfig.stateFile, { channels });
  }

  const timestampLabel = timestampNow().replaceAll(":", "-");
  const sessionBackups = scenario.sessionAgents.map((agentId) =>
    resetAgentChannelSession(agentId, scenario.channelId, timestampLabel),
  );

  const nextState = {
    active: true,
    scenario: options.scenario,
    configPath: options.configPath,
    controlFile,
    stateFile,
    preparedAt: timestampNow(),
    savedConfig: {
      protectedAccountStates: savedProtectedAccountStates,
      channelUsers: savedChannelUsers,
    },
    savedControlState: currentControlState,
    sessionBackups,
  };
  writeJsonFile(stateFile, nextState);

  const restart = restartGatewayIfNeeded(options.restart === true);
  return {
    action: "prepare",
    active: true,
    scenario: options.scenario,
    configPath: options.configPath,
    controlFile,
    stateFile,
    restarted: restart.restarted,
    protectedAccounts,
    accountStates: nextAccountStates,
    channelUsers: nextUsers,
    sessionBackups,
  };
}

export function restoreTestMode(options) {
  const stateFile = options.stateFile || DEFAULT_TEST_STATE_FILE;
  return restoreFromState(readJsonFile(stateFile), {
    stateFile,
    restart: options.restart === true,
  });
}

export function getTestModeStatus(options) {
  const config = loadConfig(options.configPath);
  const scenario = getScenario(options.scenario);
  const protectedAccounts = getProtectedAccounts(config);
  const controlFile = getControlFile(config, options.controlFile);
  const channelEntry = getChannelEntry(config, scenario.guildId, scenario.channelId);
  const state = readJsonFile(options.stateFile || DEFAULT_TEST_STATE_FILE);

  return {
    action: "status",
    scenario: options.scenario,
    configPath: options.configPath,
    controlFile,
    stateFile: options.stateFile || DEFAULT_TEST_STATE_FILE,
    active: state?.active === true,
    globalMute: readControlState(controlFile).globalMute,
    protectedAccounts,
    accountStates: getAccountStates(config, protectedAccounts),
    channelUsers: Array.isArray(channelEntry.users) ? channelEntry.users : [],
    savedConfig: state?.savedConfig ?? null,
    sessionBackups: state?.sessionBackups ?? [],
  };
}

export function runTestModeAction(options) {
  if (options.action === "prepare") {
    return prepareTestMode(options);
  }
  if (options.action === "restore") {
    return restoreTestMode(options);
  }
  if (options.action === "status") {
    return getTestModeStatus(options);
  }
  throw new Error(`unsupported action: ${options.action}`);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runTestModeAction(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
