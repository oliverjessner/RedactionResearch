const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { createCanvas } = require('@napi-rs/canvas');
const express = require('express');

const APP_DIR = __dirname;
const PROJECT_DIR = path.resolve(APP_DIR, '..');
const OUTPUT_DIR = path.join(PROJECT_DIR, 'output');
const FORENSIC_DIR = path.join(OUTPUT_DIR, 'forensic');

const PROBLEMS_FILE = path.resolve(
    process.env.HITL_PROBLEMS_FILE || path.join(FORENSIC_DIR, 'redaction_problems.json'),
);
const PDF_DIR = path.resolve(process.env.HITL_PDF_DIR || path.join(OUTPUT_DIR, 'download', 'pdfs'));
const REVIEW_DIR = path.resolve(process.env.HITL_REVIEW_DIR || FORENSIC_DIR);
const ACCEPTED_FILE = path.join(REVIEW_DIR, 'human_found_redaction_problems.json');
const PROGRESS_FILE = path.join(REVIEW_DIR, 'human_review_progress.json');
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const PDFJS_CMAP_URL = `${path.join(PDFJS_ROOT, 'cmaps')}${path.sep}`;
const PDFJS_STANDARD_FONT_URL = `${path.join(PDFJS_ROOT, 'standard_fonts')}${path.sep}`;
const PDFJS_ICC_URL = `${path.join(PDFJS_ROOT, 'iccs')}${path.sep}`;
const PDFJS_WASM_URL = `${path.join(PDFJS_ROOT, 'wasm')}${path.sep}`;
const FORENSIC_RENDER_SCALE = 1.5;

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);

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

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return fallback;
        }

        throw new Error(`Invalid or unreadable JSON at ${file}: ${error.message}`);
    }
}

