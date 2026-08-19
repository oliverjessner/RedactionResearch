const fs = require('node:fs/promises');
const path = require('node:path');

const { createCanvas } = require('@napi-rs/canvas');
const express = require('express');
const {
    DEFAULT_PROJECT,
    getProblem: getDatabaseProblem,
    getProjectId,
    listProblems: listDatabaseProblems,
    listReviewDecisions,
    openForensicDatabase,
    saveReview,
} = require('../lib/forensic-db.js');

const APP_DIR = __dirname;
const PROJECT_DIR = path.resolve(APP_DIR, '..');
const OUTPUT_DIR = path.join(PROJECT_DIR, 'output');
const FORENSIC_DIR = path.join(OUTPUT_DIR, 'forensic');
const PDF_ROOT = path.join(OUTPUT_DIR, 'download', 'pdfs');

const DATABASE_FILE = path.resolve(process.env.HITL_DATABASE_FILE || path.join(FORENSIC_DIR, 'forensic.sqlite'));
const PROJECT = process.env.HITL_PROJECT || DEFAULT_PROJECT;
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const PDFJS_CMAP_URL = `${path.join(PDFJS_ROOT, 'cmaps')}${path.sep}`;
const PDFJS_STANDARD_FONT_URL = `${path.join(PDFJS_ROOT, 'standard_fonts')}${path.sep}`;
const PDFJS_ICC_URL = `${path.join(PDFJS_ROOT, 'iccs')}${path.sep}`;
const PDFJS_WASM_URL = `${path.join(PDFJS_ROOT, 'wasm')}${path.sep}`;
const FORENSIC_RENDER_SCALE = 1.5;
const PDF_DOCUMENT_CACHE_LIMIT = 3;
const PDF_ARTIFACT_CACHE_MAX_ENTRIES = 48;
const PDF_ARTIFACT_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const PDF_BROWSER_CACHE = 'private, max-age=3600';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const database = openForensicDatabase(DATABASE_FILE);
const PROJECT_ID = getProjectId(database, PROJECT);

if (!PROJECT_ID) {
    database.close();
    throw new Error(`Unknown forensic project: ${PROJECT}`);
}

const PDF_DIR = path.resolve(process.env.HITL_PDF_DIR || path.join(PDF_ROOT, String(PROJECT_ID)));

