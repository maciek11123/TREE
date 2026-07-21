@echo off
setlocal

set "BASE=https://raw.githubusercontent.com/maciek11123/TREE/claude/bluey-models-organization-e4bcnr"
set "DIR=%~dp0"

echo.
echo  Bluey Viewer - Setup
echo  ---------------------

:: Create public folder if needed
if not exist "%DIR%public" mkdir "%DIR%public"

echo  Downloading server.js...
curl -fsSL "%BASE%/server.js" -o "%DIR%server.js"

echo  Downloading public\index.html...
curl -fsSL "%BASE%/public/index.html" -o "%DIR%public\index.html"

echo  Writing models.config.json...
(
  echo {
  echo   "modelsDir": "C:\Users\macie\OneDrive\Desktop\BLUEY ANIMATED\MODELS\Bluey World"
  echo }
) > "%DIR%models.config.json"

echo.
echo  Done! Starting server...
echo  Open http://localhost:3000 in your browser.
echo  Then click "Batch Fix All" to begin.
echo.

node "%DIR%server.js"
pause
