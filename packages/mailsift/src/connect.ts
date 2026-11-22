import { ImapFlow, type FetchMessageObject, type MessageAddressObject } from 'imapflow';
import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser';
import { MailsiftError, toMailsiftError } from './errors.js';
import { PROVIDERS, type Provider } from './providers.js';
import { compileGmail, compileImap, matchesLocally, type ImapSearch } from './query.js';
import { htmlToText } from './text.js';
import type { Address, Auth, ConnectOptions, Message, MessageRef, Query } from './types.js';

export interface Mailbox {
  folders(): Promise<{ path: string; specialUse: string | null }[]>;
  /**
   * Newest first, deduplicated by key, at most `limit` (default 200). A query
   * with no domains and no phrases matches nothing.
   */
  search(q: Query, opts?: { limit?: number }): Promise<MessageRef[]>;
  fetch(ref: MessageRef, opts?: { maxChars?: number }): Promise<Message>;
  /** Logs out; never throws. */
  close(): Promise<void>;
}

/** A folder to search: by special-use flag first, then by name. */
export interface WantedFolder {
  specialUse: string | null;
  names: string[];
}

/** Where to connect and what to search, resolved from the options. */
export interface Target {
  host: string;
  port: number;
  secure: boolean;
  dialect: Provider['dialect'];
  folders: WantedFolder[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_CHARS = 100_000;
const FETCH_CHUNK = 500;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const HEADER_ALLOWLIST = ['Message-ID', 'Date', 'From', 'To', 'Cc', 'Reply-To', 'List-Id'];
const ADDRESS_HEADERS = new Set(['from', 'to', 'cc', 'reply-to']);

/** Resolves the preset; refuses plain-text connections to anything but this machine. */
export function resolveTarget(opts: ConnectOptions): Target {
  const preset = PROVIDERS[opts.provider];
  if (!preset) throw new TypeError(`Unknown provider: ${String(opts.provider)}`);
  const folders: WantedFolder[] =
    opts.folders && opts.folders.length > 0 ? opts.folders.map((name) => ({ specialUse: null, names: [name] })) : preset.folders;

  if (preset.host !== null) {
    return { host: preset.host, port: preset.port, secure: true, dialect: preset.dialect, folders };
  }
  if (!opts.host) throw new TypeError('The custom provider needs a host');
  const secure = opts.secure ?? true;
  if (!secure && !LOCAL_HOSTS.has(opts.host.toLowerCase())) throw new MailsiftError('TLS_FAILED');
  return { host: opts.host, port: opts.port ?? preset.port, secure, dialect: preset.dialect, folders };
}

/**
 * The listed paths to search, in the order wanted: each wanted folder is found
 * by its special-use flag, else by the first name that matches (ignoring
 * case). Folders found by neither are skipped; duplicates are dropped.
 */
export function resolveFolders(listed: { path: string; specialUse: string | null }[], wanted: WantedFolder[]): string[] {
  const paths: string[] = [];
  for (const w of wanted) {
    const bySpecialUse = w.specialUse === null ? undefined : listed.find((f) => f.specialUse === w.specialUse);
    const byName = w.names
      .map((n) => listed.find((f) => f.path.toLowerCase() === n.toLowerCase()))
      .find((f) => f !== undefined);
    const found = bySpecialUse ?? byName;
    if (found && !paths.includes(found.path)) paths.push(found.path);
  }
  return paths;
}

/** Connects and signs in. Every folder is opened read-only and bodies are only peeked at. */
export async function connect(opts: ConnectOptions): Promise<Mailbox> {
  return openMailbox(resolveTarget(opts), opts.auth, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export async function openMailbox(target: Target, auth: Auth, timeoutMs: number): Promise<Mailbox> {
  const client = new ImapFlow({
    host: target.host,
    port: target.port,
    secure: target.secure,
    auth: auth.kind === 'password' ? { user: auth.user, pass: auth.password } : { user: auth.user, accessToken: await auth.accessToken() },
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    // keep-alive between calls uses NOOP; never SELECT or STATUS
    missingIdleCommand: 'NOOP',
  });
  // failures reach the caller through the rejected command; nothing is logged
  client.on('error', () => undefined);

  try {
    await client.connect();
  } catch (e) {
    client.close();
    const err = toMailsiftError(e);
    // a rejected Microsoft token is almost always an expired one: the caller refreshes it
    throw auth.kind === 'microsoft' && err.code === 'AUTH_FAILED' ? new MailsiftError('TOKEN_EXPIRED') : err;
  }
  return new ImapMailbox(client, target);
}

class ImapMailbox implements Mailbox {
  constructor(
    private readonly client: ImapFlow,
    private readonly target: Target,
  ) {}

  folders(): Promise<{ path: string; specialUse: string | null }[]> {
    return mapErrors(async () => {
      const list = await this.client.list();
      return list.map((f) => ({ path: f.path, specialUse: f.specialUse ?? null }));
    });
  }

  search(q: Query, opts: { limit?: number } = {}): Promise<MessageRef[]> {
    return mapErrors(async () => {
      const searches: ImapSearch[] =
        this.target.dialect === 'gmail' ? compileGmail(q).map((gmraw) => ({ gmraw })) : compileImap(q);
      if (searches.length === 0) return [];
      const paths = resolveFolders(await this.folders(), this.target.folders);
      if (paths.length === 0) throw new MailsiftError('FOLDER_MISSING');

      const byKey = new Map<string, MessageRef>();
      for (const path of paths) {
        for (const ref of await this.searchFolder(path, searches, q)) {
          if (!byKey.has(ref.key)) byKey.set(ref.key, ref);
        }
      }
      return [...byKey.values()].sort(newestFirst).slice(0, opts.limit ?? DEFAULT_LIMIT);
    });
  }

  private async searchFolder(path: string, searches: ImapSearch[], q: Query): Promise<MessageRef[]> {
    const lock = await this.client.getMailboxLock(path, { readOnly: true });
    try {
      const uidValidity = this.uidValidity();
      const uids = new Set<number>();
      for (const s of searches) {
        for (const uid of (await this.client.search(s, { uid: true })) || []) uids.add(uid);
      }
      const sorted = [...uids].sort((a, b) => a - b);
      const refs: MessageRef[] = [];
      for (let i = 0; i < sorted.length; i += FETCH_CHUNK) {
        const range = uidRange(sorted.slice(i, i + FETCH_CHUNK));
        for await (const m of this.client.fetch(range, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
          const ref = toRef(path, uidValidity, m);
          if (matchesLocally(q, ref)) refs.push(ref);
        }
      }
      return refs;
    } finally {
      lock.release();
    }
  }

  fetch(ref: MessageRef, opts: { maxChars?: number } = {}): Promise<Message> {
    return mapErrors(async () => {
      const lock = await this.client.getMailboxLock(ref.folder, { readOnly: true });
      let source: Buffer;
      let internalDate: Date | null;
      try {
        if (this.uidValidity() !== ref.uidValidity) throw new MailsiftError('FOLDER_MISSING');
        const m = await this.client.fetchOne(String(ref.uid), { uid: true, internalDate: true, source: true }, { uid: true });
        // the message is gone from the folder: the ref no longer points anywhere
        if (!m || !m.source) throw new MailsiftError('FOLDER_MISSING');
        source = m.source;
        internalDate = toDate(m.internalDate);
      } finally {
        lock.release();
      }
      return parseMessage(ref, source, internalDate, opts.maxChars ?? DEFAULT_MAX_CHARS);
    });
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // already closed or unreachable
    }
    try {
      this.client.close();
    } catch {
      // nothing left to close
    }
  }

  private uidValidity(): string {
    const mailbox = this.client.mailbox;
    if (!mailbox) throw new MailsiftError('FOLDER_MISSING');
    return String(mailbox.uidValidity);
  }
}

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw toMailsiftError(e);
  }
}

function newestFirst(a: MessageRef, b: MessageRef): number {
  return (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity) || 0;
}

/** A sorted uid list as an IMAP set, with runs written as ranges (1:4,7,9:10). */
function uidRange(uids: number[]): string {
  const parts: string[] = [];
  let start = uids[0];
  let prev = start;
  for (const uid of [...uids.slice(1), undefined]) {
    if (uid !== undefined && prev !== undefined && uid === prev + 1) {
      prev = uid;
      continue;
    }
    if (start !== undefined) parts.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = uid;
    prev = uid;
  }
  return parts.join(',');
}

function toDate(v: Date | string | undefined): Date | null {
  if (v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fromEnvelope(a: MessageAddressObject | undefined): Address | null {
  if (!a?.address) return null;
  return { name: a.name ? a.name : null, address: a.address };
}

/** The received date is the server's INTERNALDATE, else the Date header. */
function toRef(folder: string, uidValidity: string, m: FetchMessageObject): MessageRef {
  const env = m.envelope;
  return {
    folder,
    uid: m.uid,
    uidValidity,
    key: env?.messageId || `${folder}:${uidValidity}:${m.uid}`,
    date: toDate(m.internalDate) ?? toDate(env?.date),
    from: fromEnvelope(env?.from?.[0]),
    subject: env?.subject ?? '',
  };
}

function flattenAddresses(field: AddressObject | AddressObject[] | undefined): Address[] {
  const flat = (list: EmailAddress[]): EmailAddress[] => list.flatMap((a) => (a.group ? flat(a.group) : [a]));
  return flat([field ?? []].flat().flatMap((o) => o.value))
    .filter((a) => a.address)
    .map((a) => ({ name: a.name ? a.name : null, address: a.address as string }));
}

/** Cuts at `max` characters without splitting a surrogate pair. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

async function parseMessage(ref: MessageRef, source: Buffer, internalDate: Date | null, maxChars: number): Promise<Message> {
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    keepCidLinks: true,
    checksumAlgo: false,
  });
  const plain = parsed.text?.trim() ? parsed.text : '';
  const text = plain || (parsed.html ? htmlToText(parsed.html) : '');

  const headers: Record<string, string> = {};
  for (const name of HEADER_ALLOWLIST) {
    const lower = name.toLowerCase();
    const line = parsed.headerLines.find((h) => h.key === lower);
    if (!line) continue;
    const addresses = ADDRESS_HEADERS.has(lower) ? (parsed.headers.get(lower) as AddressObject | AddressObject[] | undefined) : undefined;
    headers[name] = addresses
      ? [addresses].flat().map((a) => a.text).join(', ')
      : line.line.slice(line.line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
  }

  const from = flattenAddresses(parsed.from)[0] ?? null;
  return {
    folder: ref.folder,
    uid: ref.uid,
    uidValidity: ref.uidValidity,
    key: ref.key,
    date: internalDate ?? parsed.date ?? null,
    from,
    subject: parsed.subject ?? '',
    to: flattenAddresses(parsed.to),
    cc: flattenAddresses(parsed.cc),
    text: cap(text, maxChars),
    headers,
    attachments: parsed.attachments.map((a) => ({ filename: a.filename ?? null, contentType: a.contentType, size: a.size })),
    sizeBytes: source.length,
  };
}
