const hints = {
    cerebras: 'Get a free key at cloud.cerebras.ai',
    groq: 'Get a free key at console.groq.com'
};

const providerSelect = document.getElementById('provider');
const apiKeyInput = document.getElementById('api-key');
const hintEl = document.getElementById('hint');
const statusEl = document.getElementById('status');

let apiKeys = {};

async function load() {
    const result = await browser.storage.local.get(['vocabProvider', 'vocabApiKeys']);
    const provider = result.vocabProvider || 'cerebras';
    apiKeys = result.vocabApiKeys || {};

    providerSelect.value = provider;
    apiKeyInput.value = apiKeys[provider] || '';
    hintEl.textContent = hints[provider];
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
    await browser.storage.local.set({ vocabProvider: provider, vocabApiKeys: apiKeys });
    statusEl.textContent = 'Saved.';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
});

load();
