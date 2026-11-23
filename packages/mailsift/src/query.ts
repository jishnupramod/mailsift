import type { SearchObject } from 'imapflow';
import type { Address, Query } from './types.js';

/** The search-object shape imapflow's `search()` accepts. */
export type ImapSearch = SearchObject;

const MAX_PIECE = 1400;
/** The longest requireAny word list, joined with " OR ": under half a piece. */
const MAX_WORDS = 600;
const DEFAULT_FIELDS: NonNullable<Query['phraseFields']> = ['from', 'subject'];
type WordField = 'from' | 'subject';
const DEFAULT_WORD_FIELDS: WordField[] = ['subject'];

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
  const words = (q.requireAny?.words ?? []).map(cleanPhrase).filter((w): w is string => w !== null);
  // the group repeats in every piece of a search, so it must leave room for the rest
  if (words.join(' OR ').length > MAX_WORDS) {
    throw new TypeError(`requireAny words must fit in ${MAX_WORDS} characters when joined with " OR "`);
  }
  const given = (['from', 'subject'] as const).filter((f) => q.requireAny?.fields?.includes(f));
  const wordFields: WordField[] = given.length > 0 ? given : DEFAULT_WORD_FIELDS;
  return { domains, phrases, fields, words, wordFields };
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
 * first, then the phrases; the requireAny word group and the tail repeat in
 * every piece.
 */
export function compileGmail(q: Query, ownExclusions = true): string[] {
  const { domains, phrases, fields, words, wordFields } = prepare(q);
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
    // Gmail reads a bare date in the account's own time zone; seconds are exact and exclusive.
    tailParts.push(`after:${Math.floor(Date.UTC(y, m - 1, d) / 1000) - 1}`);
  }
  const tail = tailParts.length > 0 ? ` ${tailParts.join(' ')}` : '';

  // a single word goes bare; anything else (a space, punctuation, or a word Gmail reads as OR/AND) is quoted
  const wordList = words.map((w) => (/^[\p{L}\p{N}]+$/u.test(w) && !/^(or|and)$/i.test(w) ? w : `"${w}"`)).join(' OR ');
  const wordTerms = wordFields.map((f) => `${f}:(${wordList})`);
  const group = words.length === 0 ? '' : wordTerms.length === 1 ? ` ${wordTerms[0]}` : ` (${wordTerms.join(' OR ')})`;

  const phraseTerm = (p: string) =>
    fields.map((f) => (f === 'from' ? `from:"${p}"` : f === 'subject' ? `subject:"${p}"` : `"${p}"`)).join(' OR ');

  const render = (piece: GmailItem[]) => {
    const terms: string[] = [];
    const ds = piece.filter((i) => i.kind === 'domain').map((i) => i.value);
    if (ds.length > 0) terms.push(`from:(${ds.join(' OR ')})`);
    for (const i of piece) if (i.kind === 'phrase') terms.push(phraseTerm(i.value));
    return `(${terms.join(' OR ')})${group}${tail}`;
  };

  return pack(items, render).map(render);
}

/**
 * imapflow search objects, each under 1,400 characters when serialised. The
 * requireAny group is ANDed onto every piece as `NOT NOT <group>`: an object
 * holds one `or` key, and the piece may already use it, so double negation is
 * how imapflow ANDs a second OR group.
 */
export function compileImap(q: Query): ImapSearch[] {
  const { domains, phrases, fields, words, wordFields } = prepare(q);
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

  const wordItems = wordFields.flatMap((f) => words.map((w): ImapSearch => (f === 'from' ? { from: w } : { subject: w })));
  const group: ImapSearch | null = wordItems.length === 0 ? null : wordItems.length === 1 ? { ...wordItems[0] } : { or: wordItems };

  const render = (piece: ImapSearch[]): ImapSearch => {
    const base: ImapSearch = piece.length === 1 ? { ...piece[0] } : { or: piece };
    const dated: ImapSearch = since ? { ...base, since } : base;
    return group ? { ...dated, not: { not: group } } : dated;
  };
  return pack(items, (piece) => JSON.stringify(render(piece))).map(render);
}

const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** True when the folded word appears in the folded text with no letter or digit either side. */
function hasWholeWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text);
}

/**
 * The checks IMAP cannot do itself, because its FROM matches substrings:
 * `excludeFrom` always applies; `requireAny` always applies, as a whole-word
 * check (IMAP's SUBJECT matches substrings and Gmail's word rules differ);
 * when domains are given, the message must match a domain by suffix, or a
 * phrase in the sender or subject. Bodies are not on the ref, so a query that
 * searches the body accepts everything else that passes.
 */
export function matchesLocally(q: Query, ref: { from: Address | null; subject?: string }): boolean {
  const address = ref.from?.address.trim().toLowerCase() ?? null;
  const excluded = (q.excludeFrom ?? []).map((a) => a.trim().toLowerCase());
  if (address !== null && excluded.includes(address)) return false;

  const { domains, phrases, fields, words, wordFields } = prepare(q);
  const sender = fold(`${ref.from?.name ?? ''} ${address ?? ''}`);
  if (words.length > 0) {
    const texts = wordFields.map((f) => (f === 'from' ? sender : fold(ref.subject ?? '')));
    const folded = words.map(fold);
    if (!folded.some((w) => texts.some((t) => hasWholeWord(t, w)))) return false;
  }
  if (domains.length === 0) return true;

  const host = address === null ? null : address.slice(address.lastIndexOf('@') + 1);
  if (host !== null && domains.some((d) => host === d || host.endsWith(`.${d}`))) return true;

  if (phrases.length === 0) return false;
  if (fields.includes('body')) return true;
  const folded = phrases.map(fold);
  if (fields.includes('from')) {
    if (folded.some((p) => sender.includes(p))) return true;
  }
  if (fields.includes('subject') && ref.subject !== undefined) {
    const subject = fold(ref.subject);
    if (folded.some((p) => subject.includes(p))) return true;
  }
  return false;
}
