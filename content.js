// Debug logging — toggle from console: bilingualDebug(true)
let _debugEnabled = false;
window.bilingualDebug = (on) => { _debugEnabled = on; console.log(`[bilingual-ard] debug ${on ? 'ON' : 'OFF'}`); };
function dbg(...args) { if (_debugEnabled) console.log('[bilingual-ard]', ...args); }

// ── State ─────────────────────────────────────────────────────────────────────

let translationCache = new Map();
let observers = [];
let currentUrl = window.location.href;

// Subtitle tracking
let subtitleBuffer        = [];
let unsentSubtitles       = [];
let currentSubtitleTexts  = new Set();
let previousSubtitleTexts = new Set();
let recentClearTimeout    = null;

// Vocabulary overlay
let vocabOverlayVisible = false;
let vocabWords          = [];
let vocabFetchTimeout   = null;
let vocabFetching       = false;
let lastVocabFetchTime  = 0;
let vocabOpacity        = 0.55;
let knownWords          = new Set();

// Learning mode
let inlineTranslationsEnabled = true;
let learningMode          = true;
let thinkTime             = 2;    // seconds before hint appears
let autoHideDelay         = 0;    // seconds before auto-hide (0 = stay visible)
let translationVisible    = false;
let hintTimeout           = null;
let autoHideTimeout       = null;
let hintEl                = null;
let recallNeededSentences = new Set();

// Vocab overlay DOM
let vocabHost     = null;
let vocabShadow   = null;
let vocabPanel    = null;
let labelsDragged = false;

// Help overlay DOM
let helpHost   = null;
let helpShadow = null;

// C-x prefix state
let cxState   = 'idle';
let cxTimeout = null;

// Color palette for word highlights
const WORD_COLORS = [
    '#ff6b6b', // coral
    '#ffd93d', // yellow
    '#6bcb77', // green
    '#4d96ff', // blue
    '#ff922b', // orange
    '#cc5de8', // purple
    '#20c997', // teal
    '#f783ac', // pink
];

function getWordColor(vocabWord) {
    const idx = vocabWords.findIndex(w => w.word === vocabWord);
    return WORD_COLORS[(idx < 0 ? 0 : idx) % WORD_COLORS.length];
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
    const result = await browser.storage.local.get([
        'subtitleFontSize', 'overlayFontSize', 'legendFontSize',
        'learningMode', 'thinkTime', 'autoHideDelay', 'knownWords',
        'inlineTranslationsEnabled'
    ]);
    learningMode              = result.learningMode              !== undefined ? result.learningMode              : true;
    thinkTime                 = result.thinkTime                 !== undefined ? result.thinkTime                 : 2;
    autoHideDelay             = result.autoHideDelay             !== undefined ? result.autoHideDelay             : 0;
    knownWords                = new Set(result.knownWords || []);
    inlineTranslationsEnabled = result.inlineTranslationsEnabled !== undefined ? result.inlineTranslationsEnabled : true;
    applyFontSizes(result);
}

async function applyFontSizes(result) {
    if (!result) {
        result = await browser.storage.local.get(['subtitleFontSize', 'overlayFontSize', 'legendFontSize']);
    }
    const subSize     = result.subtitleFontSize || 22;
    const overlaySize = result.overlayFontSize  || 14;
    const legendSize  = result.legendFontSize   || 22;
    document.documentElement.style.setProperty('--bilingual-subtitle-font-size', subSize + 'px');
    document.documentElement.style.setProperty('--bilingual-legend-font-size', legendSize + 'px');
    if (vocabPanel) vocabPanel.style.setProperty('--overlay-font-size', overlaySize + 'px');
    if (labelsShadow) {
        const container = labelsShadow.getElementById('container');
        if (container) container.style.setProperty('--legend-font-size', legendSize + 'px');
    }
}

browser.storage.onChanged.addListener((changes) => {
    if (changes.subtitleFontSize || changes.overlayFontSize || changes.legendFontSize) applyFontSizes();
    if (changes.learningMode  !== undefined) learningMode  = changes.learningMode.newValue;
    if (changes.thinkTime     !== undefined) thinkTime     = changes.thinkTime.newValue;
    if (changes.autoHideDelay !== undefined) autoHideDelay = changes.autoHideDelay.newValue;
    if (changes.knownWords    !== undefined) knownWords    = new Set(changes.knownWords.newValue || []);
    if (changes.inlineTranslationsEnabled !== undefined) {
        inlineTranslationsEnabled = changes.inlineTranslationsEnabled.newValue;
        highlightSubtitleWords();
    }
    updateModeBadge();
});

// ── DOM helpers ───────────────────────────────────────────────────────────────

function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const el = document.querySelector(selector);
        if (el) { resolve(el); return; }
        const obs = new MutationObserver((_, o) => {
            const found = document.querySelector(selector);
            if (found) { o.disconnect(); resolve(found); }
        });
        obs.observe(document, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
    });
}

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&#39;');
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// First meaningful segment of a semicolon-separated meaning string, capped for inline display
function shortMeaning(s) {
    const first = s.split(';')[0].trim();
    return first.length > 28 ? first.slice(0, 26) + '\u2026' : first;
}

function cleanup() {
    observers.forEach(obs => obs.disconnect());
    observers = [];
}

// ── Translation (learning-mode aware) ─────────────────────────────────────────

function checkAndShowSubtitles() {
    try {
        const btn      = document.querySelector(".ardplayer-button-playpause");
        const isPaused = btn && btn.classList.contains("ardplayer-icon-play");

        if (!isPaused) {
            clearTimeout(hintTimeout);
            hideTranslationHint();
            hideTranslation();
            return;
        }

        // Already revealed, or passive mode → show/update translation
        if (!learningMode || translationVisible) {
            showStoredSubtitle();
        } else {
            // Learning mode and not yet revealed → schedule hint
            clearTimeout(hintTimeout);
            const delay = thinkTime * 1000;
            if (delay === 0) {
                showTranslationHint();
            } else {
                hintTimeout = setTimeout(showTranslationHint, delay);
            }
        }
    } catch (e) {
        console.error("Error in checkAndShowSubtitles:", e);
    }
}

