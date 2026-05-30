const hints = {
    cerebras: 'Get a free key at cloud.cerebras.ai',
    groq: 'Get a free key at console.groq.com'
};

const providerSelect = document.getElementById('provider');
const apiKeyInput = document.getElementById('api-key');
const hintEl = document.getElementById('hint');
const statusEl = document.getElementById('status');
const subtitleFontSize = document.getElementById('subtitle-font-size');
const overlayFontSize = document.getElementById('overlay-font-size');

let apiKeys = {};

async function load() {
    const result = await browser.storage.local.get([
        'vocabProvider', 'vocabApiKeys', 'subtitleFontSize', 'overlayFontSize'
    ]);
    const provider = result.vocabProvider || 'cerebras';
    apiKeys = result.vocabApiKeys || {};

    providerSelect.value = provider;
    apiKeyInput.value = apiKeys[provider] || '';
    hintEl.textContent = hints[provider];
    subtitleFontSize.value = result.subtitleFontSize || 22;
    overlayFontSize.value = result.overlayFontSize || 14;
}

providerSelect.addEventListener('change', () => {
    apiKeyInput.value = apiKeys[providerSelect.value] || '';
    hintEl.textContent = hints[providerSelect.value];
    statusEl.textContent = '';
});

document.getElementById('save').addEventListener('click', async () => {
    const provider = providerSelect.value;
    const key = apiKeyInput.value.trim();
    if (key) {
        apiKeys[provider] = key;
    } else {
        delete apiKeys[provider];
    }
    await browser.storage.local.set({
        vocabProvider: provider,
        vocabApiKeys: apiKeys,
        subtitleFontSize: parseInt(subtitleFontSize.value) || 22,
        overlayFontSize: parseInt(overlayFontSize.value) || 14
    });
    statusEl.textContent = 'Saved.';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
});

load();
