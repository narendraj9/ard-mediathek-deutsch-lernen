// ─────────────────────────────────────────────────────────────────────────────
// Site adapters
// ─────────────────────────────────────────────────────────────────────────────
//
// Each adapter encapsulates everything that is specific to one streaming site:
// where the subtitle DOM lives, how to detect play/pause, how to insert a
// translation node next to the original line, etc.
//
// To add support for a new site, implement the SiteAdapter interface below and
// push it into `ADAPTERS`. The first adapter whose `matches()` returns true on
// the current page wins.
//
// SiteAdapter interface
// ─────────────────────
//   name                        : string – short id used in logs
//   sourceLang                  : string – Google Translate `sl` code
//
//   matches()                   : boolean – is this adapter for the current page?
//
//   waitForReady(waitForElement): Promise<Element>
//       Resolve once the subtitle container is mounted. Receives a helper that
//       takes a CSS selector + optional timeout and returns the matched node.
//
//   getSubtitleContainer()      : Element|null
//       The DOM node we MutationObserver to watch subtitles change.
//
//   getSubtitleLineElements()   : Iterable<Element>
//       All currently visible *original* subtitle line elements (never our own
//       translation nodes).
//
//   getSubtitleText(el)         : string
//       Extract clean text from one original subtitle line element.
//
//   resolveSubtitleNode(node)   : Element|null
//       Given an Element that was added via mutation, return the matching
//       subtitle line element (or null). Used to detect newly inserted lines.
//
//   resolveSubtitleFromCharMut(mutation): Element|null
//       Given a `characterData` mutation, return the affected subtitle line
//       element (or null). Sites that re-create their DOM (like Netflix) can
//       just return null.
//
//   isRemovedSubtitleNode(node) : boolean
//       Was a node removed from the DOM one we were tracking? Used to drop
//       stale state when subtitles disappear.
//
//   setupPauseObserver(waitForElement, callback): Promise<()=>void>
//       Wire up an observer that invokes `callback()` whenever the player's
//       play/pause state changes. Returns a cleanup function.
//
//   isPaused()                  : boolean
//
//   getHintContainer()          : Element|null
//       Where to append the "▸ press T to check" hint.
//
//   showTranslation(originalEl, text)
//       Render `text` as a translation node visually associated with the
//       given original subtitle line. Should be idempotent — repeated calls
//       must update, not duplicate.
//
//   getTranslationNodes()       : NodeListOf<Element>
//       All translation nodes the adapter has rendered, for hide/show.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    // Shared class used by all adapters for translation nodes. Old `.translated-subtitle`
    // is kept as a co-class on ARD for CSS back-compat with previous versions.
    const TRANSLATED_CLASS = 'bilingual-translated-subtitle';

    // ── ARD Mediathek ────────────────────────────────────────────────────────
    const ardAdapter = {
        name: 'ard',
        sourceLang: 'de',

        matches() {
            return /(^|\.)ardmediathek\.de$/i.test(location.host);
        },

        async waitForReady(waitForElement) {
            return waitForElement('.ardplayer-untertitel');
        },

        getSubtitleContainer() {
            return document.querySelector('.ardplayer-untertitel');
        },

        getSubtitleLineElements() {
            return document.querySelectorAll(
                `.ardplayer-untertitel p:not(.${TRANSLATED_CLASS}):not(.translated-subtitle)`
            );
        },

        getSubtitleText(el) {
            return el.innerText.trim().replace(/\n/g, ' ');
        },

        resolveSubtitleNode(node) {
            if (!node || node.nodeType !== 1 || !node.matches) return null;
            if (!node.matches('.ardplayer-untertitel p')) return null;
            if (node.classList.contains(TRANSLATED_CLASS)) return null;
            if (node.classList.contains('translated-subtitle')) return null;
            if (!node.closest("[lang='de-DE'], [lang='de']")) return null;
            return node;
        },

        resolveSubtitleFromCharMut(mut) {
            const parent = mut.target && mut.target.parentElement;
            const p = parent && parent.closest('.ardplayer-untertitel p');
            if (!p) return null;
            if (!p.closest("[lang='de-DE'], [lang='de']")) return null;
            return p;
        },

        isRemovedSubtitleNode(node) {
            return node && node.nodeType === 1 &&
                typeof node.matches === 'function' &&
                node.matches('.ardplayer-untertitel p');
        },

        async setupPauseObserver(waitForElement, callback) {
            try {
                const btn = await waitForElement('.ardplayer-button-playpause', 5000);
                const obs = new MutationObserver(callback);
                obs.observe(btn, { attributes: true, attributeFilter: ['class'] });
                return () => obs.disconnect();
            } catch (e) {
                console.warn('[bilingual-ard] Play/pause button not found:', e);
                return () => {};
            }
        },

        isPaused() {
            const btn = document.querySelector('.ardplayer-button-playpause');
            return !!(btn && btn.classList.contains('ardplayer-icon-play'));
        },

        getHintContainer() {
            return document.querySelector('.ardplayer-untertitel');
        },

        showTranslation(originalEl, text) {
            if (!originalEl || !originalEl.parentNode) return;
            let translatedP = originalEl.parentNode.querySelector(
                `.${TRANSLATED_CLASS}`
            );
            if (!translatedP) {
                translatedP = document.createElement('p');
                // Keep the legacy class as a co-class so existing CSS still applies.
                translatedP.className = `${TRANSLATED_CLASS} translated-subtitle`;
                originalEl.parentNode.insertBefore(translatedP, originalEl);
            }
            translatedP.innerText = text;
            translatedP.style.display = 'block';
        },

        getTranslationNodes() {
            return document.querySelectorAll(`.${TRANSLATED_CLASS}`);
        },
    };

    // ─────────────────────────────────────────────────────────────────────
    // Factory: HTML5-<video> + absolutely-positioned subtitle container
    // ─────────────────────────────────────────────────────────────────────
    //
    // Netflix, YouTube, Arte and ZDF all follow the same pattern: a normal
    // <video> element drives play/pause/seek, and the subtitles are rendered
    // as absolutely-positioned children of some captions container. This
    // factory generates an adapter from a small selector spec, so adding a
    // new such site is just a matter of getting four selectors right.
    //
    // Spec fields:
    //   name                : string – short id used in logs
    //   sourceLang          : Google Translate source-language code
    //   hostRegex           : RegExp matched against location.host
    //   containerSelector   : the captions container we MutationObserver
    //   lineSelector        : individual subtitle line elements within it
    //   videoSelector       : the <video> element (defaults to 'video')
    //   readySelector       : optional – what to wait for at init time
    //                         (defaults to containerSelector). Use this when
    //                         the captions container is only mounted *after*
    //                         the user enables subtitles.
    //   bottomShiftPercent  : how far up (in %) to nudge the translation
    //                         relative to the original (used when the
    //                         original's `bottom:` is in %)
    //   bottomShiftPx       : same, but for px-positioned originals
    //   languageCheck       : optional fn(lineEl) => boolean to gate by
    //                         language attribute
    function makeVideoSubtitleAdapter(spec) {
        const {
            name, sourceLang = 'de',
            hostRegex,
            containerSelector,
            lineSelector,
            videoSelector = 'video',
            readySelector = null,
            bottomShiftPercent = 7,
            bottomShiftPx = 48,
            languageCheck = null,
        } = spec;

        const lineNotTranslated = lineSelector
            .split(',')
            .map(s => `${s.trim()}:not(.${TRANSLATED_CLASS})`)
            .join(', ');

        function safeMatches(el) {
            if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return false;
            try { return el.matches(lineSelector); } catch (e) { return false; }
        }
        function safeClosest(el) {
            if (!el || typeof el.closest !== 'function') return null;
            try { return el.closest(lineSelector); } catch (e) { return null; }
        }
        function passesLanguageCheck(el) {
            if (!languageCheck) return true;
            try { return languageCheck(el); } catch (e) { return true; }
        }

        return {
            name,
            sourceLang,

            matches() { return hostRegex.test(location.host); },

            async waitForReady(waitForElement) {
                return waitForElement(readySelector || containerSelector, 30000);
            },

            getSubtitleContainer() {
                return document.querySelector(containerSelector);
            },

            getSubtitleLineElements() {
                const all = document.querySelectorAll(lineNotTranslated);
                if (!languageCheck) return all;
                return Array.from(all).filter(passesLanguageCheck);
            },

            getSubtitleText(el) {
                return el.innerText.trim().replace(/\n/g, ' ');
            },

            resolveSubtitleNode(node) {
                if (!node || node.nodeType !== 1) return null;
                const container = safeMatches(node) ? node : safeClosest(node);
                if (!container) return null;
                if (container.classList.contains(TRANSLATED_CLASS)) return null;
                if (!passesLanguageCheck(container)) return null;
                return container;
            },

            resolveSubtitleFromCharMut(mut) {
                const parent = mut.target && mut.target.parentElement;
                const container = parent && safeClosest(parent);
                if (!container) return null;
                if (container.classList.contains(TRANSLATED_CLASS)) return null;
                if (!passesLanguageCheck(container)) return null;
                return container;
            },

            isRemovedSubtitleNode(node) {
                return safeMatches(node);
            },

            async setupPauseObserver(waitForElement, callback) {
                try {
                    const video = await waitForElement(videoSelector, 10000);
                    const handler = () => callback();
                    video.addEventListener('play', handler);
                    video.addEventListener('pause', handler);
                    video.addEventListener('seeked', handler);
                    return () => {
                        video.removeEventListener('play', handler);
                        video.removeEventListener('pause', handler);
                        video.removeEventListener('seeked', handler);
                    };
                } catch (e) {
                    console.warn(`[bilingual-${name}] <${videoSelector}> not found:`, e);
                    return () => {};
                }
            },

            isPaused() {
                const video = document.querySelector(videoSelector);
                return !!(video && video.paused);
            },

            getHintContainer() {
                return document.querySelector(containerSelector);
            },

            showTranslation(originalEl, text) {
                const parent = originalEl && originalEl.parentNode;
                if (!parent) return;

                if (!originalEl.dataset.bilingualId) {
                    originalEl.dataset.bilingualId =
                        'bs-' + Math.random().toString(36).slice(2, 10);
                }
                const id = originalEl.dataset.bilingualId;

                let translatedEl = parent.querySelector(
                    `.${TRANSLATED_CLASS}[data-bilingual-for="${id}"]`
                );
                if (!translatedEl) {
                    translatedEl = document.createElement('div');
                    // Co-class with the original so site CSS for layout still applies.
                    translatedEl.className =
                        `${TRANSLATED_CLASS} ${originalEl.className || ''}`.trim();
                    translatedEl.dataset.bilingualFor = id;

                    const origStyle = originalEl.getAttribute('style') || '';
                    translatedEl.setAttribute('style', origStyle);

                    // Shift the translation up so it sits *above* the original line.
                    const bottomMatch = origStyle.match(/bottom:\s*([\d.]+)(px|%)/i);
                    if (bottomMatch) {
                        const unit = bottomMatch[2];
                        const val = parseFloat(bottomMatch[1]);
                        translatedEl.style.bottom =
                            unit === '%'
                                ? (val + bottomShiftPercent) + '%'
                                : (val + bottomShiftPx) + 'px';
                    }
                    translatedEl.style.color = '#f0c674';
                    translatedEl.style.fontFamily =
                        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                    translatedEl.style.fontWeight = '600';
                    translatedEl.style.textAlign = 'center';
                    translatedEl.style.textShadow = '0 1px 2px rgba(0,0,0,0.7)';
                    translatedEl.style.pointerEvents = 'none';
                    translatedEl.style.background = 'rgba(0,0,0,0.6)';
                    translatedEl.style.padding = '2px 10px';
                    translatedEl.style.borderRadius = '3px';

                    parent.appendChild(translatedEl);
                }
                translatedEl.innerText = text;
                translatedEl.style.display = 'block';
            },

            getTranslationNodes() {
                return document.querySelectorAll(`.${TRANSLATED_CLASS}`);
            },
        };
    }

    // ── Netflix ──────────────────────────────────────────────────────────────
    //
    // DOM (as observed on the live site):
    //   <div class="player-timedtext">
    //     <div class="player-timedtext-text-container" style="left:…; bottom:10%;…">
    //       <span><span style="color:#fff;…">Ich wollte zu Julia.</span></span>
    //     </div>
    //   </div>
    //
    // Netflix doesn't expose a `lang=` attribute on subtitle nodes, so we
    // can't gate by language. We assume the user has German subtitles
    // selected; otherwise translation output will be in the wrong language.
    const netflixAdapter = makeVideoSubtitleAdapter({
        name: 'netflix',
        hostRegex: /(^|\.)netflix\.com$/i,
        containerSelector: '.player-timedtext',
        lineSelector: '.player-timedtext-text-container',
        videoSelector: 'video',
        bottomShiftPercent: 7,
    });

    // ── YouTube ──────────────────────────────────────────────────────────────
    //
    // DOM (as observed on the live site):
    //   <div class="ytp-caption-window-container">
    //     <div class="caption-window ytp-caption-window-bottom" style="…top:…; …">
    //       <span class="captions-text">
    //         <span class="caption-visual-line">
    //           <span class="ytp-caption-segment" style="…">Hello world</span>
    //         </span>
    //       </span>
    //     </div>
    //   </div>
    //
    // The `.ytp-caption-window-container` only mounts once the user enables
    // captions, so we wait for the <video> element (always present) and let
    // the observer attach lazily when the container appears.
    const youtubeAdapter = makeVideoSubtitleAdapter({
        name: 'youtube',
        hostRegex: /(^|\.)youtube\.com$/i,
        readySelector: 'video.html5-main-video, video',
        containerSelector: '.ytp-caption-window-container, #movie_player',
        lineSelector: '.caption-window',
        videoSelector: 'video.html5-main-video, video',
        bottomShiftPx: 48,
    });

    // ── Arte ─────────────────────────────────────────────────────────────────
    //
    // ⚠ BEST-EFFORT SELECTORS. Arte's player has gone through several iterations
    // and ships a custom subtitle overlay. If translations don't appear, open
    // DevTools on an Arte video page, find the actual subtitle line element,
    // and update `lineSelector` / `containerSelector` below.
    //
    // Commonly-seen selectors include:
    //   .avp-subtitles  +  .avp-subtitles__line
    //   .vjs-text-track-display  +  .vjs-text-track-cue
    //   .subtitles  +  .subtitle
    const arteAdapter = makeVideoSubtitleAdapter({
        name: 'arte',
        hostRegex: /(^|\.)arte\.tv$/i,
        containerSelector:
            '.avp-subtitles, .vjs-text-track-display, .subtitles, .video-subtitles',
        lineSelector:
            '.avp-subtitles__line, .vjs-text-track-cue, .subtitles__line, .subtitle, .video-subtitle',
        videoSelector: 'video',
        bottomShiftPercent: 7,
    });

    // ── ZDF Mediathek ────────────────────────────────────────────────────────
    //
    // ⚠ BEST-EFFORT SELECTORS. ZDF's player ("ZDFplayer") has a long history
    // and the captions class has shifted between releases. Likely candidates:
    //   .zp-Captions       +  .zp-Captions__caption        (newer BEM-style)
    //   .zp-captions       +  .zp-captions__caption        (lowercase variant)
    //   .zdfplayer-captions +  .zdfplayer-captions__caption (legacy)
    //   .captions          +  .caption                     (very generic fallback)
    //
    // If you see no translations appear on a ZDF video, inspect the actual
    // subtitle element and adjust the two selectors below.
    const zdfAdapter = makeVideoSubtitleAdapter({
        name: 'zdf',
        hostRegex: /(^|\.)zdf\.de$/i,
        containerSelector:
            '.zp-Captions, .zp-captions, .zdfplayer-captions, .zdf-captions',
        lineSelector:
            '.zp-Captions__caption, .zp-captions__caption, .zdfplayer-captions__caption, .zdf-captions__caption',
        videoSelector: 'video',
        bottomShiftPercent: 7,
    });
    // ── Registry ─────────────────────────────────────────────────────────────

    const ADAPTERS = [
        ardAdapter,
        netflixAdapter,
        youtubeAdapter,
        arteAdapter,
        zdfAdapter,
    ];

    function getActiveAdapter() {
        return ADAPTERS.find(a => {
            try { return a.matches(); } catch (e) { return false; }
        }) || null;
    }

    window.BilingualSites = {
        TRANSLATED_CLASS,
        adapters: ADAPTERS,
        getActiveAdapter,
    };
})();
