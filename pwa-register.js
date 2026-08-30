/**
 * BookAI PWA — register SW, install prompt, update notice
 * Classic script (not module). Safe to include on all public/auth pages.
 */
(function () {
  const VERSION = '2.6.3-release';
  window.BOOKAI_VERSION = VERSION;

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function ensureUi() {
    if (!document.getElementById('install-banner')) {
      const ban = document.createElement('div');
      ban.id = 'install-banner';
      ban.className = 'hidden';
      ban.setAttribute('role', 'dialog');
      ban.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:60;padding:12px 16px calc(12px + env(safe-area-inset-bottom));' +
        'background:var(--bg-elevated,#0f172a);color:var(--text,#f8fafc);border-top:1px solid var(--border,#334155);' +
        'display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px';
      ban.innerHTML =
        '<span style="flex:1;min-width:12rem">Install BookAI on this device for faster access.</span>' +
        '<button type="button" id="btn-install-app" style="min-height:40px;padding:0 12px;border-radius:8px;border:0;background:#0ea5e9;color:#fff;font-weight:600;cursor:pointer">Install</button>' +
        '<button type="button" id="btn-install-dismiss" style="min-height:40px;padding:0 12px;border-radius:8px;border:1px solid var(--border,#475569);background:transparent;color:inherit;cursor:pointer">Not now</button>';
      document.body.appendChild(ban);
    }
    if (!document.getElementById('sw-update-bar')) {
      const bar = document.createElement('div');
      bar.id = 'sw-update-bar';
      bar.className = 'hidden';
      bar.style.cssText =
        'position:fixed;left:0;right:0;top:0;z-index:70;padding:10px 16px calc(10px + env(safe-area-inset-top));' +
        'background:#0ea5e9;color:#fff;font-size:13px;display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap';
      bar.innerHTML =
        '<span>Update available</span>' +
        '<button type="button" id="btn-sw-update" style="min-height:36px;padding:0 12px;border-radius:8px;border:0;background:#fff;color:#0369a1;font-weight:600;cursor:pointer">Refresh</button>';
      document.body.appendChild(bar);
    }
  }

  let deferred = null;
  let dismissedInstall = false;
  try {
    dismissedInstall = sessionStorage.getItem('bookai_install_dismiss') === '1';
  } catch (e) {}

  function showBanner(show) {
    ensureUi();
    const el = document.getElementById('install-banner');
    if (!el) return;
    if (isStandalone() || !show || dismissedInstall) {
      el.classList.add('hidden');
      el.style.display = 'none';
    } else {
      el.classList.remove('hidden');
      el.style.display = 'flex';
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    showBanner(true);
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    showBanner(false);
  });

  document.addEventListener('click', async (e) => {
    if (e.target.closest('#btn-install-dismiss')) {
      dismissedInstall = true;
      try { sessionStorage.setItem('bookai_install_dismiss', '1'); } catch (err) {}
      showBanner(false);
      return;
    }
    const btn = e.target.closest('#btn-install-app');
    if (!btn) return;
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch (err) {}
    deferred = null;
    showBanner(false);
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              ensureUi();
              const bar = document.getElementById('sw-update-bar');
              if (bar) {
                bar.classList.remove('hidden');
                bar.style.display = 'flex';
              }
            }
          });
        });
      }).catch(() => {});

      // Reload when new SW takes control after user chooses Update
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        // Only auto-reload if user triggered SKIP_WAITING via update button flag
        if (window.__BOOKAI_SW_UPDATE__) location.reload();
      });
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#btn-sw-update')) return;
    window.__BOOKAI_SW_UPDATE__ = true;
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
    }
    // Fallback reload if controllerchange is slow
    setTimeout(() => location.reload(), 400);
  });

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(() => {
    ensureUi();
    const v = document.getElementById('app-version');
    if (v) v.textContent = 'BookAI v' + VERSION;
    if (isStandalone()) showBanner(false);
  });
})();
