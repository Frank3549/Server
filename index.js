// index.js

const { exec } = require('child_process');
const fs = require('fs');

// ------------------ CONFIG -------------------
const SERVER_JAR = 'fabric-server-mc.1.20.1-loader.0.16.10-launcher.1.0.3.jar';
const RAM = '12G';
const RCON_PASS = 'Susbois@1234';
const RCON_PORT = 25575;
const MCRCONIP = '127.0.0.1';

// How long the server should run before auto-restart (3 hours = 10800s)
const RESTART_DELAY = 600;

// Wait 2 minutes before starting the main loop
const SERVER_SETUP_DELAY = 2 * 60_000;

// Check intervals: every 1 minute for countdown + ping + TPS
const SERVER_CHECK_INTERVAL = 60_000;

// If TPS is below this, we increment lowTPSCount
const TPS_THRESHOLD = 15;
// If it stays below threshold for these many checks in a row, do early restart
const LOW_TPS_CHECKS_BEFORE_RESTART = 3;

// ------------------ GLOBAL STATE -------------------
let timeLeft = RESTART_DELAY;
let globalFlags = {
  doWarn1: true,
  doWarn2: true,
  checkingPing: false,   // Prevents multiple pings at once
  checkingTPS: false     // Prevents multiple TPS checks at once
};

// Warnings
const warnMessage1 = 'say Server will restart in 5 minutes. Please finish up what you are doing.';
const warnTime1 = 300; // 5min

const warnMessage2 = 'say Server restarting in 30 seconds! This may take up to 5 minutes.';
const warnTime2 = 30; // 30s

// We'll track consecutive low TPS checks
let lowTPSCount = 0;

// ---------------------------------------------------------------------
// Main script start
// ---------------------------------------------------------------------
rerunPrograms(); 
console.log("Delaying server checks for 2 minutes to let everything start up...");
setTimeout(() => {
  console.log("Starting server checks now...");
  serverLoop();
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
  // 1) Countdown
  timeLeft -= 60;
  console.log(`Time left until auto-restart: ${timeLeft} seconds`);

  // 2) Send timed warnings
  sendWarning('doWarn1', warnMessage1, warnTime1);
  sendWarning('doWarn2', warnMessage2, warnTime2);

  // 3) If time is up => restart
  if (timeLeft <= 0) {
    console.log("Regular scheduled restart triggered (countdown).");
    doFullRestart("Scheduled restart");
    return;
  }

  // 4) Check external ping if not already checking
  if (!globalFlags.checkingPing) {
    globalFlags.checkingPing = true;
    exec('curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link', (err, stdout) => {
      if (!stdout.includes('"online":true')) {
        // Ping failed
        sendServerMessage('say External ping failed. Checking again in 15 seconds...');
        console.log('External ping check failed. Retrying in 15 seconds...');
        setTimeout(() => {
          exec('curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link', (err2, stdout2) => {
            if (!stdout2.includes('"online":true')) {
              // Two ping fails => restart tunnel
              console.log('Pinging the server failed twice. Restarting Playit...');
              sendServerMessage('say Restarting connection services in 15 seconds. This may take up to 1 minute.');
              setTimeout(() => {
                restartPlayit();
              }, 15_000);
            } else {
              console.log('External check passed on retry.');
              sendServerMessage('say Server is responding externally again.');
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
    // Use Spark to get server TPS
    // Note: The /spark tps output has lines like "Mean tick time: xx.x ms"
    // We'll parse that to get TPS = 1000 / meanTickMs
    exec(`mcrcon.exe -H ${MCRCONIP} -P ${RCON_PORT} -p ${RCON_PASS} "/spark tps"`, (err, stdout) => {
      if (err) {
        console.error("Error reading TPS from Spark:", err);
        globalFlags.checkingTPS = false;
        return;
      }
      // Example line to parse: "Mean tick time: 50.0 ms (TPS: 20.00)"
      // or "Mean tick time: 66.7 ms" => TPS ~ 15
      let match = stdout.match(/Mean tick time:\s*([\d.]+)\s*ms/);
      if (match) {
        let meanMs = parseFloat(match[1]);
        let tps = meanMs > 0 ? (1000 / meanMs) : 0;
        console.log(`Spark reported TPS: ${tps.toFixed(2)}`);
        if (tps < TPS_THRESHOLD) {
          // Increase consecutive low TPS count
          lowTPSCount++;
          console.log(`Low TPS detected! (TPS ~ ${tps.toFixed(2)}). Consecutive count=${lowTPSCount}`);
          if (lowTPSCount >= LOW_TPS_CHECKS_BEFORE_RESTART) {
            // If repeated too many times => do early restart
            console.log("TPS has been too low for too long. Triggering early restart now...");
            // Warn players
            sendServerMessage('say TPS is too low. We must restart to fix lag. Restarting in 30 seconds...');
            setTimeout(() => {
              doFullRestart("Low TPS emergency restart");
            }, 30_000);
          } else {
            // Warn but no immediate restart yet
            sendServerMessage(`say TPS is low (${tps.toFixed(1)}). If it stays low, we'll restart soon...`);
          }
        } else {
          // TPS is fine => reset
          lowTPSCount = 0;
        }
      } else {
        console.log("Could not parse TPS from spark output. Full output:\n", stdout);
      }
      globalFlags.checkingTPS = false;
    });
  }
}

// ---------------------------------------------------------------------
// Graceful approach to kill everything, backup, and relaunch
// ---------------------------------------------------------------------
function doFullRestart(reason) {
  console.log(`Performing a full server restart. Reason: ${reason}`);

  // 1) Announce
  sendServerMessage(`say Restarting the server now (${reason}). May take up to 5 minutes.`);

  // 2) Graceful stop
  setTimeout(() => {
    sendServerMessage("save-all flush");
    setTimeout(() => {
      sendServerMessage("stop");
      // Wait 5s for MC to close
      setTimeout(() => {
        // 3) Kill MC forcibly if not closed
        exec('taskkill /f /im java.exe', () => {
          // 4) Also kill Playit
          exec('taskkill /f /im playit.exe', () => {
            // 5) Backup after server is definitely closed
            backupWorld(() => {
              console.log("Backup done. Now relaunching...");
              // 6) Reset countdown
              timeLeft = RESTART_DELAY;
              globalFlags.doWarn1 = true;
              globalFlags.doWarn2 = true;
              lowTPSCount = 0;

              // 7) Start fresh
              rerunPrograms();
            });
          });
        });
      }, 5000);
    }, 3000);
  }, 3000);
}

// ---------------------------------------------------------------------
// Check + Start MC + Playit if not running
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
// Backup world folder; callback once done
// ---------------------------------------------------------------------
function backupWorld(doneCallback) {
  console.log('Performing world backup...');

  const now = new Date();
  const date = now.toLocaleDateString('en-CA');
  const hour = now.getHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  const min = String(now.getMinutes()).padStart(2, '0');
  const timestamp = `${date}-${hour12}${min}${ampm}`;

  const backupDir = 'backups';
  const backupPath = `${backupDir}/world-${timestamp}`;

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

  // Use xcopy to copy the "world" folder
  exec(`xcopy /E /I /Y "world" "${backupPath}"`, (err) => {
    if (err) {
      console.error('Backup error:', err);
    } else {
      console.log(`Backup complete at ${backupPath}`);
    }
    if (typeof doneCallback === 'function') {
      doneCallback();
    }
  });
}

// ---------------------------------------------------------------------
// Send timed warnings
// ---------------------------------------------------------------------
function sendWarning(flagName, message, thresholdSec) {
  if (timeLeft <= thresholdSec && globalFlags[flagName]) {
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
