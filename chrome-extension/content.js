/**
 * NoobClaw Browser Assistant — Content Script
 */
if (window.__noobclaw_injected) { /* skip */ } else {
window.__noobclaw_injected = true;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { command, params } = msg;

  (async () => {
    try {
      let result;
      switch (command) {
        case 'read_page':
          result = readPage(params);
          break;
        case 'get_text':
          result = getText();
          break;
        case 'click':
          result = clickElement(params);
          break;
        case 'type':
          result = typeText(params);
          break;
        case 'scroll':
          result = scrollPage(params);
          break;
        case 'find':
          result = findElements(params);
          break;
        case 'fill':
          result = fillInput(params);
          break;
        case 'hover':
          result = hoverElement(params);
          break;
        case 'keypress':
          result = pressKey(params);
          break;
        case 'wait_for':
          result = await waitForElement(params);
          break;
        case 'get_value':
          result = getElementValue(params);
          break;
        case 'select_option':
          result = selectOption(params);
          break;
        case 'get_url':
          result = { url: window.location.href, title: document.title };
          break;
        case 'javascript':
          result = await executeJavascript(params);
          break;
        case 'drag':
          result = dragElement(params);
          break;
        case 'read_console':
          result = readConsole(params);
          break;
        case 'get_cookies':
          result = { cookies: document.cookie };
          break;
        case 'double_click':
          result = doubleClickElement(params);
          break;
        case 'right_click':
          result = rightClickElement(params);
          break;
        case 'scroll_to':
          result = scrollToElement(params);
          break;
        case 'get_page_info':
          result = getPageInfo();
          break;
        case 'upload_file':
          result = uploadFile(params);
          break;
        case 'triple_click':
          result = tripleClickElement(params);
          break;
        // ── Scenario automation commands (no eval, CSP-safe) ──
        case 'click_by_text':
          result = clickByText(params);
          break;
        case 'read_feed_cards':
          result = readFeedCards();
          break;
        case 'read_detail_page':
          result = readDetailPage();
          break;
        case 'check_anomaly':
          result = checkPageAnomaly();
          break;
        default:
          result = { error: `Unknown command: ${command}` };
      }
      sendResponse(result);
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  })();

  return true; // keep sendResponse alive for async
});

function readPage(params) {
  const root = params?.selector ? document.querySelector(params.selector) : document.body;
  if (!root) return { tree: [], error: 'Element not found' };

  const interactiveOnly = params?.filter === 'interactive';
  const elements = [];
  const maxElements = 500;

  function walk(node, depth) {
    if (elements.length >= maxElements) return;
    if (depth > 15) return;
    if (node.nodeType !== 1) return;

    const el = node;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const isInteractive = ['a', 'button', 'input', 'textarea', 'select', 'details', 'summary'].includes(tag)
      || el.hasAttribute('onclick') || el.hasAttribute('tabindex')
      || ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab'].includes(role);

    if (interactiveOnly && !isInteractive) {
      for (const child of el.children) walk(child, depth + 1);
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      for (const child of el.children) walk(child, depth + 1);
      return;
    }

    const info = {
      tag,
      role: role || undefined,
      text: (el.textContent || '').trim().slice(0, 100),
      selector: getSelector(el),
      type: el.getAttribute('type') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      href: el.getAttribute('href') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };

    // Clean undefined
    Object.keys(info).forEach(k => info[k] === undefined && delete info[k]);
    elements.push(info);

    if (!interactiveOnly) {
      for (const child of el.children) walk(child, depth + 1);
    }
  }

  walk(root, 0);
  return { elements };
}

function getText() {
  // Try article content first
  const article = document.querySelector('article') || document.querySelector('[role="main"]') || document.querySelector('main');
  const target = article || document.body;
  return { text: target.innerText.trim().slice(0, 50000) };
}

function resolveElement(params) {
  if (params.selector) {
    // Try normal DOM first, then pierce one level of shadow DOM
    let el = document.querySelector(params.selector);
    if (!el) {
      for (const host of document.querySelectorAll('*')) {
        if (host.shadowRoot) {
          el = host.shadowRoot.querySelector(params.selector);
          if (el) break;
        }
      }
    }
    return el;
  }
  if (params.coordinate) {
    return document.elementFromPoint(params.coordinate[0], params.coordinate[1]);
  }
  return null;
}