async function writeJsonAtomic(file, data) {
    await fs.mkdir(path.dirname(file), {
        recursive: true,
    });

    const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;

    try {
        await fs.writeFile(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await fs.rename(temporaryFile, file);
    } catch (error) {
        await fs.unlink(temporaryFile).catch(cleanupError => {
            if (cleanupError.code !== 'ENOENT') {
                error.cleanupError = cleanupError;
            }
        });

        throw error;
    }
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
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

function severityFromScore(score) {
    if (score >= 90) return 'critical';
    if (score >= 75) return 'high';
    if (score >= 60) return 'medium';
    return 'low';
}

function createProblemId(documentId, page, type, index) {
    return `${documentId}:${page ?? 'document'}:${type}:${index}`;
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

function getPdfjs() {
    pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');

    return pdfjsPromise;
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

    const [{ getDocument, Util, VerbosityLevel }, pdfPath] = await Promise.all([getPdfjs(), resolvePdfPath(problem.file)]);
    const bytes = await fs.readFile(pdfPath);
    const loadingTask = getDocument({
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
    let page = null;

    try {
        const pdfDocument = await loadingTask.promise;

        if (problem.page > pdfDocument.numPages) {
            return {
                available: false,
                reason: `Seite ${problem.page} existiert in diesem PDF nicht.`,
                regions: [],
            };
        }

        page = await pdfDocument.getPage(problem.page);

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
    } finally {
        page?.cleanup();
        await loadingTask.destroy();
    }
}

function normalizeProblems(rawDocuments) {
    if (!Array.isArray(rawDocuments)) {
        return [];
    }

    const flattened = [];

    for (const [documentIndex, rawDocument] of rawDocuments.entries()) {
        if (!isPlainObject(rawDocument)) {
            continue;
        }

        const file = stringOrNull(rawDocument.file);

        if (!file || path.basename(file) !== file || !file.toLowerCase().endsWith('.pdf')) {
            continue;
        }

        const documentId =
            stringOrNull(rawDocument.document_id) || path.basename(file, path.extname(file)) || `document-${documentIndex}`;
        const rawProblems = Array.isArray(rawDocument.problems) ? rawDocument.problems : [rawDocument];

        for (const [problemIndex, rawProblem] of rawProblems.entries()) {
            if (!isPlainObject(rawProblem)) {
                continue;
            }

            const type = stringOrNull(rawProblem.type) || 'UNKNOWN_PROBLEM';
            const page = numberOrNull(rawProblem.page);
            const riskScore = numberOrNull(rawProblem.risk_score) ?? numberOrNull(rawDocument.highest_risk_score) ?? 0;

            flattened.push({
                problem_id: createProblemId(documentId, page, type, problemIndex),
                document_id: documentId,
                file,
                title: stringOrNull(rawDocument.title),
                page,
                type,
                risk_score: riskScore,
                severity: stringOrNull(rawProblem.severity)?.toLowerCase() || severityFromScore(riskScore),
                evidence: sanitizeEvidence(rawProblem.evidence),
                source_url: stringOrNull(rawDocument.source_url),
                page_count: numberOrNull(rawDocument.page_count),
            });
        }
    }

    return flattened.sort((a, b) => {
        const scoreDifference = b.risk_score - a.risk_score;

        if (scoreDifference !== 0) return scoreDifference;

        const documentDifference = a.document_id.localeCompare(b.document_id, undefined, {
            numeric: true,
        });

        if (documentDifference !== 0) return documentDifference;

        const pageDifference = (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER);

        if (pageDifference !== 0) return pageDifference;

        return a.problem_id.localeCompare(b.problem_id, undefined, {
            numeric: true,
        });
    });
}

async function loadProblems() {
    return normalizeProblems(await readJson(PROBLEMS_FILE, []));
}

function toAcceptedRecord(problem) {
    return {
        problem_id: problem.problem_id,
        document_id: problem.document_id,
        file: problem.file,
        title: problem.title,
        page: problem.page,
        type: problem.type,
        risk_score: problem.risk_score,
        severity: problem.severity,
        evidence: problem.evidence,
        source_url: problem.source_url,
        reviewed_at: new Date().toISOString(),
    };
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
        const progress = await readJson(PROGRESS_FILE, { reviewed: {} });

        response.json({
            reviewed: isPlainObject(progress.reviewed) ? progress.reviewed : {},
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

        const problems = await loadProblems();
        const problem = problems.find(item => item.problem_id === problemId);

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

    let loadingTask = null;
    let page = null;

    try {
        const [{ AnnotationMode, getDocument, VerbosityLevel }, pdfPath] = await Promise.all([
            getPdfjs(),
            resolvePdfPath(filename),
        ]);
        const bytes = await fs.readFile(pdfPath);

        loadingTask = getDocument({
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

        const pdfDocument = await loadingTask.promise;

        if (pageNumber > pdfDocument.numPages) {
            response.status(404).json({ error: `PDF has only ${pdfDocument.numPages} pages` });
            return;
        }

        page = await pdfDocument.getPage(pageNumber);

        const baseViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: requestedWidth / baseViewport.width });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const renderTask = page.render({
            canvasContext: canvas.getContext('2d'),
            viewport,
            annotationMode: AnnotationMode.ENABLE,
        });

        await renderTask.promise;

        const png = canvas.toBuffer('image/png');

        response.set({
            'Cache-Control': 'private, no-store',
            'Content-Type': 'image/png',
            'Content-Length': String(png.length),
            'X-Content-Type-Options': 'nosniff',
        });
        response.send(png);
    } catch (error) {
        next(error);
    } finally {
        page?.cleanup();
        await loadingTask?.destroy().catch(() => {});
    }
});

let reviewQueue = Promise.resolve();

app.post('/api/review', async (request, response, next) => {
    const problemId = stringOrNull(request.body?.problem_id);
    const decision = request.body?.decision === 'accept' ? 'accepted' : request.body?.decision === 'skip' ? 'skipped' : null;

    if (!problemId || !decision) {
        response.status(400).json({
            error: 'problem_id and decision (accept or skip) are required',
        });
        return;
    }

    const saveReview = async () => {
        const problems = await loadProblems();
        const problem = problems.find(item => item.problem_id === problemId);

        if (!problem) {
            const error = new Error('Unknown problem_id');
            error.status = 404;
            throw error;
        }

        const progress = await readJson(PROGRESS_FILE, { reviewed: {} });
        const reviewed = isPlainObject(progress.reviewed) ? progress.reviewed : {};
        const accepted = await readJson(ACCEPTED_FILE, []);
        const acceptedById = new Map(
            (Array.isArray(accepted) ? accepted : [])
                .filter(item => isPlainObject(item) && stringOrNull(item.problem_id))
                .map(item => [item.problem_id, item]),
        );

        if (decision === 'accepted') {
            acceptedById.set(problemId, toAcceptedRecord(problem));
        } else {
            acceptedById.delete(problemId);
        }

        reviewed[problemId] = decision;

        const acceptedOutput = [...acceptedById.values()].sort((a, b) =>
            a.problem_id.localeCompare(b.problem_id, undefined, { numeric: true }),
        );
        const progressOutput = {
            reviewed,
            updated_at: new Date().toISOString(),
        };

        await writeJsonAtomic(ACCEPTED_FILE, acceptedOutput);
        await writeJsonAtomic(PROGRESS_FILE, progressOutput);

        return {
            problem_id: problemId,
            decision,
            accepted_total: acceptedOutput.length,
        };
    };

    const queuedReview = reviewQueue.then(saveReview, saveReview);
    reviewQueue = queuedReview.catch(() => {});

    try {
        response.json(await queuedReview);
    } catch (error) {
        next(error);
    }
});

app.get('/pdf/:filename', async (request, response, next) => {
    try {
        const filename = request.params.filename;
        const pdfPath = await resolvePdfPath(filename);

        response.set({
            'Cache-Control': 'private, no-store',
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

    return app.listen(PORT, HOST, error => {
        if (error) {
            console.error(`Unable to start server on http://${HOST}:${PORT}: ${error.message}`);
            process.exitCode = 1;
            return;
        }

        console.log(`Human review app: http://${HOST}:${PORT}`);
        console.log(`Problems: ${PROBLEMS_FILE}`);
        console.log(`PDFs:     ${PDF_DIR}`);
        console.log(`Reviews:  ${REVIEW_DIR}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    loadProblems,
    normalizeProblems,
    recoverTextForProblem,
    startServer,
};
