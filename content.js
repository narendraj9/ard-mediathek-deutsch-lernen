// Global variables to manage extension state
let translationCache = new Map(); // Cache translations to avoid redundant API calls
let observers = []; // Keep track of all observers for cleanup
let currentUrl = window.location.href;

// Vocabulary overlay state
let subtitleBuffer = [];
let lastSentBufferLength = 0; // track what we've already sent to Groq
let vocabOverlayVisible = false;
let vocabWords = []; // accumulated vocab words
let vocabFetchTimeout = null;
let vocabFetching = false;
let lastVocabFetchTime = 0;
let vocabOpacity = 0.55;
let cxState = 'idle';
let cxTimeout = null;

// Utility function to wait for elements to appear in DOM
function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const element = document.querySelector(selector);
        if (element) {
            resolve(element);
            return;
        }

        const observer = new MutationObserver((mutations, obs) => {
            const element = document.querySelector(selector);
            if (element) {
                obs.disconnect();
                resolve(element);
            }
        });

        observer.observe(document, {
            childList: true,
            subtree: true
        });

        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timeout waiting for element: ${selector}`));
        }, timeout);
    });
}

// Cleanup function to disconnect all observers
function cleanup() {
    observers.forEach(obs => obs.disconnect());
    observers = [];
}

// Main initialization function
async function initializeExtension() {
    try {
        // Cleanup previous initialization
        cleanup();

        // Wait for subtitle container to be available
        const subtitleContainer = await waitForElement(".ardplayer-untertitel");
        
        // Create subtitle observer
        const observer = new MutationObserver(async (mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes.length) {
                    mutation.addedNodes.forEach(async (node) => {
                        if (node.nodeType === 1 && node.matches(".ardplayer-untertitel p")) {
                            const subtitleContainer = node.closest("[lang='de-DE'], [lang='de']");

                            if (!subtitleContainer) return; // Ensure subtitles are in German

                            if (!node.dataset.translated) {
                                node.dataset.translated = "true";
                                storeSubtitle(node);
                            }
                        }
                    });
                }
            }
        });

        observer.observe(subtitleContainer, { childList: true, subtree: true });
        observers.push(observer);

        // Wait for play/pause button and set up observer
        try {
            const playPauseButton = await waitForElement(".ardplayer-button-playpause", 5000);
            const observerPlayPause = new MutationObserver(checkAndShowSubtitles);
            observerPlayPause.observe(playPauseButton, { attributes: true, attributeFilter: ["class"] });
            observers.push(observerPlayPause);
        } catch (error) {
            console.warn("Play/pause button not found, continuing without it:", error);
        }

        console.log("Bilingual ARD extension initialized successfully");
    } catch (error) {
        console.error("Failed to initialize Bilingual ARD extension:", error);
        // Retry after a delay
        setTimeout(() => {
            console.log("Retrying extension initialization...");
            initializeExtension();
        }, 2000);
    }
}

// Helper functions
function storeSubtitle(originalP) {
    let text = originalP.innerText.trim().replace(/\n/g, ' '); // Replace new lines with spaces
    if (!text) return;

    // Accumulate subtitles for vocabulary overlay
    if (!subtitleBuffer.includes(text)) {
        subtitleBuffer.push(text);
        if (subtitleBuffer.length > 50) subtitleBuffer.shift();
        scheduleVocabFetch();
    }

    if (!translationCache.has(text)) {
        translationCache.set(text, null); // Placeholder to avoid duplicate requests
        fetchTranslation(text).then((translatedText) => {
            if (translatedText) {
                translationCache.set(text, translatedText);
                checkAndShowSubtitles();
            }
        });
    }
}

function checkAndShowSubtitles() {
    try {
        const playPauseButton = document.querySelector(".ardplayer-button-playpause");
        const isPaused = playPauseButton && playPauseButton.classList.contains("ardplayer-icon-play");
        if (isPaused) {
            showStoredSubtitle();
        }
    } catch (error) {
        console.error("Error checking play/pause state:", error);
    }
}

function showStoredSubtitle() {
    try {
        const subtitleElements = document.querySelectorAll(".ardplayer-untertitel p");
        if (!subtitleElements.length) return;
        
        subtitleElements.forEach((originalP) => {
            if (!originalP.parentNode) return; // Skip if element is detached
            
            let text = originalP.innerText.trim().replace(/\n/g, ' ');
            let translatedText = translationCache.get(text);
            if (!translatedText) return;

            let translatedP = originalP.parentNode.querySelector(".translated-subtitle");
            if (!translatedP) {
                translatedP = document.createElement("p");
                translatedP.className = "translated-subtitle";
                originalP.parentNode.insertBefore(translatedP, originalP); // Insert above original subtitle
            }

            translatedP.innerText = translatedText;
            translatedP.style.display = "block";
        });
    } catch (error) {
        console.error("Error displaying subtitles:", error);
    }
}

async function fetchTranslation(text) {
    try {
        const response = await fetch(
            "https://translate.googleapis.com/translate_a/single?client=gtx&sl=de&tl=en&dt=t&q=" +
            encodeURIComponent(text)
        );
        const result = await response.json();
        let translatedText = result[0].map((item) => item[0]).join(" ");

        // Convert text to sentence case (first letter capitalized, rest lowercase)
        translatedText = translatedText
            .toLowerCase()
            .replace(/(^\w|\.\s*\w)/g, (match) => match.toUpperCase());

        return translatedText;
    } catch (error) {
        console.error("Translation error:", error);
        return "";
    }
}

// Navigation detection for SPA routing
function setupNavigationDetection() {
    // Listen for browser navigation events
    window.addEventListener('popstate', () => {
        if (window.location.href !== currentUrl) {
            currentUrl = window.location.href;
            setTimeout(initializeExtension, 500); // Delay to let DOM update
        }
    });

    // Monitor URL changes for SPA navigation
    const urlObserver = new MutationObserver(() => {
        if (window.location.href !== currentUrl) {
            currentUrl = window.location.href;
            setTimeout(initializeExtension, 500); // Delay to let DOM update
        }
    });

    urlObserver.observe(document, { subtree: true, childList: true });
    observers.push(urlObserver);
}

// --- Vocabulary Overlay ---

function createVocabOverlay() {
    let overlay = document.getElementById('vocab-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'vocab-overlay';
    overlay.innerHTML = `
        <div id="vocab-overlay-header">
            <span>Vocabulary</span>
            <div id="vocab-overlay-buttons">
                <button id="vocab-close" title="Close (C-x C-x)">&times;</button>
            </div>
        </div>
        <div id="vocab-overlay-content">
            <div class="vocab-loading">Waiting for subtitles...</div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Drag logic
    const header = overlay.querySelector('#vocab-overlay-header');
    let dragging = false, offsetX, offsetY;
    header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        offsetX = e.clientX - overlay.getBoundingClientRect().left;
        offsetY = e.clientY - overlay.getBoundingClientRect().top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        overlay.style.right = 'auto';
        overlay.style.left = (e.clientX - offsetX) + 'px';
        overlay.style.top = (e.clientY - offsetY) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    overlay.querySelector('#vocab-close').addEventListener('click', () => {
        overlay.style.display = 'none';
        vocabOverlayVisible = false;
    });

    return overlay;
}

