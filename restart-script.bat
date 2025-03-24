@echo off
setlocal EnableDelayedExpansion

:: Prevent auto-closing if double-clicked
cd /d %~dp0
color 0A
title Minecraft Server Auto-Restart Controller

:: Basic config
set SERVER_JAR=fabric-server-mc.1.20.1-loader.0.16.10-launcher.1.0.3.jar
set RAM=8G
set RCON_PASS=Susbois@1234
set RCON_PORT=25575

:: We'll do a final 30s RCON warning. 5-minute early warning too.
set RESTART_DELAY=21600  :: 30mins hours in seconds

:loop
:: (Re)start playit.gg minimized
Taskkill /f /im playit.exe >nul 2>&1
start /min "Playit Tunnel" "Playit.gg.lnk"

echo Starting Minecraft server and Playit.gg minimized...
start /min "Minecraft Server" java -Xmx%RAM% -Xms2G -jar %SERVER_JAR% nogui

:: 5-second interval countdown
set /a timeLeft=%RESTART_DELAY%
:: Flags for one-time RCON messages
set DO_FIVE_WARN=1
set DO_HALF_WARN=1

:waitloop
if !timeLeft! LEQ 0 goto proceed 

:: 5-minute (300s) warning
if !timeLeft! LEQ 300 if !DO_FIVE_WARN!==1 (
    echo Sending 5-minute warning via RCON...
    mcrcon.exe -H 127.0.0.1 -P %RCON_PORT% -p %RCON_PASS% "say Server restarting in 5 minutes! Avoid dangerous areas."
    set DO_FIVE_WARN=0
)

:: 30-second warning
if !timeLeft! LEQ 30 if !DO_HALF_WARN!==1 (
    echo Sending 30-second final warning via RCON...
    mcrcon.exe -H 127.0.0.1 -P %RCON_PORT% -p %RCON_PASS% "say Server restarting in 30 seconds! This may take up to 5 minutes."
    set DO_HALF_WARN=0
)

echo Time left until auto-restart: !timeLeft! seconds
timeout /t 60 /nobreak >nul
set /a timeLeft-=60


:: -------- CHECK IF SERVER IS STILL ONLINE --------
mcrcon.exe -H 127.0.0.1 -P %RCON_PORT% -p %RCON_PASS% "list" > rcon_output.txt 2>&1

:: Check if output file contains an error
findstr /i "failed refused error" rcon_output.txt >nul

:: If findstr found words => errorlevel==0 => means an error
if %errorlevel%==0 (
    echo RCON connection failed. Server may be offline!
    mcrcon.exe -H 127.0.0.1 -P %RCON_PORT% -p %RCON_PASS% "say The server appears to be offline. Restarting in 15... "
    timeout /t 15 /nobreak >nul
    goto proceed
) else (
    echo RCON connection successful.
)

del rcon_output.txt

:: -------- CHECK IF PEOPLE CAN CONNECT (Goes to waitloop afterwards)--------
goto external_check_1


:proceed
echo Sending final RCON restart message...
mcrcon.exe -H 127.0.0.1 -P %RCON_PORT% -p %RCON_PASS% "say Server restarting...."

timeout /t 3 /nobreak >nul

echo Stopping server gracefully...
:: Save all chunks
mcrcon.exe -H 127.0.0.1 -P %RCON_PORT% -p %RCON_PASS% "save-all flush"
timeout /t 3 /nobreak >nul

:: Stop command
mcrcon.exe -H 127.0.0.1 -P %RCON_PORT% -p %RCON_PASS% "stop"
timeout /t 5 /nobreak >nul

:: Force kill if not closed
taskkill /f /im java.exe >nul 2>&1
timeout /t 5 /nobreak >nul

echo Backing up world folder...
:: Format date/time for the backup folder
for /f "tokens=1-4 delims=/ " %%i in ("%date%") do set datestamp=%%i-%%j-%%k
for /f "tokens=1-2 delims=: " %%i in ("%time%") do (
    set hour=%%i
    set min=%%j
)

:: Convert 24-hour to 12-hour with AM/PM
set /a hour12=1!hour!-100
if !hour! LSS 12 (
    set ampm=AM
) else (
    set /a hour12-=12
    set ampm=PM
)
set timestamp=!datestamp!-!hour12!!min!!ampm!

if not exist backups mkdir backups
xcopy /E /I /Y "world" "backups\\world-!timestamp!" >nul

echo Backup complete. Server restarting for another 12-hour cycle...
goto loop

:: -------CHECK IF PEOPLE CAN STILL CONNECT (EXTERNAL)--------

:external_check_1 :: First check moves to second check if failed.
curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link > pingcheck.json

findstr /i "\"online\":true" pingcheck.json >nul
:: If findstr found words => errorlevel==1 => means an error here
if %errorlevel%==1 (
    echo External connection to server failed! Trying one more time...
    del pingcheck.json
    timeout /t 20 /nobreak >nul
    goto external_check_2
) else (
    echo External check passed. Server is reachable via tunnel.
    goto waitloop
)



:external_check_2 :: Restart on second check failure
curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link > pingcheck.json

findstr /i "\"online\":true" pingcheck.json >nul
:: If findstr found words => errorlevel==1 => means an error here
if %errorlevel%==1 ( 
    echo External connection to server failed! Failed twice. Restarting Playit.gg...
    mcrcon.exe -H 127.0.0.1 -P %RCON_PORT% -p %RCON_PASS% "say Users may be having difficulty connecting to the server. Restarting connection services in 15 seconds. This may take up to 1 minute."
    timeout /t 15 /nobreak >nul
    taskkill /f /im playit.exe >nul 2>&1
    echo [%date% %time%] Restarted Playit.gg tunnel due to failed external check. >> logs\tunnel-log.txt
    timeout /t 3 >nul
    start /min "Playit Tunnel" "Playit.gg.lnk"
) else (
    echo External check passed. Server is reachable via tunnel.
)
del pingcheck.json
goto waitloop
