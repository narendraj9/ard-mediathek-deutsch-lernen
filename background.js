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
                            example_en: { type: "string" },
                            inflections: { 
                                type: "array",
                                items: { type: "string" }
                            }
                        }
                    }
                }
            }
        }
    }
};

async function fetchVocabFromSubtitles(subtitleText, apiKey, providerId, knownWords = []) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    const prompt = `You are a German language teacher preparing a student for the Goethe-Zertifikat B1.

Here is text from German TV subtitles the student is watching:
---
${subtitleText}
---

Extract vocabulary this B1 learner would genuinely benefit from. Be SELECTIVE — at most 6–8 items per batch, only words that would appear on a B1 exam or cause real comprehension difficulty. Quality over quantity.

For each word provide:
- word: Canonical form — nouns MUST include der/die/das and plural suffix (e.g. "die Bedeutung, -en", "der Versuch, -e"). NEVER omit the article. Irregular verbs include conjugation hints (e.g. "anfangen, fängt an, fing an, hat angefangen")
- type: Gender (m/f/n) for nouns, or part of speech (verb/adj/adv/konj/idiom) for others. Mark separable verbs as "verb, trennbar"
- meaning: English meaning. Multiple senses separated by semicolons if relevant
- example_de: The sentence from the subtitles above where this word appears
- example_en: English translation of that sentence
- inflections: (optional) Array of common inflected forms that appear in everyday speech. For verbs include 2-4 key forms (e.g. ["denkt", "dachte", "gedacht", "nachgedacht"] for "nachdenken"). For adjectives include common declensions if relevant (e.g. ["wichtigen", "wichtige", "wichtiger"]). For nouns include the plural if it's irregular or commonly used. Keep this list SHORT (2-5 items max) — only forms a learner would actually encounter.

SKIP — the student already knows all of these:
- Core verbs: sein, haben, werden, gehen, kommen, sehen, sagen, machen, geben, nehmen, wissen, denken, fragen, heißen, kennen, spielen, leben, arbeiten, kaufen, wohnen, essen, trinken, schlafen, fahren, laufen, lesen, schreiben, hören, sprechen, helfen, brauchen, zeigen, suchen, finden, bleiben, lassen, bringen, stehen, liegen, sitzen
- All modal verbs: können, müssen, dürfen, sollen, wollen, mögen, möchten
- All question words, all pronouns, all articles, all prepositions
- Basic adverbs: hier, dort, jetzt, heute, noch, auch, schon, wieder, sehr, immer, nie, oft, viel, wenig, gern, dann, jetzt, wirklich, natürlich, vielleicht, eigentlich, einfach (at A2 register)
- Numbers, colors, days, months, seasons, clock expressions
- Basic adjectives: gut, schlecht, groß, klein, alt, neu, jung, lang, kurz, schön, schnell, langsam, teuer, billig, wichtig, richtig, falsch, möglich, nötig, klar, gleich
- Any word on the Goethe A1 or A2 Wortliste

INCLUDE — genuinely B1-level:
- Prefix and separable verbs where the meaning isn't obvious (sich entscheiden, aufhören, vorbereiten, vermeiden, sich vorstellen, herausfinden)
- Subordinating conjunctions and modal particles that carry real nuance beyond A2 (obwohl, trotzdem, allerdings, nämlich, immerhin, ohnehin, ausgerechnet, zumindest, schließlich, jedenfalls)
- Abstract nouns for emotions, relationships and social processes (die Enttäuschung, das Vertrauen, die Gelegenheit, der Zusammenhang, die Verantwortung)
- Compound nouns where the combined meaning isn't obvious from the parts
- Idiomatic or fixed collocations that can't be guessed word-for-word (es geht um, auf jeden Fall, das kommt darauf an, in der Lage sein)
- False friends or deceptively familiar words used in a non-obvious way (bekommen, werden + adj, also)
- Topic-specific vocabulary relevant to what is happening in this scene

${knownWords.length > 0 ? `Do NOT include these words which the student has already mastered: ${knownWords.join(', ')}.

` : ''}If the subtitles contain mostly A1/A2 vocabulary and there is genuinely nothing worth extracting at B1 level, return an empty words array rather than padding with easy words.`;

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
            temperature: 0.4,
            max_tokens: 1200,
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
        return fetchVocabFromSubtitles(request.subtitleText, request.apiKey, request.provider, request.knownWords || [])
            .then(words => ({ success: true, words }))
            .catch(err => ({ success: false, error: err.message }));
    }
});
