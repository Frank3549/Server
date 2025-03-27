// index.js
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ------------------ CONFIG -------------------
const SERVER_JAR = 'fabric-server-mc.1.20.1-loader.0.16.10-launcher.1.0.3.jar';
const RAM = '12G';
const RCON_PASS = 'Susbois@1234';
const RCON_PORT = 25575;
const MCRCONIP = '127.0.0.1';

// Discord Webhook (for notifications)
const DISCORD_WEBHOOK ='https://discord.com/api/webhooks/1354337261461962764/JTDZopcDTgDre7iYOiSq0khX9nOrmAtPTW6QSnJpE31rxzXIMdC6ouMH3HmispMdnzfF';

// Time until we do a normal restart (3hr = 10800s)
const RESTART_DELAY = 3600; 

// Wait 2 minutes before starting the main checks
const SERVER_SETUP_DELAY = 2 * 60_000;

// Check intervals: every 1 minute
const SERVER_CHECK_INTERVAL = 60_000;

// Preventative cleanup interval: every 20 minutes
PREVENTATIVE_CLEANUP_INTERVAL = 10 * 60_000;

// If TPS < TPS_THRESHOLD, we consider it low
const TPS_THRESHOLD = 15;

// Repeated low TPS checks before an early restart
const LOW_TPS_CHECKS_BEFORE_RESTART = 3;

// After a restart, wait 3-4 minutes before we do checks
const RESTART_COOLDOWN = 3 * 60_000; // 3 minutes, adjust to 4 if needed

// Crash Report Dir
const CRASH_REPORTS_DIR = path.join(process.cwd(), 'crash-reports');


// ------------------ GLOBAL STATE -------------------
let timeLeft = RESTART_DELAY;
let globalFlags = {
  doWarn1: true,
  doWarn2: true,
  checkingPing: false, // Prevents multiple pings at once
  checkingTPS: false,
  serverJustRestarted: true // We'll set true at the start
};

// We'll track consecutive low TPS checks
let lowTPSCount = 0;

// For crash detection: we store the latest modified time of any crash report
let lastCrashReportMTime = 0; // We'll populate in init

// Timestamps
let serverRestartTime = Date.now(); // last time we started or restarted the server

// Warnings
const warnMessage1 = 'say Server will restart in 5 minutes.';
const warnTime1 = 300; // 5min

const warnMessage2 = 'say Server restarting in 30 seconds! This may take up to 5 minutes.';
const warnTime2 = 30; // 30s

// ---------------------------------------------------------------------
// MAIN SCRIPT START
// ---------------------------------------------------------------------
initCrashReportTime(); // read initial crash-reports folder state
rerunPrograms();
console.log("Delaying server checks for 2 minutes to let everything start up...");

setTimeout(() => {
  console.log("Starting server checks now...");
  globalFlags.serverJustRestarted = false;
  serverRestartTime = Date.now();
  serverLoop();
  setInterval(removeEntitiesOutsideRangePreventative, PREVENTATIVE_CLEANUP_INTERVAL);
}, SERVER_SETUP_DELAY);


// ---------------------------------------------------------------------
// The main loop: runs every minute, checks countdown, ping, TPS, etc.
// ---------------------------------------------------------------------
function serverLoop() {
  setInterval(serverChecks, SERVER_CHECK_INTERVAL);
}


