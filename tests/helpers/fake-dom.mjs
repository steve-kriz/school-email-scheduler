/**
 * A hand-rolled DOM stand-in, and a small HTML parser to build one from the
 * REAL `frontend/*.html` files.
 *
 * WHY THIS EXISTS. There is no DOM library in this repo - no jsdom, no
 * linkedom, at any level - and adding one is out of scope for a test change.
 * The frontend was written for exactly this situation: `createCalendarApp` and
 * `createSettingsPage` take their `document`, `fetch`, clock and timers by
 * injection, so the whole page can be driven from Node without a browser.
 *
 * WHY IT PARSES THE REAL HTML RATHER THAN HAND-BUILDING A FIXTURE. A fixture
 * assembled in JavaScript would assert against ids the test itself invented, so
 * it would keep passing after someone renamed `#attention-list` in the shipped
 * page. Parsing `frontend/index.html` and `frontend/settings.html` means the
 * scenarios run against the markup the Lambda actually serves: a removed id, a
 * `hidden` that stopped shipping, or a control moved out of `#settings-body` all
 * turn red here.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. `textContent` never parses markup - that is
 * the whole escaping story of the app, so the stand-in reproduces it exactly:
 * assigning `<img src=x onerror=alert(1)>` to `textContent` produces ONE text
 * node and no element. `findElements(doc, "img")` therefore proves the absence
 * of an injected element rather than merely the presence of some escaped text.
 *
 * `dispatch()` IS ASYNC AND AWAITS EVERY HANDLER. Several handlers in the app
 * are async (the disconnect submit, acknowledge, scan). A synchronous dispatch
 * would return before the fetch resolved and manufacture failures that say
 * nothing about the code.
 */

import * as fs from 'node:fs';

/** Elements that never have children or a closing tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is text, not markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/** Attributes whose mere presence means `true`. */
const BOOLEAN_ATTRIBUTES = new Set([
  'hidden', 'checked', 'disabled', 'selected', 'readonly',
  'multiple', 'novalidate', 'required', 'autofocus', 'open',
]);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/**
 * Decode the handful of entity forms the shipped pages use.
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  return String(text).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

/** A character-data node. It is the only thing `textContent =` can produce. */
export class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = value === null || value === undefined ? '' : String(value);
  }
}

/** An event object with the one method the settings form submit handler calls. */
export function makeEvent(type) {
  return {
    type,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

export class FakeElement {
  /**
   * @param {FakeDocument} ownerDocument
   * @param {string} tagName
   */
  constructor(ownerDocument, tagName) {
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.localName = String(tagName).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.listeners = new Map();
  }

  get id() {
    return this.attributes.get('id') ?? '';
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes.length > 0 ? this.childNodes[0] : null;
  }

  get lastChild() {
    return this.childNodes.length > 0 ? this.childNodes[this.childNodes.length - 1] : null;
  }

  /** Concatenated character data of the whole subtree - exactly like the real one. */
  get textContent() {
    let out = '';
    for (const child of this.childNodes) out += child.textContent;
    return out;
  }

  /**
   * Replace all children with a SINGLE text node. Nothing here parses markup;
   * that is the property the XSS scenarios rest on.
   */
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    const text = value === null || value === undefined ? '' : String(value);
    if (text !== '') this.appendChild(new FakeText(text));
  }

  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index !== -1) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const text = value === null || value === undefined ? '' : String(value);
    if (key === 'class') {
      this.className = text;
      return;
    }
    this.attributes.set(key, text);
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    if (key === 'class') return this.className === '' ? null : this.className;
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    const key = String(name).toLowerCase();
    if (key === 'class') return this.className !== '';
    return this.attributes.has(key);
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  addEventListener(type, handler) {
    const key = String(type);
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(String(type));
    if (!list) return;
    const index = list.indexOf(handler);
    if (index !== -1) list.splice(index, 1);
  }

  /** AWAITS every handler - see the file docblock. */
  async dispatch(type, event) {
    const list = [...(this.listeners.get(String(type)) || [])];
    const payload = event === undefined ? makeEvent(String(type)) : event;
    for (const handler of list) await handler(payload);
    return payload;
  }

  click() {
    return this.dispatch('click');
  }

  querySelector(selector) {
    return querySelectorFrom(this, selector, true);
  }

  querySelectorAll(selector) {
    return querySelectorFrom(this, selector, false);
  }
}

