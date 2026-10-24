@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 猫角落 corner.

rem ─────────────────────────────────────────────────────────────
rem  局域网访问说明：
rem  · 用「真实路径」的 node 启动，可命中 Windows 防火墙里已有的
rem    Node.js 入站放行规则，同一 Wi-Fi 下的手机/平板直接可访问。
rem  · 启动后看「局域网  http://192.168.x.x:8848」那一行。
rem  · 若手机打不开，右键 scripts\open-lan-firewall.cmd → 以管理员
rem    身份运行（会加一条 TCP 8848 入站规则）。
rem  · 只想本机访问：把 app\.env 里的 HOST 改成 127.0.0.1
rem ─────────────────────────────────────────────────────────────

set "NODE_EXE=D:\nvm\v20.20.1\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo.
echo   猫角落 corner.  启动中…
echo   Ctrl+C 停止
echo.
"%NODE_EXE%" app\server\index.mjs
pause
