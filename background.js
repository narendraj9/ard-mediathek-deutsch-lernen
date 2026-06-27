console.log("ARD Mediathek Translator Extension Loaded");

const PROVIDERS = {
    groq: {
        name: "Groq",
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        model: "llama-3.3-70b-versatile",
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

function responseFormatForProvider(providerId) {
    // Groq model support for `json_schema` varies by model. JSON mode is
    // broadly supported and avoids 400s while still forcing a JSON object.
    if (providerId === "groq") return { type: "json_object" };
    return VOCAB_SCHEMA;
}

async function fetchVocabFromSubtitles(subtitleText, apiKey, providerId, knownWords = []) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    const prompt = `You are a German language teacher following Goethe-Institut teaching practices: focus on communicative understanding, context, and the words/phrases that help a learner grasp what is actually being said.

You are helping an intermediate learner understand the meaning of German TV subtitle sentences.

Here is text from German TV subtitles the student is watching:
---
${subtitleText}
---

Your goal is NOT to list every teachable vocabulary item. Your goal is to help the learner understand the meaning of each sentence by showing the fewest, highest-value words or short phrases that unlock that meaning.

First, read each subtitle sentence and ask: "Which unfamiliar word or phrase would unlock the sentence's meaning if the learner knew it?" Extract only those meaning-bearing items. Prefer the words that explain the action, cause, consequence, emotion, relationship, conflict, or key topic of the sentence.

Be VERY SELECTIVE — at most 4–6 items per batch. Usually choose 0–2 items from any one sentence. Quality over quantity. If a word is common, generic, or not central to understanding the sentence, skip it even if it might be a useful vocabulary word in another context.

For each item provide:
- word: Canonical form or fixed phrase — nouns MUST include der/die/das and plural suffix (e.g. "die Bedeutung, -en", "der Versuch, -e"). NEVER omit the article. Irregular verbs include conjugation hints (e.g. "anfangen, fängt an, fing an, hat angefangen"). For idioms/collocations, give the useful phrase as it should be learned.
- type: Gender (m/f/n) for nouns, or part of speech (verb/adj/adv/konj/idiom/phrase) for others. Mark separable verbs as "verb, trennbar"
- meaning: English meaning in the context of this subtitle. Multiple senses separated by semicolons only if useful here
- example_de: The full sentence from the subtitles above where this item appears
- example_en: English translation of that sentence

STRONG SELECTION RULES:
- Include an item only if knowing it would substantially improve understanding of the whole sentence.
- Prefer specific content words over generic words: precise verbs, abstract nouns, emotionally loaded adjectives/adverbs, compounds, technical/topic words, and fixed phrases.
- Prefer phrases/collocations over single words when the phrase carries the real meaning (e.g. "es geht um", "in der Lage sein", "darauf kommt es an").
- Include advanced words when they are necessary to understand the sentence. Do not reject a sentence-critical word because it is above the learner's nominal level; comprehension comes first.
- Do not pad the list. Returning fewer words is better than returning weak words.

SKIP — avoid very common or low-information words, including:
- Core verbs unless used in a non-obvious idiom: sein, haben, werden, gehen, kommen, sehen, sagen, machen, geben, nehmen, wissen, denken, fragen, heißen, kennen, spielen, leben, arbeiten, kaufen, wohnen, essen, trinken, schlafen, fahren, laufen, lesen, schreiben, hören, sprechen, helfen, brauchen, zeigen, suchen, finden, bleiben, lassen, bringen, stehen, liegen, sitzen
- All modal verbs: können, müssen, dürfen, sollen, wollen, mögen, möchten
- All question words, pronouns, articles, and ordinary prepositions
- Basic adverbs/fillers: hier, dort, jetzt, heute, noch, auch, schon, wieder, sehr, immer, nie, oft, viel, wenig, gern, dann, wirklich, natürlich, vielleicht, eigentlich, einfach, mal, doch, ja, denn, wohl, halt, eben
- Numbers, colors, days, months, seasons, clock expressions
- Basic adjectives: gut, schlecht, groß, klein, alt, neu, jung, lang, kurz, schön, schnell, langsam, teuer, billig, wichtig, richtig, falsch, möglich, nötig, klar, gleich
- Any A1/A2 word when it is used in its ordinary literal meaning and does not unlock the sentence

GOOD CANDIDATES:
- Precise or scene-critical verbs, especially prefix/separable/reflexive verbs where the meaning is not obvious (sich entscheiden, aufhören, vorbereiten, vermeiden, herausfinden, sich weigern, auftauchen)
- Nouns that name the central issue, object, role, institution, event, emotion, or relationship in the sentence
- Abstract nouns and concepts (die Enttäuschung, das Vertrauen, die Gelegenheit, der Zusammenhang, die Verantwortung, der Verdacht)
- Compound nouns where the combined meaning is not obvious from the parts
- Idiomatic or fixed collocations that cannot be guessed word-for-word
- False friends or deceptively familiar words used in a non-obvious way (bekommen, werden + adj, also)
- Topic-specific vocabulary needed to understand what is happening in this scene

${knownWords.length > 0 ? `Do NOT include these words which the student has already mastered: ${knownWords.join(', ')}.

` : ''}Return a JSON object with exactly this shape:
{"words":[{"word":"...","type":"...","meaning":"...","example_de":"...","example_en":"..."}]}

If there are no words or phrases that genuinely unlock the meaning of a sentence, return {"words":[]} rather than padding with common or low-information words.`;

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
            response_format: responseFormatForProvider(providerId)
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
