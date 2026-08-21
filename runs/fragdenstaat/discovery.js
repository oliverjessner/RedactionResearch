const fs = require('node:fs/promises');
const path = require('node:path');

const BASE = 'https://fragdenstaat.de';

const TARGET = Number(process.env.TARGET ?? 5000);
const REQUEST_DELAY_MS = Number(process.env.DELAY ?? 300);

const PROJECT_DIR = path.resolve(__dirname, '../..');
const OUTPUT_DIR = path.join(PROJECT_DIR, 'output', 'discovery');

const OUTPUT_JSON = path.join(OUTPUT_DIR, 'candidates.json');
const OUTPUT_CSV = path.join(OUTPUT_DIR, 'candidates.csv');
const OUTPUT_DISCOVERY_JSON = path.join(OUTPUT_DIR, 'discovery.json');

const SEARCH_TERMS = [
    'geschwärzt',
    'geschwaerzt',
    'Schwärzung',
    'Schwärzungen',
    'teilgeschwärzt',
    'teilweise geschwärzt',
    'geschwärzte Fassung',
    'anonymisiert',
    'anonymisierte Fassung',
    'unkenntlich gemacht',
    'personenbezogene Daten geschwärzt',
    'Betriebs- und Geschäftsgeheimnisse',
    'Geschäftsgeheimnisse',
    'Datenschutz geschwärzt',
];

const candidates = new Map();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUrl(url) {
    if (!url) {
        return null;
    }

    try {
        return new URL(url, BASE).toString();
    } catch {
        return null;
    }
}

function getDocumentId(documentUrl) {
    if (!documentUrl) {
        return null;
    }

    const match = documentUrl.match(/\/api\/v1\/document\/(\d+)\/?/);

    return match?.[1] ?? null;
}

async function requestJson(url, attempt = 1) {
    console.log(`GET ${url}`);

    const response = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'User-Agent': 'OliverJessner-RedactionResearch/1.0 (+https://oliverjessner.at/)',
        },
    });

    if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
        if (attempt >= 6) {
            throw new Error(`HTTP ${response.status} after ${attempt} attempts: ${url}`);
        }

        const retryAfter = response.headers.get('retry-after');

        let delay;

        if (retryAfter && /^\d+$/.test(retryAfter)) {
            delay = Number(retryAfter) * 1000;
        } else {
            delay = Math.min(30_000, 1000 * 2 ** attempt);
        }

        console.error(`HTTP ${response.status}. Retry in ${delay} ms.`);

        await sleep(delay);

        return requestJson(url, attempt + 1);
    }

    if (!response.ok) {
        const text = await response.text();

        throw new Error(`HTTP ${response.status}: ${url}\n${text.slice(0, 500)}`);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('json')) {
        const text = await response.text();

        throw new Error(`Expected JSON but got "${contentType}" from ${url}\n` + text.slice(0, 500));
    }

    return response.json();
}

function addCandidate(result, term) {
    const documentUrl = normalizeUrl(result.document);

    if (!documentUrl) {
        return;
    }

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

            indicator_score: 0,

            discovery_content_samples: [],
        };

        candidates.set(documentUrl, candidate);
    }

    if (!candidate.matched_terms.includes(term)) {
        candidate.matched_terms.push(term);
    }

    if (result.number !== undefined && result.number !== null && !candidate.matched_pages.includes(result.number)) {
        candidate.matched_pages.push(result.number);
    }

    const sample = result.query_highlight ?? result.content ?? null;

    if (sample && candidate.discovery_content_samples.length < 3) {
        const cleaned = String(sample).replace(/\s+/g, ' ').trim().slice(0, 500);

        if (cleaned && !candidate.discovery_content_samples.includes(cleaned)) {
            candidate.discovery_content_samples.push(cleaned);
        }
    }
}

async function saveDiscoveryCheckpoint() {
    const data = [...candidates.values()];

    await fs.writeFile(OUTPUT_DISCOVERY_JSON, JSON.stringify(data, null, 2));
}

