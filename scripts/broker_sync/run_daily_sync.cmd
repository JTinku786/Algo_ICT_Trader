@echo off
REM Daily broker-truth sync - Windows Command Prompt / Task Scheduler wrapper.
REM
REM   run_daily_sync.cmd                      all accounts, all datasets
REM   run_daily_sync.cmd --brokers groww      one broker
REM   run_daily_sync.cmd --dry-run            fetch and report, write nothing

setlocal
set "HERE=%~dp0"
call "%HERE%env.cmd"
if not exist "%HERE%logs" mkdir "%HERE%logs"

for /f "tokens=1-3 delims=/- " %%a in ("%DATE%") do set "STAMP=%%c-%%b-%%a"
set "LOG=%HERE%logs\broker_sync_%STAMP%.log"
set "SUMMARY=%HERE%logs\broker_sync_latest.json"

echo === broker sync started %DATE% %TIME% === >> "%LOG%"
"%BROKER_SYNC_PYTHON%" "%HERE%sync_broker_accounts.py" --json-out "%SUMMARY%" %* >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
echo === broker sync finished %DATE% %TIME% exit=%CODE% === >> "%LOG%"
exit /b %CODE%
