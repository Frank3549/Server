// index.js

const { exec } = require('child_process');
const { time } = require('console');
const fs = require('fs');

const SERVER_JAR = 'fabric-server-mc.1.20.1-loader.0.16.10-launcher.1.0.3.jar';
const RAM = '12G';
const RCON_PASS = 'Susbois@1234';
const RCON_PORT = 25575;
const RESTART_DELAY = 10800; // 3 hours in seconds
const SERVER_SETUP_DELAY = 120000; // 2 minutes in milliseconds
const SERVER_CHECK_INTERVAL = 60000; // 1 minute in milliseconds
const MCRCONIP = "127.0.0.1";
let timeLeft = RESTART_DELAY;

let globalFlags = {
  doWarn1: true,
  doWarn2: true,
  checking: false // Prevents multiple checks at once
};

let warnMessage1 = 'say Server will restart in 5 minutes. Please finish up what you are doing.';
let warnMessageTime1 = 300;

let warnMessage2 = 'say Server restarting in 30 seconds! This may take up to 5 minutes.';
let warnMessageTime2 = 30;





function serverLoop() {
  setInterval(serverChecks, SERVER_CHECK_INTERVAL);

}

// Countdown interval loop as well as server checks
function serverChecks(){
  timeLeft -= 60;
  console.log(`Time left until auto-restart: ${timeLeft} seconds`);

  // Send warnings via RCON
  sendWarning('doWarn1', warnMessage1, warnMessageTime1);
  sendWarning('doWarn2', warnMessage2, warnMessageTime2);

  // Restart Trigger
  if (timeLeft <= 0) {
    restartServer();
    return; // Prevents further checks after restart
  }

  // External connectivity check (prioritized)
  if (!globalFlags["checking"]) {
    globalFlags["checking"] = true;
    exec('curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link', (err, stdout) => {
      if (!stdout.includes('"online":true')) {
        sendServerMessage('say Server is not responding to ping requests. Checking again in 15 seconds.');
        console.log('External connection check failed. Retrying in 15 seconds...');

        setTimeout(() => {
          exec('curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link', (err2, stdout2) => {
            if (!stdout2.includes('"online":true')) {
              console.log('Pinging to the server failed twice. Restarting Playit.');
              sendServerMessage('say Server is not responding to ping requests. Restarting connection services in 15 seconds. This may take up to 1 minute.');
              setTimeout(() => {
                restartPlayit();
              }, 15000);
            } else {
              console.log('External check passed on retry.');
              sendServerMessage('say Server is responding again.');
            }
            globalFlags["checking"] = false;
          });
        }, 15000);

      } else {
        console.log('External check passed.');
        globalFlags["checking"] = false;
      }
    });

  }


}

// Checks and starts Playit.gg and Minecraft server if not running
function rerunPrograms () {
  // Check and start Playit if not running
  exec('tasklist', (err, stdout) => {
    if (!stdout.includes('playit.exe')) {
      console.log('Starting Playit Tunnel...');
      exec('start /min "Playit Tunnel" "Playit.gg.lnk"');
    } else {
      console.log('Playit already running.');
    }
  });

    // Check and start Minecraft if not running
    exec('tasklist', (err, stdout) => {
    if (!stdout.includes('java.exe')) {
      console.log('Starting Minecraft server...');
      exec(`start /min "Minecraft Server" java -Xmx${RAM} -Xms2G -jar ${SERVER_JAR} nogui`);
    } else {
      console.log('Minecraft server already running.');
    }
    });
}

function restartPlayit() {
  exec('taskkill /f /im playit.exe');
  exec('start /min "Playit Tunnel" "Playit.gg.lnk"');
}

function restartServer() {
  console.log('Restarting server now.');
  sendServerMessage('say Server is restarting now. This may take up to 5 minutes.');

  setTimeout(() => {
    sendServerMessage("save-all flush");
    setTimeout(() => {
      sendServerMessage("stop");
      setTimeout(() => {
        exec('taskkill /f /im java.exe');
        backupWorld();
        process.exit(0);
      }, 5000);
    }, 3000);
  }, 3000);
}

function backupWorld() {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA');
  const hour = now.getHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  const min = String(now.getMinutes()).padStart(2, '0');
  const timestamp = `${date}-${hour12}${min}${ampm}`;

  const backupPath = `backups/world-${timestamp}`;
  if (!fs.existsSync('backups')) fs.mkdirSync('backups');

  exec(`xcopy /E /I /Y world "${backupPath}"`, () => {
    console.log('Backup complete. Restart script to start next cycle.');
    // TODO: Restart Playit and Minecraft
  });
}

// Send warnings via RCON
function sendWarning(flagName, warningMessage, timeSeconds) {
  if (timeLeft <= timeSeconds && globalFlags[flagName]) {
    globalFlags[flagName] = false;
    exec(`mcrcon.exe -H ${MCRCONIP} -P ${RCON_PORT} -p ${RCON_PASS} "${warningMessage}"`);
  }
}

function sendServerMessage(message) {
  exec(`mcrcon.exe -H ${MCRCONIP} -P ${RCON_PORT} -p ${RCON_PASS} "${message}"`);
}


rerunPrograms();
console.log("Server delay started.");
setTimeout(() => {
  console.log("Server delay ended.")
  serverLoop();
}
, SERVER_SETUP_DELAY);