// Schedule a rate-limited vocab fetch when new subtitles arrive
function scheduleVocabFetch() {
    if (!vocabOverlayVisible) return;
    if (vocabFetching) return;
    if (subtitleBuffer.length <= lastSentBufferLength) return;

    clearTimeout(vocabFetchTimeout);
    const elapsed = Date.now() - lastVocabFetchTime;
    const delay = Math.max(2000 - elapsed, 0);
    vocabFetchTimeout = setTimeout(() => fetchVocabWords(), delay);
}

async function fetchVocabWords() {
    if (vocabFetching) return;
    if (subtitleBuffer.length === 0) return;

    const content = document.querySelector('#vocab-overlay-content');
    if (!content) return;

    // Get API key
    let apiKey;
    try {
        const result = await browser.storage.local.get('groqApiKey');
        apiKey = result.groqApiKey;
    } catch (e) {
        apiKey = null;
    }

    if (!apiKey) {
        showApiKeyForm(content);
        return;
    }

    vocabFetching = true;
    lastVocabFetchTime = Date.now();
    // Send only new subtitles since last fetch
    const newSubtitles = subtitleBuffer.slice(lastSentBufferLength);
    const subtitleText = newSubtitles.join('\n');
    lastSentBufferLength = subtitleBuffer.length;

    try {
        const response = await browser.runtime.sendMessage({
            type: 'fetchVocab',
            subtitleText,
            apiKey
        });
        if (response.success && response.words.length > 0) {
            // Prepend new words, dedup by word text
            const existingWords = new Set(vocabWords.map(w => w.word));
            const newWords = [];
            for (const w of response.words) {
                if (!existingWords.has(w.word)) {
                    newWords.push(w);
                    existingWords.add(w.word);
                }
            }
            vocabWords = [...newWords, ...vocabWords];
            renderVocabWords();
        }
    } catch (err) {
        console.error("Vocab fetch error:", err);
    } finally {
        vocabFetching = false;
    }
}

