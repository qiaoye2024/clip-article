#!/bin/bash
# clip.sh — 一键入口：抓取 → 组装 → 出 .md
# 用法: bash clip.sh <URL> [输出目录]
# 等价于: bash clip-fetch.sh "$1" "$2" | python3 clip-assemble.py "$2"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 特殊处理：assemble 退出码 2 表示文件已存在，需要透传
bash "${SCRIPT_DIR}/clip-fetch.sh" "$1" "$2" | python3 "${SCRIPT_DIR}/clip-assemble.py" "$2"
EXIT_CODE=$?

if [ $EXIT_CODE -eq 2 ]; then
  # 文件已存在，退出码 2 让 AI 知道需要询问用户
  exit 2
elif [ $EXIT_CODE -ne 0 ]; then
  exit 1
fi

exit 0
