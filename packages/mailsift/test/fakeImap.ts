/**
 * An in-process IMAP4rev1 server for tests. It speaks enough of the protocol
 * for imapflow's real client code paths (connect, authenticate, list, examine,
 * search, fetch) and nothing more. It listens on 127.0.0.1 without TLS.
 *
 * Simplifications, all deliberate:
 * - BODYSTRUCTURE is always a single `text/plain` part.
 * - BODY search matches the raw body text; transfer encodings are not decoded.
 * - A non-PEEK `BODY[...]` fetch always adds `\Seen`, even after EXAMINE, so a
 *   test notices when a reader forgets `BODY.PEEK`. The flag is written to the
 *   `flags` array of the message object passed in.
 * - Nothing writes: STORE, COPY, APPEND, EXPUNGE and friends are refused.
 */
import net from 'node:net';

export type FakeMessage = { uid: number; raw: string; date: Date; flags?: string[] };

export type FakeFolder = {
  path: string;
  specialUse?: string;
  uidValidity: number;
  messages: FakeMessage[];
};

export type FakeImapOptions = {
  folders: FakeFolder[];
  auth: { user: string; password?: string; token?: string };
  /** Advertise X-GM-EXT-1 and answer X-GM-RAW searches. */
  gmail?: boolean;
  /** Refuse every login with `NO [AUTHENTICATIONFAILED] <this text>`. */
  failAuthWith?: string;
};

export type FakeImap = {
  port: number;
  /** Every command line received, with credentials replaced by `***`. */
  commands: string[];
  close(): Promise<void>;
};

type Tok = string | Tok[];
type Pred = (m: FakeMessage) => boolean;

class BadCommand extends Error {}

const DELIMITER = '/';
const SYSTEM_FLAGS = ['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------- tokenizer

/** Splits a command's arguments into atoms, quoted strings (unescaped) and nested lists. */
function tokenize(input: string): Tok[] {
  let i = 0;
  const readList = (): Tok[] => {
    const items: Tok[] = [];
    for (;;) {
      while (input[i] === ' ') i++;
      if (i >= input.length) throw new BadCommand('Unbalanced parentheses');
      if (input[i] === ')') {
        i++;
        return items;
      }
      items.push(readOne());
    }
  };
  const readOne = (): Tok => {
    const c = input[i];
    if (c === '(') {
      i++;
      return readList();
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\') i++;
        s += input[i] ?? '';
        i++;
      }
      if (input[i] !== '"') throw new BadCommand('Unterminated string');
      i++;
      return s;
    }
    let s = '';
    while (i < input.length && !/[\s()]/.test(input[i] ?? '')) {
      if (input[i] === '[') {
        // a section such as [HEADER.FIELDS (A B)] belongs to the atom, spaces and all
        while (i < input.length && input[i] !== ']') s += input[i++];
      }
      s += input[i] ?? '';
      i++;
    }
    return s;
  };
  const out: Tok[] = [];
  for (;;) {
    while (input[i] === ' ') i++;
    if (i >= input.length) return out;
    out.push(readOne());
  }
}

const text = (t: Tok | undefined): string => {
  if (typeof t !== 'string') throw new BadCommand('Missing or malformed argument');
  return t;
};

const quote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;

// ------------------------------------------------------------ message parts

function splitMessage(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/** The header block as logical fields, each with its folded lines joined by CRLF. */
function headerFields(raw: string): { name: string; text: string; value: string }[] {
  const { head } = splitMessage(raw);
  const fields: { name: string; text: string; value: string }[] = [];
  for (const line of head.split(/\r?\n/)) {
    const last = fields[fields.length - 1];
    if (/^[ \t]/.test(line) && last) {
      last.text += `\r\n${line}`;
      last.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields.push({ name: line.slice(0, colon).trim().toLowerCase(), text: line, value: line.slice(colon + 1).trim() });
  }
  return fields;
}

const headerValue = (raw: string, name: string): string | undefined =>
  headerFields(raw).find((f) => f.name === name.toLowerCase())?.value;

/** Decodes RFC 2047 encoded words; text that does not decode is left alone. */
function decodeWords(s: string): string {
  return s
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes =
          enc.toLowerCase() === 'b'
            ? Buffer.from(data, 'base64')
            : Buffer.from(
                data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
                'latin1',
              );
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return whole;
      }
    });
}

