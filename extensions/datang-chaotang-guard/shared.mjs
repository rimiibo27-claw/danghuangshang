import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ID = "datang-chaotang-guard";
export const DEFAULT_PROVIDER_ID = "discord";
export const DEFAULT_XUANZHENGDIAN_CHANNEL_ID = "1482260425616789595";
export const DEFAULT_HUMAN_USER_IDS = ["1476931252576850095"];
export const DEFAULT_RESET_SENDER_IDS = ["1482276648069107753"];
export const DEFAULT_ACCOUNT_USER_IDS = {
  silijian: "1482003317327659049",
  neige: "1482007277140709508",
  shangshu: "1482262068760416317",
  duchayuan: "1482274763979096176",
  bingbu: "1482270196067598336",
  hubu: "1482269093116772362",
  libu: "1482269546415919204",
  gongbu: "1482270975046320211",
  libu2: "1482268099037233235",
  xingbu: "1482270614185185440",
  hanlinyuan: "1482275379363188776",
  mige: "1482275809069629471",
  dianzhongsheng: "1482276648069107753",
};
export const DEFAULT_ACCOUNT_ROLE_IDS = {
  silijian: "1482261624973819988",
  neige: "1482262714431836183",
  shangshu: "1482266062102728789",
};
export const DEFAULT_PROTECTED_ACCOUNTS = [
  "silijian",
  "neige",
  "shangshu",
  "duchayuan",
  "bingbu",
  "hubu",
  "libu",
  "gongbu",
  "libu2",
  "xingbu",
  "hanlinyuan",
  "mige",
  "dianzhongsheng",
];
export const DEFAULT_XUANZHENGDIAN_BLOCKED_ACCOUNTS = [
  "hubu",
  "libu",
  "bingbu",
  "gongbu",
  "libu2",
  "xingbu",
];
export const DEFAULT_SPEAKER_LIMITS = {
  silijian: 1,
  neige: 1,
  shangshu: 1,
};
export const DEFAULT_MAX_DISCUSSION_TURNS = 9;
export const DEFAULT_MAX_DISCUSSION_ROUNDS = 3;
export const DEFAULT_MAX_REVIEW_CYCLES = 3;
export const DEFAULT_XUANZHENGDIAN_PROVIDER_OVERRIDE = "minimax-portal";
export const DEFAULT_XUANZHENGDIAN_MODEL_OVERRIDE = "minimax-portal/MiniMax-M2.7-highspeed";
export const DEFAULT_CONTROL_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "control",
  "datang-chaotang-guard.json",
);
export const DEFAULT_STATE_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "control",
  "datang-chaotang-guard-state.json",
);

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function asStringArray(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  return uniqueStrings(value);
}

function asInteger(value, fallback, min = 1) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, value);
}

function asTrimmedString(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim();
}

function resolveAccountUserIds(value) {
  const raw = value && typeof value === "object" ? value : {};
  const next = {};
  for (const [accountId, fallbackUserId] of Object.entries(DEFAULT_ACCOUNT_USER_IDS)) {
    const configuredUserId = raw[accountId];
    next[accountId] =
      typeof configuredUserId === "string" && configuredUserId.trim()
        ? configuredUserId.trim()
        : fallbackUserId;
  }
  return next;
}

function resolveAccountRoleIds(value) {
  const raw = value && typeof value === "object" ? value : {};
  const next = {};
  for (const accountId of Object.keys(DEFAULT_ACCOUNT_USER_IDS)) {
    const configuredRoleId = raw[accountId];
    const fallbackRoleId = DEFAULT_ACCOUNT_ROLE_IDS[accountId] ?? "";
    next[accountId] =
      typeof configuredRoleId === "string" && configuredRoleId.trim()
        ? configuredRoleId.trim()
        : fallbackRoleId;
  }
  return next;
}

export function resolveSpeakerLimits(value) {
  const raw = value && typeof value === "object" ? value : {};
  const limits = {};
  for (const accountId of Object.keys(DEFAULT_SPEAKER_LIMITS)) {
    const next = raw[accountId];
    limits[accountId] = asInteger(next, DEFAULT_SPEAKER_LIMITS[accountId], 1);
  }
  return limits;
}

export function resolvePluginConfig(rawConfig = {}) {
  return {
    providerId:
      typeof rawConfig.providerId === "string" && rawConfig.providerId.trim()
        ? rawConfig.providerId.trim()
        : DEFAULT_PROVIDER_ID,
    controlFile:
      typeof rawConfig.controlFile === "string" && rawConfig.controlFile.trim()
        ? rawConfig.controlFile.trim()
        : DEFAULT_CONTROL_FILE,
    stateFile:
      typeof rawConfig.stateFile === "string" && rawConfig.stateFile.trim()
        ? rawConfig.stateFile.trim()
        : DEFAULT_STATE_FILE,
    xuanzhengdianChannelId:
      typeof rawConfig.xuanzhengdianChannelId === "string" &&
      rawConfig.xuanzhengdianChannelId.trim()
        ? rawConfig.xuanzhengdianChannelId.trim()
        : DEFAULT_XUANZHENGDIAN_CHANNEL_ID,
    humanUserIds: new Set(asStringArray(rawConfig.humanUserIds, DEFAULT_HUMAN_USER_IDS)),
    resetSenderIds: new Set(asStringArray(rawConfig.resetSenderIds, DEFAULT_RESET_SENDER_IDS)),
    accountUserIds: resolveAccountUserIds(rawConfig.accountUserIds),
    accountRoleIds: resolveAccountRoleIds(rawConfig.accountRoleIds),
    protectedAccounts: new Set(
      asStringArray(rawConfig.protectedAccounts, DEFAULT_PROTECTED_ACCOUNTS),
    ),
    xuanzhengdianBlockedAccounts: new Set(
      asStringArray(
        rawConfig.xuanzhengdianBlockedAccounts,
        DEFAULT_XUANZHENGDIAN_BLOCKED_ACCOUNTS,
      ),
    ),
    speakerLimits: resolveSpeakerLimits(rawConfig.speakerLimits),
    maxDiscussionTurns: asInteger(
      rawConfig.maxDiscussionTurns,
      DEFAULT_MAX_DISCUSSION_TURNS,
      1,
    ),
    maxDiscussionRounds: asInteger(
      rawConfig.maxDiscussionRounds,
      DEFAULT_MAX_DISCUSSION_ROUNDS,
      1,
    ),
    maxReviewCycles: asInteger(rawConfig.maxReviewCycles, DEFAULT_MAX_REVIEW_CYCLES, 1),
    xuanzhengdianProviderOverride: asTrimmedString(
      rawConfig.xuanzhengdianProviderOverride,
      DEFAULT_XUANZHENGDIAN_PROVIDER_OVERRIDE,
    ),
    xuanzhengdianModelOverride: asTrimmedString(
      rawConfig.xuanzhengdianModelOverride,
      DEFAULT_XUANZHENGDIAN_MODEL_OVERRIDE,
    ),
  };
}

