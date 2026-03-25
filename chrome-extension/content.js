/**
 * NoobClaw Browser Assistant — Content Script
 * Handles DOM operations: read, click, type, scroll, find, fill, get_text.
 */

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

function clickElement(params) {
  let el;
  if (params.selector) {
    el = document.querySelector(params.selector);
  } else if (params.coordinate) {
    el = document.elementFromPoint(params.coordinate[0], params.coordinate[1]);
  }
  if (!el) return { error: 'Element not found' };

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.click();
  return { message: `Clicked ${el.tagName.toLowerCase()}` };
}

function typeText(params) {
  let el = params.selector ? document.querySelector(params.selector) : document.activeElement;
  if (!el) return { error: 'No element to type into' };

  el.focus();
  for (const char of params.text) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value += char;
    } else if (el.isContentEditable) {
      document.execCommand('insertText', false, char);
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
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
  const el = document.querySelector(params.selector);
  if (!el) return { error: `Element not found: ${params.selector}` };

  // Security: refuse password fields
  if (el.type === 'password') {
    return { error: 'Cannot interact with password fields for security reasons.' };
  }

  if (el.tagName === 'SELECT') {
    const option = Array.from(el.options).find(o => o.value === params.value || o.text === params.value);
    if (option) {
      el.value = option.value;
    } else {
      el.value = params.value;
    }
  } else {
    el.value = params.value;
  }

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { message: `Filled ${el.tagName.toLowerCase()} with value` };
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
