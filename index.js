// index.js

const { exec } = require('child_process');
const fs = require('fs');

const SERVER_JAR = 'fabric-server-mc.1.20.1-loader.0.16.10-launcher.1.0.3.jar';
const RAM = '8G';
const RCON_PASS = 'Susbois@1234';
const RCON_PORT = 25575;
const RESTART_DELAY = 21600; // 6 hours in seconds
let timeLeft = RESTART_DELAY;
let doFiveWarn = true;
let doHalfWarn = true;
let checking = false;

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

// Countdown interval loop
setInterval(() => {
  timeLeft -= 60;
  console.log(`Time left until auto-restart: ${timeLeft} seconds`);

  // Send warnings via RCON
  if (timeLeft <= 300 && doFiveWarn) {
    doFiveWarn = false;
    exec(`mcrcon.exe -H 127.0.0.1 -P ${RCON_PORT} -p ${RCON_PASS} "say Server restarting in 5 minutes! Avoid dangerous areas."`);
  }

  if (timeLeft <= 30 && doHalfWarn) {
    doHalfWarn = false;
    exec(`mcrcon.exe -H 127.0.0.1 -P ${RCON_PORT} -p ${RCON_PASS} "say Server restarting in 30 seconds! This may take up to 5 minutes."`);
  }

  // External connectivity check (prioritized)
  if (!checking) {
    checking = true;
    exec('curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link', (err, stdout) => {
      if (!stdout.includes('"online":true')) {
        exec(`mcrcon.exe -H 127.0.0.1 -P ${RCON_PORT} -p ${RCON_PASS} "say Server is not responding to ping requests. Checking again in 15 seconds."`);
        console.log('External connection check failed. Retrying in 15 seconds...');

        setTimeout(() => {
          exec('curl -s https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link', (err2, stdout2) => {
            if (!stdout2.includes('"online":true')) {
              console.log('Pinging to the server failed twice. Restarting Playit.');
              exec(`mcrcon.exe -H 127.0.0.1 -P ${RCON_PORT} -p ${RCON_PASS} "say Users may be having difficulty connecting to the server. Restarting connection services in 15 seconds. This may take up to 1 minute."`);
              setTimeout(() => {
                exec('taskkill /f /im playit.exe');
                exec('start /min "Playit Tunnel" "Playit.gg.lnk"');
              }, 15000);
            } else {
              console.log('External check passed on retry.');
              exec(`mcrcon.exe -H 127.0.0.1 -P ${RCON_PORT} -p ${RCON_PASS} "say Server is responding again."`);
            }
            checking = false;
          });
        }, 15000);

      } else {
        console.log('External check passed.');
        checking = false;
      }
    });
  }

  // When time is up
  if (timeLeft <= 0) {
    restartServer();
  }

}, 60000); // Run every 60 seconds

function restartServer() {
  console.log('Restarting server now.');
  exec(`mcrcon.exe -H 127.0.0.1 -P ${RCON_PORT} -p ${RCON_PASS} "say Server restarting...."`);

  setTimeout(() => {
    exec(`mcrcon.exe -H 127.0.0.1 -P ${RCON_PORT} -p ${RCON_PASS} "save-all flush"`);
    setTimeout(() => {
      exec(`mcrcon.exe -H 127.0.0.1 -P ${RCON_PORT} -p ${RCON_PASS} "stop"`);
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
  });
}
