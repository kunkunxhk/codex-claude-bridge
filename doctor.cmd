@echo off
call "%~dp0run.cmd" doctor %*
exit /b %errorlevel%
