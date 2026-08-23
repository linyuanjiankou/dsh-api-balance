#!/usr/bin/env bash
#
# dsh-api-balance — one-shot installer for the persistent plugin.
#
# Copies the two plugin packages into a deepseek-harness git checkout and
# applies every registration edit the bundle needs:
#   - host row + dsh.client roster row in packages/bundle/web-app
#   - remote.apiBalance assembly in packages/api/remotes
#   - tsconfig references / paths
#   - workspace dependency declarations
#
# Idempotent: re-running never double-patches. It never touches your business
# configuration or session data.
#
# Usage:
#   bash scripts/install.sh /path/to/deepseek-harness
#
# After install:
#   cd /path/to/deepseek-harness
#   pnpm install && pnpm run build:lib
#   restart `dsh web`
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HARNESS="${1:-}"

if [ -z "$HARNESS" ]; then
  echo "用法: bash scripts/install.sh /path/to/deepseek-harness"
  exit 1
fi
if [ ! -d "$HARNESS" ]; then
  echo "错误: $HARNESS 不存在"
  exit 1
fi
HARNESS="$(cd "$HARNESS" && pwd)"
if [ ! -f "$HARNESS/packages/bundle/web-app/cordis.patch.yml" ]; then
  echo "错误: $HARNESS 不是 deepseek-harness 检出根目录（找不到 packages/bundle/web-app/cordis.patch.yml）"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "错误: 需要 python3"
  exit 1
fi

HOST_DST="$HARNESS/packages/host/api-balance"
CLIENT_DST="$HARNESS/packages/client/ui-api-balance"

echo "[1/6] 复制插件包到 $HARNESS ..."
mkdir -p "$HOST_DST" "$CLIENT_DST"
cp -R "$PROJECT_DIR/plugin-host/." "$HOST_DST/"
cp -R "$PROJECT_DIR/plugin-client/." "$CLIENT_DST/"
rm -rf "$HOST_DST/lib" "$CLIENT_DST/lib" "$HOST_DST/node_modules" "$CLIENT_DST/node_modules" 2>/dev/null || true
echo "  plugin-host -> $HOST_DST"
echo "  plugin-client -> $CLIENT_DST"

echo "[2/6] 注册 remote.apiBalance 到 packages/api/remotes ..."
python3 - "$HARNESS" <<'PYEOF'
import json, sys

root = sys.argv[1]

def edit(path, fn, label):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    out = fn(text)
    if out != text:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(out)
        print(f"  patched {label}")
    else:
        print(f"  no-op {label}")

client = f'{root}/packages/api/remotes/src/client/index.ts'
def patch_client(text):
    if "dsh-api-balance/remote" in text:
        return text
    text = text.replace(
        "import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote'",
        "import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote'\nimport apiBalanceRemote from '@deepseek-ai/dsh-api-balance/remote'",
    )
    text = text.replace(
        "export type { PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'",
        "export type { PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'\nexport type { ApiBalanceData, ApiGatewayResult, ApiUsageData, ApiUsageModel, ApiUsageTokens } from '@deepseek-ai/dsh-api-balance/types'",
    )
    text = text.replace(
        "export type {} from '@deepseek-ai/dsh-message-feedback/remote'",
        "export type {} from '@deepseek-ai/dsh-message-feedback/remote'\nexport type {} from '@deepseek-ai/dsh-api-balance/remote'",
    )
    text = text.replace(
        "commandsRemote, goalsRemote, dynamicRemote, pluginInventoryRemote, messageFeedbackRemote,",
        "commandsRemote, goalsRemote, dynamicRemote, pluginInventoryRemote, messageFeedbackRemote, apiBalanceRemote,",
    )
    return text
edit(client, patch_client, 'api-remotes client assembly')

pkg = f'{root}/packages/api/remotes/package.json'
def patch_pkg(text):
    data = json.loads(text)
    changed = False
    for section in ('peerDependencies', 'devDependencies'):
        deps = data.setdefault(section, {})
        if '@deepseek-ai/dsh-api-balance' not in deps:
            deps['@deepseek-ai/dsh-api-balance'] = 'workspace:^'
            changed = True
    return json.dumps(data, indent=2, ensure_ascii=False) + '\n' if changed else text
edit(pkg, patch_pkg, 'api-remotes package.json')

tsc = f'{root}/packages/api/remotes/tsconfig.client.json'
def patch_tsc(text):
    if '"../../host/api-balance"' in text:
        return text
    return text.replace(
        '      "path": "../../host/plugin-inventory"\n    },',
        '      "path": "../../host/plugin-inventory"\n    },\n    {\n      "path": "../../host/api-balance"\n    },',
        1,
    )
edit(tsc, patch_tsc, 'api-remotes tsconfig.client.json')
PYEOF

echo "[3/6] 注册到 packages/bundle/web-app ..."
python3 - "$HARNESS" <<'PYEOF'
import json, sys

root = sys.argv[1]

