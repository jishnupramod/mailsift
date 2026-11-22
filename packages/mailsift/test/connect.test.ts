import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, connect, htmlToText, type Auth, type Mailbox, type MessageRef } from '../src/index.js';
import { openMailbox, resolveFolders, type Target } from '../src/connect.js';
import { startFakeImap, type FakeFolder, type FakeImap, type FakeImapOptions, type FakeMessage } from './fakeImap.js';

const USER = 'me@mail.example';
const PASSWORD = 'app-pass-9f8e7d';
const password: Auth = { kind: 'password', user: USER, password: PASSWORD };

type MailOpts = {
  from: string;
  subject: string;
  date?: string;
  messageId?: string | null;
  headers?: string[];
  contentType?: string;
  body?: string;
};

function mail(o: MailOpts): string {
  const head = [
    `From: ${o.from}`,
    `To: ${USER}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date ?? 'Tue, 03 Nov 2026 10:00:00 +0000'}`,
    ...(o.messageId === null ? [] : [`Message-ID: ${o.messageId ?? `<${Math.random().toString(36).slice(2)}@mail.example>`}`]),
    ...(o.headers ?? []),
    `Content-Type: ${o.contentType ?? 'text/plain; charset=utf-8'}`,
  ];
  return `${head.join('\r\n')}\r\n\r\n${o.body ?? 'Hello.'}\r\n`;
}

const at = (iso: string) => new Date(iso);

let fake: FakeImap | undefined;
let mailbox: Mailbox | undefined;

afterEach(async () => {
  await mailbox?.close();
  mailbox = undefined;
  await fake?.close();
  fake = undefined;
});

async function serve(folders: FakeFolder[], extra: Partial<FakeImapOptions> = {}): Promise<FakeImap> {
  fake = await startFakeImap({ folders, auth: { user: USER, password: PASSWORD, token: 'good-token' }, ...extra });
  return fake;
}

/** A preset's dialect and folders, pointed at the fake server. */
function target(provider: 'gmail' | 'yahoo' | 'custom', port: number): Target {
  const p = PROVIDERS[provider];
  return { host: '127.0.0.1', port, secure: false, dialect: p.dialect, folders: p.folders };
}

async function open(provider: 'gmail' | 'yahoo' | 'custom', f: FakeImap, auth: Auth = password): Promise<Mailbox> {
  mailbox = await openMailbox(target(provider, f.port), auth, 5_000);
  return mailbox;
}

async function openCustom(f: FakeImap, auth: Auth = password): Promise<Mailbox> {
  mailbox = await connect({ provider: 'custom', host: '127.0.0.1', port: f.port, secure: false, auth, timeoutMs: 5_000 });
  return mailbox;
}

const gmailFolders = (allMail: FakeMessage[], spam: FakeMessage[] = []): FakeFolder[] => [
  { path: 'INBOX', uidValidity: 1, messages: [] },
  { path: '[Gmail]/All Mail', specialUse: '\\All', uidValidity: 777, messages: allMail },
  { path: '[Gmail]/Spam', specialUse: '\\Junk', uidValidity: 888, messages: spam },
  { path: '[Gmail]/Sent Mail', specialUse: '\\Sent', uidValidity: 999, messages: [] },
];

