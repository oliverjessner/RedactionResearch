const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const OUTPUT_DIR = path.join(__dirname, 'output');
const DOWNLOAD_DIR = path.join(OUTPUT_DIR, 'download');
const PDF_DIR = path.join(DOWNLOAD_DIR, 'pdfs');

const CANDIDATES_FILE = path.join(OUTPUT_DIR, 'candidates.json');

const RESULTS_FILE = path.join(DOWNLOAD_DIR, 'download-results.json');

const ERRORS_FILE = path.join(DOWNLOAD_DIR, 'download-errors.json');

const PROGRESS_FILE = path.join(DOWNLOAD_DIR, 'download-progress.json');

const DEFAULT_DELAY_MS = 300;
const DEFAULT_CONCURRENCY = 2;

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 6;

const USER_AGENT = 'OliverJessner-RedactionResearch/1.0 (+https://oliverjessner.at/)';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
    const args = process.argv.slice(2);

    const options = {
        limit: null,
        force: false,
        documentId: null,
        delay: DEFAULT_DELAY_MS,
        concurrency: DEFAULT_CONCURRENCY,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--limit':
                options.limit = Number(args[++i]);
                break;

            case '--force':
                options.force = true;
                break;

            case '--document-id':
                options.documentId = String(args[++i]);
                break;

            case '--delay':
                options.delay = Number(args[++i]);
                break;

            case '--concurrency':
                options.concurrency = Number(args[++i]);
                break;

            case '--help':
                printHelp();
                process.exit(0);

            default:
                console.error(`Unknown argument: ${arg}`);
                printHelp();
                process.exit(1);
        }
    }

    if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
        throw new Error('--limit must be a positive integer');
    }

    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
        throw new Error('--concurrency must be a positive integer');
    }

    if (!Number.isFinite(options.delay) || options.delay < 0) {
        throw new Error('--delay must be a non-negative number');
    }

    return options;
}

function printHelp() {
    console.log(`
FragDenStaat PDF Downloader

Usage:

  node download.js

Options:

  --limit N
      Download only the first N candidates.

  --document-id ID
      Download only one document.

  --force
      Re-download PDFs that already exist.

  --delay MS
      Delay after each request.
      Default: ${DEFAULT_DELAY_MS}

  --concurrency N
      Number of simultaneous downloads.
      Default: ${DEFAULT_CONCURRENCY}

Examples:

  node download.js --limit 100

  node download.js --document-id 12345

  node download.js --force --limit 20
`);
}

async function ensureDirectories() {
    await fsp.mkdir(PDF_DIR, {
        recursive: true,
    });
}

async function readJson(file, fallback = null) {
    try {
        const content = await fsp.readFile(file, 'utf8');

        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT' && fallback !== null) {
            return fallback;
        }

        throw error;
    }
}

async function writeFileAtomically(file, data) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;

    try {
        await fsp.writeFile(temp, data);

        await fsp.rename(temp, file);
    } catch (error) {
        try {
            await fsp.unlink(temp);
        } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
                error.cleanupError = cleanupError;
            }
        }

        throw error;
    }
}

async function writeJson(file, data) {
    await writeFileAtomically(file, JSON.stringify(data, null, 2));
}

function sanitizeDocumentId(candidate, index) {
    let id = candidate.document_id ?? candidate.id ?? null;

    if (id !== null && id !== undefined) {
        id = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

        if (id.length > 0) {
            return id;
        }
    }

    return `unknown-${index + 1}`;
}

function getFileUrl(candidate) {
    return candidate.file_url ?? candidate.fileUrl ?? null;
}

function getPdfPath(documentId) {
    return path.join(PDF_DIR, `${documentId}.pdf`);
}

async function fileExists(file) {
    try {
        await fsp.access(file);
        return true;
    } catch {
        return false;
    }
}

async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');

        const stream = fs.createReadStream(filePath);

        stream.on('data', chunk => {
            hash.update(chunk);
        });

        stream.on('error', reject);

        stream.on('end', () => {
            resolve(hash.digest('hex'));
        });
    });
}

