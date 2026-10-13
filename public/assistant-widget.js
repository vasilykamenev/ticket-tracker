/* Field help for the admin panel (requirements section 12), loaded only when AI_ENABLED=true.
   A small button opens a panel: pick a field of the current screen, ask a question, read the answer. The server
   decides what the person may ask about and answers from the field catalog; if the AI cannot answer, the panel shows
   the field's static help. Everything from the server is written with textContent, so an answer is never HTML.
   It uses window.fetch at call time: csrf-client.js has already patched it to send the CSRF header. */
(function () {
  'use strict';

  var MAX = 1000;
  var screens = /^\/app\/resources\/([A-Za-z]+)(?:\/|$)/;
  var state = { resource: null, fields: [], lastField: null, open: false, busy: false };
  var els = {};

  function currentResource() {
    var m = screens.exec(window.location.pathname);
    return m ? m[1] : null;
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') node.textContent = props[k];
      else if (k === 'style') node.setAttribute('style', props[k]);
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) {
      node.appendChild(c);
    });
    return node;
  }

  function build() {
    var css = el('style', {
      text:
        '#tt-ai-button{position:fixed;right:20px;bottom:20px;z-index:2000;width:44px;height:44px;border-radius:50%;border:0;background:#3040d6;color:#fff;font:600 20px/1 Roboto,Arial,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
        '#tt-ai-button:focus-visible{outline:3px solid #9aa5ff;outline-offset:2px}' +
        '#tt-ai-panel{position:fixed;right:20px;bottom:76px;z-index:2000;width:min(380px,calc(100vw - 40px));max-height:calc(100vh - 110px);overflow:auto;background:#fff;color:#212529;border:1px solid #d5d8e2;border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,.22);padding:16px;font:14px/1.45 Roboto,Arial,sans-serif}' +
        '#tt-ai-panel h2{margin:0 0 4px;font-size:16px}' +
        '#tt-ai-panel p.tt-ai-note{margin:0 0 12px;color:#5b6070;font-size:12px}' +
        '#tt-ai-panel label{display:block;margin:10px 0 4px;font-size:12px;color:#5b6070}' +
        '#tt-ai-panel select,#tt-ai-panel textarea{width:100%;box-sizing:border-box;border:1px solid #c0c0ca;border-radius:4px;padding:8px;font:inherit;background:#fff;color:#212529}' +
        '#tt-ai-panel textarea{min-height:76px;resize:vertical}' +
        '#tt-ai-panel button.tt-ai-ask{margin-top:10px;height:34px;padding:0 18px;border:0;border-radius:4px;background:#3040d6;color:#fff;font:inherit;cursor:pointer}' +
        '#tt-ai-panel button.tt-ai-ask[disabled]{opacity:.55;cursor:default}' +
        '#tt-ai-answer{margin-top:12px;white-space:pre-wrap;word-wrap:break-word}' +
        '#tt-ai-answer .tt-ai-msg{color:#8a4b00;margin-bottom:6px}' +
        '#tt-ai-answer .tt-ai-help{border-left:3px solid #c9cdf5;padding-left:10px;color:#2c3040}' +
        '#tt-ai-answer .tt-ai-err{color:#b00020}' +
        '.tt-ai-hidden{display:none!important}',
    });
    var button = el('button', { id: 'tt-ai-button', type: 'button', 'aria-label': 'Ask about a field', 'aria-expanded': 'false', title: 'Ask about a field', text: '?' });
    var select = el('select', { id: 'tt-ai-field' });
    var question = el('textarea', { id: 'tt-ai-question', maxlength: String(MAX), placeholder: 'What do you want to know about this field?' });
    var ask = el('button', { type: 'button', class: 'tt-ai-ask', text: 'Ask' });
    var answer = el('div', { id: 'tt-ai-answer', 'aria-live': 'polite' });
    var panel = el(
      'div',
      { id: 'tt-ai-panel', class: 'tt-ai-hidden', role: 'dialog', 'aria-label': 'Field help' },
      [
        el('h2', { text: 'Field help' }),
        el('p', { class: 'tt-ai-note', text: 'Answers come from the field descriptions of this application. An AI writes them and can be wrong: check anything important.' }),
        el('label', { for: 'tt-ai-field', text: 'Field' }),
        select,
        el('label', { for: 'tt-ai-question', text: 'Your question' }),
        question,
        ask,
        answer,
      ],
    );
    document.head.appendChild(css);
    document.body.appendChild(button);
    document.body.appendChild(panel);
    els = { button: button, panel: panel, select: select, question: question, ask: ask, answer: answer };

    button.addEventListener('click', toggle);
    ask.addEventListener('click', submit);
    question.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) toggle();
    });
    // Remember which form field the person was in, to preselect it. Only fields of the form count: the widget's own
    // button takes the focus when it is clicked and must not replace the field.
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      var holder = t && t.closest ? t.closest('[data-testid^="property-edit-"]') : null;
      if (holder) state.lastField = holder.getAttribute('data-testid').replace('property-edit-', '');
    });
  }

  function setAnswer(nodes) {
    els.answer.textContent = '';
    nodes.forEach(function (n) {
      els.answer.appendChild(n);
    });
  }

  function helpNode(help) {
    var box = el('div', { class: 'tt-ai-help' });
    box.appendChild(el('div', { text: help.label, style: 'font-weight:600' }));
    (help.lines || []).forEach(function (line) {
      box.appendChild(el('div', { text: line }));
    });
    return box;
  }

  function loadFields() {
    state.resource = currentResource();
    els.select.textContent = '';
    state.fields = [];
    if (!state.resource) return Promise.resolve();
    return window
      .fetch('/internal/assistant/fields?resourceId=' + encodeURIComponent(state.resource), { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.ok ? r.json() : { fields: [] };
      })
      .then(function (data) {
        state.fields = data.fields || [];
        state.fields.forEach(function (f) {
          els.select.appendChild(el('option', { value: f.id, text: f.label }));
        });
        var wanted = state.fields.some(function (f) {
          return f.id === state.lastField;
        });
        if (wanted) els.select.value = state.lastField;
      })
      .catch(function () {
        state.fields = [];
      });
  }

  function toggle() {
    state.open = !state.open;
    els.panel.classList.toggle('tt-ai-hidden', !state.open);
    els.button.setAttribute('aria-expanded', String(state.open));
    if (state.open) {
      setAnswer([]);
      loadFields().then(function () {
        els.question.focus();
      });
    } else {
      els.button.focus();
    }
  }

  function submit() {
    var text = els.question.value.trim();
    if (state.busy || !state.resource || !text || !els.select.value) return;
    state.busy = true;
    els.ask.disabled = true;
    setAnswer([el('div', { text: 'Thinking…' })]);
    window
      .fetch('/internal/assistant', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ resourceId: state.resource, fieldId: els.select.value, question: text }),
      })
      .then(function (r) {
        return r.json().then(
          function (data) {
            return { status: r.status, data: data };
          },
          function () {
            return { status: r.status, data: {} };
          },
        );
      })
      .then(function (res) {
        var d = res.data || {};
        if (res.status === 200 && d.available) {
          setAnswer([el('div', { text: d.answer })]);
        } else if (res.status === 200 || res.status === 429) {
          var nodes = [el('div', { class: 'tt-ai-msg', text: d.message || 'The AI help is not available right now.' })];
          if (d.help) nodes.push(helpNode(d.help));
          setAnswer(nodes);
        } else if (res.status === 404) {
          setAnswer([el('div', { class: 'tt-ai-err', text: 'There is no help for this field.' })]);
        } else {
          setAnswer([el('div', { class: 'tt-ai-err', text: 'Something went wrong. Try again.' })]);
        }
      })
      .catch(function () {
        setAnswer([el('div', { class: 'tt-ai-err', text: 'The help could not be reached.' })]);
      })
      .then(function () {
        state.busy = false;
        els.ask.disabled = false;
      });
  }

  // AdminJS is a single-page app: show the button only on screens that have fields, and close the panel when leaving.
  function sync() {
    var resource = currentResource();
    var visible = !!resource;
    els.button.classList.toggle('tt-ai-hidden', !visible);
    if (!visible && state.open) toggle();
    if (visible && state.open && resource !== state.resource) loadFields();
  }

  function start() {
    build();
    sync();
    window.setInterval(sync, 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
