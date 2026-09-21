#!/bin/zsh
set -eu
cd "$(dirname "$0")"
print '请先在 Meeting Bridge 侧栏停止监听，再继续安装。'
if [[ -t 0 ]]; then
  read -r 'reply?按回车安装，或按 Ctrl+C 取消：'
fi
./node-runtime/node installer/install.mjs "$@"
if [[ -t 0 ]]; then
  read -r 'reply?按回车关闭此窗口：'
fi
