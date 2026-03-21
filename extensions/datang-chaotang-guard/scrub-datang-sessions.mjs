import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CONTROL_FILE,
  resolvePluginConfig,
  ensureParentDir,
  readJsonFile,
  timestampNow,
  writeJsonFile,
} from "./shared.mjs";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const DEFAULT_ARCHIVE_ROOT = path.join(
  os.homedir(),
  "Documents",
  "todo_claw",
  "datang-runtime-archives",
);

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    archiveRoot: DEFAULT_ARCHIVE_ROOT,
    controlFile: DEFAULT_CONTROL_FILE,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--config") {
      options.configPath = args.shift() ?? "";
      continue;
    }
    if (arg === "--archive-root") {
      options.archiveRoot = args.shift() ?? "";
      continue;
    }
    if (arg === "--control") {
      options.controlFile = args.shift() ?? "";
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!options.configPath) throw new Error("missing --config value");
  if (!options.archiveRoot) throw new Error("missing --archive-root value");
  return options;
}

function loadProtectedAccounts(configPath) {
  const config = readJsonFile(configPath);
  if (!config || typeof config !== "object") {
    throw new Error(`invalid openclaw config: ${configPath}`);
  }
  const pluginConfig = config.plugins?.entries?.["datang-chaotang-guard"]?.config ?? {};
  return [...resolvePluginConfig(pluginConfig).protectedAccounts];
}

function moveSessionContents(accountId, archiveRoot, timestampLabel) {
  const sessionsDir = path.join(os.homedir(), ".openclaw", "agents", accountId, "sessions");
  if (!fs.existsSync(sessionsDir)) {
    return { accountId, sessionsDir, archivedEntries: [], archiveDir: null };
  }

  const entries = fs.readdirSync(sessionsDir);
  const archiveDir = path.join(archiveRoot, timestampLabel, "sessions", accountId);
  ensureParentDir(path.join(archiveDir, ".keep"));
  const archivedEntries = [];

  for (const entryName of entries) {
    const srcPath = path.join(sessionsDir, entryName);
    const destPath = path.join(archiveDir, entryName);
    fs.renameSync(srcPath, destPath);
    archivedEntries.push(entryName);
  }

  fs.mkdirSync(sessionsDir, { recursive: true });
  writeJsonFile(path.join(sessionsDir, "sessions.json"), {});

  return {
    accountId,
    sessionsDir,
    archiveDir,
    archivedEntries,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const protectedAccounts = loadProtectedAccounts(options.configPath);
  const timestampLabel = timestampNow().replaceAll(":", "-");
  const results = protectedAccounts.map((accountId) =>
    moveSessionContents(accountId, options.archiveRoot, timestampLabel),
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        action: "scrub_datang_sessions",
        configPath: options.configPath,
        controlFile: options.controlFile,
        archiveRoot: options.archiveRoot,
        timestampLabel,
        protectedAccounts,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
