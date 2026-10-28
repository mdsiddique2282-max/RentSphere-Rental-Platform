// Offline saved-preview maintenance only: no URI, network or environment loader.
import { emitKeypressEvents } from 'node:readline';
import { previewStateDirectory } from '../utils/finalCatalogPreview.js';
import { setPreviewPassword } from '../utils/previewPassword.js';

function hiddenInput(label) {
  const input = process.stdin;
  if (!input.isTTY) throw new Error('Run this command in an interactive terminal for hidden password entry.');
  process.stdout.write(label);
  emitKeypressEvents(input);
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.off('keypress', keypress); input.setRawMode(false); input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const keypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled; no account was changed.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    input.on('keypress', keypress);
  });
}

async function readPasswords(fromStdin) {
  if (!fromStdin) return [await hiddenInput('New password (hidden): '), await hiddenInput('Confirm password (hidden): ')];
  // Explicit automation mode accepts two lines on stdin, never arguments/env.
  if (process.stdin.isTTY) throw new Error('Omit --password-stdin to use hidden terminal prompts.');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024) throw new Error('Password input is too long.');
  }
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 2) throw new Error('Provide exactly a password and confirmation on stdin.');
  return lines;
}

try {
  const [mode, email, option, ...extra] = process.argv.slice(2);
  if (!mode) {
    console.log('LOCAL PREVIEW ONLY\nStop the preview with Ctrl+C, then choose your own password:\nnpm run preview:admin -- --set-password admin@rentsphere.com\nPasswords are entered at hidden prompts; existing accounts are never duplicated.');
  } else {
    if (!['--set-password', '--reset', '--reset-account'].includes(mode) || !email ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || extra.length ||
        (option !== undefined && option !== '--password-stdin')) throw new Error('Usage: npm run preview:admin -- --set-password admin@rentsphere.com');
    const result = await setPreviewPassword({ directory: previewStateDirectory(), email,
      adminOnly: mode !== '--reset-account', readPassword: () => readPasswords(option === '--password-stdin') });
    console.log(`Local preview password updated.\nEmail: ${result.email}\nRole preserved: ${result.role}\nRestart the preview and log in with your chosen password. No Atlas account was accessed.`);
  }
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Existing saved preview state was not found; no account was changed.' : error.message);
  process.exitCode = 1;
}