export function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function readJsonFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function writeJsonFile(filePath, value) {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function readControlState(controlFile) {
  try {
    const state = readJsonFile(controlFile);
    if (!state || typeof state !== "object") {
      return {
        globalMute: false,
        lastAction: "none",
        updatedAt: null,
        accountSnapshot: {},
      };
    }
    return {
      globalMute: state.globalMute === true,
      lastAction:
        typeof state.lastAction === "string" && state.lastAction.trim()
          ? state.lastAction.trim()
          : "unknown",
      updatedAt:
        typeof state.updatedAt === "string" && state.updatedAt.trim()
          ? state.updatedAt.trim()
          : null,
      accountSnapshot:
        state.accountSnapshot && typeof state.accountSnapshot === "object"
          ? state.accountSnapshot
          : {},
    };
  } catch (error) {
    return {
      globalMute: true,
      lastAction: "invalid_control_file",
      updatedAt: null,
      accountSnapshot: {},
      error: String(error),
    };
  }
}

export function extractSenderId(metadata = {}) {
  return typeof metadata.senderId === "string" ? metadata.senderId : "";
}

export function extractConversationTarget(event, ctx) {
  if (event?.metadata && typeof event.metadata.channelId === "string") {
    return event.metadata.channelId;
  }
  if (typeof ctx?.conversationId === "string" && ctx.conversationId) {
    return ctx.conversationId;
  }
  if (typeof event?.to === "string" && event.to) {
    return event.to;
  }
  if (typeof event?.from === "string" && event.from) {
    return event.from;
  }
  return "";
}

export function isTargetConversation(target, channelId) {
  return typeof target === "string" && target.includes(channelId);
}

export function extractCaseSummary(content) {
  const caseKey = extractCaseKey(content);
  if (caseKey) return caseKey;

  const lines = stripReactionNoise(content)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("{") && !line.startsWith("```"));

  const firstLine = lines[0] ?? "宣政殿待办";
  const normalized = firstLine
    .replace(/<@&\d+>/g, " ")
    .replace(/[【】"'`*#{}\[\]()<>:：，。！？!?,.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.slice(0, 48) || "宣政殿待办";
}

export function stripReactionNoise(content) {
  return String(content ?? "")
    .split("\n")
    .filter((line) => !/^System:\s+\[[^\]]+\]\s+Discord reaction\b/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findJsonPayload(content) {
  const directCandidates = String(content ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const candidate of directCandidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore invalid JSON candidates and continue scanning.
    }
  }

  const fencedMatches = String(content ?? "").matchAll(/```json\s*([\s\S]*?)\s*```/gi);
  let lastParsed = null;
  for (const match of fencedMatches) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        lastParsed = parsed;
      }
    } catch {
      // Ignore invalid fenced payloads and continue scanning.
    }
  }
  return lastParsed;
}

function normalizeUpperString(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return value.trim().toUpperCase();
}

function normalizePositiveInteger(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  return null;
}

function flattenStructuredContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function extractCaseKey(content) {
  const cleanedContent = stripReactionNoise(flattenStructuredContent(content));
  const payload = findJsonPayload(cleanedContent);
  if (payload && typeof payload.case_key === "string" && payload.case_key.trim()) {
    return payload.case_key.trim();
  }

  const bracketMatch = cleanedContent.match(/【([^】]+)】/);
  return bracketMatch?.[1]?.trim() ?? "";
}

export function extractFormalEnvelope(content) {
  const cleanedContent = stripReactionNoise(flattenStructuredContent(content));
  const payload = findJsonPayload(cleanedContent);
  const caseKey =
    (payload && typeof payload.case_key === "string" && payload.case_key.trim()
      ? payload.case_key.trim()
      : "") || extractCaseKey(cleanedContent);

  return {
    cleanedContent,
    payload,
    caseKey,
    chainStage: normalizeUpperString(payload?.chain_stage),
    verdict: normalizeUpperString(payload?.verdict),
    status: normalizeUpperString(payload?.status),
    round: normalizePositiveInteger(payload?.round),
    nextRound: normalizePositiveInteger(payload?.next_round),
    maxRounds: normalizePositiveInteger(payload?.max_rounds),
  };
}

export function timestampNow() {
  return new Date().toISOString();
}
