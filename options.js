const hints = {
    cerebras: 'Get a free key at cloud.cerebras.ai',
    groq:     'Get a free key at console.groq.com'
};

const providerSelect   = document.getElementById('provider');
const apiKeyInput      = document.getElementById('api-key');
const hintEl           = document.getElementById('hint');
const statusEl         = document.getElementById('status');
const subtitleFontSize = document.getElementById('subtitle-font-size');
const overlayFontSize  = document.getElementById('overlay-font-size');
const learningModeEl   = document.getElementById('learning-mode');
const thinkTimeEl      = document.getElementById('think-time');
const autoHideDelayEl  = document.getElementById('auto-hide-delay');
const knownWordsCount  = document.getElementById('known-words-count');
const resetKnownBtn    = document.getElementById('reset-known');

let apiKeys = {};

async function load() {
    const result = await browser.storage.local.get([
        'vocabProvider', 'vocabApiKeys',
        'subtitleFontSize', 'overlayFontSize',
        'learningMode', 'thinkTime', 'autoHideDelay', 'knownWords'
    ]);

    const provider = result.vocabProvider || 'cerebras';
    apiKeys = result.vocabApiKeys || {};

    providerSelect.value   = provider;
    apiKeyInput.value      = apiKeys[provider] || '';
    hintEl.textContent     = hints[provider];
    subtitleFontSize.value = result.subtitleFontSize || 22;
    overlayFontSize.value  = result.overlayFontSize  || 14;

    learningModeEl.checked  = result.learningMode  !== undefined ? result.learningMode  : true;
    thinkTimeEl.value       = result.thinkTime     !== undefined ? result.thinkTime     : 2;
    autoHideDelayEl.value   = result.autoHideDelay !== undefined ? result.autoHideDelay : 0;

    const known = result.knownWords || [];
    knownWordsCount.textContent = `${known.length} word${known.length !== 1 ? 's' : ''} marked as known`;
}

providerSelect.addEventListener('change', () => {
    apiKeyInput.value  = apiKeys[providerSelect.value] || '';
    hintEl.textContent = hints[providerSelect.value];
    statusEl.textContent = '';
});

document.getElementById('save').addEventListener('click', async () => {
    const provider = providerSelect.value;
    const key      = apiKeyInput.value.trim();
    if (key) {
        apiKeys[provider] = key;
    } else {
        delete apiKeys[provider];
    }

    await browser.storage.local.set({
        vocabProvider:    provider,
        vocabApiKeys:     apiKeys,
        subtitleFontSize: parseInt(subtitleFontSize.value) || 22,
        overlayFontSize:  parseInt(overlayFontSize.value)  || 14,
        learningMode:     learningModeEl.checked,
        thinkTime:        parseFloat(thinkTimeEl.value)    || 0,
        autoHideDelay:    parseFloat(autoHideDelayEl.value) || 0,
    });

    statusEl.textContent = 'Saved.';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
});

resetKnownBtn.addEventListener('click', async () => {
    if (!confirm('Clear all known words? This cannot be undone.')) return;
    await browser.storage.local.set({ knownWords: [] });
    knownWordsCount.textContent = '0 words marked as known';
    statusEl.textContent = 'Known words cleared.';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
});

load();
