// Word count for a markdown note, ignoring markdown syntax and Tickmark's task metadata.
// Only the text a reader would see counts: link text but not URLs, alt text but not image
// paths, code but not fence markers, tag words but not task dates/priorities/block ids.
// Lines of pure punctuation (rules, table separators, setext underlines) never count anyway.

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const FENCE = /^\s*(`{3,}|~{3,})/;

function stripLine(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, ' ')                                   // HTML comments (single line)
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')                                // HTML tags
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/, ' ')                           // reference definitions
    .replace(/^(\s*>)+/, ' ')                                           // blockquotes
    .replace(/^\s*#{1,6}(?=\s|$)/, ' ')                                 // ATX headings
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\](?=\s|$))?/, ' ')     // list bullets + checkboxes
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, t, a) => ' ' + (a ?? t.replace(/[#^].*$/, '')) + ' ') // wikilinks/embeds
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')                         // images -> alt text
    .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, ' $1 ')           // links -> link text
    .replace(/<(?:https?:|mailto:)[^>]*>/g, ' x ')                      // autolinks count as one word
    .replace(/(?:📅|due:)\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?/gu, ' ') // due dates
    .replace(/✅\s*\d{4}-\d{2}-\d{2}/gu, ' ')                            // done dates
    .replace(/🔁\s*\S.*?(?=\s(?:📅|due:|✅|⏫|🔼|🔽|🔺|⏬|#)|$)/gu, ' ')   // recurrence rules
    .replace(/[🔺⏫🔼🔽⏬]/gu, ' ')                                        // priorities
    .replace(/(?:^|\s)\^[A-Za-z0-9-]+\s*$/, ' ')                        // block ids
    .replace(/(^|\s)#(?=[\p{L}\p{N}_/-])/gu, '$1')                      // tag hashes (the tag word counts)
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1')                      // escaped punctuation
    .replace(/\|/g, ' ')                                               // table pipes
    .replace(/[*_~=`]+/g, '');                                          // emphasis, strike, highlight, code ticks
}

// { words, chars }: chars counts the letters, digits and punctuation of the counted words, plus
// one space between neighbouring words on the same line (like a "characters with spaces" count).
export function textStats(text) {
  if (!text) return { words: 0, chars: 0 };
  const lines = text.replace(FRONTMATTER, '').split(/\r?\n/);
  let n = 0, chars = 0, fence = null;
  for (const line of lines) {
    const f = line.match(FENCE);
    if (f && (!fence || (f[1][0] === fence[0] && f[1].length >= fence.length))) {
      fence = fence ? null : f[1];
      continue; // fence lines (and their info string) never count
    }
    const s = fence ? line : stripLine(line);
    let onLine = 0;
    for (const tok of s.split(/\s+/)) {
      if (!/[\p{L}\p{N}]/u.test(tok)) continue;
      chars += [...tok].length + (onLine ? 1 : 0);
      onLine++;
    }
    n += onLine;
  }
  return { words: n, chars };
}

export const countWords = (text) => textStats(text).words;
