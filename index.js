// index.js
const { Rcon } = require('rcon-client');
const fetch = require('node-fetch');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const SERVER_JAR = 'fabric-server-mc.1.20.1-loader.0.16.10-launcher.1.0.3.jar';
const RAM = '8G';
const RCON_PASS = 'Susbois@1234';
const RCON_PORT = 25575;
const TUNNEL_COMMAND = 'start /min "Playit Tunnel" "Playit.gg.lnk"';
const TUNNEL_PROCESS_NAME = 'playit.exe';
const BACKUP_DIR = 'backups';
const PING_URL = 'https://api.mcsrvstat.us/2/shown-inspired.gl.joinmc.link';

const RESTART_DELAY = 21600; // 6 hours in seconds

let timeLeft = RESTART_DELAY;
let doFiveWarn = true;
let doHalfWarn = true;

function startServer() {
  exec(`taskkill /f /im ${TUNNEL_PROCESS_NAME}`, () => {
    exec(TUNNEL_COMMAND);
    console.log('Starting Minecraft server and tunnel...');
    exec(`start /min "Minecraft Server" java -Xmx${RAM} -Xms2G -jar ${SERVER_JAR} nogui`);
  });
}

function sendRconCommand(command) {
  return Rcon.connect({ host: '127.0.0.1', port: RCON_PORT, password: RCON_PASS })
    .then(rcon => rcon.send(command).finally(() => rcon.end()))
    .catch(() => null);
}

function backupWorld() {
  const now = new Date();
  const datestamp = now.toLocaleDateString('en-CA');
  const timestamp = `${datestamp}-${now.getHours()}${now.getMinutes()}${now.getHours() >= 12 ? 'PM' : 'AM'}`;
  const backupPath = path.join(BACKUP_DIR, `world-${timestamp}`);
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
  exec(`xcopy /E /I /Y "world" "${backupPath}" >nul`, () => {
    console.log('Backup complete.');
  });
}

function externalCheck() {
  return fetch(PING_URL)
    .then(res => res.json())
    .then(data => data.online === true)
    .catch(() => false);
}

async function loop() {
  if (timeLeft <= 0) return proceed();

  if (timeLeft <= 300 && doFiveWarn) {
    await sendRconCommand('say Server restarting in 5 minutes! Avoid dangerous areas.');
    doFiveWarn = false;
  }

  if (timeLeft <= 30 && doHalfWarn) {
    await sendRconCommand('say Server restarting in 30 seconds! This may take up to 5 minutes.');
    doHalfWarn = false;
  }

  console.log(`Time left until auto-restart: ${timeLeft} seconds`);

  const isReachable = await externalCheck();
  if (!isReachable) {
    console.log('External check failed. Restarting tunnel...');
    await sendRconCommand('say Users may be having difficulty connecting to the server. Restarting connection services.');
    exec(`taskkill /f /im ${TUNNEL_PROCESS_NAME}`, () => {
      exec(TUNNEL_COMMAND);
    });
  }

  const rconOk = await sendRconCommand('list');
  if (rconOk === null) {
    console.log('RCON connection failed. Proceeding to restart.');
    await sendRconCommand('say The server appears to be offline...');
    return proceed();
  }

  timeLeft -= 60;
  setTimeout(loop, 60000);
}

async function proceed() {
  console.log('Restarting server...');
  await sendRconCommand('say Server restarting....');
  await new Promise(res => setTimeout(res, 3000));
  await sendRconCommand('save-all flush');
  await new Promise(res => setTimeout(res, 3000));
  await sendRconCommand('stop');
  await new Promise(res => setTimeout(res, 5000));
  exec('taskkill /f /im java.exe');
  await new Promise(res => setTimeout(res, 5000));
  backupWorld();
  timeLeft = RESTART_DELAY;
  doFiveWarn = true;
  doHalfWarn = true;
  startServer();
  setTimeout(loop, 60000);
}

startServer();
setTimeout(loop, 60000);