// ---------------------------------------------------------------------
// Called every minute
// ---------------------------------------------------------------------
function serverChecks() {
  // 1) If we are in a “cooldown” after a fresh server start, skip checks
  if (globalFlags.serverJustRestarted) {
    const elapsed = Date.now() - serverRestartTime;
    if (elapsed < RESTART_COOLDOWN) {
      console.log(`Server in startup cooldown. Skipping checks... (${(RESTART_COOLDOWN - elapsed) / 1000}s left)`);
      return;
    } else {
      // done waiting
      globalFlags.serverJustRestarted = false;
      console.log("Server startup cooldown complete. Resuming normal checks.");
    }
  }

  // 2) Countdown
  timeLeft -= 60;
  console.log(`Time left until auto-restart: ${timeLeft} seconds`);

  // Timed Warnings
  sendWarning('doWarn1', warnMessage1, warnTime1);
  sendWarning('doWarn2', warnMessage2, warnTime2);

  // If time is up => full restart
  if (timeLeft <= 0) {
    console.log("Regular scheduled restart triggered (countdown).");
    sendDiscordMessage("Performing scheduled restart now.");
    doFullRestart("Scheduled restart");
    return;
  }

  // 3) Check if the server is responding => if not, see if there's a crash
  attemptRconCommand("list", (success) => {
    if (!success) {
      console.log("RCON command 'list' failed => checking crash reports...");
      const crashed = checkForNewCrashReports();
      if (crashed) {
        console.log("Detected new crash report => forcing a full restart!");
        sendDiscordMessage("Server appears crashed (new crash report found). Restarting now...");
        doFullRestart("Crash Detected");
        return;
      } else {
        console.log("No new crash report, but RCON failed. We'll forcibly restart to be safe.");
        doFullRestart("Unresponsive RCON");
        return;
      }
    }
    // else it's fine, do normal checks
  });

  // 4) If not already checking external ping => do it
  if (!globalFlags.checkingPing) {
    globalFlags.checkingPing = true;
    exec('curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link', (err, stdout) => {
      if (!stdout.includes('"online":true')) {
        console.log('External connection check failed. Retrying in 15s...');
        setTimeout(() => {
          exec('curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link', (err2, stdout2) => {
            if (!stdout2.includes('"online":true')) {
              console.log('Pinging the server failed twice. Restarting Playit...');
              sendServerMessage('say Restarting connection services in 15 seconds. This may take up to 1 minute.');
              sendDiscordMessage("Server offline externally. Attempting fix by restarting Playit tunnel...");

              setTimeout(() => {
                restartPlayit();
              }, 15_000);
            } else {
              console.log('External check passed on retry.');
              sendServerMessage('say Server is responding again.');
            }
            globalFlags.checkingPing = false;
          });
        }, 15_000);
      } else {
        console.log('External check passed.');
        globalFlags.checkingPing = false;
      }
    });
  }

  // 5) Check TPS with Spark if not already checking
  if (!globalFlags.checkingTPS) {
    globalFlags.checkingTPS = true;
    // We'll parse /spark tps
    attemptSparkTPS(() => {
      globalFlags.checkingTPS = false;
    });
  }
}


// ---------------------------------------------------------------------
// Attempt a single RCON command. If we succeed => callback(true). If fails => callback(false).
// ---------------------------------------------------------------------
function attemptRconCommand(command, callback) {
  const rconCmd = `mcrcon.exe -H ${MCRCONIP} -P ${RCON_PORT} -p ${RCON_PASS} "${command}"`;
  exec(rconCmd, (err, stdout, stderr) => {
    if (err) {
      console.log(`RCON command "${command}" error:`, err.message);
      return callback(false);
    }
    // success
    callback(true);
  });
}


