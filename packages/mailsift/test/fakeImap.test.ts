import net from 'node:net';
import { ImapFlow } from 'imapflow';
import { afterEach, describe, expect, it } from 'vitest';
import { compileGmail } from '../src/query.js';
import { startFakeImap, type FakeFolder, type FakeImap } from './fakeImap.js';

const raw = (subject: string, from = 'Ana Silva <ana@jobs.example>', body = 'Hello there.') =>
  [
    `From: ${from}`,
    'To: me@mail.example',
    `Subject: ${subject}`,
    'Date: Tue, 03 Nov 2026 10:00:00 +0000',
    `Message-ID: <${subject.length}@jobs.example>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');

const folders = (): FakeFolder[] => [
  {
    path: 'INBOX',
    uidValidity: 7,
    messages: [
      { uid: 3, raw: raw('Your application to Acme'), date: new Date('2026-09-10T08:00:00Z') },
      { uid: 5, raw: raw('Weekly digest', 'News <news@news.example>'), date: new Date('2026-08-01T08:00:00Z') },
      {
        uid: 8,
        raw: raw('=?UTF-8?B?Q2Fmw6kgaW52aXRl?=', '=?UTF-8?Q?Andr=C3=A9?= <andre@jobs.example>'),
        date: new Date('2026-10-02T08:00:00Z'),
        flags: ['\\Flagged'],
      },
    ],
  },
  {
    path: 'Sent Items',
    specialUse: '\\Sent',
    uidValidity: 9,
    messages: [{ uid: 1, raw: raw('Re: Acme', 'Me <me@mail.example>'), date: new Date('2026-09-11T08:00:00Z') }],
  },
  { path: 'Drafts', specialUse: '\\Drafts', uidValidity: 11, messages: [] },
];

const auth = { user: 'me@mail.example', password: 'app-pass-1234', token: 'tok-abcdef' };

let fake: FakeImap | undefined;
let client: ImapFlow | undefined;

afterEach(async () => {
  await client?.logout().catch(() => undefined);
  client?.close();
  client = undefined;
  await fake?.close();
  fake = undefined;
});

async function connect(opts: { gmail?: boolean; failAuthWith?: string; useToken?: boolean } = {}) {
  fake = await startFakeImap({ folders: folders(), auth, gmail: opts.gmail, failAuthWith: opts.failAuthWith });
  client = new ImapFlow({
    host: '127.0.0.1',
    port: fake.port,
    secure: false,
    auth: opts.useToken ? { user: auth.user, accessToken: auth.token } : { user: auth.user, pass: auth.password },
    logger: false,
  });
  await client.connect();
  return { fake, client };
}

/** Sends raw command lines and collects everything the server answers until it closes or goes quiet. */
async function rawSession(port: number, lines: string[]): Promise<string> {
  const socket = net.connect(port, '127.0.0.1');
  let out = '';
  socket.on('data', (d) => (out += d.toString('utf8')));
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  // wait for each command's tagged reply rather than a fixed pause, so a slow
  // machine doesn't close the socket before the last answer arrives
  for (const line of lines) {
    const tag = line.split(' ')[0];
    const from = out.length;
    socket.write(`${line}\r\n`);
    const deadline = Date.now() + 5000;
    while (!tagged(out.slice(from), tag) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  socket.destroy();
  return out;
}

function tagged(text: string, tag: string): boolean {
  return text.startsWith(`${tag} `) || text.includes(`\r\n${tag} `);
}

describe('startFakeImap', () => {
  it('lets imapflow log in with a password and lists folders with special-use', async () => {
    const { client } = await connect();
    const list = await client.list();
    expect(list.map((f) => [f.path, f.specialUse])).toEqual(
      expect.arrayContaining([
        ['INBOX', '\\Inbox'],
        ['Sent Items', '\\Sent'],
        ['Drafts', '\\Drafts'],
      ]),
    );
  });

  it('examines a folder and finds messages with UID SEARCH SINCE', async () => {
    const { client, fake } = await connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      expect(client.mailbox && client.mailbox.exists).toBe(3);
      expect(client.mailbox && client.mailbox.uidValidity).toBe(7n);
      expect(client.mailbox && client.mailbox.uidNext).toBe(9);
      expect(await client.search({ since: new Date('2026-09-01T00:00:00Z') }, { uid: true })).toEqual([3, 8]);
    } finally {
      lock.release();
    }
    expect(fake.commands.some((c) => /EXAMINE/.test(c))).toBe(true);
    expect(fake.commands.some((c) => /\bSELECT\b/.test(c))).toBe(false);
  });

  it('never records the password or the token', async () => {
    const { fake: f } = await connect();
    expect(JSON.stringify(f.commands)).not.toContain(auth.password);
    await client?.logout();
    client = undefined;
    const second = await startFakeImap({ folders: folders(), auth });
    const tokenClient = new ImapFlow({
      host: '127.0.0.1',
      port: second.port,
      secure: false,
      auth: { user: auth.user, accessToken: auth.token },
      logger: false,
    });
    await tokenClient.connect();
    await tokenClient.logout();
    const joined = second.commands.join('\n');
    expect(joined).toContain('AUTHENTICATE XOAUTH2');
    expect(joined).not.toContain(auth.token);
    expect(joined).not.toContain(Buffer.from(`user=${auth.user}\x01auth=Bearer ${auth.token}\x01\x01`).toString('base64'));
    await second.close();
  });

  it('masks the LOGIN password', async () => {
    fake = await startFakeImap({ folders: folders(), auth });
    const answer = await rawSession(fake.port, [`a1 LOGIN "${auth.user}" "${auth.password}"`, 'a2 LOGOUT']);
    expect(answer).toContain('a1 OK');
    expect(fake.commands).toContain(`a1 LOGIN "${auth.user}" ***`);
    expect(JSON.stringify(fake.commands)).not.toContain(auth.password);
  });

  it('accepts XOAUTH2 with the token', async () => {
    const { client } = await connect({ useToken: true });
    expect(client.authenticated).toBeTruthy();
  });

  it('rejects wrong credentials and reports failAuthWith', async () => {
    fake = await startFakeImap({ folders: folders(), auth, failAuthWith: 'Application-specific password required' });
    client = new ImapFlow({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      auth: { user: auth.user, pass: auth.password },
      logger: false,
    });
    await expect(client.connect()).rejects.toMatchObject({ authenticationFailed: true });
    expect(await rawSession(fake.port, [`a1 LOGIN "${auth.user}" "${auth.password}"`])).toContain(
      'a1 NO [AUTHENTICATIONFAILED] Application-specific password required',
    );
  });

  it('rejects a wrong token with the XOAUTH2 challenge', async () => {
    fake = await startFakeImap({ folders: folders(), auth });
    client = new ImapFlow({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      auth: { user: auth.user, accessToken: 'wrong' },
      logger: false,
    });
    await expect(client.connect()).rejects.toMatchObject({ authenticationFailed: true });
  });

  it('searches by sender, subject and body, decoding encoded words and using OR', async () => {
    const { client } = await connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      expect(await client.search({ from: 'jobs.example' }, { uid: true })).toEqual([3, 8]);
      expect(await client.search({ subject: 'digest' }, { uid: true })).toEqual([5]);
      expect(await client.search({ body: 'hello' }, { uid: true })).toEqual([3, 5, 8]);
      expect(await client.search({ or: [{ subject: 'acme' }, { subject: 'digest' }] }, { uid: true })).toEqual([3, 5]);
      expect(await client.search({ subject: 'Café', since: new Date('2026-09-01T00:00:00Z') }, { uid: true })).toEqual([8]);
      expect(await client.search({ from: 'André' }, { uid: true })).toEqual([8]);
    } finally {
      lock.release();
    }
    expect(fake?.commands.some((c) => /CHARSET UTF-8/.test(c))).toBe(true);
  });

  it('answers X-GM-RAW searches only when gmail is set', async () => {
    const { client, fake } = await connect({ gmail: true });
    expect(client.capabilities.has('X-GM-EXT-1')).toBe(true);
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const [domains] = compileGmail({ fromDomains: ['jobs.example'], since: new Date('2026-09-01T00:00:00Z') });
      expect(await client.search({ gmraw: domains }, { uid: true })).toEqual([3, 8]);
      const [phrases] = compileGmail({ phrases: ['digest'], excludeFrom: ['news@news.example'] });
      expect(await client.search({ gmraw: phrases }, { uid: true })).toEqual([]);
      const [either] = compileGmail({ phrases: ['digest', 'Acme'] });
      expect(await client.search({ gmraw: either }, { uid: true })).toEqual([3, 5]);
    } finally {
      lock.release();
    }
    expect(fake.commands.some((c) => c.includes('X-GM-RAW'))).toBe(true);
  });

  it('does not advertise X-GM-EXT-1 by default', async () => {
    const { client } = await connect();
    expect(client.capabilities.has('X-GM-EXT-1')).toBe(false);
  });

  it('fetches envelope, flags, uid and source without marking messages seen', async () => {
    const { client, fake } = await connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const m = await client.fetchOne('8', { uid: true, envelope: true, flags: true, source: true, bodyStructure: true }, { uid: true });
      if (!m) throw new Error('no message');
      expect(m.uid).toBe(8);
      expect(m.envelope?.subject).toBe('Café invite');
      expect(m.envelope?.from?.[0]).toMatchObject({ name: 'André', address: 'andre@jobs.example' });
      expect(m.envelope?.messageId).toBe('<28@jobs.example>');
      expect([...(m.flags ?? [])]).toEqual(['\\Flagged']);
      expect(m.source?.toString()).toBe(folders()[0]?.messages[2]?.raw);
    } finally {
      lock.release();
    }
    
    expect(fake.commands.join('\n')).toContain('BODY.PEEK[]');
    const messages = [];
    for await (const msg of client.fetch('1:*', { uid: true }, { uid: true })) messages.push(msg.uid);
    expect(messages).toEqual([3, 5, 8]);
  });

  it('passes encoded words through the envelope as written in the message', async () => {
    fake = await startFakeImap({ folders: folders(), auth });
    const answer = await rawSession(fake.port, [
      `a1 LOGIN "${auth.user}" "${auth.password}"`,
      'a2 EXAMINE INBOX',
      'a3 UID FETCH 8 (UID ENVELOPE)',
    ]);
    expect(answer).toContain('"=?UTF-8?B?Q2Fmw6kgaW52aXRl?="');
    expect(answer).toContain('"=?UTF-8?Q?Andr=C3=A9?="');
    expect(answer).toContain('"andre" "jobs.example"');
  });

  it('fetches header fields and partial bodies', async () => {
    fake = await startFakeImap({ folders: folders(), auth });
    const answer = await rawSession(fake.port, [
      `a1 LOGIN "${auth.user}" "${auth.password}"`,
      'a2 EXAMINE INBOX',
      'a3 UID FETCH 3 (BODY.PEEK[HEADER.FIELDS (Message-ID Date)])',
      'a4 UID FETCH 3 (BODY.PEEK[]<0.10>)',
    ]);
    expect(answer).toContain('BODY[HEADER.FIELDS (Message-ID Date)] {');
    expect(answer).toContain('Message-ID: <24@jobs.example>');
    expect(answer).not.toMatch(/HEADER\.FIELDS[^]*Subject:/);
    expect(answer).toContain('BODY[]<0> {10}\r\nFrom: Ana ');
  });

  it('adds \\Seen on a non-PEEK BODY[] fetch, as a real server does', async () => {
    fake = await startFakeImap({ folders: folders(), auth });
    const answer = await rawSession(fake.port, [
      `a1 LOGIN "${auth.user}" "${auth.password}"`,
      'a2 EXAMINE INBOX',
      'a3 UID FETCH 3 (FLAGS)',
      'a4 UID FETCH 3 (BODY[])',
      'a5 UID FETCH 3 (FLAGS)',
    ]);
    const flagReplies = [...answer.matchAll(/FLAGS \(([^)]*)\)\)/g)].map((m) => m[1]);
    expect(flagReplies.length).toBeGreaterThanOrEqual(2);
    expect(flagReplies[0]).toBe('');
    expect(flagReplies[flagReplies.length - 1]).toBe('\\Seen');
  });

  it('answers NOOP and LOGOUT', async () => {
    fake = await startFakeImap({ folders: folders(), auth });
    const answer = await rawSession(fake.port, [`a1 LOGIN "${auth.user}" "${auth.password}"`, 'a2 NOOP', 'a3 LOGOUT']);
    expect(answer).toContain('a2 OK');
    expect(answer).toContain('* BYE');
    expect(answer).toContain('a3 OK');
  });

  it('refuses commands before login and unknown commands cleanly', async () => {
    fake = await startFakeImap({ folders: folders(), auth });
    const answer = await rawSession(fake.port, ['a1 EXAMINE INBOX', `a2 LOGIN "${auth.user}" "${auth.password}"`, 'a3 FROBNICATE']);
    expect(answer).toMatch(/a1 (NO|BAD)/);
    expect(answer).toContain('a3 BAD');
  });
});
