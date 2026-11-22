import type { SearchObject } from 'imapflow';
import type { Address, Query } from './types.js';

/** The search-object shape imapflow's `search()` accepts. */
export type ImapSearch = SearchObject;

const MAX_PIECE = 1400;
const DEFAULT_FIELDS: NonNullable<Query['phraseFields']> = ['from', 'subject'];

/** Removes quotes and extra spaces; returns null when nothing is left. */
export function cleanPhrase(s: string): string | null {
  const cleaned = s.replace(/["\u201c\u201d]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

function cleanDomain(d: string): string | null {
  const cleaned = d.trim().toLowerCase().replace(/^[@.]+/, '');
  return cleaned === '' || /[\s()"\\]/.test(cleaned) ? null : cleaned;
}

function cleanAddress(a: string): string | null {
  const cleaned = a.trim();
  return cleaned === '' || /[\s()"\\]/.test(cleaned) ? null : cleaned;
}

function prepare(q: Query) {
  const domains = (q.fromDomains ?? []).map(cleanDomain).filter((d): d is string => d !== null);
  const phrases = (q.phrases ?? []).map(cleanPhrase).filter((p): p is string => p !== null);
  const fields = q.phraseFields && q.phraseFields.length > 0 ? q.phraseFields : DEFAULT_FIELDS;
  return { domains, phrases, fields };
}

/** Day of the date in UTC, as [year, month, day] (month 1-12). */
function utcDay(d: Date): [number, number, number] {
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/**
 * Packs items greedily into pieces: an item joins the current piece unless the
 * rendered piece would reach the limit (a lone item always gets a piece).
 */
function pack<T>(items: T[], render: (piece: T[]) => string): T[][] {
  const pieces: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    if (current.length > 0 && render([...current, item]).length >= MAX_PIECE) {
      pieces.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

type GmailItem = { kind: 'domain'; value: string } | { kind: 'phrase'; value: string };

/**
 * Gmail `X-GM-RAW` strings, each under 1,400 characters. The domain group goes
 * first, then the phrases; the tail repeats in every piece.
 */
export function compileGmail(q: Query, ownExclusions = true): string[] {
  const { domains, phrases, fields } = prepare(q);
  const items: GmailItem[] = [
    ...domains.map((value) => ({ kind: 'domain' as const, value })),
    ...phrases.map((value) => ({ kind: 'phrase' as const, value })),
  ];
  if (items.length === 0) return [];

  const tailParts = (q.excludeFrom ?? [])
    .map(cleanAddress)
    .filter((a): a is string => a !== null)
    .map((a) => `-from:${a}`);
  if (ownExclusions) tailParts.push('-in:sent', '-in:drafts');
  if (q.since) {
    const [y, m, d] = utcDay(q.since);
    tailParts.push(`after:${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`);
  }
  const tail = tailParts.length > 0 ? ` ${tailParts.join(' ')}` : '';

  const phraseTerm = (p: string) =>
    fields.map((f) => (f === 'from' ? `from:"${p}"` : f === 'subject' ? `subject:"${p}"` : `"${p}"`)).join(' OR ');

  const render = (piece: GmailItem[]) => {
    const terms: string[] = [];
    const ds = piece.filter((i) => i.kind === 'domain').map((i) => i.value);
    if (ds.length > 0) terms.push(`from:(${ds.join(' OR ')})`);
    for (const i of piece) if (i.kind === 'phrase') terms.push(phraseTerm(i.value));
    return `(${terms.join(' OR ')})${tail}`;
  };

  return pack(items, render).map(render);
}

/** imapflow search objects, each under 1,400 characters when serialised. */
export function compileImap(q: Query): ImapSearch[] {
  const { domains, phrases, fields } = prepare(q);
  const items: ImapSearch[] = [
    ...domains.map((d): ImapSearch => ({ from: d })),
    ...phrases.flatMap((p) =>
      fields.map((f): ImapSearch => (f === 'from' ? { from: p } : f === 'subject' ? { subject: p } : { body: p })),
    ),
  ];
  if (items.length === 0) return [];

  let since: Date | undefined;
  if (q.since) {
    const [y, m, d] = utcDay(q.since);
    since = new Date(Date.UTC(y, m - 1, d));
  }

  const render = (piece: ImapSearch[]): ImapSearch => {
    const base: ImapSearch = piece.length === 1 ? { ...piece[0] } : { or: piece };
    return since ? { ...base, since } : base;
  };
  return pack(items, (piece) => JSON.stringify(render(piece))).map(render);
}

/**
 * The checks IMAP cannot do itself, because its FROM matches substrings:
 * `excludeFrom`, and the `fromDomains` suffix rule. The domain rule is skipped
 * when a phrase could have matched through the subject or body, which are not
 * available here.
 */
export function matchesLocally(q: Query, ref: { from: Address | null }): boolean {
  const address = ref.from?.address.trim().toLowerCase() ?? null;
  const excluded = (q.excludeFrom ?? []).map((a) => a.trim().toLowerCase());
  if (address !== null && excluded.includes(address)) return false;

  const { domains, phrases, fields } = prepare(q);
  if (domains.length === 0) return true;

  const host = address === null ? null : address.slice(address.lastIndexOf('@') + 1);
  if (host !== null && domains.some((d) => host === d || host.endsWith(`.${d}`))) return true;

  if (phrases.length === 0) return false;
  if (fields.includes('subject') || fields.includes('body')) return true;
  const sender = `${ref.from?.name ?? ''} ${address ?? ''}`.toLowerCase();
  return phrases.some((p) => sender.includes(p.toLowerCase()));
}