function showTranslationHint() {
    const container = document.querySelector('.ardplayer-untertitel');
    if (!container || !container.querySelectorAll('p').length) return;

    if (!hintEl) {
        hintEl = document.createElement('div');
        hintEl.className = 'bilingual-hint';
        hintEl.addEventListener('click', revealTranslation);
    }
    hintEl.textContent = '▸ press T to check';
    container.appendChild(hintEl);
}

function hideTranslationHint() {
    if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
}

function revealTranslation() {
    // Record these subtitle lines as "needed a peek"
    currentSubtitleTexts.forEach(t => recallNeededSentences.add(t));
    hideTranslationHint();
    showStoredSubtitle();
    translationVisible = true;

    if (autoHideDelay > 0) {
        clearTimeout(autoHideTimeout);
        autoHideTimeout = setTimeout(hideTranslation, autoHideDelay * 1000);
    }
}

function hideTranslation() {
    document.querySelectorAll('.translated-subtitle').forEach(el => { el.style.display = 'none'; });
    translationVisible = false;
    clearTimeout(autoHideTimeout);
}

function showStoredSubtitle() {
    try {
        const subtitleElements = document.querySelectorAll(".ardplayer-untertitel p:not(.translated-subtitle)");
        if (!subtitleElements.length) return;

        subtitleElements.forEach((originalP) => {
            if (!originalP.parentNode) return;
            const text         = originalP.innerText.trim().replace(/\n/g, ' ');
            const translatedText = translationCache.get(text);
            if (!translatedText) return;

            let translatedP = originalP.parentNode.querySelector(".translated-subtitle");
            if (!translatedP) {
                translatedP = document.createElement("p");
                translatedP.className = "translated-subtitle";
                originalP.parentNode.insertBefore(translatedP, originalP);
            }
            translatedP.innerText     = translatedText;
            translatedP.style.display = "block";
        });
    } catch (e) {
        console.error("Error in showStoredSubtitle:", e);
    }
}

function storeSubtitle(originalP) {
    const text = originalP.innerText.trim().replace(/\n/g, ' ');
    if (!text) return;

    if (!subtitleBuffer.includes(text)) {
        subtitleBuffer.push(text);
        unsentSubtitles.push(text);
        if (subtitleBuffer.length > 50) subtitleBuffer.shift();
        scheduleVocabFetch();
    }

    if (!translationCache.has(text)) {
        translationCache.set(text, null);
        fetchTranslation(text).then((translated) => {
            if (translated) {
                translationCache.set(text, translated);
                checkAndShowSubtitles();
            }
        });
    }
}

async function fetchTranslation(text) {
    try {
        const response = await fetch(
            "https://translate.googleapis.com/translate_a/single?client=gtx&sl=de&tl=en&dt=t&q=" +
            encodeURIComponent(text)
        );
        const result = await response.json();
        let t = result[0].map((item) => item[0]).join(" ");
        return t.toLowerCase().replace(/(^\w|\.\s*\w)/g, m => m.toUpperCase());
    } catch (e) {
        console.error("Translation error:", e);
        return "";
    }
}

// ── Subtitle tracking ─────────────────────────────────────────────────────────

function updateCurrentSubtitles() {
    const ps = document.querySelectorAll('.ardplayer-untertitel p:not(.translated-subtitle)');
    const newTexts = new Set();
    ps.forEach(p => {
        const t = p.innerText.trim().replace(/\n/g, ' ');
        if (t) newTexts.add(t);
    });
    if (setsEqual(newTexts, currentSubtitleTexts)) return;

    previousSubtitleTexts = currentSubtitleTexts;
    currentSubtitleTexts  = newTexts;

    // Reset reveal state when subtitle line changes
    if (learningMode && translationVisible) {
        hideTranslation();
    }

    clearTimeout(recentClearTimeout);
    recentClearTimeout = setTimeout(() => {
        previousSubtitleTexts = new Set();
        updateActiveHighlight();
    }, 5000);

    updateActiveHighlight();
}

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

// ── Inline word highlights ─────────────────────────────────────────────────────

function vocabBaseWord(word) {
    return word
        .replace(/^(der|die|das|ein|eine)\s+/i, '')
        .split(/[,\s]/)[0]
        .toLowerCase()
        .trim();
}

function germanStem(word) {
    // Simple German stemming - remove common suffixes
    let stem = word.toLowerCase().trim();
    
    // Remove ge- prefix (past participles)
    stem = stem.replace(/^ge/, '');
    
    // Remove common verb/noun/adjective endings (longest first)
    stem = stem.replace(/(ungen|ieren|schaft|keit|heit|ness|lich|isch|bar|sam|los)$/, '');
    stem = stem.replace(/(en|er|em|es|st|te|et|el|nd)$/, '');
    stem = stem.replace(/[tes]$/, '');
    
    // Must be at least 3 chars to be useful
    return stem.length >= 3 ? stem : word.toLowerCase();
}

function buildWordMap() {
    const map = new Map(); // lowercase word → vocab entry
    const stemMap = new Map(); // stem → vocab entry
    
    for (const w of vocabWords) {
        if (knownWords.has(w.word)) continue;
        const base = vocabBaseWord(w.word);
        if (base.length > 2) {
            map.set(base, w);
            const stem = germanStem(base);
            if (stem.length >= 3) stemMap.set(stem, w);
        }
    }
    
    return { exactMap: map, stemMap };
}

function currentSubtitleText() {
    const fromDom = [...document.querySelectorAll('.ardplayer-untertitel p:not(.translated-subtitle)')]
        .map(p => p.innerText.trim().replace(/\n/g, ' '))
        .filter(Boolean)
        .join(' ');
    if (fromDom) return fromDom;
    return [...currentSubtitleTexts].join(' ');
}

