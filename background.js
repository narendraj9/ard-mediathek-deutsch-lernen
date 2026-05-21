console.log("ARD Mediathek Translator Extension Loaded");

const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

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

async function fetchVocabFromSubtitles(subtitleText, apiKey) {
    const prompt = `You are a German language teacher for A2-level learners.

Here is text from German TV subtitles the student is watching:
---
${subtitleText}
---

From this text, pick out words that an A2 learner would find difficult or interesting to learn. For each word provide:
- word: The word in canonical form (with article for nouns, e.g. "die Katze")
- type: Gender (m/f/n) for nouns, or part of speech (verb/adj/adv) for others
- meaning: English meaning
- example_de: An example sentence from the subtitles above that uses this word
- example_en: English translation of that example sentence

Focus on words that are above basic A1 level but useful for an A2 learner.
Skip very common words (und, ist, das, ich, er, sie, wir, haben, sein, etc.).`;

    const response = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
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
        throw new Error(`Groq API error ${response.status}: ${err}`);
    }

    const envelope = await response.json();
    const text = envelope.choices?.[0]?.message?.content;
    if (!text) throw new Error("Unexpected API response shape");

    const data = JSON.parse(text);
    if (!data.words) throw new Error("No words in response");
    return data.words;
}

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "fetchVocab") {
        fetchVocabFromSubtitles(request.subtitleText, request.apiKey)
            .then(words => sendResponse({ success: true, words }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
});