def edit(path, fn, label):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    out = fn(text)
    if out != text:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(out)
        print(f"  patched {label}")
    else:
        print(f"  no-op {label}")

patch = f'{root}/packages/bundle/web-app/cordis.patch.yml'
def patch_cordis(text):
    # Each row is guarded independently so a partial install completes
    # idempotently without duplicating rows.
    host_anchor = "    - id: plugin-inventory\n      name: '@deepseek-ai/dsh-host-plugin-inventory'\n"
    if "name: '@deepseek-ai/dsh-api-balance'" not in text and host_anchor in text:
        text = text.replace(
            host_anchor,
            host_anchor
            + "\n    # DeepSeek API balance and per-session usage/cost gateway.\n"
            + "    - id: api-balance\n      name: '@deepseek-ai/dsh-api-balance'\n",
            1,
        )
    client_anchor = "    - id: ui-conversation\n      name: '@deepseek-ai/dsh-client-ui-conversation'\n"
    if "name: '@deepseek-ai/dsh-client-ui-api-balance'" not in text and client_anchor in text:
        text = text.replace(
            client_anchor,
            client_anchor
            + "\n    # Session Header API balance badge.\n"
            + "    - id: ui-api-balance\n      name: '@deepseek-ai/dsh-client-ui-api-balance'\n",
            1,
        )
    return text
edit(patch, patch_cordis, 'web-app cordis.patch.yml')

pkg = f'{root}/packages/bundle/web-app/package.json'
def patch_pkg(text):
    data = json.loads(text)
    deps = data.setdefault('dependencies', {})
    changed = False
    for name in ('@deepseek-ai/dsh-api-balance', '@deepseek-ai/dsh-client-ui-api-balance'):
        if name not in deps:
            deps[name] = 'workspace:^'
            changed = True
    return json.dumps(data, indent=2, ensure_ascii=False) + '\n' if changed else text
edit(pkg, patch_pkg, 'web-app package.json')
PYEOF

echo "[4/6] 注册到 tsconfig 聚合与 paths ..."
python3 - "$HARNESS" <<'PYEOF'
import sys

root = sys.argv[1]

def edit(path, fn, label):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    out = fn(text)
    if out != text:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(out)
        print(f"  patched {label}")
    else:
        print(f"  no-op {label}")

base = f'{root}/tsconfig.base.json'
def patch_base(text):
    if "dsh-api-balance" in text:
        return text
    text = text.replace(
        '      "@deepseek-ai/dsh-client-connection": ["./packages/client/connection/src"],',
        '      "@deepseek-ai/dsh-client-connection": ["./packages/client/connection/src"],\n'
        '      "@deepseek-ai/dsh-api-balance": ["./packages/host/api-balance/src"],\n'
        '      "@deepseek-ai/dsh-api-balance/types": ["./packages/host/api-balance/src/types.ts"],\n'
        '      "@deepseek-ai/dsh-api-balance/invariant": ["./packages/host/api-balance/src/invariant.ts"],',
        1,
    )
    text = text.replace(
        '      "@deepseek-ai/dsh-client-ui-commands": ["./packages/client/ui-commands/src"],',
        '      "@deepseek-ai/dsh-client-ui-commands": ["./packages/client/ui-commands/src"],\n'
        '      "@deepseek-ai/dsh-client-ui-api-balance": ["./packages/client/ui-api-balance/src"],\n'
        '      "@deepseek-ai/dsh-client-ui-api-balance/client": ["./packages/client/ui-api-balance/src/client/index.ts"],\n'
        '      "@deepseek-ai/dsh-client-ui-api-balance/invariant": ["./packages/client/ui-api-balance/src/invariant.ts"],',
        1,
    )
    return text
edit(base, patch_base, 'tsconfig.base.json paths')

host_agg = f'{root}/tsconfig.host.json'
def patch_host(text):
    if 'packages/host/api-balance' in text:
        return text
    return text.replace(
        '    { "path": "./packages/host/plugin-inventory" },',
        '    { "path": "./packages/host/plugin-inventory" },\n    { "path": "./packages/host/api-balance" },',
        1,
    )
edit(host_agg, patch_host, 'tsconfig.host.json')

client_agg = f'{root}/tsconfig.client.json'
def patch_client(text):
    if 'packages/client/ui-api-balance' in text:
        return text
    return text.replace(
        '    { "path": "./packages/client/ui-goal" },',
        '    { "path": "./packages/client/ui-goal" },\n    { "path": "./packages/client/ui-api-balance" },',
        1,
    )
edit(client_agg, patch_client, 'tsconfig.client.json')
PYEOF

echo "[5/6] 构建（在检出目录内执行）"
echo "  cd $HARNESS"
echo "  pnpm install"
echo "  pnpm run build:lib"
echo "  然后重启 dsh web。"

echo "[6/6] 完成。重启后会话头部即出现余额徽标；使用前请确认 DEEPSEEK_API_KEY 已配置。"