function vocabWordVisibleInCurrentSubtitle(vocabWord) {
    const base = vocabBaseWord(vocabWord.word);
    if (base.length <= 2) return false;
    const text = currentSubtitleText();
    if (!text) return false;
    
    // Check exact match
    const exactPattern = new RegExp(
        '(?<![a-zA-ZÄÖÜäöüß])' + escapeRegex(base) + '(?![a-zA-ZÄÖÜäöüß])',
        'i'
    );
    if (exactPattern.test(text)) return { match: 'exact', word: base };
    
    // Check stem match
    const stem = germanStem(base);
    if (stem.length >= 3) {
        const stemPattern = new RegExp(
            '(?<![a-zA-ZÄÖÜäöüß])\\w*' + escapeRegex(stem) + '\\w*(?![a-zA-ZÄÖÜäöüß])',
            'i'
        );
        if (stemPattern.test(text)) return { match: 'stem', word: base };
    }
    
    return false;
}

function highlightSubtitleWords() {
    const { exactMap } = buildWordMap();

    document.querySelectorAll('.ardplayer-untertitel p:not(.translated-subtitle)').forEach(p => {
        // Restore original text nodes from any previous highlight spans
        p.querySelectorAll('.vocab-highlight').forEach(span => {
            // data-base-text holds the original matched word; fall back to last
            // text-node child to avoid including any .vocab-meaning-above label text
            const original = span.dataset.baseText
                || (span.lastChild && span.lastChild.nodeType === 3 ? span.lastChild.nodeValue : null)
                || span.textContent;
            span.replaceWith(document.createTextNode(original));
        });
        p.normalize();

        if (exactMap.size === 0) return;

        const pattern = new RegExp(
            '(?<![a-zA-ZÄÖÜäöüß])(' +
            [...exactMap.keys()].map(escapeRegex).join('|') +
            ')(?![a-zA-ZÄÖÜäöüß])',
            'gi'
        );

        // Collect text nodes first — never touch attribute values or tag names
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        for (const textNode of textNodes) {
            const text = textNode.nodeValue;
            pattern.lastIndex = 0;
            if (!pattern.test(text)) continue;
            pattern.lastIndex = 0;

            const frag = document.createDocumentFragment();
            let last = 0, m;
            while ((m = pattern.exec(text)) !== null) {
                if (m.index > last)
                    frag.appendChild(document.createTextNode(text.slice(last, m.index)));

                const entry = exactMap.get(m[0].toLowerCase());
                if (!entry) {
                    frag.appendChild(document.createTextNode(m[0]));
                } else {
                    const span = document.createElement('span');
                    span.className         = 'vocab-highlight';
                    span.dataset.vocabWord = entry.word;
                    span.dataset.baseText  = m[0];
                    span.title             = entry.meaning;
                    if (inlineTranslationsEnabled) {
                        span.style.color = getWordColor(entry.word);
                    }
                    span.appendChild(document.createTextNode(m[0]));
                    frag.appendChild(span);
                }
                last = m.index + m[0].length;
            }
            pattern.lastIndex = 0;
            if (last < text.length)
                frag.appendChild(document.createTextNode(text.slice(last)));

            textNode.parentNode.replaceChild(frag, textNode);
        }
    });

    // Keep the color legend in sync with the current visible subtitle.
    renderInlineLabels();
}

// Delegated click: highlighted German word → open panel + scroll to entry
document.addEventListener('click', (e) => {
    const span = e.target.closest('.vocab-highlight');
    if (!span) return;
    const word = span.dataset.vocabWord;
    if (!word) return;
    if (!vocabOverlayVisible) toggleVocabOverlay();
    scrollToVocabWord(word);
});

function scrollToVocabWord(word) {
    if (!vocabShadow) return;
    for (const entry of vocabShadow.querySelectorAll('.entry')) {
        const wordEl = entry.querySelector('.word-text');
        if (wordEl && wordEl.textContent.trim() === word) {
            entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
            entry.classList.add('flash');
            setTimeout(() => entry.classList.remove('flash'), 1200);
            break;
        }
    }
}

// ── Known words ───────────────────────────────────────────────────────────────

async function markWordAsKnown(word) {
    knownWords.add(word);
    vocabWords = vocabWords.filter(w => w.word !== word);
    await browser.storage.local.set({ knownWords: [...knownWords] });
    renderVocabWords(); // re-renders panel and re-runs highlightSubtitleWords()
}

// ── Toast notification ─────────────────────────────────────────────────────────

let toastEl      = null;
let toastTimeout = null;

function showToast(message) {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'bilingual-toast';
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toastEl.classList.remove('visible'), 2000);
}

// ── Vocabulary overlay (Shadow DOM) ───────────────────────────────────────────