const ALLOWED_EVIDENCE_KEYS = new Set([
    'affected_text_items',
    'annotation_subtype',
    'bbox',
    'digital_signatures',
    'eof_markers',
    'non_empty_value_count',
    'prev_entries',
    'regions',
    'sensitive_categories',
    'suspicious_unredacted_name_pattern',
]);

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringOrNull(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sanitizeArray(value, depth = 0) {
    if (!Array.isArray(value) || depth > 3) {
        return [];
    }

    return value
        .slice(0, 100)
        .map(item => {
            if (Array.isArray(item)) {
                return sanitizeArray(item, depth + 1);
            }

            if (typeof item === 'number' && Number.isFinite(item)) {
                return item;
            }

            if (typeof item === 'boolean') {
                return item;
            }

            if (typeof item === 'string' && item.length <= 100) {
                return item;
            }

            return null;
        })
        .filter(item => item !== null);
}

function sanitizeEvidence(evidence) {
    if (!isPlainObject(evidence)) {
        return {};
    }

    const clean = {};

    for (const [key, value] of Object.entries(evidence)) {
        if (!ALLOWED_EVIDENCE_KEYS.has(key)) {
            continue;
        }

        if (Array.isArray(value)) {
            clean[key] = sanitizeArray(value);
        } else if (typeof value === 'number' && Number.isFinite(value)) {
            clean[key] = value;
        } else if (typeof value === 'boolean') {
            clean[key] = value;
        } else if (typeof value === 'string' && value.length <= 100) {
            clean[key] = value;
        }
    }

    return clean;
}

function normalizeRegion(value) {
    if (!Array.isArray(value) || value.length !== 4) {
        return null;
    }

    const coordinates = value.map(Number);

    if (!coordinates.every(Number.isFinite)) {
        return null;
    }

    return {
        x0: Math.min(coordinates[0], coordinates[2]),
        y0: Math.min(coordinates[1], coordinates[3]),
        x1: Math.max(coordinates[0], coordinates[2]),
        y1: Math.max(coordinates[1], coordinates[3]),
        bbox: coordinates,
    };
}

function intersects(a, b) {
    return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}

function nearHorizontal(angle) {
    let normalized = Math.abs(angle % Math.PI);

    if (normalized > Math.PI / 2) {
        normalized = Math.PI - normalized;
    }

    return normalized < 0.18;
}

function textItemToRect(item, viewport, Util) {
    if (!item || typeof item.str !== 'string' || !item.str.trim() || !Array.isArray(item.transform)) {
        return null;
    }

    const transform = Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(transform[1], transform[0]);

    if (!nearHorizontal(angle)) {
        return null;
    }

    const height = Math.max(Math.abs(item.height || 0) * viewport.scale, Math.hypot(transform[2], transform[3]));
    const width = Math.abs(item.width || 0) * viewport.scale;

    if (width <= 0 || height <= 0) {
        return null;
    }

    let x0 = transform[4];

    if (Math.cos(angle) < 0) {
        x0 -= width;
    }

    return {
        x0,
        y0: transform[5] - height,
        x1: x0 + width,
        y1: transform[5],
        text: item.str.replace(/\s+/g, ' ').trim(),
    };
}

function roundedCoordinate(value) {
    return Math.round(value * 1000) / 1000;
}

function textItemToLayerItem(item, styles, viewport, Util) {
    if (!item || typeof item.str !== 'string' || !item.str || !Array.isArray(item.transform)) {
        return null;
    }

    const transform = Util.transform(viewport.transform, item.transform);
    const style = styles?.[item.fontName] || {};
    let angle = Math.atan2(transform[1], transform[0]);

    if (style.vertical) {
        angle += Math.PI / 2;
    }

    const fontHeight = Math.hypot(transform[2], transform[3]);

    if (!Number.isFinite(fontHeight) || fontHeight <= 0) {
        return null;
    }

    let fontAscent = fontHeight;

    if (Number.isFinite(style.ascent)) {
        fontAscent = style.ascent * fontHeight;
    } else if (Number.isFinite(style.descent)) {
        fontAscent = (1 + style.descent) * fontHeight;
    }

    const left = angle === 0 ? transform[4] : transform[4] + fontAscent * Math.sin(angle);
    const top = angle === 0 ? transform[5] - fontAscent : transform[5] - fontAscent * Math.cos(angle);
    const width = Math.abs(Number(item.width) || 0) * viewport.scale;

    if (![left, top, width, angle].every(Number.isFinite)) {
        return null;
    }

    return {
        text: item.str,
        left: roundedCoordinate(left),
        top: roundedCoordinate(top),
        width: roundedCoordinate(width),
        height: roundedCoordinate(fontHeight),
        angle: roundedCoordinate(angle),
        font_family: typeof style.fontFamily === 'string' ? style.fontFamily.slice(0, 200) : 'sans-serif',
        direction: item.dir === 'rtl' ? 'rtl' : 'ltr',
        has_eol: item.hasEOL === true,
    };
}

function problemRegions(problem) {
    const rawRegions = Array.isArray(problem.evidence?.regions) ? [...problem.evidence.regions] : [];

    if (Array.isArray(problem.evidence?.bbox)) {
        rawRegions.push(problem.evidence.bbox);
    }

    return rawRegions.map(normalizeRegion).filter(Boolean);
}

async function resolvePdfPath(filename) {
    if (!/^[a-zA-Z0-9._-]+\.pdf$/i.test(filename) || path.basename(filename) !== filename) {
        const error = new Error('Invalid PDF filename');
        error.status = 400;
        throw error;
    }

    const pdfRoot = await fs.realpath(PDF_DIR);
    const pdfPath = await fs.realpath(path.join(pdfRoot, filename));

    if (!pdfPath.startsWith(`${pdfRoot}${path.sep}`)) {
        const error = new Error('PDF path is outside the allowed directory');
        error.status = 403;
        throw error;
    }

    return pdfPath;
}

let pdfjsPromise = null;
const pdfDocumentCache = new Map();
const pdfArtifactCache = new Map();
let pdfArtifactCacheBytes = 0;

function getPdfjs() {
    pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');

    return pdfjsPromise;
}

async function resolvePdfDescriptor(filename) {
    const pdfPath = await resolvePdfPath(filename);
    const stats = await fs.stat(pdfPath);

    return {
        pdfPath,
        version: `${pdfPath}:${stats.size}:${stats.mtimeMs}`,
    };
}

function touchCacheEntry(cache, key, entry) {
    cache.delete(key);
    cache.set(key, entry);
}

async function trimPdfDocumentCache(excludedKey = null) {
    while (pdfDocumentCache.size > PDF_DOCUMENT_CACHE_LIMIT) {
        const candidate = [...pdfDocumentCache.entries()].find(
            ([key, entry]) => key !== excludedKey && entry.active === 0,
        );

        if (!candidate) return;

        const [key, entry] = candidate;
        pdfDocumentCache.delete(key);

        try {
            await entry.promise.catch(() => null);
            await entry.loadingTask?.destroy();
        } catch {
            // Cache eviction is best effort.
        }
    }
}

async function acquirePdfDocument(descriptor) {
    let entry = pdfDocumentCache.get(descriptor.version);

    if (!entry) {
        entry = {
            active: 0,
            loadingTask: null,
            operationQueue: Promise.resolve(),
            promise: null,
        };
        entry.promise = (async () => {
            const { getDocument, VerbosityLevel } = await getPdfjs();
            const bytes = await fs.readFile(descriptor.pdfPath);

            entry.loadingTask = getDocument({
                data: new Uint8Array(bytes),
                cMapUrl: PDFJS_CMAP_URL,
                cMapPacked: true,
                standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
                iccUrl: PDFJS_ICC_URL,
                wasmUrl: PDFJS_WASM_URL,
                useWorkerFetch: false,
                verbosity: VerbosityLevel.ERRORS,
                stopAtErrors: false,
            });

            return entry.loadingTask.promise;
        })().catch(error => {
            if (pdfDocumentCache.get(descriptor.version) === entry) {
                pdfDocumentCache.delete(descriptor.version);
            }

            throw error;
        });
        pdfDocumentCache.set(descriptor.version, entry);
    } else {
        touchCacheEntry(pdfDocumentCache, descriptor.version, entry);
    }

    entry.active++;

    try {
        const pdfDocument = await entry.promise;
        await trimPdfDocumentCache(descriptor.version);
        let released = false;

        return {
            entry,
            pdfDocument,
            release() {
                if (released) return;

                released = true;
                entry.active = Math.max(0, entry.active - 1);
                void trimPdfDocumentCache();
            },
        };
    } catch (error) {
        entry.active = Math.max(0, entry.active - 1);
        throw error;
    }
}

async function withPdfDocument(descriptor, operation) {
    const handle = await acquirePdfDocument(descriptor);
    const operationPromise = handle.entry.operationQueue.then(() => operation(handle.pdfDocument));

    handle.entry.operationQueue = operationPromise.catch(() => {});

    try {
        return await operationPromise;
    } finally {
        handle.release();
    }
}

function cachedArtifactSize(value) {
    if (Buffer.isBuffer(value)) return value.length;
    return Buffer.byteLength(JSON.stringify(value));
}

function trimPdfArtifactCache(excludedKey = null) {
    while (
        pdfArtifactCache.size > PDF_ARTIFACT_CACHE_MAX_ENTRIES ||
        pdfArtifactCacheBytes > PDF_ARTIFACT_CACHE_MAX_BYTES
    ) {
        const candidate = [...pdfArtifactCache.entries()].find(
            ([key, entry]) => key !== excludedKey && entry.ready,
        );

        if (!candidate) return;

        const [key, entry] = candidate;
        pdfArtifactCache.delete(key);
        pdfArtifactCacheBytes = Math.max(0, pdfArtifactCacheBytes - entry.size);
    }
}

async function getCachedPdfArtifact(key, producer) {
    let entry = pdfArtifactCache.get(key);

    if (entry) {
        touchCacheEntry(pdfArtifactCache, key, entry);
        return entry.promise;
    }

    entry = {
        promise: null,
        ready: false,
        size: 0,
    };
    entry.promise = Promise.resolve()
        .then(producer)
        .then(value => {
            entry.ready = true;
            entry.size = cachedArtifactSize(value);
            pdfArtifactCacheBytes += entry.size;
            trimPdfArtifactCache(key);
            return value;
        })
        .catch(error => {
            if (pdfArtifactCache.get(key) === entry) {
                pdfArtifactCache.delete(key);
            }

            throw error;
        });
    pdfArtifactCache.set(key, entry);
    trimPdfArtifactCache(key);

    return entry.promise;
}

async function closePdfCaches() {
    pdfArtifactCache.clear();
    pdfArtifactCacheBytes = 0;
    const entries = [...pdfDocumentCache.values()];
    pdfDocumentCache.clear();

    await Promise.all(
        entries.map(async entry => {
            try {
                await entry.promise.catch(() => null);
                await entry.operationQueue.catch(() => null);
                await entry.loadingTask?.destroy();
            } catch {
                // Server shutdown is best effort.
            }
        }),
    );
}

async function recoverTextForProblem(problem) {
    if (!Number.isInteger(problem.page) || problem.page < 1) {
        return {
            available: false,
            reason: 'Dieser Fund ist keiner einzelnen PDF-Seite zugeordnet.',
            regions: [],
        };
    }

    const regions = problemRegions(problem);

    if (regions.length === 0) {
        return {
            available: false,
            reason: 'Für diesen Fund sind keine Positionsdaten vorhanden.',
            regions: [],
        };
    }

    const [{ Util }, descriptor] = await Promise.all([getPdfjs(), resolvePdfDescriptor(problem.file)]);

    return withPdfDocument(descriptor, async pdfDocument => {
        if (problem.page > pdfDocument.numPages) {
            return {
                available: false,
                reason: `Seite ${problem.page} existiert in diesem PDF nicht.`,
                regions: [],
            };
        }

        const page = await pdfDocument.getPage(problem.page);

        const viewport = page.getViewport({
            scale: FORENSIC_RENDER_SCALE,
        });
        const textContent = await page.getTextContent({
            includeMarkedContent: true,
        });
        const textItems = textContent.items.map(item => textItemToRect(item, viewport, Util)).filter(Boolean);
        const recoveredRegions = regions.map(region => {
            const matchingItems = textItems.filter(item => intersects(region, item));
            const text = matchingItems
                .map(item => item.text)
                .filter(Boolean)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();

            return {
                bbox: region.bbox,
                text,
                text_item_count: matchingItems.length,
            };
        });

        return {
            available: true,
            page: problem.page,
            regions: recoveredRegions,
            recovered_text: recoveredRegions
                .map(region => region.text)
                .filter(Boolean)
                .join('\n'),
        };
    });
}

async function loadProblems() {
    return listDatabaseProblems(database, PROJECT).map(problem => ({
        ...problem,
        evidence: sanitizeEvidence(problem.evidence),
    }));
}

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(APP_DIR, 'public'), { index: false }));

