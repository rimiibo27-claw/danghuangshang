#!/bin/bash
# ============================================
# 当前机器专用：OpenClaw 安全接管脚本
#
# 目标：
#   1. 保住当前机器必须保留的三条链路：
#      - Discord main
#      - Telegram wangcai
#      - Telegram laowang
#   2. 保住已配置的 OpenAI / MiniMax 凭证与模型配置
#   3. 用仓库内的 Tang 模板重建朝廷部分
#   4. 默认移除失败方案残留的 guard 插件
#   5. 默认归档并清空朝廷相关会话，避免旧上下文继续污染
#
# 用法：
#   bash install-openclaw-safe-merge.sh
#   bash install-openclaw-safe-merge.sh --dry-run
#   bash install-openclaw-safe-merge.sh --restart
#   bash install-openclaw-safe-merge.sh --keep-court-sessions
#   bash install-openclaw-safe-merge.sh --keep-guard-plugin
#   bash install-openclaw-safe-merge.sh --allow-bots keep
# ============================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_CONFIG="$SCRIPT_DIR/openclaw.example.json"
CURRENT_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
BACKUP_ROOT="${OPENCLAW_BACKUP_ROOT:-$HOME/.openclaw/backups}"
CONTROL_DIR="$HOME/.openclaw/control"
AGENTS_DIR="$HOME/.openclaw/agents"
PROTECTED_AGENT_IDS_JSON='["main","wangcai","laowang"]'

DRY_RUN=false
RESTART_GATEWAY=false
KEEP_COURT_SESSIONS=false
KEEP_GUARD_PLUGIN=false
ALLOW_BOTS_SETTING="mentions"

usage() {
  cat <<'EOF'
当前机器专用：OpenClaw 安全接管脚本

选项：
  --dry-run               只生成并检查候选配置，不落盘
  --restart               写入后自动重启 gateway
  --keep-court-sessions   保留朝廷相关 agent 的旧会话
  --keep-guard-plugin     保留当前自定义 guard 插件
  --allow-bots VALUE      VALUE 可选：mentions / true / keep
  --config PATH           指定当前 openclaw.json 路径
  -h, --help              显示帮助

默认行为：
  - 保留 main / wangcai / laowang
  - 保留当前模型与凭据配置
  - 重建朝廷 agents / bindings / court Discord accounts
  - 移除 datang-chaotang-guard 插件配置
  - 归档并清空朝廷相关 sessions
  - 不自动重启 gateway
EOF
}

log() {
  echo -e "${BLUE}$*${NC}"
}

ok() {
  echo -e "${GREEN}$*${NC}"
}

warn() {
  echo -e "${YELLOW}$*${NC}"
}