const VOCAB_STYLES = `
    :host {
        position: fixed;
        top: 10%;
        right: 20px;
        z-index: 999999;
        display: none;
    }
    #panel {
        display: flex;
        flex-direction: column;
        width: 320px;
        max-height: 70vh;
        background: rgba(15, 15, 20, 0.55);
        border: none;
        border-radius: 10px;
        color: #e0e0e0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: var(--overlay-font-size, 14px);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        overflow: hidden;
        resize: both;
        min-width: 200px;
        min-height: 150px;
    }
    #header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 14px;
        background: rgba(255, 255, 255, 0.06);
        cursor: grab;
        user-select: none;
        font-weight: 600;
        font-size: 13px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        color: #aaa;
    }
    #header:active { cursor: grabbing; }
    #mode-badge {
        font-size: 10px;
        letter-spacing: 0;
        text-transform: none;
        font-weight: 500;
        padding: 2px 7px;
        border-radius: 10px;
        background: rgba(77, 182, 172, 0.25);
        color: #4db6ac;
        cursor: pointer;
        transition: background 0.2s;
        flex-shrink: 0;
    }
    #mode-badge.off { background: rgba(255, 255, 255, 0.08); color: #777; }
    #mode-badge:hover { background: rgba(77, 182, 172, 0.4); }
    #buttons { display: flex; gap: 4px; margin-left: auto; }
    #buttons button {
        background: none;
        border: none;
        color: #888;
        font-size: 18px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        line-height: 1;
    }
    #buttons button:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
    #buttons button.export-btn { font-size: 14px; }
    #buttons button.help-btn {
        font-size: 13px;
        font-weight: 600;
        color: #555;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 50%;
        width: 22px;
        height: 22px;
        padding: 0;
        line-height: 20px;
        text-align: center;
    }
    #buttons button.help-btn:hover { color: #4db6ac; border-color: #4db6ac; background: rgba(77,182,172,0.1); }
    #content {
        overflow-y: auto;
        scrollbar-width: none;
        padding: 8px;
        flex: 1;
    }
    #content::-webkit-scrollbar { display: none; }
    .loading { padding: 20px 14px; color: #888; text-align: center; font-style: italic; }
    .group {
        padding: 8px 12px;
        border-left: 3px solid transparent;
        transition: border-color 0.6s ease, background-color 0.6s ease;
    }
    .group.active { border-left-color: #4db6ac; background: rgba(255, 255, 255, 0.04); }
    .group.recent { border-left-color: rgba(77, 182, 172, 0.3); }
    .example { font-size: 12px; line-height: 1.4; margin-bottom: 6px; }
    .example-de { color: #ccc; font-style: italic; }
    .example-en { color: #bbb; margin-top: 2px; text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
    .entry { padding: 3px 0; border-radius: 4px; }
    .entry.flash { animation: flashEntry 1.2s ease; }
    @keyframes flashEntry {
        0%   { background: rgba(77, 182, 172, 0.3); }
        100% { background: transparent; }
    }
    .word-row {
        display: flex;
        align-items: baseline;
        gap: 4px;
        margin-bottom: 2px;
        flex-wrap: wrap;
    }
    .word-text { font-size: 16px; font-weight: 600; color: #fff; }
    .type { font-size: 11px; font-weight: 400; color: #7eb8da; }
    .recall-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #ef9a9a;
        flex-shrink: 0;
        align-self: center;
        cursor: help;
    }
    .known-btn {
        margin-left: auto;
        background: none;
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #555;
        font-size: 10px;
        cursor: pointer;
        padding: 1px 5px;
        border-radius: 3px;
        line-height: 1.5;
        flex-shrink: 0;
        transition: border-color 0.15s, color 0.15s;
    }
    .known-btn:hover { border-color: #4caf50; color: #4caf50; }
    .meaning { color: #f0c674; font-size: 13px; }
    .no-key { padding: 14px; color: #aaa; font-size: 13px; text-align: center; }
`;

function createVocabOverlay() {
    if (vocabHost) return vocabHost;

    vocabHost   = document.createElement('div');
    vocabHost.id = 'vocab-overlay-host';
    vocabShadow = vocabHost.attachShadow({ mode: 'open' });

    vocabShadow.innerHTML = `
        <style>${VOCAB_STYLES}</style>
        <div id="panel">
            <div id="header">
                <span>Vocabulary</span>
                <span id="mode-badge" title="Toggle learning mode (C-x l)">learning</span>
                <div id="buttons">
                    <button id="help" class="help-btn" title="Help (C-x ?)">?</button>
                    <button id="export" class="export-btn" title="Export to Anki (TSV)">&#8615;</button>
                    <button id="close" title="Close (C-x C-x)">&times;</button>
                </div>
            </div>
            <div id="content">
                <div class="loading">Waiting for subtitles…</div>
            </div>
        </div>
    `;
    document.body.appendChild(vocabHost);
    vocabPanel = vocabShadow.getElementById('panel');
    applyFontSizes();
    updateModeBadge();

    // Drag
    const header = vocabShadow.getElementById('header');
    let dragging = false, offsetX = 0, offsetY = 0;
    header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.id === 'mode-badge') return;
        dragging = true;
        const rect = vocabHost.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        vocabHost.style.right = 'auto';
        vocabHost.style.left  = (e.clientX - offsetX) + 'px';
        vocabHost.style.top   = (e.clientY - offsetY) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    vocabShadow.getElementById('mode-badge').addEventListener('click', toggleLearningMode);
    vocabShadow.getElementById('help').addEventListener('click', toggleHelpOverlay);
    vocabShadow.getElementById('export').addEventListener('click', exportVocabToAnki);
    vocabShadow.getElementById('close').addEventListener('click', () => {
        vocabHost.style.display = 'none';
        vocabOverlayVisible = false;
    });

    return vocabHost;
}

function updateModeBadge() {
    if (!vocabShadow) return;
    const badge = vocabShadow.getElementById('mode-badge');
    if (!badge) return;
    badge.textContent = learningMode ? 'learning' : 'passive';
    badge.classList.toggle('off', !learningMode);
}

function toggleLearningMode() {
    learningMode = !learningMode;
    browser.storage.local.set({ learningMode });
    updateModeBadge();
    showToast(learningMode ? '📚 Learning mode ON — press T to reveal' : '👁 Passive mode');
}

function toggleInlineTranslations() {
    inlineTranslationsEnabled = !inlineTranslationsEnabled;
    browser.storage.local.set({ inlineTranslationsEnabled });
    highlightSubtitleWords(); // recolours or strips colour from existing spans
    showToast(inlineTranslationsEnabled ? '🔤 Word translations ON' : '🔤 Word translations OFF');
}

// ── Inline translation labels (fixed overlay, never touches subtitle DOM) ────

const LABELS_STYLES = `
    :host {
        position: fixed;
        display: flex;
        z-index: 999997;
    }
    #container {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px 32px;
        padding: 16px 32px;
        background: rgba(0, 0, 0, 0.75);
        border-radius: 12px;
        max-width: 90vw;
        cursor: grab;
        user-select: none;
    }
    #container:active { cursor: grabbing; }
    .bilingual-inline-label {
        font-size: var(--legend-font-size, 22px);
        line-height: 1.5;
        white-space: nowrap;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .bilingual-inline-label b { font-weight: 700; }
`;

let labelsHost   = null;
let labelsShadow = null;