function showApiKeyForm(content) {
    content.innerHTML = `
        <div class="vocab-api-key-form">
            <p>Enter your Groq API key to fetch vocabulary:</p>
            <p class="vocab-api-hint">Get a free key at console.groq.com</p>
            <input type="text" id="vocab-api-key-input" placeholder="gsk_..." />
            <button id="vocab-api-key-save">Save</button>
        </div>
    `;
    content.querySelector('#vocab-api-key-save').addEventListener('click', async () => {
        const key = content.querySelector('#vocab-api-key-input').value.trim();
        if (key) {
            await browser.storage.local.set({ groqApiKey: key });
            content.innerHTML = '<div class="vocab-loading">Waiting for subtitles...</div>';
            scheduleVocabFetch();
        }
    });
}

function renderVocabWords() {
    const content = document.querySelector('#vocab-overlay-content');
    if (!content) return;

    if (vocabWords.length === 0) {
        content.innerHTML = '<div class="vocab-loading">Waiting for subtitles...</div>';
        return;
    }

    content.innerHTML = vocabWords.map(w => `
        <div class="vocab-card">
            <div class="vocab-word">${w.word} <span class="vocab-type">${w.type}</span></div>
            <div class="vocab-meaning">${w.meaning}</div>
            <div class="vocab-example">
                <div class="vocab-example-de">${w.example_de}</div>
                <div class="vocab-example-en">${w.example_en}</div>
            </div>
        </div>
    `).join('');
}

function toggleVocabOverlay() {
    const overlay = createVocabOverlay();
    vocabOverlayVisible = !vocabOverlayVisible;
    overlay.style.display = vocabOverlayVisible ? 'flex' : 'none';
    if (vocabOverlayVisible) {
        if (vocabWords.length > 0) {
            renderVocabWords();
        }
        // Trigger fetch if there are unsent subtitles
        scheduleVocabFetch();
    }
}

// Keybindings
document.addEventListener('keydown', (e) => {
    // C-x C-x: toggle overlay
    if (e.ctrlKey && e.key === 'x') {
        e.preventDefault();
        if (cxState === 'idle') {
            cxState = 'prefix';
            cxTimeout = setTimeout(() => { cxState = 'idle'; }, 1000);
        } else if (cxState === 'prefix') {
            clearTimeout(cxTimeout);
            cxState = 'idle';
            toggleVocabOverlay();
        }
        return;
    }
    if (cxState === 'prefix') {
        clearTimeout(cxTimeout);
        cxState = 'idle';
    }

    // C-+ / C-=: increase overlay opacity by 5%
    if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        adjustVocabOpacity(0.05);
        return;
    }
    // C--: decrease overlay opacity by 5%
    if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        adjustVocabOpacity(-0.05);
        return;
    }
});

function adjustVocabOpacity(delta) {
    const overlay = document.getElementById('vocab-overlay');
    if (!overlay) return;
    vocabOpacity = Math.min(1, Math.max(0.1, vocabOpacity + delta));
    overlay.style.backgroundColor = `rgba(15, 15, 20, ${vocabOpacity})`;
}

// Initialize extension when page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
    initializeExtension();
}

// Set up navigation detection
setupNavigationDetection();