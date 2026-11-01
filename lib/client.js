'use strict';

/**
 * Runtime injected into every proxied HTML page.
 *
 * It keeps the visitor inside the proxy by:
 *   - rewriting anchors / dynamically added resources to proxy paths
 *   - patching fetch(), XHR, sendBeacon, window.open, history.*, Location.*
 *   - rendering a small floating toolbar with a URL bar
 *
 * NOTE: written with String.raw and deliberately without template literals so
 * `${` / backticks never collide with the outer template.
 */
const CLIENT_RUNTIME = String.raw`
(function () {
  "use strict";

  var PROXY_BASE = "__PROXY_BASE__";
  var PAGE_URL = "__PROXY_URL__";
  var TOKEN = "__PROXY_TOKEN__";

  /* Token format matches the server exactly: the host, with the port when
     there is one. The scheme is not part of the token, so http:// and
     https:// variants of the same site always resolve to the same URL and
     the browser never loads a script twice. */
  function tokenFor(origin) {
    try {
      return new URL(origin).host.toLowerCase();
    } catch (e) {
      return "";
    }
  }

  var SKIP_RE = /^(data|mailto|tel|sms|javascript|blob|about|ftp|file|ws|wss|magnet|news|irc|intent|market|chrome-extension|moz-extension|about:blank)/i;

  function toProxy(url) {
    if (typeof url !== "string") return null;
    var u = url.trim();
    if (!u) return null;
    if (u.charAt(0) === "#") return null;
    if (SKIP_RE.test(u)) return null;
    if (u.indexOf("/p/") === 0) return null;
    var abs;
    try {
      // Relative URLs resolve against the *real* page address, not the proxy
      // address, so the target site sees the URLs it expects.
      abs = new URL(u, currentUrl || PAGE_URL).href;
    } catch (e) {
      return null;
    }
    var a;
    try {
      a = new URL(abs);
    } catch (e) {
      return null;
    }
    if (a.protocol !== "http:" && a.protocol !== "https:") return null;
    // Already pointing at this proxy server -> leave it untouched, otherwise
    // we would wrap our own proxy URLs around and around.
    if (a.origin === location.origin) return a.pathname + a.search + a.hash;
    var tok = tokenFor(a.protocol + "//" + a.host);
    if (!tok) return null;
    return "/p/" + tok + a.pathname + a.search + a.hash;
  }

  var currentUrl = PAGE_URL;

  function setCurrent(url) {
    if (typeof url === "string" && url) {
      try {
        currentUrl = new URL(url, PAGE_URL).href;
      } catch (e) {
        currentUrl = url;
      }
    }
    updateToolbarUrl();
  }

  /* ---------------- patched browser APIs ---------------- */

  try {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          var url = typeof input === "string" ? input : input && input.url;
          var p = toProxy(url);
          if (p) {
            if (typeof input !== "string" && typeof Request !== "undefined" && input instanceof Request) {
              try {
                return origFetch.call(window, new Request(p, input), init);
              } catch (e) {
                return origFetch.call(window, p, init);
              }
            }
            return origFetch.call(window, p, init);
          }
        } catch (e) {}
        return origFetch.apply(window, arguments);
      };
    }
  } catch (e) {}

  try {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        var p = toProxy(url);
        if (p) url = p;
      } catch (e) {}
      return origOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
    };
  } catch (e) {}

  try {
    var origBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (origBeacon) {
      navigator.sendBeacon = function (url, data) {
        try {
          var p = toProxy(url);
          if (p) return origBeacon(p, data);
        } catch (e) {}
        return origBeacon(url, data);
      };
    }
  } catch (e) {}

  try {
    var origWindowOpen = window.open;
    window.open = function (url) {
      try {
        var p = toProxy(url);
        if (p) {
          var rest = Array.prototype.slice.call(arguments, 1);
          return origWindowOpen.apply(window, [p].concat(rest));
        }
      } catch (e) {}
      return origWindowOpen.apply(window, arguments);
    };
  } catch (e) {}

  try {
    var origPush = history.pushState;
    history.pushState = function (state, title, url) {
      if (url) setCurrent(url);
      var p = toProxy(url);
      return origPush.call(history, state, title, p || url);
    };
    var origReplace = history.replaceState;
    history.replaceState = function (state, title, url) {
      if (url) setCurrent(url);
      var p = toProxy(url);
      return origReplace.call(history, state, title, p || url);
    };
  } catch (e) {}

  try {
    var origAssign = Location.prototype.assign;
    Location.prototype.assign = function (url) {
      var p = toProxy(url);
      return origAssign.call(this, p || url);
    };
    var origReplaceUrl = Location.prototype.replace;
    Location.prototype.replace = function (url) {
      var p = toProxy(url);
      return origReplaceUrl.call(this, p || url);
    };
  } catch (e) {}

  /* ---------------- dynamically inserted resources ---------------- */

  var LAZY_ATTRS = ["src", "href", "poster", "data-src", "data-original", "data-href", "data-lazy-src"];

  function fixSrcset(el) {
    var v = el.getAttribute && el.getAttribute("srcset");
    if (!v) return;
    var parts = v.split(",");
    var changed = false;
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (!t) continue;
      var space = t.search(/\s/);
      var url = space === -1 ? t : t.slice(0, space);
      var rest = space === -1 ? "" : t.slice(space);
      if (url.indexOf("data:") === 0 || url.indexOf("/p/") === 0) continue;
      var p = toProxy(url);
      if (p && p !== url) {
        parts[i] = p + rest;
        changed = true;
      }
    }
    if (changed) el.setAttribute("srcset", parts.join(", "));
  }

  function fixElement(el) {
    if (!el || el.nodeType !== 1) return;
    for (var i = 0; i < LAZY_ATTRS.length; i++) {
      var name = LAZY_ATTRS[i];
      var v = el.getAttribute && el.getAttribute(name);
      if (!v) continue;
      if (v.indexOf("/p/") === 0 || v.indexOf("data:") === 0) continue;
      var p = toProxy(v);
      if (p && p !== v) el.setAttribute(name, p);
    }
    if (el.tagName === "IMG" || el.tagName === "SOURCE") fixSrcset(el);
  }

  function fixTree(node) {
    if (!node) return;
    if (node.nodeType === 1) {
      fixElement(node);
      var kids = node.querySelectorAll ? node.querySelectorAll("[src],[href],[srcset],[poster],[data-src]") : [];
      for (var i = 0; i < kids.length; i++) fixElement(kids[i]);
    }
  }

  /* Intercept attribute/property assignment so a cross-origin resource is
     rewritten *before* the browser starts fetching it. Without this, a
     <script src="https://cdn..."> set by site JavaScript is fetched
     cross-origin and blocked by CORS before the observer can react. */
  function patchUrlProperty(proto, prop) {
    try {
      if (!proto) return;
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set || !desc.get) return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) {
          var p = toProxy(value);
          return desc.set.call(this, p === null ? value : p);
        },
      });
    } catch (e) {}
  }

  try {
    patchUrlProperty(window.HTMLScriptElement && HTMLScriptElement.prototype, "src");
    patchUrlProperty(window.HTMLImageElement && HTMLImageElement.prototype, "src");
    patchUrlProperty(window.HTMLIFrameElement && HTMLIFrameElement.prototype, "src");
    patchUrlProperty(window.HTMLLinkElement && HTMLLinkElement.prototype, "href");
    patchUrlProperty(window.HTMLSourceElement && HTMLSourceElement.prototype, "src");
    patchUrlProperty(window.HTMLMediaElement && HTMLMediaElement.prototype, "src");
    patchUrlProperty(window.HTMLAnchorElement && HTMLAnchorElement.prototype, "href");
    patchUrlProperty(window.HTMLFormElement && HTMLFormElement.prototype, "action");
  } catch (e) {}

  try {
    var origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        var lower = String(name).toLowerCase();
        if (lower === "src" || lower === "href" || lower === "poster" || lower === "action") {
          var p = toProxy(value);
          if (p !== null) value = p;
        }
      } catch (e) {}
      return origSetAttribute.call(this, name, value);
    };
  } catch (e) {}

  try {
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        if (rec.type === "attributes") {
          fixElement(rec.target);
        } else {
          for (var j = 0; j < rec.addedNodes.length; j++) fixTree(rec.addedNodes[j]);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href", "srcset", "poster", "data-src", "data-original", "data-href", "data-lazy-src"],
    });
  } catch (e) {}

  /* ---------------- toolbar ---------------- */

  var toolbarInput = null;

  function updateToolbarUrl() {
    if (!toolbarInput) return;
    try {
      toolbarInput.value = currentUrl;
    } catch (e) {}
  }

  function navigate(raw) {
    var v = (raw || "").trim();
    if (!v) return;
    if (v.indexOf("/p/") === 0 || v === "/") {
      window.location.href = v;
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(v)) {
      v = "https://" + v.replace(/^\/+/, "");
    }
    var p = toProxy(v);
    window.location.href = p || v;
  }

  function buildToolbar() {
    if (document.getElementById("__ownproxy_host__")) return;

    var host = document.createElement("div");
    host.id = "__ownproxy_host__";
    host.setAttribute("style", "position:fixed;top:10px;right:10px;z-index:2147483647;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;");
    var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

    var style = document.createElement("style");
    style.textContent = [
      ".bar{display:flex;align-items:center;gap:4px;background:rgba(17,20,28,.94);color:#e9edf5;border:1px solid rgba(255,255,255,.14);",
      "border-radius:999px;padding:5px 8px;box-shadow:0 8px 30px rgba(0,0,0,.45);backdrop-filter:blur(8px);}",
      "button{all:unset;cursor:pointer;width:26px;height:26px;display:flex;align-items:center;justify-content:center;",
      "border-radius:50%;color:#c8d2e4;font-size:14px;line-height:1;}",
      "button:hover{background:rgba(255,255,255,.14);color:#fff;}",
      "input{all:unset;background:rgba(255,255,255,.08);color:#e9edf5;border-radius:999px;padding:5px 12px;width:min(46vw,380px);",
      "font-size:12px;outline:none;}",
      "input:focus{background:rgba(255,255,255,.16);}",
      ".dot{width:7px;height:7px;border-radius:50%;background:#4ade80;margin-right:2px;}",
      ".hide{display:none !important;}",
    ].join("");

    var bar = document.createElement("div");
    bar.className = "bar";

    function mkBtn(label, title, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    }

    var dot = document.createElement("span");
    dot.className = "dot";
    dot.title = "Proxied via own proxy";
    bar.appendChild(dot);

    bar.appendChild(mkBtn("←", "Back", function () { window.history.back(); }));
    bar.appendChild(mkBtn("→", "Forward", function () { window.history.forward(); }));
    bar.appendChild(mkBtn("⟳", "Reload", function () { window.location.reload(); }));

    toolbarInput = document.createElement("input");
    toolbarInput.type = "text";
    toolbarInput.placeholder = "Search or enter address";
    toolbarInput.spellcheck = false;
    toolbarInput.value = currentUrl;
    toolbarInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        navigate(toolbarInput.value);
      }
    });
    toolbarInput.addEventListener("focus", function () { toolbarInput.select(); });
    bar.appendChild(toolbarInput);

    bar.appendChild(mkBtn("⌂", "Proxy home", function () { window.location.href = "/"; }));
    bar.appendChild(mkBtn("✕", "Hide toolbar", function () { host.style.display = "none"; }));

    shadow.appendChild(style);
    shadow.appendChild(bar);

    (document.body || document.documentElement).appendChild(host);
  }

  function init() {
    try { buildToolbar(); } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.__ownproxy__ = { toProxy: toProxy, base: PROXY_BASE, url: PAGE_URL };
})();
`;

/**
 * Fill the placeholders in the runtime for a given page.
 *
 * The token map is intentionally left as the raw `__PROXY_TOKEN_MAP__`
 * placeholder: the server fills it in *after* rewriting the document, so the
 * browser and the server always agree on the token for every origin.
 */
function renderClientRuntime({ base, url, token }) {
  return CLIENT_RUNTIME
    .replace('"__PROXY_BASE__"', () => JSON.stringify(base || url || ''))
    .replace('"__PROXY_URL__"', () => JSON.stringify(url || ''))
    .replace('"__PROXY_TOKEN__"', () => JSON.stringify(token || ''));
}

module.exports = { CLIENT_RUNTIME, renderClientRuntime };