function getOrCreateLabelsOverlay() {
    if (labelsHost) return labelsHost;
    
    labelsHost = document.createElement('div');
    labelsHost.id = 'bilingual-labels-host';
    labelsShadow = labelsHost.attachShadow({ mode: 'open' });
    
    labelsShadow.innerHTML = `
        <style>${LABELS_STYLES}</style>
        <div id="container"></div>
    `;
    
    document.body.appendChild(labelsHost);

    const container = labelsShadow.getElementById('container');
    let dragging = false, offsetX = 0, offsetY = 0;
    
    container.addEventListener('mousedown', (e) => {
        dragging = true;
        const rect = labelsHost.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        // Switch from bottom-anchor to top-anchor so drag works naturally
        labelsHost.style.top       = rect.top + 'px';
        labelsHost.style.bottom    = 'auto';
        labelsHost.style.transform = 'none';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        labelsDragged = true;
        labelsHost.style.left = (e.clientX - offsetX) + 'px';
        labelsHost.style.top  = (e.clientY - offsetY) + 'px';
    });
    
    document.addEventListener('mouseup', () => { dragging = false; });

    return labelsHost;
}

function renderInlineLabels() {
    getOrCreateLabelsOverlay();
    const container = labelsShadow.getElementById('container');
    while (container.firstChild) container.removeChild(container.firstChild);

    if (!inlineTranslationsEnabled || !vocabWords.length) {
        labelsHost.style.display = 'none';
        return;
    }

    // Show only vocab words that are visible in the current subtitle.
    // This keeps the overlay small and synced with what you are reading now.
    const seen = new Set();
    for (const w of vocabWords) {
        const base = vocabBaseWord(w.word);
        if (!base || seen.has(base)) continue;
        if (knownWords.has(w.word)) continue;
        
        const matchResult = vocabWordVisibleInCurrentSubtitle(w);
        if (!matchResult) continue;
        seen.add(base);

        const meaning = shortMeaning(w.meaning);
        if (!meaning) continue;

        const entry = document.createElement('div');
        entry.className = 'bilingual-inline-label';
        
        // Only color exact matches; stem matches stay default color
        if (matchResult.match === 'exact') {
            entry.style.color = getWordColor(w.word);
        } else {
            entry.style.color = '#999'; // Gray for stem matches
            entry.style.opacity = '0.8';
        }

        const wordEl = document.createElement('b');
        wordEl.textContent = base;
        const meaningEl = document.createElement('span');
        meaningEl.textContent = '\u2009\u2192\u2009' + meaning;
        entry.appendChild(wordEl);
        entry.appendChild(meaningEl);
        container.appendChild(entry);
    }

    if (!container.childElementCount) {
        labelsHost.style.display = 'none';
        return;
    }

    labelsHost.style.display = 'flex';

    if (!labelsDragged) {
        labelsHost.style.left      = Math.round(window.innerWidth / 2) + 'px';
        labelsHost.style.bottom    = '130px';
        labelsHost.style.top       = 'auto';
        labelsHost.style.transform = 'translateX(-50%)';
    }
}

// ── Vocab fetch ───────────────────────────────────────────────────────────────

function findBestSourceLine(exampleDe, sourceLines) {
    if (!exampleDe || !sourceLines.length) return null;
    let best = null, bestScore = 0;
    const exLower = exampleDe.toLowerCase();
    for (const line of sourceLines) {
        const words = line.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        if (!words.length) continue;
        const score = words.filter(w => exLower.includes(w)).length / words.length;
        if (score > bestScore) { bestScore = score; best = line; }
    }
    return bestScore >= 0.4 ? best : null;
}

function scheduleVocabFetch() {
    dbg("scheduleVocabFetch", { vocabOverlayVisible, inlineTranslationsEnabled, vocabFetching, unsent: unsentSubtitles.length });
    if (!vocabOverlayVisible && !inlineTranslationsEnabled) return;
    if (vocabFetching || !unsentSubtitles.length) return;
    clearTimeout(vocabFetchTimeout);
    const delay = Math.max(2000 - (Date.now() - lastVocabFetchTime), 0);
    vocabFetchTimeout = setTimeout(fetchVocabWords, delay);
}

async function fetchVocabWords() {
    if (vocabFetching || !subtitleBuffer.length) return;
    // Need at least one consumer active
    if (!vocabOverlayVisible && !inlineTranslationsEnabled) return;

    let provider, apiKey;
    try {
        const r = await browser.storage.local.get(['vocabProvider', 'vocabApiKeys']);
        provider = r.vocabProvider || 'cerebras';
        apiKey   = (r.vocabApiKeys || {})[provider];
    } catch (e) { provider = 'cerebras'; apiKey = null; }

    if (!apiKey) {
        // Only show the error inside the vocab panel if it is open
        if (vocabShadow) {
            const content = vocabShadow.getElementById('content');
            if (content) showNoApiKeyMessage(content);
        }
        return;
    }

    vocabFetching      = true;
    lastVocabFetchTime = Date.now();
    const batchLines   = [...unsentSubtitles];
    unsentSubtitles    = [];

    try {
        const response = await browser.runtime.sendMessage({
            type:         'fetchVocab',
            subtitleText:  batchLines.join('\n'),
            apiKey,
            provider,
            knownWords:    [...knownWords]
        });
        if (response.success && response.words.length > 0) {
            const tagged = response.words.map(w => ({
                ...w,
                _sourceLine: findBestSourceLine(w.example_de, batchLines)
            }));
            vocabWords = [...tagged, ...vocabWords];
            renderVocabWords();    // updates vocab panel and subtitle highlights
            renderInlineLabels();  // updates color legend overlay
        }
    } catch (err) {
        console.error("Vocab fetch error:", err);
    } finally {
        vocabFetching = false;
    }
}

function showNoApiKeyMessage(content) {
    content.innerHTML = '<div class="no-key">No API key configured.<br>Go to extension settings in about:addons.</div>';
}

// ── Vocab render ──────────────────────────────────────────────────────────────

