import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { prepareTestMode } from "./test-mode.mjs";
import { extractFormalEnvelope } from "./shared.mjs";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const DEFAULT_CONTROL_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "control",
  "datang-chaotang-guard.json",
);
const DEFAULT_STATE_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "control",
  "datang-chaotang-test-mode.json",
);
const XUANZHENGDIAN_CHANNEL_ID = "1482260425616789595";
const READ_ACCOUNT_ID = "silijian";
const INITIATOR_ACCOUNT_ID = "dianzhongsheng";
const ACCOUNT_NAMES = {
  dianzhongsheng: "殿中监·高力士",
  silijian: "中书令·苏绰",
  neige: "侍中·魏徵",
  shangshu: "尚书令·裴耀卿",
};
const CORE_ACCOUNT_NAMES = {
  silijian: ACCOUNT_NAMES.silijian,
  neige: ACCOUNT_NAMES.neige,
  shangshu: ACCOUNT_NAMES.shangshu,
};
const REQUIRED_ACCOUNTS = ["dianzhongsheng", "silijian", "neige", "shangshu"];
const LOGIN_LOOKBACK_MS = 30 * 1000;

function buildLocalDateLabel(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultLogPath() {
  return path.join(os.tmpdir(), "openclaw", `openclaw-${buildLocalDateLabel()}.log`);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    controlFile: DEFAULT_CONTROL_FILE,
    stateFile: DEFAULT_STATE_FILE,
    logPath: defaultLogPath(),
    caseKey: `轮测-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`,
    timeoutSeconds: 60,
    pollSeconds: 2,
    loginTimeoutSeconds: 60,
    prepare: true,
    scenario: "xuanzhengdian-three-province-autonomous",
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
    if (arg === "--state") {
      options.stateFile = args.shift() ?? "";
      continue;
    }
    if (arg === "--log-path") {
      options.logPath = args.shift() ?? "";
      continue;
    }
    if (arg === "--scenario") {
      options.scenario = args.shift() ?? "";
      continue;
    }
    if (arg === "--case-key") {
      options.caseKey = args.shift() ?? "";
      continue;
    }
    if (arg === "--timeout-seconds") {
      options.timeoutSeconds = Number(args.shift() ?? "60");
      continue;
    }
    if (arg === "--poll-seconds") {
      options.pollSeconds = Number(args.shift() ?? "2");
      continue;
    }
    if (arg === "--login-timeout-seconds") {
      options.loginTimeoutSeconds = Number(args.shift() ?? "25");
      continue;
    }
    if (arg === "--no-prepare") {
      options.prepare = false;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!options.caseKey) throw new Error("missing --case-key value");
  if (!options.logPath) throw new Error("missing --log-path value");
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJson(output) {
  const text = String(output ?? "").trim();
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error(`no json payload found: ${text}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(start, index + 1));
      }
    }
  }

  throw new Error(`unterminated json payload: ${text.slice(start, Math.min(text.length, start + 400))}`);
}

function runOpenClaw(args) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `openclaw ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  return result.stdout || result.stderr || "";
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\"'\"'`)}'`;
}

function runOpenClawShell(command) {
  const result = spawnSync("/bin/zsh", ["-lc", command], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || String(result.status));
  }
  return result.stdout || result.stderr || "";
}

function shouldRetryOpenClaw(error) {
  const text = String(error instanceof Error ? error.message : error ?? "");
  return /fetch failed|gateway closed \(1006/i.test(text);
}

async function runOpenClawShellWithRetry(command, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 3;
  const retryDelayMs = Number.isInteger(options.retryDelayMs) ? options.retryDelayMs : 2000;

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return runOpenClawShell(command);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetryOpenClaw(error)) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }

  throw lastError ?? new Error(command);
}

async function runOpenClawWithRetry(args, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 3;
  const retryDelayMs = Number.isInteger(options.retryDelayMs) ? options.retryDelayMs : 2000;

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return runOpenClaw(args);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetryOpenClaw(error)) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }

  throw lastError ?? new Error(`openclaw ${args.join(" ")} failed`);
}