app.get('/', (request, response) => {
    response.sendFile(path.join(APP_DIR, 'public', 'index.html'));
});

app.get('/api/problems', async (request, response, next) => {
    try {
        const problems = await loadProblems();

        response.json({
            problems,
            total: problems.length,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/progress', async (request, response, next) => {
    try {
        response.json({
            reviewed: listReviewDecisions(database, PROJECT),
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/recovered-text', async (request, response, next) => {
    try {
        const problemId = stringOrNull(request.query.problem_id);

        if (!problemId) {
            response.status(400).json({ error: 'problem_id is required' });
            return;
        }

        const databaseProblem = getDatabaseProblem(database, PROJECT, problemId);
        const problem = databaseProblem
            ? { ...databaseProblem, evidence: sanitizeEvidence(databaseProblem.evidence) }
            : null;

        if (!problem) {
            response.status(404).json({ error: 'Unknown problem_id' });
            return;
        }

        response.set('Cache-Control', 'private, no-store');
        response.json({
            problem_id: problemId,
            ...(await recoverTextForProblem(problem)),
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/pdf-page', async (request, response, next) => {
    const filename = stringOrNull(request.query.filename);
    const pageNumber = Number(request.query.page);
    const requestedWidth = Number(request.query.width || 1600);

    if (!filename || !Number.isInteger(pageNumber) || pageNumber < 1) {
        response.status(400).json({ error: 'filename and a positive integer page are required' });
        return;
    }

    if (!Number.isFinite(requestedWidth) || requestedWidth < 600 || requestedWidth > 2400) {
        response.status(400).json({ error: 'width must be between 600 and 2400' });
        return;
    }

    try {
        const descriptor = await resolvePdfDescriptor(filename);
        const cacheKey = `page:${descriptor.version}:${pageNumber}:${requestedWidth}`;
        const cacheStatus = pdfArtifactCache.has(cacheKey) ? 'HIT' : 'MISS';
        const png = await getCachedPdfArtifact(cacheKey, async () => {
            const { AnnotationMode } = await getPdfjs();

            return withPdfDocument(descriptor, async pdfDocument => {
                if (pageNumber > pdfDocument.numPages) {
                    const error = new Error(`PDF has only ${pdfDocument.numPages} pages`);
                    error.status = 404;
                    throw error;
                }

                const page = await pdfDocument.getPage(pageNumber);
                const baseViewport = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: requestedWidth / baseViewport.width });
                const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                const renderTask = page.render({
                    canvasContext: canvas.getContext('2d'),
                    viewport,
                    annotationMode: AnnotationMode.ENABLE,
                });

                await renderTask.promise;
                return canvas.toBuffer('image/png');
            });
        });

        response.set({
            'Cache-Control': PDF_BROWSER_CACHE,
            'Content-Type': 'image/png',
            'Content-Length': String(png.length),
            'X-PDF-Cache': cacheStatus,
            'X-Content-Type-Options': 'nosniff',
        });
        response.send(png);
    } catch (error) {
        next(error);
    }
});

app.get('/api/pdf-text-layer', async (request, response, next) => {
    const filename = stringOrNull(request.query.filename);
    const pageNumber = Number(request.query.page);
    const requestedWidth = Number(request.query.width || 1600);

    if (!filename || !Number.isInteger(pageNumber) || pageNumber < 1) {
        response.status(400).json({ error: 'filename and a positive integer page are required' });
        return;
    }

    if (!Number.isFinite(requestedWidth) || requestedWidth < 600 || requestedWidth > 2400) {
        response.status(400).json({ error: 'width must be between 600 and 2400' });
        return;
    }

    try {
        const [{ Util }, descriptor] = await Promise.all([getPdfjs(), resolvePdfDescriptor(filename)]);
        const cacheKey = `text:${descriptor.version}:${pageNumber}:${requestedWidth}`;
        const cacheStatus = pdfArtifactCache.has(cacheKey) ? 'HIT' : 'MISS';
        const payload = await getCachedPdfArtifact(cacheKey, () =>
            withPdfDocument(descriptor, async pdfDocument => {
                if (pageNumber > pdfDocument.numPages) {
                    const error = new Error(`PDF has only ${pdfDocument.numPages} pages`);
                    error.status = 404;
                    throw error;
                }

                const page = await pdfDocument.getPage(pageNumber);
                const baseViewport = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: requestedWidth / baseViewport.width });
                const textContent = await page.getTextContent({
                    includeMarkedContent: false,
                });
                const items = textContent.items
                    .map(item => textItemToLayerItem(item, textContent.styles, viewport, Util))
                    .filter(Boolean);

                return {
                    width: roundedCoordinate(viewport.width),
                    height: roundedCoordinate(viewport.height),
                    coordinate_width: roundedCoordinate(baseViewport.width * FORENSIC_RENDER_SCALE),
                    coordinate_height: roundedCoordinate(baseViewport.height * FORENSIC_RENDER_SCALE),
                    items,
                };
            }),
        );

        response.set({
            'Cache-Control': PDF_BROWSER_CACHE,
            'X-PDF-Cache': cacheStatus,
        });
        response.json(payload);
    } catch (error) {
        next(error);
    }
});

app.post('/api/review', async (request, response, next) => {
    const problemId = stringOrNull(request.body?.problem_id);
    const decision = request.body?.decision === 'accept' ? 'accepted' : request.body?.decision === 'skip' ? 'skipped' : null;

    if (!problemId || !decision) {
        response.status(400).json({
            error: 'problem_id and decision (accept or skip) are required',
        });
        return;
    }

    try {
        response.json(saveReview(database, PROJECT, problemId, decision));
    } catch (error) {
        next(error);
    }
});

app.get('/pdf/:filename', async (request, response, next) => {
    try {
        const filename = request.params.filename;
        const pdfPath = await resolvePdfPath(filename);

        response.set({
            'Cache-Control': PDF_BROWSER_CACHE,
            'Content-Disposition': `inline; filename="${filename}"`,
            'X-Content-Type-Options': 'nosniff',
        });
        response.sendFile(pdfPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            response.status(404).json({ error: 'PDF not found' });
            return;
        }

        next(error);
    }
});

app.use((error, request, response, next) => {
    if (response.headersSent) {
        next(error);
        return;
    }

    if (!error.status || error.status >= 500) {
        console.error(error);
    }
    response.status(error.status || 500).json({
        error: error.status ? error.message : 'Internal server error',
    });
});

function startServer() {
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
        throw new Error('PORT must be an integer between 1 and 65535');
    }

    const server = app.listen(PORT, HOST, error => {
        if (error) {
            console.error(`Unable to start server on http://${HOST}:${PORT}: ${error.message}`);
            process.exitCode = 1;
            return;
        }

        console.log(`Human review app: http://${HOST}:${PORT}`);
        console.log(`Database: ${DATABASE_FILE}`);
        console.log(`Project:  ${PROJECT}`);
        console.log(`Project ID: ${PROJECT_ID}`);
        console.log(`PDFs:     ${PDF_DIR}`);
    });

    server.on('close', () => {
        database.close();
        void closePdfCaches();
    });
    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    loadProblems,
    recoverTextForProblem,
    startServer,
};