function renderVocabWords() {
    // Always update highlights/labels regardless of whether the panel is open
    highlightSubtitleWords();

    if (!vocabShadow) return;
    const content = vocabShadow.getElementById('content');
    if (!content) return;

    if (!vocabWords.length) {
        content.innerHTML = '<div class="loading">Waiting for subtitles…</div>';
        return;
    }

    // Group words by example sentence
    const groups     = [];
    const groupIndex = new Map();
    for (const w of vocabWords) {
        const key = w.example_de;
        if (groupIndex.has(key)) {
            groups[groupIndex.get(key)].words.push(w);
        } else {
            groupIndex.set(key, groups.length);
            groups.push({
                example_de: w.example_de,
                example_en: w.example_en,
                srcLine:    w._sourceLine || '',
                words:      [w]
            });
        }
    }

    // Sort: active → recent → rest
    groups.sort((a, b) => {
        const aA = a.srcLine && currentSubtitleTexts.has(a.srcLine);
        const bA = b.srcLine && currentSubtitleTexts.has(b.srcLine);
        if (aA && !bA) return -1;
        if (!aA && bA) return 1;
        const aR = a.srcLine && previousSubtitleTexts.has(a.srcLine);
        const bR = b.srcLine && previousSubtitleTexts.has(b.srcLine);
        if (aR && !bR) return -1;
        if (!aR && bR) return 1;
        return 0;
    });

    content.innerHTML = groups.map(g => {
        const isActive = g.srcLine && currentSubtitleTexts.has(g.srcLine);
        const isRecent = g.srcLine && previousSubtitleTexts.has(g.srcLine);
        const cls      = isActive ? 'group active' : isRecent ? 'group recent' : 'group';

        const entries = g.words.map(w => {
            const needsRecall = w._sourceLine && recallNeededSentences.has(w._sourceLine);
            return `
            <div class="entry">
                <div class="word-row">
                    <span class="word-text">${escapeAttr(w.word)}</span>
                    <span class="type">${escapeAttr(w.type)}</span>
                    ${needsRecall ? '<span class="recall-dot" title="You needed the translation for this line"></span>' : ''}
                    <button class="known-btn" data-known-word="${escapeAttr(w.word)}" title="Mark as known — won't appear again">known ✓</button>
                </div>
                <div class="meaning">${escapeAttr(w.meaning)}</div>
            </div>`;
        }).join('');

        return `
        <div class="${cls}" data-source-line="${escapeAttr(g.srcLine)}">
            <div class="example">
                <div class="example-de">${escapeAttr(g.example_de)}</div>
                <div class="example-en">${escapeAttr(g.example_en)}</div>
            </div>
            ${entries}
        </div>`;
    }).join('');

    // Wire up "known" buttons
    content.querySelectorAll('.known-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            markWordAsKnown(btn.dataset.knownWord);
        });
    });

    // Update inline highlights in subtitle DOM
    highlightSubtitleWords();
}

// Toggle active/recent classes without full re-render
function updateActiveHighlight() {
    if (!vocabShadow) return;
    vocabShadow.querySelectorAll('.group').forEach(g => {
        const src      = g.getAttribute('data-source-line');
        const isActive = src && currentSubtitleTexts.has(src);
        const isRecent = src && !isActive && previousSubtitleTexts.has(src);
        g.classList.toggle('active', !!isActive);
        g.classList.toggle('recent', !!isRecent);
    });
}

// ── Anki export (with recall tags) ────────────────────────────────────────────

