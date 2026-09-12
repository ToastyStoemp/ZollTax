#!/usr/bin/env node
/**
 * One-off password recovery for a self-hosted ZollTax install. Sets a new scrypt
 * password hash directly in data/users.json — use it when you're locked out and
 * can't sign in to reset from the UI.
 *
 * The data dir is ZOLLTAX_DATA_DIR (as in docker-compose.yml: /data), else the
 * repo's ./data. Run it wherever that data lives:
 *
 *   List accounts:   node scripts/reset-password.mjs
 *   Reset one:       node scripts/reset-password.mjs you@example.com
 *
 * You'll be prompted for the new password (typed hidden, entered twice). Nothing
 * is passed on the command line or printed. In Docker:
 *   docker compose exec zolltax node scripts/reset-password.mjs you@example.com
 */
import { listUsers, setPassword, DATA_DIR } from '../src/store.js';

/** Read the whole of a piped stdin as the password (non-interactive use). */
function readPiped() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
  });
}

/** Prompt on a real terminal, echoing nothing. */
function askHidden(query) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    stdin.resume();
    stdin.setRawMode(true);
    let input = '';
    const onData = (chunk) => {
      const ch = chunk.toString('utf8');
      if (ch === '\n' || ch === '\r' || ch === '') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '') {
        process.stdout.write('\n');
        reject(new Error('Cancelled'));
      } else if (ch === '' || ch === '\b') {
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const users = listUsers();
  const email = process.argv[2];

  if (!email) {
    console.log(`ZollTax accounts in ${DATA_DIR}/users.json:\n`);
    if (!users.length) {
      console.log('  (none — this data dir has no accounts. Point ZOLLTAX_DATA_DIR at the right one.)');
    } else {
      for (const u of users) console.log(`  ${u.email}${u.role ? `  [${u.role}]` : ''}`);
      console.log('\nReset one:  node scripts/reset-password.mjs <email>');
    }
    return;
  }

  const user = users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
  if (!user) {
    console.error(`No account with email "${email}". Run without arguments to list accounts.`);
    process.exit(1);
  }

  let password;
  if (!process.stdin.isTTY) {
    // Non-interactive (piped): one read, no confirmation prompt.
    password = await readPiped();
  } else {
    password = await askHidden(`New password for ${user.email}: `);
    const repeat = await askHidden('Repeat new password: ');
    if (password !== repeat) {
      console.error('Passwords did not match — nothing changed.');
      process.exit(1);
    }
  }
  if (String(password).length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  setPassword(user.id, password);
  console.log(`\n✓ Password updated for ${user.email}. Sign in with the new password.`);
  console.log('  (If 2FA is enabled, you still need your authenticator code.)');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