/** Every spelling of a header's value that a search should be able to match. */
function headerHaystack(raw: string, name: string): string[] {
  return headerFields(raw)
    .filter((f) => f.name === name.toLowerCase())
    .flatMap((f) => [f.value, decodeWords(f.value)]);
}

const contains = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
const anyContains = (hays: string[], needle: string) => hays.some((h) => contains(h, needle));

// --------------------------------------------------------------- envelope

type Address = { name: string | null; mailbox: string; host: string };

function parseAddresses(value: string | undefined): Address[] {
  if (!value) return [];
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === '<' || ch === '(')) depth++;
    if (!quoted && (ch === '>' || ch === ')')) depth--;
    if (ch === ',' && !quoted && depth <= 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  const out: Address[] = [];
  for (const part of parts) {
    const withName = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(part);
    const name = withName ? (withName[1] ?? '').replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1') : '';
    const addr = (withName ? (withName[2] ?? '') : part.replace(/\([^)]*\)/g, '')).trim();
    if (!addr) continue;
    const at = addr.lastIndexOf('@');
    out.push({
      name: name === '' ? null : name,
      mailbox: at < 0 ? addr : addr.slice(0, at),
      host: at < 0 ? '' : addr.slice(at + 1),
    });
  }
  return out;
}

/** An IMAP string: NIL, a quoted string, or a literal when the text needs one. */
function imapString(s: string | null | undefined): string {
  if (s === null || s === undefined) return 'NIL';
  return /^[\x20-\x7e]*$/.test(s) ? quote(s) : `{${Buffer.byteLength(s)}}\r\n${s}`;
}

function envelope(raw: string): string {
  const list = (name: string, fallback?: Address[]) => {
    const addrs = parseAddresses(headerValue(raw, name));
    const use = addrs.length > 0 ? addrs : (fallback ?? []);
    if (use.length === 0) return 'NIL';
    return `(${use.map((a) => `(${imapString(a.name)} NIL ${imapString(a.mailbox)} ${imapString(a.host)})`).join('')})`;
  };
  const from = parseAddresses(headerValue(raw, 'from'));
  return [
    '(',
    [
      imapString(headerValue(raw, 'date')),
      imapString(headerValue(raw, 'subject')),
      list('from'),
      list('sender', from),
      list('reply-to', from),
      list('to'),
      list('cc'),
      list('bcc'),
      imapString(headerValue(raw, 'in-reply-to')),
      imapString(headerValue(raw, 'message-id')),
    ].join(' '),
    ')',
  ].join('');
}

function bodyStructure(raw: string): string {
  const { body } = splitMessage(raw);
  const lines = body === '' ? 0 : body.split(/\r?\n/).length - (/\n$/.test(body) ? 1 : 0);
  return `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${Buffer.byteLength(body)} ${lines})`;
}

// ------------------------------------------------------------- body section

function section(raw: string, spec: string): Buffer {
  const { head, body } = splitMessage(raw);
  const upper = spec.toUpperCase();
  const fieldList = /^HEADER\.FIELDS(\.NOT)?\s*\(([^)]*)\)$/.exec(upper);
  if (spec === '') return Buffer.from(raw);
  if (upper === 'HEADER') return Buffer.from(`${head.replace(/\r?\n/g, '\r\n')}\r\n\r\n`);
  if (fieldList) {
    const wanted = (fieldList[2] ?? '').split(/\s+/).filter(Boolean).map((n) => n.toLowerCase());
    const keep = headerFields(raw).filter((f) => wanted.includes(f.name) !== Boolean(fieldList[1]));
    return Buffer.from(`${keep.map((f) => f.text).join('\r\n')}${keep.length > 0 ? '\r\n' : ''}\r\n`);
  }
  if (upper === 'TEXT' || upper === '1') return Buffer.from(body);
  return Buffer.alloc(0);
}

