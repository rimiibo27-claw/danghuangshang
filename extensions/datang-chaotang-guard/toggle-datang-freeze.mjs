import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CONTROL_FILE,
  DEFAULT_PROTECTED_ACCOUNTS,
  PLUGIN_ID,
  readControlState,
  readJsonFile,
  timestampNow,
  writeJsonFile,
} from "./shared.mjs";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

function parseArgs(argv) {
  const args = [...argv];
  const action = args.shift();
  if (!action) {
    throw new Error("usage: freeze|unfreeze|status [--config <path>] [--control <path>] [--no-restart]");
  }

  const options = {
    action,
    configPath: DEFAULT_CONFIG_PATH,
    controlFile: "",
    restart: action !== "status",
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--config") {
      options.configPath = args.shift() ?? "";
      continue;
    }
    if (arg === "--control") {
      options.controlFile = args.shift() ?? "";
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

  if (!options.configPath) {
    throw new Error("missing --config value");
  }

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
  return entries[PLUGIN_ID] && typeof entries[PLUGIN_ID] === "object" ? entries[PLUGIN_ID] : {};
}

function getProtectedAccounts(config) {
  const pluginEntry = getPluginEntry(config);
  const accounts = pluginEntry.config?.protectedAccounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return [...DEFAULT_PROTECTED_ACCOUNTS];
  }
  return [...new Set(accounts.map((value) => String(value).trim()).filter(Boolean))];
}

function getXuanzhengdianBlockedAccounts(config) {
  const pluginEntry = getPluginEntry(config);
  const accounts = pluginEntry.config?.xuanzhengdianBlockedAccounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return [];
  }
  return [...new Set(accounts.map((value) => String(value).trim()).filter(Boolean))];
}

function getControlFile(config, overrideControlFile) {
  if (overrideControlFile) return overrideControlFile;
  const pluginEntry = getPluginEntry(config);
  const configured = pluginEntry.config?.controlFile;
  return typeof configured === "string" && configured.trim() ? configured.trim() : DEFAULT_CONTROL_FILE;
}

function getAccountStates(config, protectedAccounts) {
  const discordAccounts = config.channels?.discord?.accounts ?? {};
  const snapshot = {};
  for (const accountId of protectedAccounts) {
    const current = discordAccounts[accountId];
    snapshot[accountId] = current?.enabled !== false;
  }
  return snapshot;
}

function applyAccountStates(config, protectedAccounts, nextStates) {
  const discordAccounts = config.channels?.discord?.accounts;
  if (!discordAccounts || typeof discordAccounts !== "object") {
    throw new Error("channels.discord.accounts is missing from openclaw config");
  }

  for (const accountId of protectedAccounts) {
    if (!discordAccounts[accountId] || typeof discordAccounts[accountId] !== "object") {
      continue;
    }
    discordAccounts[accountId].enabled = nextStates[accountId] !== false;
  }
}

function writeControlFile(controlFile, state) {
  writeJsonFile(controlFile, state);
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

export function runAction(options) {
  const config = loadConfig(options.configPath);
  const protectedAccounts = getProtectedAccounts(config);
  const controlFile = getControlFile(config, options.controlFile);
  const currentControlState = readControlState(controlFile);

  if (options.action === "status") {
    return {
      action: "status",
      configPath: options.configPath,
      controlFile,
      globalMute: currentControlState.globalMute,
      protectedAccounts,
      xuanzhengdianBlockedAccounts: getXuanzhengdianBlockedAccounts(config),
      accountStates: getAccountStates(config, protectedAccounts),
    };
  }

  if (options.action !== "freeze" && options.action !== "unfreeze") {
    throw new Error(`unsupported action: ${options.action}`);
  }

  const currentStates = getAccountStates(config, protectedAccounts);
  const snapshot =
    currentControlState.accountSnapshot && Object.keys(currentControlState.accountSnapshot).length > 0
      ? currentControlState.accountSnapshot
      : currentStates;

  const nextAccountStates = {};
  if (options.action === "freeze") {
    for (const accountId of protectedAccounts) nextAccountStates[accountId] = false;
  } else {
    for (const accountId of protectedAccounts) {
      nextAccountStates[accountId] = snapshot[accountId] !== false;
    }
  }

  applyAccountStates(config, protectedAccounts, nextAccountStates);
  writeJsonFile(options.configPath, config);

  writeControlFile(controlFile, {
    globalMute: options.action === "freeze",
    lastAction: options.action,
    updatedAt: timestampNow(),
    accountSnapshot: snapshot,
  });

  const restart = restartGatewayIfNeeded(options.restart);

  return {
    action: options.action,
    configPath: options.configPath,
    controlFile,
    globalMute: options.action === "freeze",
    protectedAccounts,
    xuanzhengdianBlockedAccounts: getXuanzhengdianBlockedAccounts(config),
    accountStates: nextAccountStates,
    restarted: restart.restarted,
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runAction(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
