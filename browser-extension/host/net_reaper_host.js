#!/usr/bin/env node

// Native Messaging Host for Net Reaper
// Chrome sends/receives messages as: [4-byte LE length][JSON payload]
// This host forwards download URLs to the running Net Reaper app via a local named pipe.

const net = require('net');
const path = require('path');

const PIPE_NAME = process.platform === 'win32'
  ? '\\\\.\\pipe\\net-reaper'
  : '/tmp/net-reaper.sock';

// Read a native message from stdin
function readMessage(callback) {
  let lengthBuf = Buffer.alloc(0);

  function onReadable() {
    // Read the 4-byte length prefix
    if (lengthBuf.length < 4) {
      const chunk = process.stdin.read(4 - lengthBuf.length);
      if (!chunk) return;
      lengthBuf = Buffer.concat([lengthBuf, chunk]);
      if (lengthBuf.length < 4) return;
    }

    const msgLen = lengthBuf.readUInt32LE(0);
    if (msgLen === 0 || msgLen > 1024 * 1024) {
      process.exit(0);
      return;
    }

    const msgBuf = process.stdin.read(msgLen);
    if (!msgBuf) return;

    lengthBuf = Buffer.alloc(0);
    try {
      callback(JSON.parse(msgBuf.toString()));
    } catch (e) {
      sendMessage({ error: 'Invalid JSON' });
    }
  }

  process.stdin.on('readable', onReadable);
}

// Write a native message to stdout
function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.alloc(4 + json.length);
  buf.writeUInt32LE(json.length, 0);
  buf.write(json, 4);
  process.stdout.write(buf);
}

// Forward download request to Net Reaper via named pipe
function forwardToApp(data) {
  const client = net.createConnection(PIPE_NAME, () => {
    client.write(JSON.stringify(data) + '\n');
    client.end();
    sendMessage({ status: 'ok' });
  });

  client.on('error', () => {
    sendMessage({ status: 'error', message: 'Net Reaper is not running' });
  });
}

// Main loop
readMessage(function onMessage(msg) {
  if (msg.url) {
    forwardToApp(msg);
  } else {
    sendMessage({ status: 'error', message: 'No URL provided' });
  }
  readMessage(onMessage);
});
