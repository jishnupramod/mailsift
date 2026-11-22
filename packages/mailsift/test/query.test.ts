import { describe, expect, it } from 'vitest';
import { cleanPhrase, compileGmail, compileImap, matchesLocally } from '../src/query.js';

const since = new Date('2026-09-01T00:00:00Z');

describe('cleanPhrase', () => {
  it('removes quotes and collapses spaces', () => {
    expect(cleanPhrase('Procter "PG" Gamble')).toBe('Procter PG Gamble');
  });
  it('returns null for an empty phrase', () => {
    expect(cleanPhrase('""')).toBeNull();
    expect(cleanPhrase('   ')).toBeNull();
  });
});

describe('compileGmail', () => {
  it('builds one search with domains, phrases, exclusions and date', () => {
    expect(
      compileGmail({ fromDomains: ['greenhouse.io'], phrases: ['Acme'], excludeFrom: ['me@x.example'], since }),
    ).toEqual([
      '(from:(greenhouse.io) OR from:"Acme" OR subject:"Acme") -from:me@x.example -in:sent -in:drafts after:2026/09/01',
    ]);
  });

  it('joins several domains inside one from group', () => {
    const [s] = compileGmail({ fromDomains: ['a.example', 'b.example'] });
    expect(s).toBe('(from:(a.example OR b.example)) -in:sent -in:drafts');
  });

  it('can leave out the own-mail exclusions', () => {
    expect(compileGmail({ phrases: ['Acme'] }, false)).toEqual(['(from:"Acme" OR subject:"Acme")']);
  });

  it('searches the body bare when asked', () => {
    const [s] = compileGmail({ phrases: ['Acme'], phraseFields: ['body'] });
    expect(s).toBe('("Acme") -in:sent -in:drafts');
  });

  it('cleans phrases and drops empty ones', () => {
    const [s] = compileGmail({ phrases: ['Pro"cter', '""'] });
    expect(s).toBe('(from:"Procter" OR subject:"Procter") -in:sent -in:drafts');
  });

  it('returns nothing when there is nothing to search', () => {
    expect(compileGmail({})).toEqual([]);
    expect(compileGmail({ phrases: ['""'], excludeFrom: ['a@x.example'] })).toEqual([]);
  });

  it('splits 150 phrases into pieces under 1,400 characters with the same tail', () => {
    const phrases = Array.from({ length: 150 }, (_, i) => `Company Number ${String(i).padStart(3, '0')} Limited`);
    const pieces = compileGmail({ fromDomains: ['greenhouse.io'], phrases, excludeFrom: ['me@x.example'], since });
    const tail = ' -from:me@x.example -in:sent -in:drafts after:2026/09/01';
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThan(1400);
      expect(p.endsWith(tail)).toBe(true);
    }
    expect(pieces[0]).toContain('from:(greenhouse.io)');
    for (const phrase of phrases) {
      expect(pieces.filter((p) => p.includes(`from:"${phrase}"`))).toHaveLength(1);
    }
  });
});

describe('compileImap', () => {
  it('builds an or tree plus since', () => {
    expect(compileImap({ fromDomains: ['greenhouse.io'], phrases: ['Acme'], since })).toEqual([
      { or: [{ from: 'greenhouse.io' }, { from: 'Acme' }, { subject: 'Acme' }], since },
    ]);
  });

  it('uses the UTC calendar date for since', () => {
    const [s] = compileImap({ phrases: ['Acme'], since: new Date('2026-09-01T23:30:00Z') });
    expect(s?.since).toEqual(new Date('2026-09-01T00:00:00Z'));
  });

  it('keeps UTF-8 phrases and adds body when asked', () => {
    const [s] = compileImap({ phrases: ['Zürich Labs'], phraseFields: ['body'] });
    expect(s).toEqual({ body: 'Zürich Labs' });
  });

  it('returns nothing when there is nothing to search', () => {
    expect(compileImap({})).toEqual([]);
  });

  it('splits long queries into pieces under 1,400 characters', () => {
    const phrases = Array.from({ length: 150 }, (_, i) => `Company Number ${i} Limited`);
    const pieces = compileImap({ phrases, since });
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(JSON.stringify(p).length).toBeLessThan(1400);
    const all = JSON.stringify(pieces);
    for (const phrase of phrases) expect(all.split(`"from":"${phrase}"`)).toHaveLength(2);
  });
});

describe('matchesLocally', () => {
  const q = { fromDomains: ['greenhouse.io'], excludeFrom: ['me@x.example'] };
  const from = (address: string) => ({ from: { name: null, address } });

  it('rejects a lookalike domain', () => {
    expect(matchesLocally(q, from('jobs@notgreenhouse.io'))).toBe(false);
  });
  it('accepts the domain and its subdomains', () => {
    expect(matchesLocally(q, from('jobs@greenhouse.io'))).toBe(true);
    expect(matchesLocally(q, from('x@mail.greenhouse.io'))).toBe(true);
  });
  it('rejects excluded senders, ignoring case', () => {
    expect(matchesLocally({ ...q, fromDomains: ['x.example'] }, from('Me@X.example'))).toBe(false);
  });
  it('does not apply the domain rule when a phrase may have matched elsewhere', () => {
    expect(matchesLocally({ ...q, phrases: ['Acme'] }, from('jobs@other.example'))).toBe(true);
  });
  it('applies the domain rule when phrases only search the sender and do not match it', () => {
    expect(matchesLocally({ ...q, phrases: ['Acme'], phraseFields: ['from'] }, from('jobs@other.example'))).toBe(false);
  });
  it('rejects a missing sender when domains are required', () => {
    expect(matchesLocally(q, { from: null })).toBe(false);
  });
});
