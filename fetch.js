import fs from 'node:fs/promises';

const BASE = 'https://fragdenstaat.de';

const TARGET = 5000;
const REQUEST_DELAY_MS = 250;

const SEARCH_TERMS = [
    'geschwärzt',
    'geschwaerzt',
    'Schwärzung',
    'Schwärzungen',
    '"teilweise geschwärzt"',
    '"teilgeschwärzt"',
    '"geschwärzte Fassung"',
    '"anonymisierte Fassung"',
    'anonymisiert',
    '"unkenntlich gemacht"',
    '"personenbezogene Daten"',
    '"Betriebs- und Geschäftsgeheimnisse"',
];

const candidates = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestJson(url, attempt = 1) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'OliverJessner-RedactionResearch/1.0 (+https://oliverjessner.at/)',
            Accept: 'application/json',
        },
    });

    if (response.status === 429 || response.status >= 500) {
        if (attempt > 5) {
            throw new Error(`HTTP ${response.status}: ${url}`);
        }

        const delay = Math.min(30_000, 1000 * 2 ** attempt);

        console.error(`HTTP ${response.status}, retry in ${delay}ms`);

        await sleep(delay);

        return requestJson(url, attempt + 1);
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${url}`);
    }

    return response.json();
}

function normalizeUrl(url) {
    if (!url) return null;

    return new URL(url, BASE).toString();
}

function getDocumentId(documentUrl) {
    const match = documentUrl.match(/\/api\/v1\/document\/(\d+)\/?/);

    return match?.[1] ?? null;
}

async function searchTerm(term) {
    console.log(`\nSearching: ${term}`);

    let url = `${BASE}/api/v1/page/` + `?q=${encodeURIComponent(term)}` + `&limit=100`;

    let page = 0;

    while (url && candidates.size < TARGET) {
        page++;

        console.log(`  page ${page} | candidates ${candidates.size}`);

        const data = await requestJson(url);

        for (const result of data.results ?? []) {
            const documentUrl = normalizeUrl(result.document);

            if (!documentUrl) continue;

            let candidate = candidates.get(documentUrl);

            if (!candidate) {
                candidate = {
                    document_url: documentUrl,
                    document_id: getDocumentId(documentUrl),

                    matched_terms: [],
                    matched_pages: [],

                    title: null,
                    description: null,
                    file_url: null,
                    file_size: null,
                    num_pages: null,

                    publicbody: null,
                    foirequest: null,

                    published_at: null,
                    last_modified_at: null,
                };

                candidates.set(documentUrl, candidate);
            }

            if (!candidate.matched_terms.includes(term)) {
                candidate.matched_terms.push(term);
            }

            if (result.number && !candidate.matched_pages.includes(result.number)) {
                candidate.matched_pages.push(result.number);
            }

            if (candidates.size >= TARGET) break;
        }

        url = data.next ? normalizeUrl(data.next) : null;

        await sleep(REQUEST_DELAY_MS);
    }
}

async function enrichCandidate(candidate, index) {
    console.log(`Enrich ${index + 1}/${candidates.size}: ` + candidate.document_id);

    try {
        const document = await requestJson(candidate.document_url);

        candidate.title = document.title ?? null;
        candidate.description = document.description ?? null;

        candidate.file_url = document.file_url ? normalizeUrl(document.file_url) : null;

        candidate.file_size = document.file_size ?? null;

        candidate.num_pages = document.num_pages ?? null;

        candidate.publicbody = document.publicbody ?? null;

        candidate.foirequest = document.foirequest ?? null;

        candidate.published_at = document.published_at ?? null;

        candidate.last_modified_at = document.last_modified_at ?? null;

        candidate.indicator_score = calculateScore(candidate);
    } catch (error) {
        candidate.error = error.message;
    }

    await sleep(REQUEST_DELAY_MS);
}

function calculateScore(candidate) {
    let score = 0;

    const title = candidate.title?.toLowerCase() ?? '';

    if (title.includes('geschwärzt')) score += 10;
    if (title.includes('geschwaerzt')) score += 10;
    if (title.includes('anonymisiert')) score += 8;

    for (const term of candidate.matched_terms) {
        const t = term.toLowerCase();

        if (t.includes('teilweise geschwärzt') || t.includes('geschwärzte fassung')) {
            score += 5;
        } else if (t.includes('schwärzung')) {
            score += 4;
        } else if (t.includes('geschwärzt') || t.includes('geschwaerzt')) {
            score += 4;
        } else if (t.includes('anonymisiert')) {
            score += 3;
        } else {
            score += 1;
        }
    }

    // Mehrere verschiedene Fundstellen im selben
    // Dokument erhöhen die Wahrscheinlichkeit.
    score += Math.min(candidate.matched_pages.length, 5);

    return score;
}

function csvEscape(value) {
    if (value === null || value === undefined) {
        return '';
    }

    const string = Array.isArray(value) ? value.join('|') : String(value);

    return `"${string.replaceAll('"', '""')}"`;
}

async function saveResults() {
    const results = [...candidates.values()].sort((a, b) => (b.indicator_score ?? 0) - (a.indicator_score ?? 0));

    await fs.writeFile('candidates.json', JSON.stringify(results, null, 2));

    const columns = [
        'document_id',
        'title',
        'file_url',
        'num_pages',
        'file_size',
        'indicator_score',
        'matched_terms',
        'matched_pages',
        'publicbody',
        'foirequest',
        'published_at',
        'document_url',
    ];

    const csv = [
        columns.join(','),
        ...results.map(row => columns.map(column => csvEscape(row[column])).join(',')),
    ].join('\n');

    await fs.writeFile('candidates.csv', csv);

    console.log(`\nSaved ${results.length} candidates.`);
}

async function main() {
    for (const term of SEARCH_TERMS) {
        if (candidates.size >= TARGET) break;

        try {
            await searchTerm(term);
        } catch (error) {
            console.error(`Search failed for "${term}":`, error.message);
        }
    }

    console.log(`\nFound ${candidates.size} unique documents.`);

    const items = [...candidates.values()];

    for (let i = 0; i < items.length; i++) {
        await enrichCandidate(items[i], i);
    }

    await saveResults();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