async function searchTerm(term) {
    console.log('\n======================================');
    console.log(`SEARCH: ${term}`);
    console.log('======================================');

    let url = `${BASE}/api/v1/page/` + `?q=${encodeURIComponent(term)}` + `&limit=50`;

    let apiPage = 0;

    while (url) {
        if (candidates.size >= TARGET) {
            console.log(`Target of ${TARGET} unique documents reached.`);

            break;
        }

        apiPage++;

        const data = await requestJson(url);

        const objects = Array.isArray(data.objects) ? data.objects : [];

        const total = data.meta?.total_count ?? '?';

        console.log(
            [
                `Search term: "${term}"`,
                `API page: ${apiPage}`,
                `API total: ${total}`,
                `Objects returned: ${objects.length}`,
                `Unique candidates: ${candidates.size}`,
            ].join(' | '),
        );

        if (!data.meta && !data.objects) {
            console.error('Unexpected API response:');

            console.error(JSON.stringify(data, null, 2).slice(0, 2000));

            throw new Error('FragDenStaat API response format is unexpected.');
        }

        for (const result of objects) {
            addCandidate(result, term);

            if (candidates.size >= TARGET) {
                break;
            }
        }

        await saveDiscoveryCheckpoint();

        if (candidates.size >= TARGET) {
            break;
        }

        url = data.meta?.next ? normalizeUrl(data.meta.next) : null;

        if (!url) {
            console.log(`Finished search term "${term}".`);
        }

        await sleep(REQUEST_DELAY_MS);
    }
}

function calculateScore(candidate) {
    let score = 0;

    const title = candidate.title?.toLowerCase() ?? '';

    const description = candidate.description?.toLowerCase() ?? '';

    if (title.includes('geschwärzt')) {
        score += 12;
    }

    if (title.includes('geschwaerzt')) {
        score += 12;
    }

    if (title.includes('teilgeschwärzt')) {
        score += 12;
    }

    if (title.includes('anonymisiert')) {
        score += 10;
    }

    if (description.includes('geschwärzt')) {
        score += 5;
    }

    if (description.includes('anonymisiert')) {
        score += 4;
    }

    for (const rawTerm of candidate.matched_terms) {
        const term = rawTerm.toLowerCase();

        if (term === 'teilgeschwärzt' || term === 'teilweise geschwärzt' || term === 'geschwärzte fassung') {
            score += 6;
            continue;
        }

        if (term === 'geschwärzt' || term === 'geschwaerzt') {
            score += 5;
            continue;
        }

        if (term.includes('schwärzung')) {
            score += 4;
            continue;
        }

        if (term.includes('anonymisiert')) {
            score += 3;
            continue;
        }

        if (term.includes('unkenntlich')) {
            score += 3;
            continue;
        }

        if (term.includes('geschäftsgeheim')) {
            score += 2;
            continue;
        }

        score += 1;
    }

    // Mehrere unterschiedliche Seiten mit Treffern
    // machen eine tatsächliche Schwärzung wahrscheinlicher.
    score += Math.min(candidate.matched_pages.length, 10);

    // Mehrere unterschiedliche Suchbegriffe sind ein gutes Signal.
    score += Math.min(candidate.matched_terms.length * 2, 10);

    return score;
}

async function enrichCandidate(candidate, index, total) {
    console.log(`[${index + 1}/${total}] Enrich document ${candidate.document_id ?? candidate.document_url}`);

    try {
        const document = await requestJson(candidate.document_url);

        candidate.title = document.title ?? null;

        candidate.description = document.description ?? null;

        candidate.file_url = normalizeUrl(document.file_url);

        candidate.file_size = document.file_size ?? null;

        candidate.num_pages = document.num_pages ?? null;

        candidate.publicbody = document.publicbody ?? null;

        candidate.foirequest = document.foirequest ?? null;

        candidate.published_at = document.published_at ?? null;

        candidate.last_modified_at = document.last_modified_at ?? null;

        candidate.site_url = normalizeUrl(document.site_url);

        candidate.is_public = document.public ?? null;

        candidate.is_listed = document.listed ?? null;

        candidate.indicator_score = calculateScore(candidate);
    } catch (error) {
        candidate.enrichment_error = error.message;

        console.error(`Enrichment failed for ${candidate.document_url}`);

        console.error(error.message);
    }

    await sleep(REQUEST_DELAY_MS);
}