async function sendDiscordMessageWithRetry({ accountId, target, message }, options = {}) {
  const command = [
    "openclaw",
    "message",
    "send",
    "--channel",
    "discord",
    "--account",
    shellQuote(accountId),
    "--target",
    shellQuote(target),
    "--message",
    shellQuote(message),
    "--json",
  ].join(" ");
  return runOpenClawShellWithRetry(command, options);
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw error;
  }
}

function formatLogEntryPayload(entry) {
  return [entry["0"], entry["1"], entry["2"]]
    .filter((value) => value !== undefined)
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
}

function parseRecentLogEntries(logPath, maxLines = 800) {
  const text = safeReadFile(logPath);
  if (!text.trim()) return [];
  const lines = text.trim().split("\n").slice(-maxLines);
  return lines
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        const dateMs = Date.parse(parsed?._meta?.date ?? parsed?.time ?? "");
        return {
          dateMs: Number.isFinite(dateMs) ? dateMs : 0,
          text: formatLogEntryPayload(parsed),
        };
      } catch {
        return { dateMs: 0, text: line };
      }
    })
    .filter((entry) => entry.text);
}

function collectRecentLogEntries(logPath, sinceMs) {
  return parseRecentLogEntries(logPath).filter((entry) => entry.dateMs >= sinceMs - 1000);
}

async function waitForDiscordLogins({ logPath, sinceMs, requiredAccounts, timeoutMs }) {
  const pending = new Set(requiredAccounts);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const entries = collectRecentLogEntries(logPath, Math.max(0, sinceMs - LOGIN_LOOKBACK_MS));
    for (const accountId of [...pending]) {
      const expected = `logged in to discord as`;
      const name = ACCOUNT_NAMES[accountId];
      const matched = entries.some(
        (entry) => entry.text.includes(expected) && entry.text.includes(`(${name})`),
      );
      if (matched) pending.delete(accountId);
    }
    if (pending.size === 0) {
      return {
        ok: true,
        logins: requiredAccounts.map((accountId) => ({
          accountId,
          name: ACCOUNT_NAMES[accountId],
        })),
      };
    }
    await sleep(500);
  }

  const diagnosticEntries = collectRecentLogEntries(
    logPath,
    Math.max(0, sinceMs - LOGIN_LOOKBACK_MS),
  ).slice(-20);
  return {
    ok: false,
    missingAccounts: [...pending],
    diagnostics: diagnosticEntries.map((entry) => entry.text),
  };
}

function buildInitiatorMessage(caseKey) {
  return `【${caseKey}】仅三省，最多3轮，请中书省起草。<@1482003317327659049> <@&1482261624973819988> {"request_type":"THREE_PROVINCE_ROUND_TEST"}`;
}

function parseCoreFormalMessages(botMessages) {
  return botMessages
    .filter((message) => Object.values(CORE_ACCOUNT_NAMES).includes(message.author?.username ?? ""))
    .map((message) => ({
      ...message,
      summary: extractFormalEnvelope(String(message.content ?? "")),
    }));
}

function validateRoundSequence(coreFormalMessages) {
  let expectedStage = "DRAFT";
  let expectedRound = 1;
  let terminalStatus = null;

  for (const message of coreFormalMessages) {
    const author = message.author?.username ?? "unknown";
    const stage = message.summary.chainStage;
    const round = message.summary.round;
    const status = message.summary.status;

    if (!stage || !["DRAFT", "REVIEW", "DECISION"].includes(stage)) {
      return {
        ok: false,
        reason: `missing_or_invalid_stage:${author}`,
      };
    }
    if (!Number.isInteger(round)) {
      return {
        ok: false,
        reason: `missing_round:${author}:${stage}`,
      };
    }
    if (round !== expectedRound) {
      return {
        ok: false,
        reason: `round_mismatch:${author}:${stage}:${round}:expected:${expectedRound}`,
      };
    }
    if (stage !== expectedStage) {
      return {
        ok: false,
        reason: `stage_out_of_order:${author}:${stage}:expected:${expectedStage}`,
      };
    }
    if (stage === "DRAFT" && author !== CORE_ACCOUNT_NAMES.silijian) {
      return {
        ok: false,
        reason: `draft_wrong_author:${author}`,
      };
    }
    if (stage === "REVIEW" && author !== CORE_ACCOUNT_NAMES.neige) {
      return {
        ok: false,
        reason: `review_wrong_author:${author}`,
      };
    }
    if (stage === "DECISION" && author !== CORE_ACCOUNT_NAMES.shangshu) {
      return {
        ok: false,
        reason: `decision_wrong_author:${author}`,
      };
    }

    if (stage === "DRAFT") {
      expectedStage = "REVIEW";
      continue;
    }
    if (stage === "REVIEW") {
      expectedStage = "DECISION";
      continue;
    }

    if (!["REVISE_NEXT_ROUND", "CONSENSUS_REACHED", "ESCALATE_TO_HUMAN"].includes(status)) {
      return {
        ok: false,
        reason: `invalid_decision_status:${status || "missing"}`,
      };
    }
    if (status === "REVISE_NEXT_ROUND") {
      expectedRound += 1;
      expectedStage = "DRAFT";
      continue;
    }

    terminalStatus = status;
    expectedStage = null;
  }

  return {
    ok: true,
    terminalStatus,
    expectedStage,
    expectedRound,
  };
}

