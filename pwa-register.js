/**
 * BookAI PWA registration + install + update toast
 * Include as classic script (not module) before </body>
 */
(function () {
  const VERSION = '2.5.0-final';
  window.BOOKAI_VERSION = VERSION;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  let deferred = null;

  function showBanner(show) {
    const el = document.getElementById('install-banner');
    if (!el) return;
    if (isStandalone() || !show) el.classList.add('hidden');
    else el.classList.remove('hidden');
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
    const btn = e.target.closest('#btn-install-app');
    if (!btn) return;
    if (!deferred) {
      alert('Install: use browser menu → Install app / Add to Home screen');
      return;
    }
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    showBanner(false);
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('#btn-install-dismiss')) showBanner(false);
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              const bar = document.getElementById('sw-update-bar');
              if (bar) bar.classList.remove('hidden');
            }
          });
        });
      }).catch(() => {});
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#btn-sw-update')) return;
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
    }
    location.reload();
  });

  document.addEventListener('DOMContentLoaded', () => {
    const v = document.getElementById('app-version');
    if (v) v.textContent = 'BookAI v' + VERSION;
    if (isStandalone()) showBanner(false);
  });
})();
