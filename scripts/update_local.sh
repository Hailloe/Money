#!/bin/bash
# 在 Mac 本地更新基金数据并推送到 GitHub（代替原来 GitHub Actions 的定时任务）。
# 由 ~/Library/LaunchAgents/com.money.update-data.plist 定时运行，也可以手动运行：
#     bash scripts/update_local.sh
# 日志在 ~/Library/Logs/money-update.log。每次跑完把 data/*.json 复制到 NAS（MONEY_NAS_DIR）。
# AI 写提醒需要 DEEPSEEK_API_KEY：写在 ~/.config/money/env 里（一行 export DEEPSEEK_API_KEY=...），没有就用规则文字。
set -u
cd "$(dirname "$0")/.."
PY="${PY:-python3}"

echo "===== $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M') 北京时间 ====="
[ -f "$HOME/.config/money/env" ] && . "$HOME/.config/money/env"

git pull --rebase -q || { echo "git pull 失败，本次不更新"; exit 1; }

failed=0
"$PY" scripts/update_data.py || failed=1
"$PY" scripts/ai_report.py || echo "盯盘检查失败，不影响数据更新"

git add data/data.json
[ -f data/ai-report.json ] && git add data/ai-report.json
if git diff --cached --quiet; then
  echo "数据没有变化"
else
  git -c user.name=money-bot -c user.email=money-bot@users.noreply.github.com \
    commit -q -m "数据更新 $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M')"
  git pull --rebase -q && git push -q && echo "已推送"
fi

# 数据另备份一份到 NAS（MONEY_NAS_DIR 由 plist 设置；NAS 没挂载就跳过）
if [ -n "${MONEY_NAS_DIR:-}" ]; then
  if [ -d "$MONEY_NAS_DIR" ]; then
    cp -p data/*.json "$MONEY_NAS_DIR"/ && echo "已备份到 NAS：$MONEY_NAS_DIR"
  else
    echo "NAS 没挂载（或没有 $MONEY_NAS_DIR 文件夹），本次没备份"
  fi
fi

[ "$failed" = 1 ] && { echo "有关键数据源抓取失败，看上面的日志"; exit 1; }
exit 0