export class FakeDocument {
  constructor() {
    this.nodeType = 9;
    this.documentElement = null;
    this.body = null;
    this.head = null;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  createTextNode(data) {
    return new FakeText(data);
  }

  getElementById(id) {
    const wanted = String(id);
    let found = null;
    walk(this.documentElement, (node) => {
      if (found === null && node.attributes.get('id') === wanted) found = node;
    });
    return found;
  }

  querySelector(selector) {
    return querySelectorFrom(this.documentElement, selector, true, true);
  }

  querySelectorAll(selector) {
    return querySelectorFrom(this.documentElement, selector, false, true);
  }
}

/* =========================================================================
 * Tree walking and a small selector engine
 * ========================================================================= */

/**
 * Depth-first visit of every ELEMENT in a subtree, root excluded by default.
 *
 * @param {FakeElement|null} root
 * @param {(node: FakeElement) => void} visit
 * @param {boolean} [includeRoot]
 */
export function walk(root, visit, includeRoot = true) {
  if (!root || root.nodeType !== 1) return;
  if (includeRoot) visit(root);
  for (const child of root.childNodes) {
    if (child.nodeType === 1) walk(child, visit, true);
  }
}

/**
 * Every element in the document (or subtree) whose tag name matches.
 *
 * Used by the XSS scenarios: proving no `IMG` exists anywhere is a much
 * stronger statement than proving some string was escaped.
 *
 * @param {FakeDocument|FakeElement} scope
 * @param {string} tagName
 * @returns {FakeElement[]}
 */
export function findElements(scope, tagName) {
  const wanted = String(tagName).toUpperCase();
  const root = scope instanceof FakeDocument ? scope.documentElement : scope;
  const out = [];
  walk(root, (node) => {
    if (node.tagName === wanted) out.push(node);
  });
  return out;
}

/**
 * Every tag name present in the subtree, as a Set.
 *
 * @param {FakeDocument|FakeElement} scope
 * @returns {Set<string>}
 */
export function tagNames(scope) {
  const root = scope instanceof FakeDocument ? scope.documentElement : scope;
  const out = new Set();
  walk(root, (node) => out.add(node.tagName));
  return out;
}

/** Parse one compound selector, e.g. `button.chip[data-event-id="x"]`. */
function parseSimpleSelector(text) {
  const simple = { tag: null, ids: [], classes: [], attributes: [] };
  const pattern = /([a-zA-Z][\w-]*)|#([\w:-]+)|\.([\w-]+)|\[([^\]]+)\]/g;
  let match;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index !== index) return null;
    index = pattern.lastIndex;
    if (match[1] !== undefined) simple.tag = match[1].toUpperCase();
    else if (match[2] !== undefined) simple.ids.push(match[2]);
    else if (match[3] !== undefined) simple.classes.push(match[3]);
    else {
      const attribute = /^([\w:-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*([^\]]+))?$/.exec(match[4].trim());
      if (!attribute) return null;
      simple.attributes.push([attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? null]);
    }
  }
  return index === text.length ? simple : null;
}

function matchesSimple(node, simple) {
  if (!node || node.nodeType !== 1 || !simple) return false;
  if (simple.tag !== null && node.tagName !== simple.tag) return false;
  for (const id of simple.ids) if (node.attributes.get('id') !== id) return false;
  const classes = String(node.className || '').split(/\s+/).filter(Boolean);
  for (const cls of simple.classes) if (!classes.includes(cls)) return false;
  for (const [name, value] of simple.attributes) {
    if (!node.hasAttribute(name)) return false;
    if (value !== null && node.getAttribute(name) !== value) return false;
  }
  return true;
}

function matchesChain(node, chain) {
  if (!matchesSimple(node, chain[chain.length - 1])) return false;
  let ancestor = node.parentNode;
  let position = chain.length - 2;
  while (position >= 0) {
    if (!ancestor || ancestor.nodeType !== 1) return false;
    if (matchesSimple(ancestor, chain[position])) position -= 1;
    ancestor = ancestor.parentNode;
  }
  return true;
}

function querySelectorFrom(root, selector, single, includeRoot = false) {
  const chains = String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/).map(parseSimpleSelector));

  for (const chain of chains) {
    for (const simple of chain) {
      if (simple === null) throw new Error(`fake-dom: unsupported selector "${selector}"`);
    }
  }

  const out = [];
  const visit = (node) => {
    if (out.length > 0 && single) return;
    for (const chain of chains) {
      if (matchesChain(node, chain)) {
        out.push(node);
        return;
      }
    }
  };

  if (root) {
    if (includeRoot) walk(root, visit, true);
    else for (const child of root.childNodes) if (child.nodeType === 1) walk(child, visit, true);
  }

  return single ? (out.length > 0 ? out[0] : null) : out;
}