function fireMouseSequence(el, extra = {}) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const init = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, ...extra };
  el.dispatchEvent(new MouseEvent('mouseover',  init));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
  el.dispatchEvent(new MouseEvent('mousemove',  init));
  el.dispatchEvent(new MouseEvent('mousedown',  init));
  el.focus && el.focus({ preventScroll: true });
  el.dispatchEvent(new MouseEvent('mouseup',    init));
  el.dispatchEvent(new MouseEvent('click',      init));
}

function clickElement(params) {
  const el = resolveElement(params);
  if (!el) return { error: 'Element not found' };

  // Scroll into view synchronously (instant), then fire full event sequence
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  fireMouseSequence(el);
  // Fallback: also call native .click() for elements that only listen to it
  if (typeof el.click === 'function') el.click();
  return { message: `Clicked ${el.tagName.toLowerCase()}` };
}

function setNativeValue(el, value) {
  // React/Vue override the native setter, so we must go through the original descriptor
  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
}

function typeText(params) {
  let el = params.selector ? resolveElement(params) : document.activeElement;
  if (!el) return { error: 'No element to type into' };

  el.focus();
  el.click();

  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const current = el.value || '';
    setNativeValue(el, current + params.text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.focus();
    // Use Selection API for contenteditable (works in React rich-text editors)
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, params.text);
  } else {
    // Fallback: dispatch individual keydown/keypress/keyup
    for (const char of params.text) {
      el.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup',    { key: char, bubbles: true, cancelable: true }));
    }
  }
  return { message: `Typed ${params.text.length} characters` };
}

function scrollPage(params) {
  const amount = (params.amount || 3) * 200;
  const map = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] };
  const [x, y] = map[params.direction] || [0, 0];
  window.scrollBy({ left: x, top: y, behavior: 'smooth' });
  return { message: `Scrolled ${params.direction}` };
}

function findElements(params) {
  const query = params.query.toLowerCase();
  const results = [];
  const allElements = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [onclick], [tabindex], h1, h2, h3, h4, h5, h6, label, img');

  for (const el of allElements) {
    if (results.length >= 20) break;

    const text = (el.textContent || '').trim().toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const alt = (el.getAttribute('alt') || '').toLowerCase();
    const name = (el.getAttribute('name') || '').toLowerCase();

    const match = text.includes(query) || ariaLabel.includes(query) || placeholder.includes(query) || title.includes(query) || alt.includes(query) || name.includes(query);

    if (match) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      results.push({
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 100),
        selector: getSelector(el),
        ariaLabel: el.getAttribute('aria-label') || undefined,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }
  }
  return { elements: results };
}

function fillInput(params) {
  const el = resolveElement(params);
  if (!el) return { error: `Element not found: ${params.selector}` };

  // Security: refuse password fields
  if (el.type === 'password') {
    return { error: 'Cannot interact with password fields for security reasons.' };
  }

  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  el.focus();

  if (el.tagName === 'SELECT') {
    const option = Array.from(el.options).find(o => o.value === params.value || o.text === params.value);
    el.value = option ? option.value : params.value;
  } else {
    // React/Vue-compatible: use native setter so framework state updates
    setNativeValue(el, params.value);
  }

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { message: `Filled ${el.tagName.toLowerCase()} with value` };
}

function hoverElement(params) {
  const el = resolveElement(params);
  if (!el) return { error: 'Element not found' };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const init = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
  el.dispatchEvent(new MouseEvent('mouseover',  init));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
  el.dispatchEvent(new MouseEvent('mousemove',  init));
  return { message: `Hovered ${el.tagName.toLowerCase()}` };
}

function pressKey(params) {
  const target = params.selector ? resolveElement(params) : document.activeElement || document.body;
  const key = params.key || 'Enter';
  const keyMap = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'Space': { key: ' ', code: 'Space', keyCode: 32 },
  };
  const k = keyMap[key] || { key, code: key, keyCode: 0 };
  const opts = { key: k.key, code: k.code, keyCode: k.keyCode, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keypress', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
  return { message: `Pressed ${key}` };
}