describe('connect: Gmail-style', () => {
  it('searches All Mail and Spam with X-GM-RAW and returns refs newest first', async () => {
    const f = await serve(
      gmailFolders(
        [
          { uid: 1, raw: mail({ from: 'Ana <ana@acme.example>', subject: 'Interview' }), date: at('2026-10-01T09:00:00Z') },
          { uid: 2, raw: mail({ from: 'News <news@other.example>', subject: 'Digest' }), date: at('2026-10-05T09:00:00Z') },
          { uid: 3, raw: mail({ from: 'Bo <bo@acme.example>', subject: 'Offer' }), date: at('2026-10-03T09:00:00Z') },
        ],
        [{ uid: 9, raw: mail({ from: 'HR <hr@acme.example>', subject: 'Next steps' }), date: at('2026-10-04T09:00:00Z') }],
      ),
      { gmail: true },
    );
    const mb = await open('gmail', f);

    const refs = await mb.search({ fromDomains: ['acme.example'] });

    expect(f.commands.some((c) => /UID SEARCH .*X-GM-RAW/.test(c))).toBe(true);
    expect(refs.map((r) => [r.folder, r.uid])).toEqual([
      ['[Gmail]/Spam', 9],
      ['[Gmail]/All Mail', 3],
      ['[Gmail]/All Mail', 1],
    ]);
    expect(refs[0]).toMatchObject({
      uidValidity: '888',
      subject: 'Next steps',
      from: { name: 'HR', address: 'hr@acme.example' },
      date: at('2026-10-04T09:00:00Z'),
    });
  });

  it('gives one ref for the same Message-ID in two folders', async () => {
    const raw = mail({ from: 'Ana <ana@acme.example>', subject: 'Interview', messageId: '<same-1@acme.example>' });
    const f = await serve(
      gmailFolders([{ uid: 4, raw, date: at('2026-10-01T09:00:00Z') }], [{ uid: 2, raw, date: at('2026-10-01T09:00:00Z') }]),
      { gmail: true },
    );
    const mb = await open('gmail', f);

    const refs = await mb.search({ fromDomains: ['acme.example'] });

    expect(refs).toHaveLength(1);
    expect(refs[0]?.key).toBe('<same-1@acme.example>');
  });

  it('keys a message without Message-ID by folder, uidValidity and uid', async () => {
    const f = await serve(
      gmailFolders([
        { uid: 3, raw: mail({ from: 'Ana <ana@acme.example>', subject: 'No id', messageId: null }), date: at('2026-10-01T09:00:00Z') },
      ]),
      { gmail: true },
    );
    const mb = await open('gmail', f);

    const refs = await mb.search({ fromDomains: ['acme.example'] });

    expect(refs.map((r) => r.key)).toEqual(['[Gmail]/All Mail:777:3']);
  });

  it('lists folders with their special-use flag', async () => {
    const f = await serve(gmailFolders([]), { gmail: true });
    const mb = await open('gmail', f);

    const folders = await mb.folders();

    expect(folders).toContainEqual({ path: '[Gmail]/All Mail', specialUse: '\\All' });
    expect(folders).toContainEqual({ path: '[Gmail]/Spam', specialUse: '\\Junk' });
  });

  it('raises FOLDER_MISSING when no preset folder resolves', async () => {
    const f = await serve([{ path: 'INBOX', uidValidity: 1, messages: [] }], { gmail: true });
    const mb = await open('gmail', f);

    await expect(mb.search({ fromDomains: ['acme.example'] })).rejects.toMatchObject({ code: 'FOLDER_MISSING' });
  });
});

describe('connect: Yahoo-style folders', () => {
  const hit = (uid: number, day: string) => ({
    uid,
    raw: mail({ from: 'Ana <ana@acme.example>', subject: `Hit ${uid}` }),
    date: at(`2026-10-${day}T09:00:00Z`),
  });

  it('searches a Bulk folder that has no special-use flag, and never Sent', async () => {
    const f = await serve([
      { path: 'INBOX', uidValidity: 1, messages: [hit(1, '01')] },
      { path: 'Archive', specialUse: '\\Archive', uidValidity: 2, messages: [hit(1, '02')] },
      { path: 'Bulk', uidValidity: 3, messages: [hit(1, '03')] },
      { path: 'Sent', specialUse: '\\Sent', uidValidity: 4, messages: [hit(1, '04')] },
    ]);
    const mb = await open('yahoo', f);

    const refs = await mb.search({ fromDomains: ['acme.example'] });

    expect(refs.map((r) => r.folder)).toEqual(['Bulk', 'Archive', 'INBOX']);
  });

  it('still searches Inbox and Archive when there is no junk folder', async () => {
    const f = await serve([
      { path: 'INBOX', uidValidity: 1, messages: [hit(1, '01')] },
      { path: 'Archive', specialUse: '\\Archive', uidValidity: 2, messages: [hit(1, '02')] },
    ]);
    const mb = await open('yahoo', f);

    const refs = await mb.search({ fromDomains: ['acme.example'] });

    expect(refs.map((r) => r.folder)).toEqual(['Archive', 'INBOX']);
  });
});

