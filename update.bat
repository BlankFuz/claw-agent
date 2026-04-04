@echo off
echo === Building Claw Agent ===
cd /d "%~dp0"
call npx vsce package --allow-missing-repository
echo.
echo === Installing ===
call "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" --install-extension claw-agent-0.0.1.vsix --force
echo.
echo === Done! Reload VS Code (Ctrl+Shift+P → Reload Window) ===
pause
