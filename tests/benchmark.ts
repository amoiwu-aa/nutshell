import { spawn } from 'child_process';
import { readFileSync, statSync } from 'fs';
import * as path from 'path';

const exeName = process.platform === 'win32' ? 'nutshell-core.exe' : 'nutshell-core';
const corePath = path.resolve(__dirname, '../native/nutshell-core/target/release', exeName);

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log("Usage: npx tsx tests/benchmark.ts <host> <user> <password>");
  process.exit(1);
}

const [host, user, password, portStr] = args;
const port = portStr ? parseInt(portStr, 10) : 22;

const proc = spawn(corePath, [], { stdio: 'pipe' });

let resolveReady: () => void;
const readyPromise = new Promise<void>(resolve => { resolveReady = resolve; });

let stdoutBuffer = Buffer.alloc(0);
let pendingRequests = new Map<string, {resolve: Function, reject: Function}>();
let reqId = 1;

proc.stdout.on('data', chunk => {
  stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);

  while (stdoutBuffer.length >= 4) {
    const frameLength = stdoutBuffer.readUInt32BE(0);
    if (stdoutBuffer.length < 4 + frameLength) break;

    const payload = stdoutBuffer.subarray(4, 4 + frameLength);
    stdoutBuffer = stdoutBuffer.subarray(4 + frameLength);

    try {
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.type === 'event') {
        if (msg.version) resolveReady();
        if (msg.transfer_id) {
            const pct = ((msg.transferred / msg.total) * 100).toFixed(1);
            process.stdout.write(`\rProgress: ${pct}% [${(msg.transferred / 1024 / 1024).toFixed(1)} MB / ${(msg.total / 1024 / 1024).toFixed(1)} MB]`);
        }
      } else if (msg.id && pendingRequests.has(msg.id)) {
        const p = pendingRequests.get(msg.id)!;
        pendingRequests.delete(msg.id);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new Error(msg.error?.message));
      }
    } catch (err) {}
  }
});

function request(method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `req-${reqId++}`;
    pendingRequests.set(id, { resolve, reject });
    const payload = JSON.stringify({ id, method, params });
    const buf = Buffer.from(payload, 'utf8');
    const frame = Buffer.alloc(4 + buf.length);
    frame.writeUInt32BE(buf.length, 0);
    buf.copy(frame, 4);
    proc.stdin.write(frame);
  });
}

async function run() {
  console.log('Waiting for rust core to be ready...');
  await readyPromise;
  console.log('Rust core is ready!');

  const sessionId = 'bench_session_1';
  console.log(`Connecting to ${host} as ${user}...`);
  await request('ssh.connect', {
    session_id: sessionId,
    host,
    port,
    username: user,
    auth_type: 'password',
    password,
    ai_compatibility_mode: false
  });
  console.log('SSH Native Connected via Rust!');

  const localFile = path.resolve(__dirname, '../dummy_500M.bin');
  const remoteFile = `/tmp/dummy_500M.bin`;
  const size = statSync(localFile).size;

  console.log(`\nStarting Native Upload of 500MB...`);
  const startTime = Date.now();

  try {
      await request('tool.nativeUpload', {
        session_id: sessionId,
        transfer_id: 'test_upload_id',
        local_path: localFile,
        remote_path: remoteFile
      });

      const elapsedMs = Date.now() - startTime;
      const speedMBps = (size / (1024 * 1024)) / (elapsedMs / 1000);

      console.log(`\n\nUpload completed in ${(elapsedMs / 1000).toFixed(2)} seconds!`);
      console.log(`Native Upload Speed: \x1b[32m${speedMBps.toFixed(2)} MB/s\x1b[0m`);
      
      console.log(`\nStarting Native Download of 500MB...`);
      const dlStartTime = Date.now();
      await request('tool.nativeDownload', {
        session_id: sessionId,
        transfer_id: 'test_download_id',
        local_path: localFile + ".downloaded",
        remote_path: remoteFile
      });
      
      const dlElapsedMs = Date.now() - dlStartTime;
      const dlSpeedMBps = (size / (1024 * 1024)) / (dlElapsedMs / 1000);
      console.log(`\n\nDownload completed in ${(dlElapsedMs / 1000).toFixed(2)} seconds!`);
      console.log(`Native Download Speed: \x1b[32m${dlSpeedMBps.toFixed(2)} MB/s\x1b[0m`);

  } catch (e) {
      console.error('\nNative Transfer Failed: ', e);
  } finally {
      request('ssh.disconnect', { session_id: sessionId }).catch(() => {});
      proc.kill();
      process.exit(0);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