async function waitForElement(params) {
  const timeout = params.timeout || 5000;
  const selector = params.selector;
  if (!selector) return { error: 'selector is required' };
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) {
      const rect = el.getBoundingClientRect();
      return { found: true, selector, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return { found: false, selector, error: `Element ${selector} not found within ${timeout}ms` };
}

function getElementValue(params) {
  const el = params.selector ? document.querySelector(params.selector) : null;
  if (!el) return { error: 'Element not found' };
  return {
    tag: el.tagName.toLowerCase(),
    value: el.value !== undefined ? el.value : null,
    text: (el.textContent || '').trim().slice(0, 500),
    checked: el.checked !== undefined ? el.checked : null,
    selected: el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text : null,
    href: el.getAttribute('href'),
    src: el.getAttribute('src'),
    attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
  };
}

function selectOption(params) {
  const el = params.selector ? document.querySelector(params.selector) : null;
  if (!el || el.tagName !== 'SELECT') return { error: 'SELECT element not found' };
  const option = Array.from(el.options).find(o => o.value === params.value || o.text.trim() === params.value);
  if (!option) return { error: `Option "${params.value}" not found` };
  el.value = option.value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { message: `Selected "${option.text}"` };
}

async function executeJavascript(params) {
  try {
    const fn = new Function(params.code);
    const result = await fn();
    return { result: result !== undefined ? String(result) : 'undefined' };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

function dragElement(params) {
  const fromEl = params.from_selector ? resolveElement({ selector: params.from_selector }) : null;
  const toEl   = params.to_selector   ? resolveElement({ selector: params.to_selector })   : null;
  if (!fromEl) return { error: 'Source element not found' };

  const fromRect = fromEl.getBoundingClientRect();
  const startX = fromRect.x + fromRect.width / 2;
  const startY = fromRect.y + fromRect.height / 2;
  let endX, endY;
  if (toEl) {
    const toRect = toEl.getBoundingClientRect();
    endX = toRect.x + toRect.width / 2;
    endY = toRect.y + toRect.height / 2;
  } else if (params.to_coordinate) {
    [endX, endY] = params.to_coordinate;
  } else {
    return { error: 'Must provide to_selector or to_coordinate' };
  }

  // Start: mousedown + HTML5 dragstart
  const dt = new DataTransfer();
  fromEl.dispatchEvent(new MouseEvent('mousedown', { clientX: startX, clientY: startY, bubbles: true, cancelable: true }));
  fromEl.dispatchEvent(new DragEvent('dragstart',  { clientX: startX, clientY: startY, bubbles: true, cancelable: true, dataTransfer: dt }));

  // Intermediate steps: mousemove + drag + dragover on whatever is under cursor
  const STEPS = 6;
  for (let i = 1; i <= STEPS; i++) {
    const ix = startX + (endX - startX) * (i / STEPS);
    const iy = startY + (endY - startY) * (i / STEPS);
    const overEl = document.elementFromPoint(ix, iy) || fromEl;
    fromEl.dispatchEvent(new MouseEvent('mousemove', { clientX: ix, clientY: iy, bubbles: true }));
    fromEl.dispatchEvent(new DragEvent('drag',       { clientX: ix, clientY: iy, bubbles: true, dataTransfer: dt }));
    overEl.dispatchEvent(new DragEvent('dragover',   { clientX: ix, clientY: iy, bubbles: true, cancelable: true, dataTransfer: dt }));
  }

  // End: drop + dragend + mouseup
  const dropTarget = toEl || document.elementFromPoint(endX, endY) || fromEl;
  dropTarget.dispatchEvent(new DragEvent('drop',   { clientX: endX, clientY: endY, bubbles: true, cancelable: true, dataTransfer: dt }));
  fromEl.dispatchEvent(new DragEvent('dragend',    { clientX: endX, clientY: endY, bubbles: true, dataTransfer: dt }));
  fromEl.dispatchEvent(new MouseEvent('mouseup',   { clientX: endX, clientY: endY, bubbles: true }));

  return { message: `Dragged from (${Math.round(startX)},${Math.round(startY)}) to (${Math.round(endX)},${Math.round(endY)})` };
}

const consoleLogs = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
['log', 'warn', 'error', 'info'].forEach(level => {
  console[level] = (...args) => {
    consoleLogs.push({ level, message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), timestamp: Date.now() });
    if (consoleLogs.length > 200) consoleLogs.shift();
    originalConsole[level](...args);
  };
});

function readConsole(params) {
  let logs = consoleLogs;
  if (params?.level) logs = logs.filter(l => l.level === params.level);
  if (params?.pattern) {
    const re = new RegExp(params.pattern, 'i');
    logs = logs.filter(l => re.test(l.message));
  }
  const limit = params?.limit || 50;
  return { logs: logs.slice(-limit) };
}

function doubleClickElement(params) {
  const el = resolveElement(params);
  if (!el) return { error: 'Element not found' };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  fireMouseSequence(el, { detail: 1 });
  fireMouseSequence(el, { detail: 2 });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, detail: 2 }));
  return { message: `Double-clicked ${el.tagName.toLowerCase()}` };
}

