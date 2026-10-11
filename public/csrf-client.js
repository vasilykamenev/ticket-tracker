/* Adds the CSRF token header to every same-origin state-changing request made by the AdminJS client.
   AdminJS uses XMLHttpRequest (axios); fetch is patched too. The token comes from GET /auth/csrf. */
(function () {
  'use strict';
  var token = null;
  var pending = null;
  var unsafe = /^(POST|PUT|PATCH|DELETE)$/i;
  var nativeFetch = window.fetch;

  function sameOrigin(url) {
    try {
      return new URL(url, window.location.href).origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }

  function getToken() {
    if (token) return Promise.resolve(token);
    if (!pending) {
      pending = nativeFetch
        .call(window, '/auth/csrf', { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('csrf token unavailable');
          return r.json();
        })
        .then(function (j) {
          token = j.token;
          pending = null;
          return token;
        })
        .catch(function (e) {
          pending = null;
          throw e;
        });
    }
    return pending;
  }

  window.fetch = function (input, init) {
    var method = (init && init.method) || (input && input.method) || 'GET';
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!unsafe.test(method) || !sameOrigin(url)) return nativeFetch.apply(this, arguments);
    return getToken().then(function (t) {
      var next = Object.assign({}, init);
      var headers = new Headers(next.headers || (input && input.headers));
      headers.set('X-CSRF-Token', t);
      next.headers = headers;
      return nativeFetch.call(window, input, next);
    });
  };

  var nativeOpen = XMLHttpRequest.prototype.open;
  var nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__csrfNeeded = unsafe.test(method) && sameOrigin(url);
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    if (!xhr.__csrfNeeded) return nativeSend.call(xhr, body);
    getToken().then(
      function (t) {
        xhr.setRequestHeader('X-CSRF-Token', t);
        nativeSend.call(xhr, body);
      },
      function () {
        xhr.dispatchEvent(new Event('error'));
      },
    );
  };
})();