// ----------------------------------------------------------- sequence sets

function inSet(set: string, n: number, max: number): boolean {
  if (!/^[\d*:,]+$/.test(set)) throw new BadCommand('Invalid sequence set');
  const num = (x: string) => (x === '*' ? max : Number(x));
  return set.split(',').some((part) => {
    const [a, b] = part.split(':');
    const lo = num(a ?? '');
    const hi = b === undefined ? lo : num(b);
    return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
  });
}

function imapDate(s: string): number {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
  const month = MONTHS.findIndex((x) => x.toLowerCase() === (m?.[2] ?? '').toLowerCase());
  if (!m || month < 0) throw new BadCommand('Invalid date');
  return Date.UTC(Number(m[3]), month, Number(m[1]));
}

const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

// ------------------------------------------------------------------ search

type SearchEnv = { gmail: boolean; folder: FakeFolder; ordered: FakeMessage[] };

class Cursor {
  i = 0;
  constructor(readonly toks: Tok[]) {}
  more() {
    return this.i < this.toks.length;
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (t === undefined) throw new BadCommand('Missing search argument');
    return t;
  }
}

function parseKeys(c: Cursor, env: SearchEnv): Pred {
  const preds: Pred[] = [];
  while (c.more()) preds.push(parseKey(c, env));
  return (m) => preds.every((p) => p(m));
}

function parseKey(c: Cursor, env: SearchEnv): Pred {
  const t = c.next();
  if (Array.isArray(t)) return parseKeys(new Cursor(t), env);
  const key = t.toUpperCase();
  const flag = (name: string, want: boolean): Pred => (m) => (m.flags ?? []).some((f) => f.toLowerCase() === name.toLowerCase()) === want;
  const max = env.ordered.reduce((a, m) => Math.max(a, m.uid), 0);
  switch (key) {
    case 'ALL':
      return () => true;
    case 'ANSWERED': case 'DELETED': case 'DRAFT': case 'FLAGGED': case 'SEEN':
      return flag(`\\${key}`, true);
    case 'UNANSWERED': case 'UNDELETED': case 'UNDRAFT': case 'UNFLAGGED': case 'UNSEEN':
      return flag(`\\${key.slice(2)}`, false);
    case 'KEYWORD':
      return flag(text(c.next()), true);
    case 'UNKEYWORD':
      return flag(text(c.next()), false);
    case 'SINCE': {
      const d = imapDate(text(c.next()));
      return (m) => dayStart(m.date) >= d;
    }
    case 'BEFORE': {
      const d = imapDate(text(c.next()));
      return (m) => dayStart(m.date) < d;
    }
    case 'ON': {
      const d = imapDate(text(c.next()));
      return (m) => dayStart(m.date) === d;
    }
    case 'SENTSINCE': case 'SENTBEFORE': case 'SENTON': {
      const d = imapDate(text(c.next()));
      return (m) => {
        const sent = Date.parse(headerValue(m.raw, 'date') ?? '');
        if (Number.isNaN(sent)) return false;
        const day = dayStart(new Date(sent));
        return key === 'SENTSINCE' ? day >= d : key === 'SENTBEFORE' ? day < d : day === d;
      };
    }
    case 'FROM': case 'TO': case 'CC': case 'BCC': case 'SUBJECT': {
      const needle = text(c.next());
      return (m) => anyContains(headerHaystack(m.raw, key), needle);
    }
    case 'HEADER': {
      const name = text(c.next());
      const needle = text(c.next());
      return (m) => anyContains(headerHaystack(m.raw, name), needle);
    }
    case 'BODY': {
      const needle = text(c.next());
      return (m) => contains(splitMessage(m.raw).body, needle);
    }
    case 'TEXT': {
      const needle = text(c.next());
      return (m) => contains(m.raw, needle) || contains(decodeWords(m.raw), needle);
    }
    case 'LARGER': {
      const n = Number(text(c.next()));
      return (m) => Buffer.byteLength(m.raw) > n;
    }
    case 'SMALLER': {
      const n = Number(text(c.next()));
      return (m) => Buffer.byteLength(m.raw) < n;
    }
    case 'UID': {
      const set = text(c.next());
      return (m) => inSet(set, m.uid, max);
    }
    case 'NOT': {
      const p = parseKey(c, env);
      return (m) => !p(m);
    }
    case 'OR': {
      const a = parseKey(c, env);
      const b = parseKey(c, env);
      return (m) => a(m) || b(m);
    }
    case 'X-GM-RAW': {
      if (!env.gmail) throw new BadCommand('Unknown search key X-GM-RAW');
      return gmailPredicate(text(c.next()), env);
    }
    default:
      if (/^[\d*:,]+$/.test(t)) return (m) => inSet(t, env.ordered.indexOf(m) + 1, env.ordered.length);
      throw new BadCommand(`Unknown search key ${t}`);
  }
}