function exportVocabToAnki() {
    if (!vocabWords.length) return;

    const lines = vocabWords.map(w => {
        const front       = `${w.word} <i>(${w.type})</i>`;
        const back        = `${w.meaning}<br><br><i>${w.example_de}</i><br>${w.example_en}`;
        const needsRecall = w._sourceLine && recallNeededSentences.has(w._sourceLine);
        const tags        = needsRecall ? 'bilingual-ard recall-needed' : 'bilingual-ard';
        return `${front}\t${back}\t${tags}`;
    });

    const tsv  = lines.join('\n');
    const blob = new Blob([tsv], { type: 'text/tab-separated-values' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `vocab-${new Date().toISOString().slice(0, 10)}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ── Overlay toggle ─────────────────────────────────────────────────────────────

function toggleVocabOverlay() {
    createVocabOverlay();
    vocabOverlayVisible = !vocabOverlayVisible;
    vocabHost.style.display = vocabOverlayVisible ? 'block' : 'none';
    if (vocabOverlayVisible) {
        if (vocabWords.length > 0) renderVocabWords();
        scheduleVocabFetch();
    }
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    // Don't intercept keys when the user is typing in a field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // C-x prefix handling
    if (e.ctrlKey && e.key === 'x') {
        e.preventDefault();
        if (cxState === 'idle') {
            cxState   = 'prefix';
            cxTimeout = setTimeout(() => { cxState = 'idle'; }, 1000);
        } else if (cxState === 'prefix') {
            clearTimeout(cxTimeout);
            cxState = 'idle';
            toggleVocabOverlay();   // C-x C-x
        }
        return;
    }

    // C-x <letter> commands
    if (cxState === 'prefix') {
        clearTimeout(cxTimeout);
        cxState = 'idle';
        if (e.key === 'l') {
            e.preventDefault();
            toggleLearningMode();   // C-x l
        } else if (e.key === '?') {
            e.preventDefault();
            toggleHelpOverlay();        // C-x ?
        } else if (e.key === 'h') {
            e.preventDefault();
            toggleInlineTranslations(); // C-x h
        }
        return;
    }

    // Escape — close help overlay
    if (e.key === 'Escape') {
        if (helpHost && helpHost.style.display !== 'none') {
            helpHost.style.display = 'none';
            return;
        }
    }

    // T — reveal translation when paused in learning mode
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 't') {
        const btn      = document.querySelector(".ardplayer-button-playpause");
        const isPaused = btn && btn.classList.contains("ardplayer-icon-play");
        if (isPaused && learningMode && !translationVisible) {
            e.preventDefault();
            revealTranslation();
            return;
        }
    }

    // C-+/= and C-- : adjust overlay opacity
    if (e.ctrlKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); adjustVocabOpacity( 0.05); return; }
    if (e.ctrlKey &&  e.key === '-')                   { e.preventDefault(); adjustVocabOpacity(-0.05); return; }
});

function adjustVocabOpacity(delta) {
    vocabOpacity = Math.min(1, Math.max(0.1, vocabOpacity + delta));
    if (vocabPanel)    vocabPanel.style.backgroundColor    = `rgba(15, 15, 20, ${vocabOpacity})`;
    if (labelsHost) {
        const container = labelsShadow.getElementById('container');
        if (container) container.style.backgroundColor = `rgba(0, 0, 0, ${vocabOpacity})`;
    }
}

// ── Help overlay ─────────────────────────────────────────────────────────────────

const HELP_STYLES = `
    :host {
        position: fixed;
        inset: 0;
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(2px);
    }
    #card {
        width: 540px;
        max-height: 80vh;
        background: #16181e;
        border-radius: 12px;
        color: #d4d4d4;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }
    #card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 20px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.07);
        flex-shrink: 0;
    }
    #card-header h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        color: #fff;
        letter-spacing: 0.2px;
    }
    #card-header .subtitle {
        font-size: 11px;
        color: #666;
        margin-top: 2px;
    }
    #close-btn {
        background: none;
        border: none;
        color: #666;
        font-size: 20px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        line-height: 1;
        flex-shrink: 0;
    }
    #close-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
    #body {
        overflow-y: auto;
        padding: 16px 20px 20px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.1) transparent;
    }
    .section {
        margin-bottom: 20px;
    }
    .section:last-child { margin-bottom: 0; }
    .section-title {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1px;
        text-transform: uppercase;
        color: #4db6ac;
        margin: 0 0 8px;
        padding-bottom: 4px;
        border-bottom: 1px solid rgba(77,182,172,0.2);
    }
    table {
        width: 100%;
        border-collapse: collapse;
    }
    tr + tr td { border-top: 1px solid rgba(255,255,255,0.04); }
    td {
        padding: 5px 4px;
        vertical-align: top;
        line-height: 1.45;
    }
    td:first-child {
        white-space: nowrap;
        padding-right: 16px;
        width: 1%;
    }
    kbd {
        display: inline-block;
        padding: 1px 6px;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 4px;
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 11px;
        color: #c9d1d9;
        white-space: nowrap;
    }
    kbd + kbd { margin-left: 2px; }
    .desc { color: #aaa; }
    .desc b { color: #e0e0e0; font-weight: 500; }
    .desc .dim { color: #666; font-size: 11px; }
    ul {
        margin: 0;
        padding: 0 0 0 16px;
        list-style: disc;
    }
    ul li {
        color: #aaa;
        padding: 3px 0;
        line-height: 1.45;
    }
    ul li b { color: #e0e0e0; font-weight: 500; }
`;

const HELP_CONTENT = `
    <div class="section">
        <div class="section-title">Keyboard Shortcuts</div>
        <table>
            <tr>
                <td><kbd>T</kbd></td>
                <td class="desc">Reveal English translation <span class="dim">(while paused, learning mode only)</span></td>
            </tr>
            <tr>
                <td><kbd>C-x</kbd> <kbd>C-x</kbd></td>
                <td class="desc">Toggle vocabulary panel</td>
            </tr>
            <tr>
                <td><kbd>C-x</kbd> <kbd>l</kbd></td>
                <td class="desc">Toggle <b>learning</b> / <b>passive</b> mode</td>
            </tr>
            <tr>
                <td><kbd>C-x</kbd> <kbd>?</kbd></td>
                <td class="desc">Show this help</td>
            </tr>
            <tr>
                <td><kbd>C-x</kbd> <kbd>h</kbd></td>
                <td class="desc">Toggle <b>always-on word translations</b> above highlighted words</td>
            </tr>
            <tr>
                <td><kbd>C-+</kbd></td>
                <td class="desc">Increase vocabulary panel opacity</td>
            </tr>
            <tr>
                <td><kbd>C--</kbd></td>
                <td class="desc">Decrease vocabulary panel opacity</td>
            </tr>
            <tr>
                <td><kbd>Esc</kbd></td>
                <td class="desc">Close this help</td>
            </tr>
        </table>
    </div>

    <div class="section">
        <div class="section-title">Learning Mode</div>
        <ul>
            <li>English translation is <b>hidden on pause</b> — giving you time to read the German first.</li>
            <li>After the configured <b>think time</b>, a subtle hint appears at the bottom of the subtitle.</li>
            <li>Press <b>T</b> or click the hint to reveal the translation. Each new subtitle line resets the reveal.</li>
            <li>Optional <b>auto-hide</b>: translation disappears again after N seconds, reinforcing recall.</li>
            <li>Switch to <b>passive mode</b> (C-x l) to restore the old always-visible behaviour.</li>
        </ul>
    </div>

    <div class="section">
        <div class="section-title">Inline Word Highlights &amp; Translations</div>
        <ul>
            <li>German words extracted by the vocabulary panel are <b>underlined in teal</b> in the subtitle text.</li>
            <li><b>Hover</b> a highlighted word to see its English meaning as a browser tooltip.</li>
            <li><b>Click</b> a highlighted word to open the vocab panel and jump to that entry.</li>
            <li><kbd>C-x h</kbd> — toggle <b>always-on translations</b>: each highlighted word shows its English meaning floating directly above it in the subtitle at all times.</li>
        </ul>
    </div>

    <div class="section">
        <div class="section-title">Vocabulary Panel  <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#666;font-size:10px">(C-x C-x)</span></div>
        <ul>
            <li>An AI (Cerebras / Groq) extracts <b>B1-level vocabulary</b> from the subtitles you watch.</li>
            <li>Words are <b>grouped by the sentence they appear in</b>; the currently visible line is highlighted.</li>
            <li>Click <b>known ✓</b> on any word to permanently remove it — it won't be suggested again.</li>
            <li>A <b>red dot</b> next to a word means you pressed T for that sentence — it's a weak spot.</li>
            <li>The <b>↓ export</b> button downloads a TSV file for Anki. Words with a red dot get the <code style="font-size:11px;color:#9cdcfe">recall-needed</code> tag so Anki schedules them more aggressively.</li>
            <li>The panel is <b>draggable</b> (grab the header) and <b>resizable</b> (bottom-right corner).</li>
        </ul>
    </div>

    <div class="section">
        <div class="section-title">Settings  <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#666;font-size:10px">(about:addons → Bilingual ARD → Preferences)</span></div>
        <ul>
            <li><b>API key</b> — Cerebras (cloud.cerebras.ai) or Groq (console.groq.com). Both are free.</li>
            <li><b>Think time</b> — seconds before the "press T" hint appears after pausing (0 = instant).</li>
            <li><b>Auto-hide delay</b> — seconds before the revealed translation hides itself (0 = keep visible).</li>
            <li><b>Reset known words</b> — clear the list of words you've marked as already known.</li>
        </ul>
    </div>
`;

function createHelpOverlay() {
    if (helpHost) return helpHost;

    helpHost   = document.createElement('div');
    helpHost.id = 'bilingual-help-host';
    helpShadow  = helpHost.attachShadow({ mode: 'open' });

    helpShadow.innerHTML = `
        <style>${HELP_STYLES}</style>
        <div id="card">
            <div id="card-header">
                <div>
                    <h2>Bilingual ARD — Help</h2>
                    <div class="subtitle">C-x ? to reopen &nbsp;·&nbsp; Esc or click outside to close</div>
                </div>
                <button id="close-btn" title="Close">&times;</button>
            </div>
            <div id="body">${HELP_CONTENT}</div>
        </div>
    `;

    document.body.appendChild(helpHost);

    helpShadow.getElementById('close-btn').addEventListener('click', () => {
        helpHost.style.display = 'none';
    });

    // Click on the backdrop (outside the card) closes the overlay
    helpHost.addEventListener('click', (e) => {
        if (e.composedPath()[0] === helpShadow.host ||
            e.target === helpShadow.querySelector(':host')) return;
        const card = helpShadow.getElementById('card');
        if (card && !card.contains(e.target)) {
            helpHost.style.display = 'none';
        }
    });

    return helpHost;
}

function toggleHelpOverlay() {
    createHelpOverlay();
    const visible = helpHost.style.display !== 'none' && helpHost.style.display !== '';
    helpHost.style.display = visible ? 'none' : 'flex';
}

// ── Fullscreen ─────────────────────────────────────────────────────────────────

document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
        if (vocabHost)   document.fullscreenElement.appendChild(vocabHost);
        if (helpHost)    document.fullscreenElement.appendChild(helpHost);
        if (labelsHost)  document.fullscreenElement.appendChild(labelsHost);
        // Re-apply font sizes to ensure CSS variables work in fullscreen
        applyFontSizes();
    } else {
        if (vocabHost)   document.body.appendChild(vocabHost);
        if (helpHost)    document.body.appendChild(helpHost);
        if (labelsHost)  document.body.appendChild(labelsHost);
    }
    renderInlineLabels();
});

window.addEventListener('resize', renderInlineLabels);

// ── Navigation (SPA) ──────────────────────────────────────────────────────────

function setupNavigationDetection() {
    window.addEventListener('popstate', () => {
        if (window.location.href !== currentUrl) {
            currentUrl = window.location.href;
            setTimeout(initializeExtension, 500);
        }
    });

    const urlObs = new MutationObserver(() => {
        if (window.location.href !== currentUrl) {
            currentUrl = window.location.href;
            setTimeout(initializeExtension, 500);
        }
    });
    urlObs.observe(document, { subtree: true, childList: true });
    observers.push(urlObs);
}

// ── Initialization ─────────────────────────────────────────────────────────────

async function initializeExtension() {
    try {
        cleanup();
        await loadSettings();

        const subtitleContainer = await waitForElement(".ardplayer-untertitel");

        const observer = new MutationObserver(async (mutations) => {
            let changed = false;
            for (const mutation of mutations) {
                if (mutation.type === 'characterData') {
                    const p = mutation.target.parentElement && mutation.target.parentElement.closest('.ardplayer-untertitel p');
                    const container = p && p.closest("[lang='de-DE'], [lang='de']");
                    if (p && container) {
                        storeSubtitle(p);
                        changed = true;
                    }
                }

                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1 && node.matches(".ardplayer-untertitel p") && !node.classList.contains('translated-subtitle')) {
                        const container = node.closest("[lang='de-DE'], [lang='de']");
                        if (!container) continue;
                        if (!node.dataset.translated) {
                            node.dataset.translated = "true";
                            storeSubtitle(node);
                            changed = true;
                        }
                    }
                }
                for (const node of mutation.removedNodes) {
                    if (node.nodeType === 1 && node.matches && node.matches('.ardplayer-untertitel p')) {
                        changed = true;
                    }
                }
            }
            if (changed) {
                updateCurrentSubtitles();
                if (vocabWords.length > 0) highlightSubtitleWords();
            }
        });

        observer.observe(subtitleContainer, { childList: true, subtree: true, characterData: true });
        observers.push(observer);

        try {
            const playPauseBtn = await waitForElement(".ardplayer-button-playpause", 5000);
            const ppObs = new MutationObserver(checkAndShowSubtitles);
            ppObs.observe(playPauseBtn, { attributes: true, attributeFilter: ["class"] });
            observers.push(ppObs);
        } catch (e) {
            console.warn("Play/pause button not found, continuing without it:", e);
        }

        console.log(`Bilingual ARD initialized — learning mode: ${learningMode}`);
    } catch (e) {
        console.error("Failed to initialize:", e);
        setTimeout(() => { console.log("Retrying…"); initializeExtension(); }, 2000);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
    initializeExtension();
}

setupNavigationDetection();
