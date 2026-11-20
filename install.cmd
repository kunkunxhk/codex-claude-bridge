@echo off
call "%~dp0run.cmd" install %*
exit /b %errorlevel%