die() {
  echo -e "${RED}$*${NC}" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

normalize_bool_arg() {
  case "$1" in
    true|false) printf '%s' "$1" ;;
    *) die "非法布尔值: $1" ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --restart)
      RESTART_GATEWAY=true
      shift
      ;;
    --keep-court-sessions)
      KEEP_COURT_SESSIONS=true
      shift
      ;;
    --keep-guard-plugin)
      KEEP_GUARD_PLUGIN=true
      shift
      ;;
    --allow-bots)
      [[ $# -ge 2 ]] || die "--allow-bots 需要一个值"
      case "$2" in
        mentions|true|keep)
          ALLOW_BOTS_SETTING="$2"
          ;;
        *)
          die "--allow-bots 仅支持 mentions / true / keep"
          ;;
      esac
      shift 2
      ;;
    --config)
      [[ $# -ge 2 ]] || die "--config 需要一个路径"
      CURRENT_CONFIG="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数: $1"
      ;;
  esac
done

echo ""
log "🏛️ 当前机器专用：OpenClaw 安全接管"
echo "================================"
echo ""

require_cmd jq
require_cmd openclaw
[[ -f "$CURRENT_CONFIG" ]] || die "未找到当前配置: $CURRENT_CONFIG"
[[ -f "$TEMPLATE_CONFIG" ]] || die "未找到模板文件: $TEMPLATE_CONFIG"

jq empty "$CURRENT_CONFIG" >/dev/null
jq empty "$TEMPLATE_CONFIG" >/dev/null

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-safe-merge-XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

CANDIDATE_CONFIG="$TMP_DIR/openclaw.json"
JQ_PROGRAM="$TMP_DIR/merge.jq"

cat > "$JQ_PROGRAM" <<'JQ'
def first_or_null(stream):
  first(stream // empty);

def existing_agent($agents; $id):
  first_or_null($agents[]? | select(.id == $id));

def template_agent($agents; $id):
  first_or_null($agents[]? | select(.id == $id));

def merge_agent($template_agent; $existing_agent):
  ((($existing_agent // {}) + $template_agent)
    | .model = ($existing_agent.model // $template_agent.model)
    | if ($existing_agent.workspace // $template_agent.workspace) != null then
        .workspace = ($existing_agent.workspace // $template_agent.workspace)
      else
        del(.workspace)
      end
    | if ($existing_agent.agentDir // $template_agent.agentDir) != null then
        .agentDir = ($existing_agent.agentDir // $template_agent.agentDir)
      else
        del(.agentDir)
      end);

def normalize_account($id; $template_account; $existing_account; $agent):
  (($template_account // {}) + ($existing_account // {}))
  | .name = (
      $existing_account.name
      // $existing_account.botName
      // $template_account.name
      // $template_account.botName
      // $agent.name
      // $id
    )
  | .groupPolicy = ($existing_account.groupPolicy // $template_account.groupPolicy // "open")
  | if (($existing_account // {}) | has("enabled")) then
      .enabled = $existing_account.enabled
    elif has("enabled") then
      .
    else
      .enabled = false
    end
  | del(.botName);

($current[0]) as $cur
| ($template[0]) as $tpl
| (($tpl.agents.list // []) | map(.id)) as $court_ids
| ((($tpl.bindings // []) | map(.agentId) | unique)) as $court_account_ids
| ($cur.agents.list // []) as $cur_agents
| ($tpl.agents.list // []) as $tpl_agents
| ($cur.channels.discord.accounts // {}) as $cur_accounts
| ($tpl.channels.discord.accounts // {}) as $tpl_accounts
| ($cur.plugins // null) as $cur_plugins
| ($allow_bots_mode == "keep") as $keep_allow_bots
| $cur
| .agents.defaults = ($cur.agents.defaults // $tpl.agents.defaults)
| .agents.list =
    (
      [ $cur_agents[]? | select((.id as $id | $protected | index($id)) != null) ]
      + [ $tpl_agents[]? as $ta | merge_agent($ta; existing_agent($cur_agents; $ta.id)) ]
      + [ $cur_agents[]? | select((.id as $id | (($protected + $court_ids) | index($id))) == null) ]
    )
| .bindings =
    (
      [ ($cur.bindings // [])[]? | select(((.agentId // "") as $id | $protected | index($id)) != null) ]
      + [ ($tpl.bindings // [])[]? ]
    )
| .channels.discord =
    (
      ($cur.channels.discord // $tpl.channels.discord // {})
      + {
          allowBots:
            (
              if $keep_allow_bots then
                ($cur.channels.discord.allowBots // $tpl.channels.discord.allowBots // "mentions")
              else
                $allow_bots_mode
              end
            ),
          accounts:
            (
              (reduce (($cur_accounts | keys[])?) as $id
                ({};
                  if ($court_account_ids | index($id)) == null then
                    . + { ($id): $cur_accounts[$id] }
                  else
                    .
                  end
                )
              )
              + (reduce ($court_account_ids[]) as $id
                  ({};
                    . + {
                      ($id): normalize_account(
                        $id;
                        ($tpl_accounts[$id]);
                        ($cur_accounts[$id]);
                        template_agent($tpl_agents; $id)
                      )
                    }
                  )
                )
            )
        }
    )
| .plugins =
    (
      if ($cur_plugins == null) or $keep_guard_plugin then
        $cur.plugins
      else
        ($cur.plugins
          | .allow = ((.allow // []) | map(select(. != "datang-chaotang-guard")) | unique)
          | .entries = ((.entries // {}) | del(.["datang-chaotang-guard"]))
        )
      end
    )
JQ

ALLOW_BOTS_JQ_VALUE="$ALLOW_BOTS_SETTING"
KEEP_GUARD_JQ_VALUE="$(normalize_bool_arg "$KEEP_GUARD_PLUGIN")"

jq -n \
  --slurpfile current "$CURRENT_CONFIG" \
  --slurpfile template "$TEMPLATE_CONFIG" \
  --argjson protected "$PROTECTED_AGENT_IDS_JSON" \
  --arg allow_bots_mode "$ALLOW_BOTS_JQ_VALUE" \
  --argjson keep_guard_plugin "$KEEP_GUARD_JQ_VALUE" \
  -f "$JQ_PROGRAM" > "$CANDIDATE_CONFIG"

jq empty "$CANDIDATE_CONFIG" >/dev/null

COURT_AGENT_IDS_FILE="$TMP_DIR/court_agents.txt"
jq -r '.agents.list[].id' "$TEMPLATE_CONFIG" > "$COURT_AGENT_IDS_FILE"

log "候选配置已生成并通过 JSON 校验"
ok "保留链路: Discord/main, Telegram/wangcai, Telegram/laowang"
ok "保留内容: 当前 auth/models/gateway/tools/commands/session/hooks/messages"
if $KEEP_GUARD_PLUGIN; then
  warn "自定义 guard 插件将被保留"
else
  ok "自定义 guard 插件将被从运行配置中移除"
fi
if $KEEP_COURT_SESSIONS; then
  warn "朝廷相关旧会话将被保留"
else
  ok "朝廷相关旧会话将归档后清空"
fi
echo ""

if $DRY_RUN; then
  log "Dry run 模式：未落盘修改"
  jq '{agents: [.agents.list[].id], bindings: (.bindings|length), discord_accounts: (.channels.discord.accounts|keys), plugins: .plugins.allow}' "$CANDIDATE_CONFIG"
  exit 0
fi

TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/danghuangshang-safe-$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

cp "$CURRENT_CONFIG" "$BACKUP_DIR/openclaw.json.before"
cp "$CANDIDATE_CONFIG" "$BACKUP_DIR/openclaw.json.after"
ok "配置备份已写入: $BACKUP_DIR"

cp "$CANDIDATE_CONFIG" "$CURRENT_CONFIG"
ok "候选配置已临时写入: $CURRENT_CONFIG"

VALIDATE_OUTPUT="$TMP_DIR/validate-output.json"
if openclaw config validate --json > "$VALIDATE_OUTPUT" 2>&1; then
  ok "openclaw config validate 通过"
else
  cp "$BACKUP_DIR/openclaw.json.before" "$CURRENT_CONFIG"
  if [[ -s "$VALIDATE_OUTPUT" ]]; then
    cat "$VALIDATE_OUTPUT" >&2
  fi
  die "openclaw config validate 失败，已自动恢复旧配置"
fi

if [[ -d "$CONTROL_DIR" ]]; then
  mkdir -p "$BACKUP_DIR/control"
  for control_file in "$CONTROL_DIR"/datang-chaotang-guard.json "$CONTROL_DIR"/datang-chaotang-test-mode.json; do
    if [[ -f "$control_file" ]]; then
      cp "$control_file" "$BACKUP_DIR/control/"
      if ! $KEEP_GUARD_PLUGIN; then
        rm -f "$control_file"
      fi
    fi
  done
fi

if ! $KEEP_COURT_SESSIONS && [[ -d "$AGENTS_DIR" ]]; then
  mkdir -p "$BACKUP_DIR/agents"
  while IFS= read -r agent_id; do
    [[ -z "$agent_id" ]] && continue
    agent_sessions_dir="$AGENTS_DIR/$agent_id/sessions"
    if [[ -d "$agent_sessions_dir" ]]; then
      mkdir -p "$BACKUP_DIR/agents/$agent_id"
      cp -R "$agent_sessions_dir" "$BACKUP_DIR/agents/$agent_id/"
      find "$agent_sessions_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    fi
  done < "$COURT_AGENT_IDS_FILE"
  ok "朝廷相关 sessions 已归档并清空"
fi

if $RESTART_GATEWAY; then
  log "正在重启 gateway..."
  RESTART_OUTPUT="$TMP_DIR/gateway-restart.log"
  if openclaw gateway restart >"$RESTART_OUTPUT" 2>&1; then
    ok "gateway 已重启"
  else
    warn "gateway 首次重启失败，2 秒后重试一次"
    sleep 2
    if openclaw gateway restart >>"$RESTART_OUTPUT" 2>&1; then
      ok "gateway 已重启"
    else
      if [[ -s "$RESTART_OUTPUT" ]]; then
        cat "$RESTART_OUTPUT" >&2
      fi
      die "gateway 重启失败"
    fi
  fi
else
  warn "未自动重启 gateway；如需生效，请手动执行: openclaw gateway restart"
fi

echo ""
ok "安全接管完成"
echo "  备份目录: $BACKUP_DIR"
echo "  当前配置: $CURRENT_CONFIG"
echo "  手动重启: openclaw gateway restart"
