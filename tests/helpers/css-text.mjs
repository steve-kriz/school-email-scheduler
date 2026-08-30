/**
 * A brace-matching reader for CSS **as text**.
 *
 * WHY THIS EXISTS. There is no CSS engine in this repo - no jsdom, no layout,
 * no cascade - and `tests/helpers/fake-dom.mjs` deliberately models markup
 * only. So a requirement like "the 44px touch target is NOT nested inside a
 * media query" cannot be asserted by measuring a rendered button; it has to be
 * asserted about the stylesheet the Lambda actually serves. The repo already
 * scans served source this way (the no-`innerHTML` and no-remote-URL scans in
 * `tests/e2e/calendar-frontend-flow.test.js`); this module is the same idea
 * with enough structure to tell "inside `@media`" from "outside" it.
 *
 * WHY NOT A REGEX. `/\.btn\s*\{[^}]*min-height:\s*44px/` cannot answer the
 * question that matters. It matches `.btn` nested inside a media block just as
 * happily as a top-level one, and it matches `.btn-small` when asked about
 * `.btn`. Brace matching plus an exact selector comparison answers both.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is load-bearing here rather than
 * incidental: this stylesheet documents its 44px rule and its 28px `.chip`
 * exception in prose, so an un-stripped scan would find "44px" in a sentence
 * ABOUT the rule and call the rule present even after someone deleted it.
 * `stripComments` replaces comment bytes with spaces (newlines kept), so
 * offsets - and therefore "which block comes first" - survive intact.
 *
 * NO I/O AND NO DATABASE. Every function here takes a string.
 */

/**
 * Blank out every `/* ... *\/` comment, preserving length and line breaks.
 *
 * @param {string} css
 * @returns {string} The same text with comment bytes turned into spaces.
 */
export function stripComments(css) {
  const source = String(css);
  let out = '';
  let index = 0;
  while (index < source.length) {
    if (source[index] === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let position = index; position < stop; position += 1) {
        out += source[position] === '\n' ? '\n' : ' ';
      }
      index = stop;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

/**
 * Index of the `}` matching the `{` at `open`.
 *
 * @param {string} source Comment-stripped CSS.
 * @param {number} open
 * @returns {number} `source.length` when the block is never closed.
 */
export function matchBrace(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

/**
 * Every TOP-LEVEL `@media` block, in source order.
 *
 * Order is part of the contract being tested - a `max-width: 600px` block that
 * lands before a `max-width: 860px` block is silently overridden by it - so
 * each result carries its offsets.
 *
 * @param {string} css
 * @returns {Array<{ prelude: string, body: string, start: number, end: number }>}
 */
export function mediaBlocks(css) {
  const source = stripComments(css);
  const out = [];
  const pattern = /@media\b/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf('{', match.index);
    if (open === -1) break;
    const close = matchBrace(source, open);
    out.push({
      prelude: source.slice(match.index + '@media'.length, open).trim(),
      body: source.slice(open + 1, close),
      start: match.index,
      end: close,
    });
    // Skip the whole block, so a nested at-rule is not reported as top level.
    pattern.lastIndex = close + 1;
  }
  return out;
}

/**
 * The stylesheet with every `@media` block removed - i.e. what applies at
 * EVERY viewport width.
 *
 * @param {string} css
 * @returns {string}
 */
export function outsideMediaQueries(css) {
  const source = stripComments(css);
  let out = '';
  let cursor = 0;
  for (const block of mediaBlocks(css)) {
    out += source.slice(cursor, block.start);
    cursor = block.end + 1;
  }
  return out + source.slice(cursor);
}

/**
 * Split a flat run of CSS into its rules.
 *
 * @param {string} css Comment-stripped CSS with no at-rule blocks in it.
 * @returns {Array<{ selectors: string[], body: string }>}
 */
export function eachRule(css) {
  const source = String(css);
  const out = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('{', index);
    if (open === -1) break;
    const close = matchBrace(source, open);
    out.push({
      selectors: source
        .slice(index, open)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
      body: source.slice(open + 1, close),
    });
    index = close + 1;
  }
  return out;
}

/**
 * Every rule whose selector list contains `selector` EXACTLY.
 *
 * Exact, so asking about `.btn` does not answer with `.btn-small` or
 * `.btn:hover`.
 *
 * @param {string} css
 * @param {string} selector
 * @returns {Array<{ selectors: string[], body: string }>}
 */
export function rulesFor(css, selector) {
  const wanted = String(selector).trim();
  return eachRule(css).filter((rule) => rule.selectors.includes(wanted));
}

/**
 * Declarations of a rule body as a lower-cased property map (last wins, as the
 * cascade would).
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function declarationsOf(body) {
  const out = {};
  for (const part of String(body).split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    if (name === '') continue;
    out[name] = part.slice(colon + 1).trim();
  }
  return out;
}

/**
 * The value a selector declares for a property, searching only the CSS handed
 * in (so the caller decides whether media blocks are in scope).
 *
 * @param {string} css
 * @param {string} selector
 * @param {string} property
 * @returns {string|null} `null` when no matching rule declares it.
 */
export function declaredValue(css, selector, property) {
  const wanted = String(property).toLowerCase();
  let found = null;
  for (const rule of rulesFor(css, selector)) {
    const value = declarationsOf(rule.body)[wanted];
    if (value !== undefined) found = value;
  }
  return found;
}
