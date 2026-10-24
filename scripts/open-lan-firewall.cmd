@echo off
chcp 65001 >nul
title 猫角落 · 开放局域网访问（只需运行一次）
cd /d "%~dp0"

rem 已有管理员权限就直接执行，否则自我提权
net session >nul 2>&1
if %errorlevel%==0 goto run

echo 需要管理员权限才能改防火墙，正在弹出 UAC 确认框…
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:run
echo.
echo 正在添加防火墙入站规则：允许 TCP 8848（所有网络类型）
netsh advfirewall firewall delete rule name="CatCorner Corner LAN 8848" >nul 2>&1
netsh advfirewall firewall add rule name="CatCorner Corner LAN 8848" dir=in action=allow protocol=TCP localport=8848 profile=any
if %errorlevel%==0 (
  echo.
  echo   完成。同一 Wi-Fi 下的手机/平板现在可以访问：
  echo     http://192.168.1.5:8848
  echo   如果换网络导致 IP 变化，以服务启动时打印的「局域网」那行为准。
  echo.
  echo   要撤销：netsh advfirewall firewall delete rule name="CatCorner Corner LAN 8848"
) else (
  echo.
  echo   添加失败。请右键本文件 -^> 以管理员身份运行。
)
echo.
pause