function rightClickElement(params) {
  const el = resolveElement(params);
  if (!el) return { error: 'Element not found' };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // Hover first so the element knows the mouse arrived
  const hoverInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
  el.dispatchEvent(new MouseEvent('mouseover',  hoverInit));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...hoverInit, bubbles: false }));
  el.dispatchEvent(new MouseEvent('mousemove',  hoverInit));
  const init = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 2, buttons: 2 };
  el.dispatchEvent(new MouseEvent('mousedown',   init));
  el.dispatchEvent(new MouseEvent('mouseup',     init));
  el.dispatchEvent(new MouseEvent('contextmenu', init));
  return { message: `Right-clicked ${el.tagName.toLowerCase()}` };
}

function scrollToElement(params) {
  const el = params.selector ? document.querySelector(params.selector) : null;
  if (!el) return { error: 'Element not found' };
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return { message: `Scrolled to ${el.tagName.toLowerCase()}` };
}

function getPageInfo() {
  return {
    url: window.location.href,
    title: document.title,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    forms: document.forms.length,
    links: document.links.length,
    images: document.images.length,
    scripts: document.scripts.length,
  };
}

function getSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;

  // Try data-testid
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  // Build path
  const parts = [];
  let current = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(selector);
    current = parent;
  }
  return parts.join(' > ');
}

function uploadFile(params) {
  const selector = params.selector || params.ref;
  let input;
  if (selector) {
    input = document.querySelector(selector);
  } else {
    input = document.querySelector('input[type="file"]');
  }
  if (!input || input.tagName !== 'INPUT' || input.type !== 'file') {
    return { error: 'No file input found. Provide a selector for the file input element.' };
  }
  if (!params.fileData || !params.fileName) {
    return { error: 'fileData (base64) and fileName are required.' };
  }
  try {
    const byteChars = atob(params.fileData);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
    const mimeType = params.mimeType || 'application/octet-stream';
    const file = new File([byteArray], params.fileName, { type: mimeType });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { message: `Uploaded ${params.fileName} (${byteArray.length} bytes)` };
  } catch (e) {
    return { error: `Upload failed: ${e.message}` };
  }
}

function tripleClickElement(params) {
  const el = resolveElement(params);
  if (!el) return { error: 'Element not found' };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  fireMouseSequence(el, { detail: 1 });
  fireMouseSequence(el, { detail: 2 });
  fireMouseSequence(el, { detail: 3 });
  return { message: `Triple-clicked ${el.tagName.toLowerCase()}` };
}
// ═══════════════════════════════════════════════════════════
// Scenario automation commands — CSP-safe (no eval/new Function)
// These run directly in the content script's isolated world
// and access page DOM via standard DOM APIs.
// ═══════════════════════════════════════════════════════════

/**
 * click_by_text — find element by visible text, return coordinates.
 * params: { target: "图文" }
 * Returns: { found: true, x, y, tag, cls } or { found: false }
 */