function calculateBufferSha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function looksLikePdf(buffer) {
    if (!buffer || buffer.length < 5) {
        return false;
    }

    return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

function normalizeContentType(value) {
    return String(value ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
}

async function fetchWithRetry(url, attempt = 1) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,

            headers: {
                Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.1',

                'User-Agent': USER_AGENT,
            },
        });

        if (
            response.status === 429 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504
        ) {
            if (attempt >= MAX_ATTEMPTS) {
                throw new Error(`HTTP ${response.status} after ${attempt} attempts`);
            }

            let retryDelay;

            const retryAfter = response.headers.get('retry-after');

            if (retryAfter && /^\d+$/.test(retryAfter)) {
                retryDelay = Number(retryAfter) * 1000;
            } else {
                retryDelay = Math.min(30_000, 1000 * 2 ** attempt);
            }

            console.log(`    HTTP ${response.status}, retry in ${retryDelay} ms`);

            await sleep(retryDelay);

            return fetchWithRetry(url, attempt + 1);
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        return response;
    } catch (error) {
        if (error.name === 'AbortError') {
            if (attempt >= MAX_ATTEMPTS) {
                throw new Error(`Request timeout after ${attempt} attempts`);
            }

            const delay = Math.min(30_000, 1000 * 2 ** attempt);

            console.log(`    Timeout, retry in ${delay} ms`);

            await sleep(delay);

            return fetchWithRetry(url, attempt + 1);
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function downloadCandidate({ candidate, index, total, options }) {
    const documentId = sanitizeDocumentId(candidate, index);

    const fileUrl = getFileUrl(candidate);

    const pdfPath = getPdfPath(documentId);

    console.log(`[${index + 1}/${total}] ${documentId}`);

    if (!fileUrl) {
        throw new Error('Candidate has no file_url');
    }

    const exists = await fileExists(pdfPath);

    if (exists && !options.force) {
        const stats = await fsp.stat(pdfPath);

        const sha256 = await sha256File(pdfPath);

        console.log(`    SKIP existing (${formatBytes(stats.size)})`);

        return {
            document_id: documentId,
            status: 'existing',

            title: candidate.title ?? null,

            site_url: candidate.site_url ?? null,

            file_url: fileUrl,

            local_file: path.relative(__dirname, pdfPath),

            bytes: stats.size,
            sha256,

            downloaded_at: null,
        };
    }

    console.log(`    Download ${fileUrl}`);

    const response = await fetchWithRetry(fileUrl);

    const contentType = normalizeContentType(response.headers.get('content-type'));

    const arrayBuffer = await response.arrayBuffer();

    const buffer = Buffer.from(arrayBuffer);

    if (!looksLikePdf(buffer)) {
        throw new Error(`Response is not a valid PDF ` + `(content-type: ${contentType || 'unknown'})`);
    }

    const sha256 = calculateBufferSha256(buffer);

    await writeFileAtomically(pdfPath, buffer);

    console.log(`    OK ${formatBytes(buffer.length)} | ${sha256.slice(0, 12)}…`);

    return {
        document_id: documentId,
        status: exists ? 'redownloaded' : 'downloaded',

        title: candidate.title ?? null,

        site_url: candidate.site_url ?? null,

        file_url: fileUrl,

        local_file: path.relative(__dirname, pdfPath),

        bytes: buffer.length,

        sha256,

        content_type: contentType || null,

        downloaded_at: new Date().toISOString(),
    };
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
        return '?';
    }

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 ** 2) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    if (bytes < 1024 ** 3) {
        return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    }

    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function runWorkerPool(items, worker, concurrency) {
    let currentIndex = 0;

    async function runWorker() {
        while (true) {
            const index = currentIndex++;

            if (index >= items.length) {
                return;
            }

            await worker(items[index], index);
        }
    }

    const workers = Array.from(
        {
            length: Math.min(concurrency, items.length),
        },
        () => runWorker(),
    );

    await Promise.all(workers);
}

async function main() {
    const options = parseArgs();

    await ensureDirectories();

    const candidates = await readJson(CANDIDATES_FILE);

    if (!Array.isArray(candidates)) {
        throw new Error(`${CANDIDATES_FILE} must contain a JSON array`);
    }

    let selected = candidates.map((candidate, index) => ({
        candidate,
        originalIndex: index,
    }));

    if (options.documentId) {
        selected = selected.filter(({ candidate }) => String(candidate.document_id) === options.documentId);

        if (selected.length === 0) {
            throw new Error(`Document ${options.documentId} not found in candidates.json`);
        }
    }

    if (options.limit !== null) {
        selected = selected.slice(0, options.limit);
    }

    const previousResults = await readJson(RESULTS_FILE, []);

    const previousErrors = await readJson(ERRORS_FILE, []);

    const resultsById = new Map();

    for (const result of previousResults) {
        if (result.document_id) {
            resultsById.set(String(result.document_id), result);
        }
    }

    const errorsById = new Map();

    for (const error of previousErrors) {
        if (error.document_id) {
            errorsById.set(String(error.document_id), error);
        }
    }

    let processed = 0;
    let successful = 0;
    let failed = 0;
    let downloaded = 0;
    let existing = 0;

    let totalBytes = 0;

    console.log('FragDenStaat PDF Downloader');

    console.log('---------------------------');

    console.log(`Candidates:  ${candidates.length}`);

    console.log(`Selected:    ${selected.length}`);

    console.log(`Concurrency: ${options.concurrency}`);

    console.log(`Delay:       ${options.delay} ms`);

    console.log(`Force:       ${options.force}`);

    console.log('');

    let saveStateQueue = Promise.resolve();

    function saveState() {
        const results = [...resultsById.values()].sort((a, b) =>
            String(a.document_id).localeCompare(String(b.document_id), undefined, {
                numeric: true,
            }),
        );

        const errors = [...errorsById.values()];

        const progress = {
            total: selected.length,
            processed,
            successful,
            failed,
            downloaded,
            existing,

            bytes: totalBytes,

            human_bytes: formatBytes(totalBytes),

            updated_at: new Date().toISOString(),
        };

        const queuedSave = saveStateQueue.then(async () => {
            await writeJson(RESULTS_FILE, results);

            await writeJson(ERRORS_FILE, errors);

            await writeJson(PROGRESS_FILE, progress);
        });

        saveStateQueue = queuedSave.catch(() => {});

        return queuedSave;
    }

    await runWorkerPool(
        selected,

        async (item, workerIndex) => {
            const { candidate, originalIndex } = item;

            const documentId = sanitizeDocumentId(candidate, originalIndex);

            try {
                const result = await downloadCandidate({
                    candidate,
                    index: workerIndex,
                    total: selected.length,
                    options,
                });

                resultsById.set(documentId, result);

                errorsById.delete(documentId);

                processed++;
                successful++;

                totalBytes += result.bytes ?? 0;

                if (result.status === 'downloaded' || result.status === 'redownloaded') {
                    downloaded++;
                }

                if (result.status === 'existing') {
                    existing++;
                }
            } catch (error) {
                processed++;
                failed++;

                console.error(`    ERROR: ${error.message}`);

                errorsById.set(documentId, {
                    document_id: documentId,

                    title: candidate.title ?? null,

                    file_url: getFileUrl(candidate),

                    error: error.message,

                    failed_at: new Date().toISOString(),
                });
            }

            await saveState();

            if (options.delay > 0) {
                await sleep(options.delay);
            }
        },

        options.concurrency,
    );

    await saveState();

    console.log('');
    console.log('==============================');

    console.log('DOWNLOAD COMPLETE');

    console.log('==============================');

    console.log(`Selected:   ${selected.length}`);

    console.log(`Successful: ${successful}`);

    console.log(`Downloaded: ${downloaded}`);

    console.log(`Existing:   ${existing}`);

    console.log(`Failed:     ${failed}`);

    console.log(`Data:       ${formatBytes(totalBytes)}`);

    console.log('');
    console.log(`PDFs:     ${PDF_DIR}`);

    console.log(`Results:  ${RESULTS_FILE}`);

    console.log(`Errors:   ${ERRORS_FILE}`);

    console.log(`Progress: ${PROGRESS_FILE}`);
}

main().catch(error => {
    console.error('\nFATAL ERROR');

    console.error(error);

    process.exit(1);
});