describe('resolveFolders', () => {
  const listed = [
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: 'Old Junk', specialUse: null },
    { path: 'Spam Box', specialUse: '\\Junk' },
    { path: 'bulk mail', specialUse: null },
  ];

  it('prefers the special-use flag, then name fallbacks case-insensitively, and skips the rest', () => {
    expect(
      resolveFolders(listed, [
        { specialUse: '\\Inbox', names: ['INBOX'] },
        { specialUse: '\\Junk', names: ['Old Junk'] },
        { specialUse: '\\Archive', names: ['Bulk Mail'] },
        { specialUse: '\\All', names: ['Nowhere'] },
      ]),
    ).toEqual(['INBOX', 'Spam Box', 'bulk mail']);
  });

  it('resolves named folders and drops duplicates', () => {
    expect(
      resolveFolders(listed, [
        { specialUse: null, names: ['inbox'] },
        { specialUse: '\\Inbox', names: [] },
        { specialUse: null, names: ['Missing'] },
      ]),
    ).toEqual(['INBOX']);
  });
});

describe('connect: read-only', () => {
  it('only EXAMINEs, only peeks at bodies, sends no write commands and marks nothing seen', async () => {
    const messages: FakeMessage[] = [
      { uid: 1, raw: mail({ from: 'Ana <ana@acme.example>', subject: 'One' }), date: at('2026-10-01T09:00:00Z') },
      { uid: 2, raw: mail({ from: 'Bo <bo@acme.example>', subject: 'Two' }), date: at('2026-10-02T09:00:00Z') },
    ];
    const archive: FakeMessage[] = [{ uid: 5, raw: mail({ from: 'Cy <cy@acme.example>', subject: 'Three' }), date: at('2026-10-03T09:00:00Z') }];
    const f = await serve([
      { path: 'INBOX', uidValidity: 1, messages },
      { path: 'Junk', specialUse: '\\Junk', uidValidity: 2, messages: archive },
    ]);
    const mb = await openCustom(f);

    const refs = await mb.search({ fromDomains: ['acme.example'] });
    for (const ref of refs) await mb.fetch(ref);
    await mb.close();
    mailbox = undefined;

    expect(refs).toHaveLength(3);
    const opens = f.commands.filter((c) => /^\S+ (EXAMINE|SELECT)\b/i.test(c));
    expect(opens.length).toBeGreaterThan(0);
    expect(opens.every((c) => /^\S+ EXAMINE /.test(c))).toBe(true);
    const bodyFetches = f.commands.filter((c) => /BODY(\.PEEK)?\[/i.test(c));
    expect(bodyFetches).toHaveLength(3);
    expect(bodyFetches.every((c) => /BODY\.PEEK\[/.test(c))).toBe(true);
    expect(f.commands.filter((c) => /^\S+ (UID )?(STORE|COPY|MOVE|EXPUNGE|APPEND|SELECT)\b/i.test(c))).toEqual([]);
    expect([...messages, ...archive].flatMap((m) => m.flags ?? [])).not.toContain('\\Seen');
  });

  it('fetches only envelopes for thousands of hits, cuts at limit and sorts newest first', async () => {
    const base = Date.UTC(2026, 0, 1);
    const messages = Array.from({ length: 3000 }, (_, i) => {
      const uid = i + 1;
      // dates do not follow uids, so the order has to come from sorting
      const date = new Date(base + ((uid * 7919) % 3000) * 60_000);
      return { uid, raw: mail({ from: `Ana <ana${uid}@acme.example>`, subject: `Hit ${uid}` }), date };
    });
    const f = await serve([{ path: 'INBOX', uidValidity: 1, messages }]);
    const mb = await openCustom(f);

    const refs = await mb.search({ fromDomains: ['acme.example'] }, { limit: 50 });

    const expected = [...messages].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 50).map((m) => m.uid);
    expect(refs.map((r) => r.uid)).toEqual(expected);
    expect(f.commands.some((c) => /BODY/i.test(c))).toBe(false);
    const envelopeFetches = f.commands.filter((c) => /UID FETCH/.test(c));
    expect(envelopeFetches).toHaveLength(6);
    expect(envelopeFetches.every((c) => / \(UID ENVELOPE INTERNALDATE\)$/.test(c))).toBe(true);
  });

  it('matches nothing and sends no search for a query without domains or phrases', async () => {
    const f = await serve([
      { path: 'INBOX', uidValidity: 1, messages: [{ uid: 1, raw: mail({ from: 'a@acme.example', subject: 'x' }), date: at('2026-10-01T09:00:00Z') }] },
    ]);
    const mb = await openCustom(f);

    expect(await mb.search({ since: at('2026-01-01T00:00:00Z') })).toEqual([]);
    expect(f.commands.some((c) => /SEARCH|EXAMINE/.test(c))).toBe(false);
  });

  it('defaults the limit to 200', async () => {
    const messages = Array.from({ length: 250 }, (_, i) => ({
      uid: i + 1,
      raw: mail({ from: 'Ana <ana@acme.example>', subject: `Hit ${i}` }),
      date: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
    }));
    const f = await serve([{ path: 'INBOX', uidValidity: 1, messages }]);
    const mb = await openCustom(f);

    expect(await mb.search({ fromDomains: ['acme.example'] })).toHaveLength(200);
  });
});

describe('connect: local checks', () => {
  it('drops lookalike domains and excluded senders that the IMAP search matched as substrings', async () => {
    const day = at('2026-10-01T09:00:00Z');
    const f = await serve([
      {
        path: 'INBOX',
        uidValidity: 1,
        messages: [
          { uid: 1, raw: mail({ from: 'Ana <ana@acme.example>', subject: 'Real' }), date: day },
          { uid: 2, raw: mail({ from: 'Eve <eve@acme.example.evil.example>', subject: 'Lookalike' }), date: day },
          { uid: 3, raw: mail({ from: 'Me <me@acme.example>', subject: 'Mine' }), date: day },
        ],
      },
    ]);
    const mb = await openCustom(f);

    const refs = await mb.search({ fromDomains: ['acme.example'], excludeFrom: ['me@acme.example'] });

    expect(refs.map((r) => r.subject)).toEqual(['Real']);
  });
});

describe('connect: non-ASCII', () => {
  it('decodes an RFC 2047 subject and a UTF-8 display name in the ref and in fetch', async () => {
    const subject = 'Zürich Labs: your application';
    const encoded = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const raw = mail({ from: '"Zürich Labs" <jobs@zurich-labs.example>', subject: encoded });
    const f = await serve([{ path: 'INBOX', uidValidity: 1, messages: [{ uid: 1, raw, date: at('2026-10-01T09:00:00Z') }] }]);
    const mb = await openCustom(f);

    const refs = await mb.search({ phrases: ['Zürich Labs'] });

    expect(f.commands.some((c) => /UID SEARCH CHARSET UTF-8/.test(c))).toBe(true);
    expect(refs).toHaveLength(1);
    const ref = refs[0] as MessageRef;
    expect(ref.subject).toBe(subject);
    expect(ref.from).toEqual({ name: 'Zürich Labs', address: 'jobs@zurich-labs.example' });
    const msg = await mb.fetch(ref);
    expect(msg.subject).toBe(subject);
    expect(msg.from).toEqual({ name: 'Zürich Labs', address: 'jobs@zurich-labs.example' });
  });
});

describe('connect: fetch', () => {
  async function fetchOnly(raw: string, opts?: { maxChars?: number }) {
    const f = await serve([{ path: 'INBOX', uidValidity: 42, messages: [{ uid: 7, raw, date: at('2026-10-01T09:00:00Z') }] }]);
    const mb = await openCustom(f);
    const [ref] = await mb.search({ fromDomains: ['acme.example'] });
    if (!ref) throw new Error('expected a hit');
    return mb.fetch(ref, opts);
  }

  it('turns an HTML-only message into text without tags', async () => {
    const html =
      '<html><head><style>p { color: red }</style><script>alert("x")</script></head>' +
      '<body><p>Hello <b>Ada</b> &amp; team</p><div>Second line</div></body></html>';
    const msg = await fetchOnly(mail({ from: 'Ana <ana@acme.example>', subject: 'Html', contentType: 'text/html; charset=utf-8', body: html }));

    expect(msg.text).toContain('Hello Ada & team');
    expect(msg.text).toMatch(/Hello Ada & team\s*\n\s*Second line/);
    expect(msg.text).not.toMatch(/[<>]/);
    expect(msg.text).not.toContain('alert');
    expect(msg.text).not.toContain('color');
  });

  it('caps the text at 100 000 characters, or at maxChars', async () => {
    const raw = mail({ from: 'Ana <ana@acme.example>', subject: 'Long', body: 'a'.repeat(150_000) });
    expect((await fetchOnly(raw)).text).toHaveLength(100_000);
    await mailbox?.close();
    await fake?.close();
    expect((await fetchOnly(raw, { maxChars: 10 })).text).toBe('aaaaaaaaaa');
  });

  it('keeps only allowlisted headers and returns the ref fields', async () => {
    const raw = mail({
      from: 'Ana <ana@acme.example>',
      subject: 'Headers',
      messageId: '<h-1@acme.example>',
      headers: [
        'Cc: Bo <bo@acme.example>',
        'Reply-To: jobs@acme.example',
        'List-Id: Jobs <jobs.acme.example>',
        'Received: from mx.acme.example by mx.mail.example',
        'X-Secret-Token: do-not-copy',
        'DKIM-Signature: v=1; a=rsa-sha256; d=acme.example',
      ],
    });
    const msg = await fetchOnly(raw);

    expect(Object.keys(msg.headers).sort()).toEqual(['Cc', 'Date', 'From', 'List-Id', 'Message-ID', 'Reply-To', 'To']);
    expect(msg.headers['Message-ID']).toBe('<h-1@acme.example>');
    expect(msg.headers['From']).toBe('"Ana" <ana@acme.example>');
    expect(msg.headers['List-Id']).toBe('Jobs <jobs.acme.example>');
    expect(msg).toMatchObject({
      folder: 'INBOX',
      uid: 7,
      uidValidity: '42',
      key: '<h-1@acme.example>',
      subject: 'Headers',
      to: [{ name: null, address: USER }],
      cc: [{ name: 'Bo', address: 'bo@acme.example' }],
      sizeBytes: Buffer.byteLength(raw),
    });
  });

  it('joins a repeated address header', async () => {
    const raw = mail({ from: 'Ana <ana@acme.example>', subject: 'Two Cc lines', headers: ['Cc: bo@acme.example', 'Cc: cy@acme.example'] });
    const msg = await fetchOnly(raw);

    expect(msg.headers['Cc']).toBe('bo@acme.example, cy@acme.example');
    expect(msg.cc.map((a) => a.address)).toEqual(['bo@acme.example', 'cy@acme.example']);
  });

  it('reports attachments as metadata only', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake resume content').toString('base64');
    const body = [
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'See attached.',
      '--b1',
      'Content-Type: application/pdf; name="resume.pdf"',
      'Content-Disposition: attachment; filename="resume.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf,
      '--b1--',
    ].join('\r\n');
    const msg = await fetchOnly(
      mail({ from: 'Ana <ana@acme.example>', subject: 'Attachment', contentType: 'multipart/mixed; boundary="b1"', body }),
    );

    expect(msg.text.trim()).toBe('See attached.');
    expect(msg.attachments).toEqual([{ filename: 'resume.pdf', contentType: 'application/pdf', size: 28 }]);
    expect(JSON.stringify(msg)).not.toContain(pdf);
  });

  it('raises FOLDER_MISSING when the uidValidity changed or the folder is gone', async () => {
    const f = await serve([
      { path: 'INBOX', uidValidity: 42, messages: [{ uid: 7, raw: mail({ from: 'a@acme.example', subject: 'x' }), date: at('2026-10-01T09:00:00Z') }] },
    ]);
    const mb = await openCustom(f);
    const ref: MessageRef = { folder: 'INBOX', uid: 7, uidValidity: '41', key: 'k', date: null, from: null, subject: '' };

    await expect(mb.fetch(ref)).rejects.toMatchObject({ code: 'FOLDER_MISSING' });
    await expect(mb.fetch({ ...ref, folder: 'Gone', uidValidity: '42' })).rejects.toMatchObject({ code: 'FOLDER_MISSING' });
  });
});

