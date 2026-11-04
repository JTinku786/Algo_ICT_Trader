@echo off
REM OANDA broker-truth sync (read-only) for Account Management > OANDA forex.
REM   run_oanda_sync.cmd            sync now
REM   run_oanda_sync.cmd --dry-run  fetch and report, write nothing
setlocal
set "HERE=%~dp0"
call "%HERE%env.cmd"
if not exist "%HERE%logs" mkdir "%HERE%logs"
"%BROKER_SYNC_PYTHON%" "%HERE%oanda_sync.py" %* >> "%HERE%logs\oanda_sync.log" 2>&1
exit /b %ERRORLEVEL%
