const BLOCK_TAGS = new Set(
  'address article aside blockquote br dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul'.split(
    ' ',
  ),
);
/** Tags dropped together with everything up to their closing tag. */
const DROPPED_TAGS = new Set(['script', 'style', 'head']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Strips tags in one pass. Every search starts where the last one ended, so
 * the work stays linear even for hostile input such as thousands of unclosed
 * tags. An unclosed comment, tag or dropped block swallows the rest.
 */
function stripTags(html: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    const tag = html.slice(lt + 1, gt);
    const name = /^\/?([a-z][a-z0-9]*)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    i = gt + 1;
    if (DROPPED_TAGS.has(name) && !tag.startsWith('/') && !tag.endsWith('/')) {
      const close = new RegExp(`</${name}(?![a-z0-9])`, 'gi');
      close.lastIndex = i;
      if (!close.exec(html)) break;
      const closeEnd = html.indexOf('>', close.lastIndex);
      if (closeEnd < 0) break;
      i = closeEnd + 1;
      continue;
    }
    if (BLOCK_TAGS.has(name)) out.push('\n');
  }
  return out.join('');
}

/**
 * Plain text from an HTML body: drops `script`, `style` and `head` with their
 * content, turns block tags into line breaks, strips every other tag and
 * decodes entities. Lines are trimmed and blank lines collapse to one.
 */
export function htmlToText(html: string): string {
  return decodeEntities(stripTags(html))
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