describe('connect: auth', () => {
  const folders = (): FakeFolder[] => [{ path: 'INBOX', uidValidity: 1, messages: [] }];

  it('raises AUTH_FAILED for a wrong password without carrying it', async () => {
    const f = await serve(folders());
    const wrong = 'wrong-pass-5c4b3a';

    const err = await openCustom(f, { kind: 'password', user: USER, password: wrong }).catch((e: unknown) => e);

    expect(err).toMatchObject({ name: 'MailsiftError', code: 'AUTH_FAILED' });
    const e = err as Error;
    expect(e.message).not.toContain(wrong);
    expect(String(e.cause ?? '')).not.toContain(wrong);
    expect(e.cause).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain(wrong);
  });

  it('raises APP_PASSWORD_REQUIRED when the server asks for an app password', async () => {
    const f = await serve(folders(), { failAuthWith: 'Application-specific password required' });

    await expect(openCustom(f)).rejects.toMatchObject({ code: 'APP_PASSWORD_REQUIRED' });
  });

  it('signs in with a Microsoft token over XOAUTH2, asking for it once per connect', async () => {
    const f = await serve(folders());
    const accessToken = vi.fn(async () => 'good-token');

    const mb = await openCustom(f, { kind: 'microsoft', user: USER, accessToken });

    expect(accessToken).toHaveBeenCalledTimes(1);
    expect(f.commands.some((c) => /AUTHENTICATE XOAUTH2/.test(c))).toBe(true);
    expect(await mb.folders()).toContainEqual({ path: 'INBOX', specialUse: '\\Inbox' });
  });

  it('raises TOKEN_EXPIRED when the server rejects a Microsoft token', async () => {
    const f = await serve(folders());
    const accessToken = vi.fn(async () => 'stale-token');

    await expect(openCustom(f, { kind: 'microsoft', user: USER, accessToken })).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(accessToken).toHaveBeenCalledTimes(1);
  });
});