function collectSignals(messages, startMs, caseKey) {
  const relevant = messages
    .filter((message) => Number(message.timestampMs ?? 0) >= startMs - 2000)
    .filter((message) => String(message.content ?? "").includes(caseKey))
    .sort((a, b) => Number(a.timestampMs ?? 0) - Number(b.timestampMs ?? 0));

  const botMessages = relevant.filter((message) => message.author?.bot);
  const authors = botMessages.map((message) => message.author?.username ?? "unknown");
  const uniqueAuthors = [...new Set(authors)];
  const allowedAuthors = new Set(Object.values(ACCOUNT_NAMES));
  const coreFormalMessages = parseCoreFormalMessages(botMessages);
  const malformedCoreMessages = coreFormalMessages.filter(
    (message) => !message.summary.chainStage,
  );
  const sequenceCheck = validateRoundSequence(coreFormalMessages);
  const terminalMessage =
    sequenceCheck.terminalStatus == null ? null : coreFormalMessages[coreFormalMessages.length - 1];

  return {
    relevant,
    botMessages,
    coreBotMessages: coreFormalMessages,
    uniqueAuthors,
    allowedAuthors,
    malformedCoreMessages,
    sequenceCheck,
    terminalMessage,
    hasDraft: coreFormalMessages.some(
      (message) =>
        message.author?.username === CORE_ACCOUNT_NAMES.silijian &&
        message.summary.chainStage === "DRAFT",
    ),
    hasReview: coreFormalMessages.some(
      (message) =>
        message.author?.username === CORE_ACCOUNT_NAMES.neige &&
        message.summary.chainStage === "REVIEW",
    ),
    hasDecision: coreFormalMessages.some(
      (message) =>
        message.author?.username === CORE_ACCOUNT_NAMES.shangshu &&
        message.summary.chainStage === "DECISION",
    ),
    terminalStatus: sequenceCheck.terminalStatus,
  };
}

async function extractRecentMessages() {
  const command = [
    "openclaw",
    "message",
    "read",
    "--channel",
    "discord",
    "--account",
    shellQuote(READ_ACCOUNT_ID),
    "--target",
    shellQuote(`channel:${XUANZHENGDIAN_CHANNEL_ID}`),
    "--json",
    "--limit",
    "12",
  ].join(" ");
  const payload = extractJson(await runOpenClawShellWithRetry(command));
  return Array.isArray(payload?.payload?.messages) ? payload.payload.messages : [];
}

