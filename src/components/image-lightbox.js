// src/components/image-lightbox.js
// See AI image options large before choosing one (owner, 2026-10-27). The three pickers that show
// generate-ai-image's four variations — Blog Studio, the shared media picker, My Content — drew them
// as ~120px thumbnails with no way to look closer, so a person chose between four pictures they
// could not actually see.
//
//   window.ImageLightbox.open({ urls, index, actionLabel, onAction(i) })
//
// Arrow keys / buttons step through the set, Escape or the backdrop closes it, and the action
// button (e.g. "Use this") runs the picker's own choose handler for the image on screen, so the
// lightbox never decides anything itself. z-index 12000: above the media picker (11000), Blog Studio
// (85) and the My Content modals (z-50).
(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function open({ urls, index, actionLabel, onAction }) {
        const list = (urls || []).filter(Boolean);
        if (!list.length) return;
        let i = Math.min(Math.max(Number(index) || 0, 0), list.length - 1);

        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Image preview');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:12000;background:rgba(17,24,39,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px';
        overlay.innerHTML = `
          <div style="position:relative;max-width:min(1100px,100%);width:100%;display:flex;align-items:center;justify-content:center">
            <button type="button" data-lb-prev aria-label="Previous image" style="position:absolute;left:4px;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:9999px;background:rgba(255,255,255,.9);font-size:22px;font-weight:700">&#8249;</button>
            <img data-lb-img alt="" style="max-width:100%;max-height:78vh;object-fit:contain;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);background:#fff">
            <button type="button" data-lb-next aria-label="Next image" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:9999px;background:rgba(255,255,255,.9);font-size:22px;font-weight:700">&#8250;</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;margin-top:14px">
            <span data-lb-count style="color:#fff;font-size:14px;font-weight:600"></span>
            ${typeof onAction === 'function' ? `<button type="button" data-lb-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg">${esc(actionLabel || 'Use this')}</button>` : ''}
            <button type="button" data-lb-close class="btn-secondary px-4 py-2 text-sm font-bold rounded-lg border">Close</button>
          </div>`;

        const img = overlay.querySelector('[data-lb-img]');
        const count = overlay.querySelector('[data-lb-count]');
        const prev = overlay.querySelector('[data-lb-prev]');
        const next = overlay.querySelector('[data-lb-next]');
        const paint = () => {
            img.src = list[i];
            img.alt = `Option ${i + 1} of ${list.length}`;
            count.textContent = `Option ${i + 1} of ${list.length}`;
            const many = list.length > 1;
            prev.style.display = many ? '' : 'none';
            next.style.display = many ? '' : 'none';
        };
        const step = (d) => { i = (i + d + list.length) % list.length; paint(); };
        const onKey = (e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowLeft') step(-1);
            else if (e.key === 'ArrowRight') step(1);
        };
        function close() {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
        }
        prev.addEventListener('click', () => step(-1));
        next.addEventListener('click', () => step(1));
        overlay.querySelector('[data-lb-close]').addEventListener('click', close);
        overlay.querySelector('[data-lb-go]')?.addEventListener('click', () => { const at = i; close(); onAction(at); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', onKey, true);
        paint();
        document.body.appendChild(overlay);
        overlay.querySelector('[data-lb-close]').focus();
    }

    /** The small "enlarge" button the pickers put on each tile. */
    const ZOOM_BUTTON_STYLE = 'position:absolute;top:6px;left:6px;width:30px;height:30px;border-radius:9999px;background:rgba(255,255,255,.92);box-shadow:0 1px 3px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;font-size:15px;line-height:1;cursor:zoom-in';

    window.ImageLightbox = { open, ZOOM_BUTTON_STYLE };
})();
