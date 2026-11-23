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
  it('quotes a required word that Gmail would read as an operator', () => {
    const [q] = compileGmail({ phrases: ['Acme'], phraseFields: ['subject'], requireAny: { words: ['OR', 'and', 'offer'] } });
    expect(q).toContain('subject:("OR" OR "and" OR offer)');
  });

  it('refuses required words too long for one search', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${String(i).padStart(6, '0')}`);
    expect(() => compileGmail({ phrases: ['Acme'], requireAny: { words } })).toThrow(TypeError);
    expect(() => compileImap({ phrases: ['Acme'], requireAny: { words } })).toThrow(TypeError);
    expect(() => compileGmail({ phrases: ['Acme'], requireAny: { words: words.slice(0, 20) } })).not.toThrow();
  });

  it('builds one search with domains, phrases, exclusions and date', () => {
    expect(
      compileGmail({ fromDomains: ['greenhouse.io'], phrases: ['Acme'], excludeFrom: ['me@x.example'], since }),
    ).toEqual([
      '(from:(greenhouse.io) OR from:"Acme" OR subject:"Acme") -from:me@x.example -in:sent -in:drafts after:1788220799',
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
    const tail = ' -from:me@x.example -in:sent -in:drafts after:1788220799';
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

describe('compileGmail with requireAny', () => {
  const words = ['application', 'next steps'];

  it('ands the word group after the main group, before the tail', () => {
    expect(compileGmail({ phrases: ['Acme'], phraseFields: ['subject'], requireAny: { words } })).toEqual([
      '(subject:"Acme") subject:(application OR "next steps") -in:sent -in:drafts',
    ]);
  });

  it('looks in the sender and the subject when asked', () => {
    const [s] = compileGmail({ phrases: ['Acme'], phraseFields: ['subject'], requireAny: { words, fields: ['from', 'subject'] } });
    expect(s).toBe(
      '(subject:"Acme") (from:(application OR "next steps") OR subject:(application OR "next steps")) -in:sent -in:drafts',
    );
  });

  it('repeats the group in every piece and keeps each under 1,400 characters', () => {
    const phrases = Array.from({ length: 150 }, (_, i) => `Company Number ${String(i).padStart(3, '0')} Limited`);
    const many = Array.from({ length: 20 }, (_, i) => `jobword${i}`);
    const group = `subject:(${many.join(' OR ')})`;
    const pieces = compileGmail({ phrases, excludeFrom: ['me@x.example'], since, requireAny: { words: many } });
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThan(1400);
      expect(p).toContain(`) ${group} -from:me@x.example`);
    }
    for (const phrase of phrases) {
      expect(pieces.filter((p) => p.includes(`subject:"${phrase}"`))).toHaveLength(1);
    }
  });

  it('compiles like no requirement when every word is empty', () => {
    const q = { phrases: ['Acme'], since };
    expect(compileGmail({ ...q, requireAny: { words: ['  ', '""'] } })).toEqual(compileGmail(q));
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

describe('compileImap with requireAny', () => {
  it('ands one word through a double NOT', () => {
    expect(
      compileImap({ phrases: ['Acme'], phraseFields: ['subject'], requireAny: { words: ['application'] }, since }),
    ).toEqual([{ subject: 'Acme', since, not: { not: { subject: 'application' } } }]);
  });

  it('ands an or of words onto a piece that is itself an or', () => {
    expect(compileImap({ phrases: ['Acme', 'Globex'], requireAny: { words: ['application', 'next steps'] }, since })).toEqual([
      {
        or: [{ from: 'Acme' }, { subject: 'Acme' }, { from: 'Globex' }, { subject: 'Globex' }],
        since,
        not: { not: { or: [{ subject: 'application' }, { subject: 'next steps' }] } },
      },
    ]);
  });

  it('looks in the sender and the subject when asked', () => {
    const [s] = compileImap({ phrases: ['Acme'], phraseFields: ['subject'], requireAny: { words: ['offer'], fields: ['from', 'subject'] } });
    expect(s).toEqual({ subject: 'Acme', not: { not: { or: [{ from: 'offer' }, { subject: 'offer' }] } } });
  });

  it('repeats the group in every piece and keeps each under 1,400 characters', () => {
    const phrases = Array.from({ length: 150 }, (_, i) => `Company Number ${i} Limited`);
    const many = Array.from({ length: 20 }, (_, i) => `jobword${i}`);
    const group = JSON.stringify({ not: { not: { or: many.map((subject) => ({ subject })) } } }).slice(1, -1);
    const pieces = compileImap({ phrases, since, requireAny: { words: many } });
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(JSON.stringify(p).length).toBeLessThan(1400);
      expect(JSON.stringify(p)).toContain(group);
    }
  });

  it('compiles like no requirement when every word is empty', () => {
    const q = { phrases: ['Acme'], since };
    expect(compileImap({ ...q, requireAny: { words: ['  ', '""'] } })).toEqual(compileImap(q));
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
  it('rejects a lookalike domain with an unrelated phrase', () => {
    expect(matchesLocally({ ...q, phrases: ['Acme'] }, { ...from('jobs@notgreenhouse.io'), subject: 'Weekly digest' })).toBe(false);
  });
  it('accepts a subject hit', () => {
    expect(matchesLocally({ ...q, phrases: ['Acme'] }, { ...from('jobs@other.example'), subject: 'Your Acme application' })).toBe(true);
  });
  it('accepts a sender-name hit', () => {
    const ref = { from: { name: 'Acme Recruiting', address: 'jobs@other.example' }, subject: 'Hello' };
    expect(matchesLocally({ ...q, phrases: ['Acme'] }, ref)).toBe(true);
  });
  it('accepts an accent-folded subject hit', () => {
    const ref = { ...from('jobs@other.example'), subject: 'Zurich Labs interview' };
    expect(matchesLocally({ ...q, phrases: ['Zürich Labs'] }, ref)).toBe(true);
  });
  it('ignores the subject when phraseFields lacks it', () => {
    const ref = { ...from('jobs@other.example'), subject: 'Acme' };
    expect(matchesLocally({ ...q, phrases: ['Acme'], phraseFields: ['from'] }, ref)).toBe(false);
  });
  it('accepts everything not excluded when the body is searched', () => {
    const body = { ...q, phrases: ['Acme'], phraseFields: ['body' as const] };
    expect(matchesLocally(body, from('jobs@other.example'))).toBe(true);
    expect(matchesLocally(body, from('me@x.example'))).toBe(false);
  });
  it('rejects a missing sender when domains are required', () => {
    expect(matchesLocally(q, { from: null })).toBe(false);
  });
});

describe('matchesLocally with requireAny', () => {
  const q = { phrases: ['Acme'], phraseFields: ['subject' as const], requireAny: { words: ['application', 'next steps'] } };
  const ref = (subject: string, name: string | null = null, address = 'jobs@other.example') => ({ from: { name, address }, subject });

  it('needs one of the words in the subject, with no fromDomains', () => {
    expect(matchesLocally(q, ref('Your application to Acme'))).toBe(true);
    expect(matchesLocally(q, ref('Acme news'))).toBe(false);
  });
  it('matches whole words only, in the listed form', () => {
    expect(matchesLocally(q, ref('Applications at Acme'))).toBe(false);
    expect(matchesLocally(q, ref('Reapplication at Acme'))).toBe(false);
    expect(matchesLocally(q, ref('Acme: application.'))).toBe(true);
  });
  it('matches a two-word entry as a phrase', () => {
    expect(matchesLocally(q, ref('Next steps with Acme'))).toBe(true);
    expect(matchesLocally(q, ref('Next  Steps with Acme'))).toBe(true);
    expect(matchesLocally(q, ref('Steps next Acme'))).toBe(false);
  });
  it('folds case and accents', () => {
    const accented = { ...q, requireAny: { words: ['Réunion'] } };
    expect(matchesLocally(accented, ref('ACME REUNION'))).toBe(true);
    expect(matchesLocally({ ...q, requireAny: { words: ['reunion'] } }, ref('Acme réunion'))).toBe(true);
  });
  it('applies alongside domains, to a domain hit too', () => {
    const withDomains = { ...q, fromDomains: ['greenhouse.io'] };
    expect(matchesLocally(withDomains, ref('Hello', null, 'jobs@greenhouse.io'))).toBe(false);
    expect(matchesLocally(withDomains, ref('Your application', null, 'jobs@greenhouse.io'))).toBe(true);
  });
  it('applies when the body is searched', () => {
    const body = { phrases: ['Acme'], phraseFields: ['body' as const], requireAny: { words: ['offer'] } };
    expect(matchesLocally(body, ref('An offer'))).toBe(true);
    expect(matchesLocally(body, ref('Weekly digest'))).toBe(false);
  });
  it('looks at the sender name and address only when fields is from', () => {
    const fromOnly = { ...q, requireAny: { words: ['recruiting'], fields: ['from' as const] } };
    expect(matchesLocally(fromOnly, ref('Acme recruiting update'))).toBe(false);
    expect(matchesLocally(fromOnly, ref('Acme update', 'Acme Recruiting'))).toBe(true);
    expect(matchesLocally(fromOnly, ref('Acme update', null, 'recruiting@acme.example'))).toBe(true);
  });
  it('still rejects excluded senders', () => {
    expect(matchesLocally({ ...q, excludeFrom: ['me@x.example'] }, ref('Your application', null, 'me@x.example'))).toBe(false);
  });
  it('sets no requirement when every word is empty', () => {
    expect(matchesLocally({ ...q, requireAny: { words: ['  ', '""'] } }, ref('Acme news'))).toBe(true);
  });
});