function buildDiagnostics(logPath, sinceMs) {
  return collectRecentLogEntries(logPath, sinceMs)
    .filter((entry) =>
      /discord|health-monitor|no-mention|other-mention|gateway error|logged in to discord/i.test(
        entry.text,
      ),
    )
    .slice(-20)
    .map((entry) => entry.text);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prepareStartedAt = Date.now();
  let loginWarning = null;

  if (options.prepare) {
    prepareTestMode({
      action: "prepare",
      scenario: options.scenario,
      configPath: options.configPath,
      controlFile: options.controlFile,
      stateFile: options.stateFile,
      restart: true,
    });
  }

  const loginResult = await waitForDiscordLogins({
    logPath: options.logPath,
    sinceMs: prepareStartedAt,
    requiredAccounts: REQUIRED_ACCOUNTS,
    timeoutMs: options.loginTimeoutSeconds * 1000,
  });
  if (!loginResult.ok) {
    loginWarning = `timed out waiting for discord logins: ${loginResult.missingAccounts.join(", ")}`;
    await sleep(5000);
  }

  const injectedMessage = buildInitiatorMessage(options.caseKey);
  await sendDiscordMessageWithRetry({
    accountId: INITIATOR_ACCOUNT_ID,
    target: `channel:${XUANZHENGDIAN_CHANNEL_ID}`,
    message: injectedMessage,
  });

  const startMs = Date.now();
  const timeoutMs = options.timeoutSeconds * 1000;
  const pollMs = options.pollSeconds * 1000;
  const quietWindowMs = 6000;

  let lastSignals = {
    relevant: [],
    botMessages: [],
    coreBotMessages: [],
    uniqueAuthors: [],
    allowedAuthors: new Set(),
    malformedCoreMessages: [],
    sequenceCheck: { ok: true, terminalStatus: null, expectedStage: "DRAFT", expectedRound: 1 },
    terminalMessage: null,
    hasDraft: false,
    hasReview: false,
    hasDecision: false,
    terminalStatus: null,
  };
  let terminalObservedAt = 0;
  let terminalCoreMessageCount = 0;

  while (Date.now() - startMs <= timeoutMs) {
    await sleep(pollMs);
    lastSignals = collectSignals(await extractRecentMessages(), startMs, options.caseKey);

    const unexpectedBotAuthors = lastSignals.uniqueAuthors.filter(
      (name) => !lastSignals.allowedAuthors.has(name),
    );
    if (unexpectedBotAuthors.length > 0) {
      throw new Error(`unexpected bot authors in xuanzhengdian: ${unexpectedBotAuthors.join(", ")}`);
    }
    if (lastSignals.malformedCoreMessages.length > 0) {
      throw new Error("core province reply missing formal JSON envelope");
    }
    if (!lastSignals.sequenceCheck.ok) {
      throw new Error(`three-province sequence violation: ${lastSignals.sequenceCheck.reason}`);
    }
    if (lastSignals.coreBotMessages.length > 9) {
      throw new Error(
        `three-province flow exceeded safe reply budget: ${lastSignals.coreBotMessages.length}`,
      );
    }
    if (lastSignals.hasDraft && lastSignals.hasReview && lastSignals.hasDecision && lastSignals.terminalStatus) {
      if (terminalObservedAt === 0) {
        terminalObservedAt = Date.now();
        terminalCoreMessageCount = lastSignals.coreBotMessages.length;
      }
      if (lastSignals.coreBotMessages.length !== terminalCoreMessageCount) {
        terminalObservedAt = Date.now();
        terminalCoreMessageCount = lastSignals.coreBotMessages.length;
      }
      if (Date.now() - terminalObservedAt < quietWindowMs) {
        continue;
      }

      process.stdout.write(
        `${JSON.stringify(
          {
            status: "ok",
            caseKey: options.caseKey,
            botMessageCount: lastSignals.coreBotMessages.length,
            authors: lastSignals.uniqueAuthors,
            terminalStatus: lastSignals.terminalStatus,
            loginWarning,
            messages: lastSignals.relevant.map((message) => ({
              id: message.id,
              author: message.author?.username ?? "unknown",
              timestampMs: message.timestampMs,
              content: message.content,
            })),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
  }

  const diagnostics = buildDiagnostics(options.logPath, startMs);
  throw new Error(
    `timeout waiting for three-province round closure: draft=${String(lastSignals.hasDraft)} review=${String(
      lastSignals.hasReview,
    )} decision=${String(lastSignals.hasDecision)} terminal=${String(lastSignals.terminalStatus)}\n${diagnostics.join("\n")}`,
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // main() is already invoked above so CLI execution remains single-entry.
}