/* =========================================================================
 * The parser
 * ========================================================================= */

function findTagEnd(source, start) {
  let index = start + 1;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
    index += 1;
  }
  return source.length;
}

function parseAttributes(source) {
  const out = [];
  const pattern = /([a-zA-Z_:@][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const raw = match[2] ?? match[3] ?? match[4];
    out.push([match[1], raw === undefined ? null : decodeEntities(raw)]);
  }
  return out;
}

function applyParsedAttribute(node, name, rawValue) {
  const key = String(name).toLowerCase();
  const value = rawValue === null ? '' : rawValue;
  node.setAttribute(key, value);
  if (BOOLEAN_ATTRIBUTES.has(key)) node[key === 'readonly' ? 'readOnly' : key] = true;
  if (key === 'value') node.value = value;
}

/**
 * Turn an HTML string into a `FakeDocument`.
 *
 * @param {string} html
 * @returns {FakeDocument}
 */
export function parseHtml(html) {
  const doc = new FakeDocument();
  const root = new FakeElement(doc, 'fake-root');
  const stack = [root];
  const source = String(html);
  let index = 0;

  const top = () => stack[stack.length - 1];
  const addText = (text) => {
    if (text === '') return;
    top().appendChild(new FakeText(decodeEntities(text)));
  };

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt === -1) {
      addText(source.slice(index));
      break;
    }
    if (lt > index) addText(source.slice(index, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt);
      const name = source.slice(lt + 2, end === -1 ? source.length : end).trim().toLowerCase();
      for (let position = stack.length - 1; position >= 1; position -= 1) {
        if (stack[position].localName === name) {
          stack.length = position;
          break;
        }
      }
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const end = findTagEnd(source, lt);
    let inner = source.slice(lt + 1, end);
    const selfClosing = inner.trimEnd().endsWith('/');
    if (selfClosing) inner = inner.trimEnd().slice(0, -1);

    const nameMatch = /^([a-zA-Z][\w:-]*)/.exec(inner);
    if (!nameMatch) {
      index = end + 1;
      continue;
    }
    const tagName = nameMatch[1].toLowerCase();
    const element = new FakeElement(doc, tagName);
    for (const [name, value] of parseAttributes(inner.slice(nameMatch[1].length))) {
      applyParsedAttribute(element, name, value);
    }
    top().appendChild(element);
    index = end + 1;

    if (VOID_ELEMENTS.has(tagName) || selfClosing) continue;

    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      const closer = new RegExp(`</${tagName}\\s*>`, 'i');
      const rest = source.slice(index);
      const closeMatch = closer.exec(rest);
      const body = closeMatch ? rest.slice(0, closeMatch.index) : rest;
      if (body !== '') element.appendChild(new FakeText(body));
      if (tagName === 'textarea') element.value = decodeEntities(body).trim();
      index += closeMatch ? closeMatch.index + closeMatch[0].length : rest.length;
      continue;
    }

    stack.push(element);
  }

  const html_ = root.children.find((node) => node.localName === 'html') || root;
  doc.documentElement = html_;
  walk(html_, (node) => {
    if (doc.body === null && node.localName === 'body') doc.body = node;
    if (doc.head === null && node.localName === 'head') doc.head = node;
  });

  // A <select>'s value is its selected option's value, or the first option's.
  walk(html_, (node) => {
    if (node.localName !== 'select') return;
    const options = findElements(node, 'option');
    const selected = options.find((option) => option.selected === true) || options[0];
    node.value = selected ? (selected.getAttribute('value') ?? selected.textContent.trim()) : '';
  });

  return doc;
}

/**
 * Parse a file from disk into a `FakeDocument`.
 *
 * @param {string} filePath
 * @returns {FakeDocument}
 */
export function loadDocument(filePath) {
  return parseHtml(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Collapsed visible text of a node, for readable assertions.
 *
 * @param {FakeElement|FakeText|null} node
 * @returns {string}
 */
export function textOf(node) {
  return node ? String(node.textContent).replace(/\s+/g, ' ').trim() : '';
}