describe('connect: connection', () => {
  it('refuses secure: false for a non-local host without connecting', async () => {
    await expect(
      connect({ provider: 'custom', host: 'mail.example.com', port: 143, secure: false, auth: password }),
    ).rejects.toMatchObject({ code: 'TLS_FAILED' });
  });

  it('raises TIMEOUT when the server never greets', async () => {
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((s) => sockets.add(s));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as net.AddressInfo;
    try {
      await expect(
        connect({ provider: 'custom', host: '127.0.0.1', port, secure: false, auth: password, timeoutMs: 200 }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it('raises CONNECTION_FAILED when nothing listens', async () => {
    const f = await serve([]);
    const { port } = f;
    await f.close();
    fake = undefined;

    await expect(connect({ provider: 'custom', host: '127.0.0.1', port, secure: false, auth: password })).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
  });

  it('close never throws, even twice or after the server went away', async () => {
    const f = await serve([{ path: 'INBOX', uidValidity: 1, messages: [] }]);
    const mb = await openCustom(f);
    await f.close();
    fake = undefined;

    await expect(mb.close()).resolves.toBeUndefined();
    await expect(mb.close()).resolves.toBeUndefined();
  });
});

describe('htmlToText', () => {
  it('drops script and style, turns block tags into newlines and decodes entities', () => {
    const text = htmlToText(
      '<style>.a{}</style><script>var x = "<p>";</script><h1>Title</h1><p>One&nbsp;&lt;two&gt;</p><ul><li>A</li><li>B</li></ul>Tail<br>End &#233;&#x41;',
    );
    expect(text).toBe('Title\n\nOne <two>\n\nA\n\nB\n\nTail\nEnd éA');
  });
});