/** Evaluates the subset of Gmail search syntax that `compileGmail` produces. */
function gmailPredicate(q: string, env: SearchEnv): Pred {
  let i = 0;
  const ws = () => {
    while (i < q.length && /\s/.test(q[i] ?? '')) i++;
  };
  const leaf = (field: string | undefined, value: string): Pred => (m) => {
    switch (field) {
      case undefined:
        return contains(m.raw, value) || contains(decodeWords(m.raw), value);
      case 'from': case 'to': case 'cc': case 'bcc': case 'subject':
        return anyContains(headerHaystack(m.raw, field), value);
      case 'in': {
        const v = value.toLowerCase();
        if (v === 'anywhere') return true;
        if (v === 'inbox') return env.folder.path.toUpperCase() === 'INBOX';
        if (v === 'sent') return env.folder.specialUse === '\\Sent';
        if (v === 'drafts') return env.folder.specialUse === '\\Drafts' || (m.flags ?? []).includes('\\Draft');
        return false;
      }
      case 'after': case 'before': {
        if (/^\d+$/.test(value)) {
          // Unix seconds: exact and exclusive, like Gmail.
          const secs = Number(value);
          return field === 'after' ? m.date.getTime() / 1000 > secs : m.date.getTime() / 1000 < secs;
        }
        const [y, mo, d] = value.split('/').map(Number);
        if (!y || !mo || !d) throw new BadCommand('Invalid date in X-GM-RAW');
        const at = Date.UTC(y, mo - 1, d);
        return field === 'after' ? dayStart(m.date) >= at : dayStart(m.date) < at;
      }
      default:
        return false;
    }
  };
  const readWord = () => {
    const start = i;
    while (i < q.length && !/[\s()]/.test(q[i] ?? '')) i++;
    return q.slice(start, i);
  };
  const readQuoted = () => {
    i++;
    const start = i;
    while (i < q.length && q[i] !== '"') i++;
    const s = q.slice(start, i);
    i++;
    return s;
  };
  const atom = (field: string | undefined): Pred => {
    ws();
    if (q[i] === '-') {
      i++;
      const p = atom(field);
      return (m) => !p(m);
    }
    if (q[i] === '(') {
      i++;
      const p = and(field);
      ws();
      if (q[i] !== ')') throw new BadCommand('Unbalanced parentheses in X-GM-RAW');
      i++;
      return p;
    }
    if (q[i] === '"') return leaf(field, readQuoted());
    const key = /^([A-Za-z]+):/.exec(q.slice(i));
    if (key && field === undefined) {
      i += key[0].length;
      return atom(key[1]?.toLowerCase());
    }
    return leaf(field, readWord());
  };
  const or = (field: string | undefined): Pred => {
    const parts = [atom(field)];
    for (;;) {
      ws();
      if (/^OR\s/.test(q.slice(i))) {
        i += 2;
        parts.push(atom(field));
      } else break;
    }
    return (m) => parts.some((p) => p(m));
  };
  const and = (field: string | undefined): Pred => {
    const parts: Pred[] = [];
    for (;;) {
      ws();
      if (i >= q.length || q[i] === ')') break;
      parts.push(or(field));
    }
    return (m) => parts.every((p) => p(m));
  };
  const pred = and(undefined);
  if (i < q.length) throw new BadCommand('Unbalanced parentheses in X-GM-RAW');
  return pred;
}

