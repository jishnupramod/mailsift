// Live check: runs connect, folders, search, fetch and close against a real
// mailbox for each provider named on the command line. It only reads. It
// prints PASS or FAIL with an error code, counts and folder names, and never
// prints an address, a password, a subject, a sender or any message text.
//
// Usage: pnpm --filter mailsift test:live <provider> [<provider>...]
//
// The address and app password come from MAILSIFT_LIVE_<PROVIDER>_USER and
// MAILSIFT_LIVE_<PROVIDER>_PASSWORD, or are typed at a prompt; the password
// prompt does not echo. For `custom`, MAILSIFT_LIVE_CUSTOM_HOST and
// MAILSIFT_LIVE_CUSTOM_PORT are used if set, else asked for.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { connect, MailsiftError, PROVIDERS } from '../dist/index.js';

const ids = Object.keys(PROVIDERS).filter((id) => id !== 'outlook');
const usage = `Usage: test:live <provider> [<provider>...]  (providers: ${ids.join(', ')})`;

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    let muted = false;
    const output = new Writable({
      write(chunk, _enc, done) {
        if (!muted) process.stdout.write(chunk);
        done();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
    process.stdout.write(question);
    muted = hidden;
    rl.question('', (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function failure(e) {
  return e instanceof MailsiftError ? `FAIL ${e.code}` : 'FAIL UNKNOWN';
}

async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ${name}: PASS${detail ? ` (${detail})` : ''}`);
    return true;
  } catch (e) {
    console.log(`  ${name}: ${failure(e)}`);
    return false;
  }
}

async function check(id) {
  const key = id.toUpperCase();
  console.log(`${id}`);
  const user = process.env[`MAILSIFT_LIVE_${key}_USER`] || (await ask('  Address: '));
  const password =
    process.env[`MAILSIFT_LIVE_${key}_PASSWORD`] || (await ask('  App password (hidden): ', { hidden: true }));
  const options = { provider: id, auth: { kind: 'password', user, password } };
  if (id === 'custom') {
    options.host = process.env.MAILSIFT_LIVE_CUSTOM_HOST || (await ask('  Host: '));
    const port = process.env.MAILSIFT_LIVE_CUSTOM_PORT || (await ask('  Port (993): '));
    if (port) options.port = Number(port);
  }

  let box;
  let ok = await step('connect', async () => {
    box = await connect(options);
  });
  if (!ok) return false;

  ok = (await step('folders', async () => {
    const folders = await box.folders();
    return `${folders.length}: ${folders.map((f) => f.path).join(', ')}`;
  })) && ok;

  let refs = [];
  ok = (await step('search', async () => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    refs = await box.search({ fromDomains: ['linkedin.com'], since }, { limit: 5 });
    return `${refs.length} found`;
  })) && ok;

  if (refs.length > 0) {
    ok = (await step('fetch', async () => {
      const message = await box.fetch(refs[0]);
      return `${message.text.length} chars, ${message.attachments.length} attachments`;
    })) && ok;
  }

  await box.close();
  console.log('  close: PASS');
  return ok;
}

const requested = process.argv.slice(2);
if (requested.length === 0 || requested.some((id) => id !== 'outlook' && !ids.includes(id))) {
  console.error(usage);
  process.exit(2);
}
if (requested.includes('outlook')) {
  console.error("Microsoft sign-in isn't in this release, so Outlook can't be checked yet.");
  process.exit(2);
}

let allPassed = true;
for (const id of requested) {
  if (!(await check(id))) allPassed = false;
}
process.exit(allPassed ? 0 : 1);
