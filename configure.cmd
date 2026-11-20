@echo off
call "%~dp0run.cmd" configure %*
exit /b %errorlevel%
