console.log("ARD Mediathek Translator Extension Loaded");

const PROVIDERS = {
    groq: {
        name: "Groq",
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
    },
    cerebras: {
        name: "Cerebras",
        endpoint: "https://api.cerebras.ai/v1/chat/completions",
        model: "gpt-oss-120b",
    }
};

const VOCAB_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "vocab_response",
        strict: true,
        schema: {
            type: "object",
            required: ["words"],
            additionalProperties: false,
            properties: {
                words: {
                    type: "array",
                    items: {
                        type: "object",
                        required: ["word", "type", "meaning", "example_de", "example_en"],
                        additionalProperties: false,
                        properties: {
                            word: { type: "string" },
                            type: { type: "string" },
                            meaning: { type: "string" },
                            example_de: { type: "string" },
                            example_en: { type: "string" }
                        }
                    }
                }
            }
        }
    }
};

async function fetchVocabFromSubtitles(subtitleText, apiKey, providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    const prompt = `You are a German language teacher preparing a student for the Goethe-Zertifikat B1.

Here is text from German TV subtitles the student is watching:
---
${subtitleText}
---

Pick out words and expressions from this text that are relevant for a B1 learner, following the Goethe-Institut B1 Wortliste approach. For each word provide:
- word: Canonical form — nouns with article and plural (e.g. "die Bedeutung, -en"), verbs with conjugation hints for irregulars (e.g. "anfangen, fängt an, fing an, hat angefangen")
- type: Gender (m/f/n) for nouns, or part of speech (verb/adj/adv/konj/idiom) for others. For separable verbs, mark as "verb, trennbar"
- meaning: English meaning. If the word has multiple meanings relevant here, list them separated by semicolons
- example_de: A sentence from the subtitles above that uses this word, showing it in its natural context
- example_en: English translation of that example sentence

Prioritize:
- Separable and inseparable prefix verbs (aufhören, bemerken, verstehen)
- Subordinate clause connectors and conjunctions (obwohl, damit, falls, nachdem, sobald)
- Abstract nouns common in everyday, work, and public life (die Erfahrung, die Meinung, die Bedeutung)
- Compound nouns where the meaning isn't obvious from parts
- Idiomatic expressions and colloquial usage from spoken German
- Words with multiple meanings depending on context
- Regional variants if present (mark with D/A/CH)

Skip basic A1/A2 vocabulary the student already knows (common verbs like haben/sein/machen, basic nouns, numbers, colors, days, months).`;

    const response = await fetch(provider.endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: provider.model,
            messages: [
                { role: "system", content: "You are a helpful German language teaching assistant. Always respond with valid JSON only, no additional text." },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 2048,
            response_format: VOCAB_SCHEMA
        })
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`${provider.name} API error ${response.status}: ${err}`);
    }

    const envelope = await response.json();
    const text = envelope.choices?.[0]?.message?.content;
    if (!text) throw new Error("Unexpected API response shape");

    const data = JSON.parse(text);
    if (!data.words) throw new Error("No words in response");
    return data.words;
}

browser.runtime.onMessage.addListener((request, sender) => {
    if (request.type === "fetchVocab") {
        return fetchVocabFromSubtitles(request.subtitleText, request.apiKey, request.provider)
            .then(words => ({ success: true, words }))
            .catch(err => ({ success: false, error: err.message }));
    }
});