function clickByText(params) {
  const target = params.target || params.text || '';
  if (!target) return { found: false, error: 'no target text' };

  let best = null;
  let bestArea = Infinity;
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const t = (el.textContent || '').trim();
    if (t !== target) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.top > 500) continue;
    const area = rect.width * rect.height;
    if (area < bestArea) {
      best = el;
      bestArea = area;
    }
  }

  if (best) {
    const r = best.getBoundingClientRect();
    return {
      found: true,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      tag: best.tagName,
      cls: (best.className || '').toString().split(' ')[0],
    };
  }
  return { found: false };
}

/**
 * read_feed_cards — extract note cards from XHS feed/search pages.
 * Returns: { cards: FeedCard[] }
 */
function readFeedCards() {
  const out = [];
  const seen = {};
  const idRe = /\/([a-f0-9]{24})(?:\?|$)/i;
  const allLinks = document.querySelectorAll('a[href]');

  for (let i = 0; i < allLinks.length; i++) {
    const a = allLinks[i];
    const href = a.getAttribute('href') || '';
    const idMatch = href.match(idRe);
    if (!idMatch || !idMatch[1]) continue;
    const noteId = idMatch[1];
    if (seen[noteId]) continue;

    const card = a.closest('section, [class*="note"], [class*="card"], [class*="feed"]') || a;
    const rect = card.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 80) continue;
    seen[noteId] = true;

    const isVideo = !!card.querySelector('.play-icon, [class*="video-icon"], [class*="play"]');
    const titleEl = card.querySelector('.title, [class*="title"], .note-text, a span');
    const likesEl = card.querySelector('.like-wrapper .count, .count, [class*="like"] span, [class*="like-count"]');

    let title = '';
    if (titleEl) {
      title = (titleEl.textContent || '').trim().slice(0, 200);
    } else {
      title = (a.textContent || '').trim().slice(0, 200);
    }

    out.push({
      post_id: noteId,
      url: href.startsWith('http') ? href : 'https://www.xiaohongshu.com' + href,
      title: title,
      likes_text: likesEl ? (likesEl.textContent || '').trim() : '0',
      is_video: isVideo,
    });
  }
  return { cards: out };
}

/**
 * read_detail_page — extract full post details from XHS note detail page.
 * Returns: { title, body, images, publish_time, hashtags, author_name, author_followers_text }
 */
function readDetailPage() {
  function text(sels) {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) return (el.textContent || '').trim();
    }
    return '';
  }
  function many(sel, attr) {
    const arr = [];
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const v = attr ? el.getAttribute(attr) : (el.textContent || '').trim();
      if (v) arr.push(v);
    }
    return arr;
  }
  return {
    title: text(['#detail-title', 'h1.title', '[class*="title"]']),
    body: text(['#detail-desc', '.content', '[class*="desc"]']),
    images: many('.carousel .slide img, [class*="swiper-slide"] img', 'src'),
    publish_time: text(['.publish-date', '.date', 'time']),
    hashtags: many('.hash-tag, a[href*="page/topics/"]', null),
    author_name: text(['.author .name', '.user .name']),
    author_followers_text: text(['.follower-count']),
  };
}

/**
 * check_anomaly — detect captcha, login wall, rate limiting.
 * Returns: { status: 'ok' | 'captcha' | 'login_wall' | 'rate_limited' | 'account_flag' }
 */
function checkPageAnomaly() {
  const body = document.body ? (document.body.innerText || '') : '';
  const url = location.href || '';

  if (document.querySelector('.captcha-slider, .nc_iconfont, iframe[src*="captcha"]')) {
    return { status: 'captcha' };
  }
  if (/\/login|\/signin/i.test(url) || document.querySelector('.login-container, [class*="login-panel"]')) {
    return { status: 'login_wall' };
  }
  if (body.includes('操作过于频繁') || body.includes('访问频率')) {
    return { status: 'rate_limited' };
  }
  if (body.includes('账号异常') || body.includes('暂时限流')) {
    return { status: 'account_flag' };
  }
  return { status: 'ok' };
}

} // end __noobclaw_injected guard