// ---------------------------------------------------------------------
// Use Spark to get TPS, do logic for low TPS
// ---------------------------------------------------------------------
function attemptSparkTPS(onDone) {
  let cmd = `mcrcon.exe -H ${MCRCONIP} -P ${RCON_PORT} -p ${RCON_PASS} "/spark tps"`;
  exec(cmd, (err, stdout) => {
    if (err) {
      console.error("Spark TPS command error:", err.message);
      // possibly server isn't up or RCON isn't responding
      onDone();
      return;
    }
    // parse out "Mean tick time: xx.x ms"
    let match = stdout.match(/Mean tick time:\s*([\d.]+)\s*ms/);
    if (!match) {
      console.log("Could not parse TPS from spark output. Full output:\n", stdout);
      onDone();
      return;
    }

    let meanMs = parseFloat(match[1]);
    let tps = meanMs > 0 ? (1000 / meanMs) : 0;
    console.log(`Spark reported TPS: ${tps.toFixed(2)}`);

    if (tps < TPS_THRESHOLD) {
      lowTPSCount++;
      console.log(`Low TPS detected (TPS ~ ${tps.toFixed(2)}). Count = ${lowTPSCount}`);

      if (lowTPSCount === 1) {
        // FIRST measure => remove dropped items & far-away mobs
        sendServerMessage('say TPS is low. Removing distant mobs/items to reduce lag...');

        removeEntitiesOutsideRange(() => {
          // done removing. We'll see if next minute helps TPS
        });

      } else if (lowTPSCount < LOW_TPS_CHECKS_BEFORE_RESTART) {
        // 2nd measure or continuing => just warn
        sendServerMessage(`say TPS is still low (${tps.toFixed(1)}). We might restart soon if it doesn't recover.`);
      } else {
        // If repeated too many times => do an early restart
        console.log("TPS has been too low for too long. Triggering early restart.");
        sendServerMessage('say TPS is severely low. Restarting the server in 30 seconds...');
        sendDiscordMessage(`Server TPS ~ ${tps.toFixed(2)} for too long. Early restart in 30s to fix lag.`);

        setTimeout(() => {
          doFullRestart("Low TPS emergency restart");
        }, 30_000);
      }
    } else {
      // TPS is fine => reset
      lowTPSCount = 0;
    }
    onDone();
  });
}


// ---------------------------------------------------------------------
// Removes dropped items + mobs that are 64 blocks from any player
// Then tries an RCON command to see if the server is alive
// If RCON fails => checks for crash => forced restart if needed
// ---------------------------------------------------------------------
function removeEntitiesOutsideRange(callback) {
  // 1) remove mobs (they might drop items)
  sendServerMessage(`execute as @e[type=!player,type=!armor_stand,type=!item] at @s unless entity @a[distance=..64] run kill @s`);

  // 2) remove items (including any dropped from above)
  sendServerMessage(`execute as @e[type=item] at @s unless entity @a[distance=..64] run kill @s`);

  // Wait 3s, then see if we can still RCON
  setTimeout(() => {
    attemptRconCommand("say Cleanup check. If you see this, server is alive.", (alive) => {
      if (!alive) {
        console.log("RCON check failed after entity cleanup => checking crash reports...");
        let crashed = checkForNewCrashReports();
        if (crashed) {
          console.log("Found new crash report => forcing a restart now.");
          sendDiscordMessage("Server unresponsive after cleanup + crash report found. Restarting...");
          doFullRestart("Crash after cleanup");
        } else {
          console.log("No new crash report, but RCON is unresponsive => forced restart.");
          sendDiscordMessage("Server unresponsive after cleanup (no crash report). Forcing restart...");
          doFullRestart("Unresponsive after cleanup");
        }
      } else {
        console.log("Cleanup successful, server responded to RCON. We'll see if TPS improves next check.");
        if (callback) callback();
      }
    });
  }, 7000);
}

function removeEntitiesOutsideRangePreventative(callback) {
  console.log("Preventative cleanup announced.");
  sendServerMessage("save-all");
  sendServerMessage('say Preventative cleanup in 15 seconds.');

  // Step 1: Wait 15 seconds before running cleanup
  setTimeout(() => {
    console.log("Running preventative cleaning...");
    
    // Run entity removal commands
    sendServerMessage(`execute as @e[type=!player,type=!armor_stand,type=!item] at @s unless entity @a[distance=..64] run kill @s`);
    sendServerMessage(`execute as @e[type=item] at @s unless entity @a[distance=..64] run kill @s`);

    // Step 2: Wait 10 more seconds before RCON check
    setTimeout(() => {
      attemptRconCommand("say Cleanup finished.", (alive) => {
        if (!alive) {
          console.log("RCON check failed after cleanup => checking crash reports...");
          let crashed = checkForNewCrashReports();
          if (crashed) {
            console.log("Found new crash report => forcing a restart now.");
            sendDiscordMessage("Server unresponsive after cleanup + crash report found. Restarting...");
            doFullRestart("Crash after cleanup");
          } else {
            console.log("No new crash report, but RCON is unresponsive => forced restart.");
            sendDiscordMessage("Server unresponsive after cleanup (no crash report). Forcing restart...");
            doFullRestart("Unresponsive after cleanup");
          }
        } else {
          console.log("Cleanup successful, server responded to RCON.");
          if (callback) callback();
        }
      });
    }, 10_000); // wait 10s after cleanup

  }, 15_000); // wait 15s before starting cleanup
}