// ------------------------------------------------------------------ server

export async function startFakeImap(opts: FakeImapOptions): Promise<FakeImap> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const capability = ['IMAP4rev1', 'AUTH=PLAIN', 'AUTH=XOAUTH2', 'SPECIAL-USE', ...(opts.gmail ? ['X-GM-EXT-1'] : [])].join(' ');
  const ordered = (f: FakeFolder) => [...f.messages].sort((a, b) => a.uid - b.uid);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    let buf = Buffer.alloc(0);
    let line = '';
    let literalLeft: number | null = null;
    let authenticated = false;
    let selected: FakeFolder | null = null;
    let pendingAuth: { tag: string; mechanism: 'PLAIN' | 'XOAUTH2'; failedOnce: boolean } | null = null;

    const send = (...chunks: (string | Buffer)[]) => {
      if (!socket.destroyed) socket.write(Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c))));
    };
    const reply = (tag: string, status: 'OK' | 'NO' | 'BAD', message: string) => send(`${tag} ${status} ${message}\r\n`);

    const failLogin = (tag: string, message?: string) =>
      reply(tag, 'NO', `[AUTHENTICATIONFAILED] ${opts.failAuthWith ?? message ?? 'Invalid credentials'}`);

    const checkSasl = (mechanism: 'PLAIN' | 'XOAUTH2', payload: string): boolean => {
      if (opts.failAuthWith !== undefined) return false;
      const decoded = Buffer.from(payload, 'base64').toString('utf8');
      if (mechanism === 'PLAIN') {
        const [, user, pass] = decoded.split('\0');
        return opts.auth.password !== undefined && user === opts.auth.user && pass === opts.auth.password;
      }
      const fields = decoded.split('\x01');
      return (
        opts.auth.token !== undefined &&
        fields[0] === `user=${opts.auth.user}` &&
        fields[1] === `auth=Bearer ${opts.auth.token}`
      );
    };

    const finishSasl = (tag: string, mechanism: 'PLAIN' | 'XOAUTH2', payload: string) => {
      if (checkSasl(mechanism, payload)) {
        authenticated = true;
        reply(tag, 'OK', `[CAPABILITY ${capability}] Authenticated`);
        return;
      }
      if (mechanism === 'XOAUTH2' && opts.failAuthWith === undefined) {
        // Like Gmail: a JSON error as a continuation, then the tagged NO after the client's empty answer.
        const challenge = Buffer.from('{"status":"401","schemes":"Bearer","scope":"https://mail.google.com/"}').toString('base64');
        pendingAuth = { tag, mechanism, failedOnce: true };
        send(`+ ${challenge}\r\n`);
        return;
      }
      failLogin(tag);
    };

    const handleContinuation = (data: string) => {
      const p = pendingAuth;
      if (!p) return;
      if (p.failedOnce) {
        pendingAuth = null;
        failLogin(p.tag);
        return;
      }
      pendingAuth = null;
      if (data === '*') return reply(p.tag, 'BAD', 'Authentication cancelled');
      finishSasl(p.tag, p.mechanism, data);
    };

    const listFolders = (reference: string, pattern: string) => {
      if (reference === '' && pattern === '') {
        send(`* LIST (\\Noselect) "${DELIMITER}" ""\r\n`);
        return;
      }
      const full = `${reference}${pattern}`;
      const re = new RegExp(
        `^${full.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, `[^${DELIMITER}]*`)}$`,
        'i',
      );
      for (const f of opts.folders) {
        if (!re.test(f.path)) continue;
        const flags = ['\\HasNoChildren', ...(f.specialUse ? [f.specialUse] : [])];
        send(`* LIST (${flags.join(' ')}) "${DELIMITER}" ${quote(f.path)}\r\n`);
      }
    };

    const open = (tag: string, name: string, readOnly: boolean) => {
      const folder = opts.folders.find((f) => (f.path.toUpperCase() === 'INBOX' ? name.toUpperCase() === 'INBOX' : f.path === name));
      if (!folder) {
        selected = null;
        return reply(tag, 'NO', '[NONEXISTENT] Mailbox does not exist');
      }
      selected = folder;
      const msgs = ordered(folder);
      const uidNext = msgs.reduce((a, m) => Math.max(a, m.uid), 0) + 1;
      send(
        `* FLAGS (${SYSTEM_FLAGS.join(' ')})\r\n`,
        `* OK [PERMANENTFLAGS (${readOnly ? '' : `${SYSTEM_FLAGS.join(' ')} \\*`})] Flags permitted\r\n`,
        `* ${msgs.length} EXISTS\r\n`,
        '* 0 RECENT\r\n',
        `* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid\r\n`,
        `* OK [UIDNEXT ${uidNext}] Predicted next UID\r\n`,
      );
      reply(tag, 'OK', `[${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${readOnly ? 'EXAMINE' : 'SELECT'} completed`);
    };

    const search = (tag: string, args: Tok[], byUid: boolean) => {
      if (!selected) return reply(tag, 'BAD', 'No mailbox selected');
      const rest = args[0] !== undefined && text(args[0]).toUpperCase() === 'CHARSET' ? args.slice(2) : args;
      const msgs = ordered(selected);
      const pred = parseKeys(new Cursor(rest.length > 0 ? rest : ['ALL']), { gmail: Boolean(opts.gmail), folder: selected, ordered: msgs });
      const hits = msgs.map((m, idx) => ({ m, seq: idx + 1 })).filter(({ m }) => pred(m));
      send(`* SEARCH${hits.map(({ m, seq }) => ` ${byUid ? m.uid : seq}`).join('')}\r\n`);
      reply(tag, 'OK', 'SEARCH completed');
    };

    const fetch = (tag: string, args: Tok[], byUid: boolean) => {
      if (!selected) return reply(tag, 'BAD', 'No mailbox selected');
      const set = text(args[0]);
      const itemsTok = args[1];
      const items = (Array.isArray(itemsTok) ? itemsTok : [itemsTok ?? '']).map(text);
      const msgs = ordered(selected);
      const max = byUid ? msgs.reduce((a, m) => Math.max(a, m.uid), 0) : msgs.length;
      const known = /^(UID|FLAGS|ENVELOPE|BODYSTRUCTURE|INTERNALDATE|RFC822\.SIZE|BODY(\.PEEK)?\[.*\](<\d+(\.\d+)?>)?|X-GM-MSGID|X-GM-THRID|X-GM-LABELS)$/i;
      for (const item of items) {
        const gm = /^X-GM-/i.test(item);
        if (!known.test(item) || (gm && !opts.gmail)) throw new BadCommand(`Unknown fetch item ${item}`);
      }
      msgs.forEach((m, idx) => {
        if (!inSet(set, byUid ? m.uid : idx + 1, max)) return;
        const parts: (string | Buffer)[] = [];
        const add = (...p: (string | Buffer)[]) => {
          if (parts.length > 0) parts.push(' ');
          parts.push(...p);
        };
        let flagsChanged = false;
        const bodyItems = items.filter((x) => /^BODY(\.PEEK)?\[/i.test(x));
        if (bodyItems.some((x) => !/^BODY\.PEEK/i.test(x)) && !(m.flags ?? []).includes('\\Seen')) {
          m.flags = [...(m.flags ?? []), '\\Seen'];
          flagsChanged = true;
        }
        if (byUid && !items.some((x) => x.toUpperCase() === 'UID')) add(`UID ${m.uid}`);
        for (const item of items) {
          const upper = item.toUpperCase();
          if (upper === 'UID') add(`UID ${m.uid}`);
          else if (upper === 'FLAGS') add(`FLAGS (${(m.flags ?? []).join(' ')})`);
          else if (upper === 'ENVELOPE') add(`ENVELOPE ${envelope(m.raw)}`);
          else if (upper === 'BODYSTRUCTURE') add(`BODYSTRUCTURE ${bodyStructure(m.raw)}`);
          else if (upper === 'INTERNALDATE') add(`INTERNALDATE ${quote(internalDate(m.date))}`);
          else if (upper === 'RFC822.SIZE') add(`RFC822.SIZE ${Buffer.byteLength(m.raw)}`);
          else if (upper === 'X-GM-MSGID') add(`X-GM-MSGID ${1_000_000 + m.uid}`);
          else if (upper === 'X-GM-THRID') add(`X-GM-THRID ${1_000_000 + m.uid}`);
          else if (upper === 'X-GM-LABELS') add('X-GM-LABELS ()');
          else {
            const body = /^BODY(?:\.PEEK)?\[(.*)\](?:<(\d+)(?:\.(\d+))?>)?$/i.exec(item);
            if (!body) continue;
            let data = section(m.raw, body[1] ?? '');
            const start = body[2] === undefined ? undefined : Number(body[2]);
            if (start !== undefined) data = data.subarray(start, body[3] === undefined ? undefined : start + Number(body[3]));
            add(`BODY[${body[1] ?? ''}]${start === undefined ? '' : `<${start}>`} {${data.length}}\r\n`, data);
          }
        }
        if (flagsChanged && !items.some((x) => x.toUpperCase() === 'FLAGS')) add(`FLAGS (${(m.flags ?? []).join(' ')})`);
        send(`* ${idx + 1} FETCH (`, ...parts, ')\r\n');
      });
      reply(tag, 'OK', 'FETCH completed');
    };

    const dispatch = (input: string) => {
      const space = input.indexOf(' ');
      const tag = space < 0 ? input : input.slice(0, space);
      const rest = space < 0 ? '' : input.slice(space + 1);
      let args: Tok[];
      try {
        args = tokenize(rest);
      } catch (err) {
        commands.push(input);
        return reply(tag || '*', 'BAD', err instanceof BadCommand ? err.message : 'Parse error');
      }
      const name = typeof args[0] === 'string' ? args[0].toUpperCase() : '';
      const params = args.slice(1);

      // Log first, with credentials masked.
      if (name === 'LOGIN') commands.push(`${tag} LOGIN ${typeof params[0] === 'string' ? quote(params[0]) : ''} ***`);
      else if (name === 'AUTHENTICATE') commands.push(`${tag} AUTHENTICATE ${String(params[0] ?? '').toUpperCase()}${params[1] === undefined ? '' : ' ***'}`);
      else commands.push(input);

      try {
        switch (name) {
          case 'CAPABILITY':
            send(`* CAPABILITY ${capability}\r\n`);
            return reply(tag, 'OK', 'CAPABILITY completed');
          case 'NOOP':
            return reply(tag, 'OK', 'NOOP completed');
          case 'LOGOUT':
            send('* BYE Logging out\r\n');
            reply(tag, 'OK', 'LOGOUT completed');
            socket.end();
            return;
          case 'LOGIN': {
            if (authenticated) return reply(tag, 'BAD', 'Already authenticated');
            const ok =
              opts.failAuthWith === undefined &&
              opts.auth.password !== undefined &&
              text(params[0]) === opts.auth.user &&
              text(params[1]) === opts.auth.password;
            if (!ok) return failLogin(tag);
            authenticated = true;
            return reply(tag, 'OK', `[CAPABILITY ${capability}] Logged in`);
          }
          case 'AUTHENTICATE': {
            if (authenticated) return reply(tag, 'BAD', 'Already authenticated');
            const mechanism = text(params[0]).toUpperCase();
            if (mechanism !== 'PLAIN' && mechanism !== 'XOAUTH2') return reply(tag, 'NO', 'Unsupported authentication mechanism');
            if (params[1] !== undefined) return finishSasl(tag, mechanism, text(params[1]));
            pendingAuth = { tag, mechanism, failedOnce: false };
            send('+ \r\n');
            return;
          }
        }
        if (!authenticated) return reply(tag, 'BAD', 'Command not valid in this state, log in first');
        switch (name) {
          case 'LIST':
          case 'LSUB':
            listFolders(text(params[0]), text(params[1]));
            return reply(tag, 'OK', `${name} completed`);
          case 'EXAMINE':
          case 'SELECT':
            return open(tag, text(params[0]), name === 'EXAMINE');
          case 'CLOSE':
          case 'UNSELECT':
            selected = null;
            return reply(tag, 'OK', `${name} completed`);
          case 'ENABLE':
            send('* ENABLED\r\n');
            return reply(tag, 'OK', 'ENABLE completed');
          case 'SEARCH':
            return search(tag, params, false);
          case 'FETCH':
            return fetch(tag, params, false);
          case 'UID': {
            const sub = text(params[0]).toUpperCase();
            if (sub === 'SEARCH') return search(tag, params.slice(1), true);
            if (sub === 'FETCH') return fetch(tag, params.slice(1), true);
            return reply(tag, 'NO', `UID ${sub} is not allowed: this server is read-only`);
          }
          case 'STORE': case 'COPY': case 'MOVE': case 'APPEND': case 'EXPUNGE': case 'CREATE': case 'DELETE': case 'RENAME':
            return reply(tag, 'NO', `${name} is not allowed: this server is read-only`);
          default:
            return reply(tag, 'BAD', `Unknown command ${name}`);
        }
      } catch (err) {
        reply(tag, 'BAD', err instanceof BadCommand ? err.message : 'Command failed');
      }
    };

    const pump = () => {
      for (;;) {
        if (literalLeft !== null) {
          if (buf.length < literalLeft) return;
          line += quote(buf.subarray(0, literalLeft).toString('utf8'));
          buf = buf.subarray(literalLeft);
          literalLeft = null;
          continue;
        }
        const eol = buf.indexOf('\n');
        if (eol < 0) return;
        const chunk = buf.subarray(0, eol).toString('utf8').replace(/\r$/, '');
        buf = buf.subarray(eol + 1);
        if (pendingAuth) {
          handleContinuation(chunk);
          continue;
        }
        const lit = /\{(\d+)(\+?)\}$/.exec(chunk);
        if (lit) {
          line += chunk.slice(0, lit.index);
          literalLeft = Number(lit[1]);
          if (lit[2] !== '+') send('+ Ready for literal data\r\n');
          continue;
        }
        const complete = line + chunk;
        line = '';
        if (complete.trim() !== '') dispatch(complete);
      }
    };

    socket.on('data', (d) => {
      buf = Buffer.concat([buf, Buffer.from(d)]);
      pump();
    });
    send(`* OK IMAP4rev1 fake server ready\r\n`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake IMAP server has no port');

  return {
    port: address.port,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function internalDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}
