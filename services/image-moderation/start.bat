@echo off
REM One-click launcher for the IstaSeva image-moderation service.
REM Creates a venv (first run only), installs deps, and starts the API.
cd /d "%~dp0"
setlocal

echo ============================================================
echo  IstaSeva Image Moderation - starting up
echo ============================================================

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] Creating virtual environment...
  python -m venv .venv || goto :fail
) else (
  echo [1/3] Virtual environment already exists.
)

echo [2/3] Installing dependencies (first run downloads packages)...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail

echo [3/3] Starting API on http://127.0.0.1:8501
echo       Open http://127.0.0.1:8501/docs in your browser to test.
echo       (First image you submit downloads the NudeNet model once.)
echo       Press Ctrl+C in this window to stop.
echo ------------------------------------------------------------
".venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8501
goto :eof

:fail
echo.
echo *** Startup failed. Scroll up to see the error. ***
pause
