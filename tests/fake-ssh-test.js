const { Server } = require('ssh2');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

// Generate a temporary host key
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const server = new Server({
  hostKeys: [privateKey.export({ type: 'pkcs1', format: 'pem' })]
}, (client) => {
  client.on('authentication', (ctx) => {
    ctx.accept(); // Accept any auth!
  }).on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (accept) => {
        const sftp = accept();
        sftp.on('OPEN', (reqid, filename, flags, attrs) => {
          // just mock an open handle
          const handle = Buffer.alloc(4);
          handle.writeUInt32BE(1234, 0);
          sftp.handle(reqid, handle);
        });
        sftp.on('WRITE', (reqid, handle, offset, data) => {
          // Swallow the data, fast as possible!
          sftp.status(reqid, 0); // SSH_FX_OK
        });
        sftp.on('CLOSE', (reqid, handle) => {
          sftp.status(reqid, 0); // SSH_FX_OK
        });
      });
    });
  });
}).listen(50222, '127.0.0.1', function() {
  console.log('Fake SSH server listening on port 50222');
  
  // Now spawn the benchmarker
  console.log('Spawning benchmark...');
  const bencher = spawn('npx', ['tsx', 'tests/benchmark.ts', '127.0.0.1', 'test_user', 'test_pass', '50222'], {
    stdio: 'inherit',
    shell: true
  });

  bencher.on('exit', () => {
    server.close();
    process.exit(0);
  });
});
