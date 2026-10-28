import { spawn } from 'node:child_process';

// Test passwords travel over stdin, never command arguments or environment.
export function runWithInput(script, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error('Preview password command refused the operation.'), { code, stdout, stderr }));
    });
    child.stdin.end(input);
  });
}