// ---------------------------------------------------------------------
// Reads crash-reports folder, sees if there's a file newer than lastCrashReportMTime
// If yes => returns true
// ---------------------------------------------------------------------
function checkForNewCrashReports() {
  if (!fs.existsSync(CRASH_REPORTS_DIR)) {
    return false; // no folder, no crash
  }
  let newestTime = lastCrashReportMTime;
  let files = fs.readdirSync(CRASH_REPORTS_DIR);
  let foundNew = false;

  files.forEach(file => {
    let fullPath = path.join(CRASH_REPORTS_DIR, file);
    let stats = fs.statSync(fullPath);
    if (stats.mtimeMs > newestTime) {
      // found something newer
      foundNew = true;
      if (stats.mtimeMs > lastCrashReportMTime) {
        lastCrashReportMTime = stats.mtimeMs;
      }
    }
  });

  return foundNew;
}


// ---------------------------------------------------------------------
// Initialize lastCrashReportMTime so we only detect new files
// ---------------------------------------------------------------------
function initCrashReportTime() {
  if (!fs.existsSync(CRASH_REPORTS_DIR)) {
    fs.mkdirSync(CRASH_REPORTS_DIR, { recursive: true });
    lastCrashReportMTime = 0;
    return;
  }
  let files = fs.readdirSync(CRASH_REPORTS_DIR);
  let mostRecent = 0;
  files.forEach(file => {
    let full = path.join(CRASH_REPORTS_DIR, file);
    let stats = fs.statSync(full);
    if (stats.mtimeMs > mostRecent) {
      mostRecent = stats.mtimeMs;
    }
  });
  lastCrashReportMTime = mostRecent;
}


// ---------------------------------------------------------------------
// Master function that gracefully restarts everything
// ---------------------------------------------------------------------
function doFullRestart(reason) {
  console.log(`Performing full server restart. Reason: ${reason}`);
  sendDiscordMessage(`Restarting server now. Reason: ${reason}`);

  // 1) Announce
  sendServerMessage(`say Restarting the server now (${reason}). May take up to 5 minutes.`);

  // 2) Graceful stop
  setTimeout(() => {
    sendServerMessage("save-all flush");
    setTimeout(() => {
      sendServerMessage("stop");
      // Wait 5s to let the server shut down
      setTimeout(() => {
        exec('taskkill /f /im java.exe', () => {
          // Also kill Playit
          exec('taskkill /f /im playit.exe', () => {
            // 3) Backup after the server is definitely closed
            backupWorld(() => {
              console.log("Backup done. Now relaunching...");
              sendDiscordMessage("Server is offline. Backup completed. Launching fresh server. I will notify once up...");

              // 4) Reset countdown & flags
              timeLeft = RESTART_DELAY;
              globalFlags.doWarn1 = true;
              globalFlags.doWarn2 = true;
              lowTPSCount = 0;

              // Mark serverJustRestarted => we'll skip checks for RESTART_COOLDOWN
              globalFlags.serverJustRestarted = true;
              serverRestartTime = Date.now();

              // 5) Start fresh
              rerunPrograms();

              // We'll do checkServerOnline eventually, but let's not spam
              // or you can call it after some delay if you want
              setTimeout(() => {
                checkServerOnline(0);
              }, 60_000);
            });
          });
        });
      }, 5000);
    }, 3000);
  }, 3000);
}