function csvEscape(value) {
    if (value === null || value === undefined) {
        return '';
    }

    let string;

    if (Array.isArray(value)) {
        string = value.join('|');
    } else if (typeof value === 'object') {
        string = JSON.stringify(value);
    } else {
        string = String(value);
    }

    return `"${string.replaceAll('"', '""')}"`;
}

async function saveFinalResults() {
    const results = [...candidates.values()].sort((a, b) => (b.indicator_score ?? 0) - (a.indicator_score ?? 0));

    await fs.writeFile(OUTPUT_JSON, JSON.stringify(results, null, 2));

    const columns = [
        'document_id',
        'title',
        'indicator_score',

        'matched_terms',
        'matched_pages',

        'file_url',
        'file_size',
        'num_pages',

        'site_url',

        'publicbody',
        'foirequest',

        'published_at',
        'last_modified_at',

        'document_url',

        'enrichment_error',
    ];

    const rows = [columns.join(','), ...results.map(row => columns.map(column => csvEscape(row[column])).join(','))];

    await fs.writeFile(OUTPUT_CSV, rows.join('\n'));

    console.log('\n======================================');
    console.log('RESULT');
    console.log('======================================');

    console.log(`Unique candidates: ${results.length}`);

    const withFileUrl = results.filter(item => item.file_url).length;

    console.log(`With downloadable file URL: ${withFileUrl}`);

    const withGeschwaerztInTitle = results.filter(item => {
        const title = item.title?.toLowerCase() ?? '';

        return title.includes('geschwärzt') || title.includes('geschwaerzt');
    }).length;

    console.log(`Title contains geschwärzt/geschwaerzt: ${withGeschwaerztInTitle}`);

    const score10 = results.filter(item => (item.indicator_score ?? 0) >= 10).length;

    console.log(`Score >= 10: ${score10}`);

    const totalBytes = results.reduce(
        (sum, item) => sum + (Number.isFinite(Number(item.file_size)) ? Number(item.file_size) : 0),
        0,
    );

    console.log(`Combined file size: ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);

    console.log(`\nJSON: ${OUTPUT_JSON}`);

    console.log(`CSV:  ${OUTPUT_CSV}`);
}

async function main() {
    await fs.mkdir(OUTPUT_DIR, {
        recursive: true,
    });

    console.log('FragDenStaat Redaction Discovery');
    console.log('--------------------------------');
    console.log(`Target: ${TARGET}`);
    console.log(`Delay: ${REQUEST_DELAY_MS} ms`);
    console.log(`Search terms: ${SEARCH_TERMS.length}`);

    for (const term of SEARCH_TERMS) {
        if (candidates.size >= TARGET) {
            break;
        }

        try {
            await searchTerm(term);
        } catch (error) {
            console.error(`\nSearch failed for "${term}":`);

            console.error(error.message);
        }
    }

    console.log('\n======================================');
    console.log('DISCOVERY COMPLETE');
    console.log('======================================');

    console.log(`Unique documents found: ${candidates.size}`);

    if (candidates.size === 0) {
        console.error(`
NO CANDIDATES FOUND.

This time the script will NOT silently create an empty
result without telling you.

Check the GET output above and especially any unexpected
API response or HTTP error.
`);

        process.exit(1);
    }

    await saveDiscoveryCheckpoint();

    console.log('\n======================================');
    console.log('ENRICHING DOCUMENTS');
    console.log('======================================');

    const items = [...candidates.values()];

    for (let index = 0; index < items.length; index++) {
        await enrichCandidate(items[index], index, items.length);

        // regelmäßig zwischenspeichern
        if ((index + 1) % 50 === 0) {
            await saveFinalResults();
        }
    }

    await saveFinalResults();
}

main().catch(error => {
    console.error('\nFATAL ERROR');
    console.error(error);

    process.exit(1);
});
