@echo off
call "%~dp0run.cmd" uninstall %*
exit /b %errorlevel%