// ---------------------------------------------------------------------
// Start up MC + Playit
// ---------------------------------------------------------------------
function rerunPrograms() {

  // Start Playit
  exec('tasklist', (err, stdout) => {
    if (!stdout.includes('playit.exe')) {
      console.log('Starting Playit Tunnel...');
      exec('start /min "Playit Tunnel" "Playit.gg.lnk"');
    } else {
      console.log('Playit already running.');
    }
  });

  // Start MC
  exec('tasklist', (err, stdout) => {
    if (!stdout.includes('java.exe')) {
      console.log('Starting Minecraft server...');
      exec(`start /min "Minecraft Server" java -Xmx${RAM} -Xms2G -jar ${SERVER_JAR} nogui`);
    } else {
      console.log('Minecraft server already running.');
    }
  });
}


// ---------------------------------------------------------------------
// Kills + restarts just Playit
// ---------------------------------------------------------------------
function restartPlayit() {
  exec('taskkill /f /im playit.exe', () => {
    exec('start /min "Playit Tunnel" "Playit.gg.lnk"');
  });
}



// ---------------------------------------------------------------------
// Backs up the world folder
// ---------------------------------------------------------------------
function backupWorld(doneCallback) {
  console.log('Performing world backup...');
  const now = new Date();
  const date = now.toLocaleDateString('en-CA'); // e.g. 2025-03-25
  const hour = now.getHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  const min = String(now.getMinutes()).padStart(2, '0');
  const timestamp = `${date}-${hour12}${min}${ampm}`;

  const backupDir = 'backups';
  const backupPath = `${backupDir}/world-${timestamp}`;

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

  exec(`xcopy /E /I /Y "world" "${backupPath}"`, (err) => {
    if (err) {
      console.error('Backup error:', err);
      sendDiscordMessage(`Backup error occurred: ${err.message || err}`);
    } else {
      console.log(`Backup complete at ${backupPath}`);
    }
    if (typeof doneCallback === 'function') {
      doneCallback();
    }
  });
}


// ---------------------------------------------------------------------
// Verify server is up via external ping; if not, keep checking
// "attempt" param to avoid infinite recursion
// ---------------------------------------------------------------------
function checkServerOnline(attempt) {
  if (attempt > 5) {
    // after 5 tries, give up
    console.log("Server not detected after several checks. Notifying Discord...");
    sendDiscordMessage("Server still not online after multiple checks. Waiting for manual intervention...");
    return;
  }

  console.log("Verifying server is up via external ping...");
  exec('curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link', (err, stdout) => {
    if (stdout.includes('"online":true')) {
      console.log("Server confirmed online. Notifying Discord...");
      sendDiscordMessage("Server is back online and should be playable now!");
    } else {
      console.log("Server not detected as online. Will check again in 30s...");
      sendDiscordMessage(`Server not yet online (attempt ${attempt + 1}). Checking again soon...`);
      setTimeout(() => checkServerOnline(attempt + 1), 30_000);
    }
  });
}


// ---------------------------------------------------------------------
// Send timed warnings
// ---------------------------------------------------------------------
function sendWarning(flagName, message, timeSeconds) {
  if (timeLeft <= timeSeconds && globalFlags[flagName]) {
    globalFlags[flagName] = false;
    exec(`mcrcon.exe -H ${MCRCONIP} -P ${RCON_PORT} -p ${RCON_PASS} "${message}"`);
  }
}


// ---------------------------------------------------------------------
// Send a single RCON message
// ---------------------------------------------------------------------
function sendServerMessage(msg) {
  exec(`mcrcon.exe -H ${MCRCONIP} -P ${RCON_PORT} -p ${RCON_PASS} "${msg}"`);
}


// ---------------------------------------------------------------------
// Send a Discord message via webhook, using silent cURL
// ---------------------------------------------------------------------
function sendDiscordMessage(content) {
  if (!DISCORD_WEBHOOK) {
    console.log("No Discord Webhook set, skipping message:", content);
    return;
  }

  const payload = { content };

  axios.post(DISCORD_WEBHOOK, payload)
    .then(response => {
      console.log(`Sent Discord message: ${content}`);
    })
    .catch(error => {
      console.error("Error sending Discord message:", error.response ? error.response.data : error.message);
    });
}
