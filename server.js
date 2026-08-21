const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

const { createCanvas } = require('@napi-rs/canvas');
const express = require('express');
const {
    createProject,
    createProjectJob,
    deleteProject,
    failStaleProjectJobs,
    getProblem: getDatabaseProblem,
    getProject,
    getProjectJob,
    listProblems: listDatabaseProblems,
    listProjects: listDatabaseProjects,
    listReviewDecisions,
    openForensicDatabase,
    saveReview,
    updateProjectJob,
} = require('./lib/forensic-db.js');
const {
    FORENSIC_RENDER_SCALE,
    combineRecoveredText,
    problemRegions,
    recoverProblemRegions,
    textItemToRect,
} = require('./lib/pdf-text-recovery.js');

const APP_DIR = __dirname;
const PROJECT_DIR = APP_DIR;
const OUTPUT_DIR = path.join(PROJECT_DIR, 'output');
const FORENSIC_DIR = path.join(OUTPUT_DIR, 'forensic');
const PDF_ROOT = path.resolve(process.env.HITL_PDF_ROOT || path.join(OUTPUT_DIR, 'download', 'pdfs'));

const DATABASE_FILE = path.resolve(process.env.HITL_DATABASE_FILE || path.join(FORENSIC_DIR, 'forensic.sqlite'));
const SCANNER_FILE = path.resolve(
    process.env.HITL_SCANNER_FILE || path.join(PROJECT_DIR, 'forensic.mjs'),
);
const OPEN_FINDINGS_FILTER_FILE = path.resolve(
    process.env.HITL_OPEN_FINDINGS_FILTER_FILE || path.join(PROJECT_DIR, 'scripts', 'filter-open-findings.mjs'),
);
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const PDFJS_CMAP_URL = `${path.join(PDFJS_ROOT, 'cmaps')}${path.sep}`;
const PDFJS_STANDARD_FONT_URL = `${path.join(PDFJS_ROOT, 'standard_fonts')}${path.sep}`;
const PDFJS_ICC_URL = `${path.join(PDFJS_ROOT, 'iccs')}${path.sep}`;
const PDFJS_WASM_URL = `${path.join(PDFJS_ROOT, 'wasm')}${path.sep}`;
const PDF_DOCUMENT_CACHE_LIMIT = 3;
const PDF_ARTIFACT_CACHE_MAX_ENTRIES = 48;
const PDF_ARTIFACT_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const PDF_BROWSER_CACHE = 'private, max-age=3600';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const database = openForensicDatabase(DATABASE_FILE);
failStaleProjectJobs(database);

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

function httpError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function parseProjectId(value) {
    const projectId = Number(value);

    if (!Number.isInteger(projectId) || projectId < 1) {
        throw httpError('project_id must be a positive integer');
    }

    return projectId;
}

function requireProject(value) {
    const projectId = parseProjectId(value);
    const project = getProject(database, projectId);

    if (!project) throw httpError('Unknown project_id', 404);

    return project;
}

function projectPdfDirectory(projectId) {
    return path.join(PDF_ROOT, String(projectId));
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

function sanitizeMetadata(value, state = { fields: 0 }, depth = 0) {
    if (depth > 6 || state.fields >= 250 || value === undefined) return undefined;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') return value.slice(0, 20_000);

    if (Array.isArray(value)) {
        return value
            .slice(0, 100)
            .map(item => sanitizeMetadata(item, state, depth + 1))
            .filter(item => item !== undefined);
    }

    if (value instanceof Map) {
        value = Object.fromEntries(value);
    }

    if (typeof value !== 'object') return undefined;

    const clean = Object.create(null);

    for (const [key, item] of Object.entries(value)) {
        if (state.fields >= 250) break;

        state.fields++;
        const sanitized = sanitizeMetadata(item, state, depth + 1);

        if (sanitized !== undefined) clean[String(key).slice(0, 200)] = sanitized;
    }

    return clean;
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

async function resolvePdfPath(projectId, filename) {
    if (!/^[a-zA-Z0-9._-]+\.pdf$/i.test(filename) || path.basename(filename) !== filename) {
        const error = new Error('Invalid PDF filename');
        error.status = 400;
        throw error;
    }

    let pdfRoot;
    let pdfPath;

    try {
        pdfRoot = await fs.realpath(projectPdfDirectory(projectId));
        pdfPath = await fs.realpath(path.join(pdfRoot, filename));
    } catch (error) {
        if (error.code === 'ENOENT') throw httpError('PDF not found', 404);
        throw error;
    }

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

async function resolvePdfDescriptor(projectId, filename) {
    const pdfPath = await resolvePdfPath(projectId, filename);
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

async function recoverTextForProblem(projectId, problem) {
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

    const [{ Util }, descriptor] = await Promise.all([getPdfjs(), resolvePdfDescriptor(projectId, problem.file)]);

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
        const recoveredRegions = recoverProblemRegions(problem, textItems);

        return {
            available: true,
            page: problem.page,
            regions: recoveredRegions,
            recovered_text: combineRecoveredText(recoveredRegions),
        };
    });
}

async function readPdfMetadata(projectId, problem) {
    const descriptor = await resolvePdfDescriptor(projectId, problem.file);

    return withPdfDocument(descriptor, async pdfDocument => {
        const metadata = await pdfDocument.getMetadata();
        const info = sanitizeMetadata(metadata?.info) || {};
        const rawXmp = typeof metadata?.metadata?.getAll === 'function' ? metadata.metadata.getAll() : null;
        const xmp = sanitizeMetadata(rawXmp) || {};
        const available = Object.keys(info).length > 0 || Object.keys(xmp).length > 0;

        return {
            available,
            reason: available ? null : 'Dieses PDF enthält keine lesbaren Info- oder XMP-Metadaten.',
            info,
            xmp,
        };
    });
}

async function loadProblems(project) {
    return listDatabaseProblems(database, project.project).map(problem => ({
        ...problem,
        evidence: sanitizeEvidence(problem.evidence),
    }));
}

async function countProjectPdfs(projectId) {
    try {
        const entries = await fs.readdir(projectPdfDirectory(projectId), { withFileTypes: true });
        return entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')).length;
    } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
    }
}

async function listProjects() {
    return Promise.all(
        listDatabaseProjects(database).map(async project => ({
            ...project,
            pdf_count: await countProjectPdfs(project.id),
        })),
    );
}

function safePdfFilename(fileName) {
    const baseName = path.basename(fileName);
    const sourceName = path.basename(baseName, path.extname(baseName));
    const safeStem = sourceName
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 160);

    return `${safeStem || 'document'}.pdf`;
}

function fileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);

        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function importPdf(sourceFile, targetDirectory, requestedName = path.basename(sourceFile)) {
    const safeName = safePdfFilename(requestedName);
    let targetFile = path.join(targetDirectory, safeName);

    if (!(await fileExists(targetFile))) {
        await fs.copyFile(sourceFile, targetFile);
        return { imported: true, file: safeName };
    }

    const sourceHash = await fileHash(sourceFile);

    if ((await fileHash(targetFile)) === sourceHash) {
        return { imported: false, file: safeName };
    }

    const stem = path.basename(safeName, '.pdf');
    let suffix = sourceHash.slice(0, 10);
    let attempt = 0;

    while (true) {
        const candidateName = `${stem}-${suffix}${attempt ? `-${attempt}` : ''}.pdf`;
        targetFile = path.join(targetDirectory, candidateName);

        if (!(await fileExists(targetFile))) {
            await fs.copyFile(sourceFile, targetFile);
            return { imported: true, file: candidateName };
        }

        if ((await fileHash(targetFile)) === sourceHash) {
            return { imported: false, file: candidateName };
        }

        attempt++;
    }
}

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

async function receiveUploadedPdf(request, projectId, requestedName) {
    if (!requestedName || !requestedName.toLowerCase().endsWith('.pdf') || requestedName.length > 255) {
        throw httpError('Ein gültiger PDF-Dateiname ist erforderlich.');
    }

    const contentLength = Number(request.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
        throw httpError('Das PDF ist größer als 1 GB.', 413);
    }

    const targetDirectory = projectPdfDirectory(projectId);
    await fs.mkdir(targetDirectory, { recursive: true });
    const temporaryFile = path.join(targetDirectory, `.upload-${randomUUID()}.tmp`);
    const handle = await fs.open(temporaryFile, 'wx');
    let totalBytes = 0;
    let header = Buffer.alloc(0);
    let uploadError = null;

    try {
        for await (const chunk of request) {
            totalBytes += chunk.length;
            if (totalBytes > MAX_UPLOAD_BYTES) throw httpError('Das PDF ist größer als 1 GB.', 413);
            if (header.length < 1024) header = Buffer.concat([header, chunk]).subarray(0, 1024);
            await handle.write(chunk);
        }
    } catch (error) {
        uploadError = error;
    } finally {
        await handle.close();
    }

    if (uploadError) {
        await fs.unlink(temporaryFile).catch(() => {});
        throw uploadError;
    }

    try {
        if (totalBytes === 0 || !header.includes(Buffer.from('%PDF-'))) {
            throw httpError('Die ausgewählte Datei ist kein gültiges PDF.');
        }

        return await importPdf(temporaryFile, targetDirectory, requestedName);
    } finally {
        await fs.unlink(temporaryFile).catch(() => {});
    }
}

function requireUploadJob(projectId, jobId) {
    const job = getProjectJob(database, projectId, Number(jobId));

    if (!job || job.kind !== 'import') throw httpError('Unknown upload job', 404);
    if (!['queued', 'running'].includes(job.status)) throw httpError('Dieser Upload ist bereits beendet.', 409);

    return job;
}

function runScanJob(project, jobId) {
    updateProjectJob(database, jobId, { status: 'running', message: 'Forensic-Scanner wird gestartet …' });
    const child = spawn(process.execPath, [SCANNER_FILE, '--project', project.project], {
        cwd: PROJECT_DIR,
        env: {
            ...process.env,
            FORENSIC_DATABASE_FILE: DATABASE_FILE,
            FORENSIC_OUTPUT_DIR: OUTPUT_DIR,
            FORENSIC_PDF_ROOT: PDF_ROOT,
        },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let bufferedOutput = '';
    let lastMessage = 'Forensic-Scan läuft …';

    const consumeOutput = chunk => {
        bufferedOutput = `${bufferedOutput}${chunk}`.slice(-8000);
        const lines = bufferedOutput.split(/\r?\n/);
        bufferedOutput = lines.pop() || '';
        const usefulLine = lines.map(line => line.trim()).filter(Boolean).at(-1);

        if (usefulLine) {
            lastMessage = usefulLine.slice(0, 500);
            const progress = usefulLine.match(/^\[(\d+)\/(\d+)\]/);
            updateProjectJob(database, jobId, {
                status: 'running',
                ...(progress
                    ? { processed_count: Number(progress[1]), total_count: Number(progress[2]) }
                    : {}),
                message: lastMessage,
            });
        }
    };

    child.stdout.on('data', consumeOutput);
    child.stderr.on('data', consumeOutput);
    child.on('error', error => {
        if (settled) return;
        settled = true;
        updateProjectJob(database, jobId, {
            status: 'failed',
            message: 'Scanner konnte nicht gestartet werden',
            error_message: String(error?.message || error).slice(0, 1000),
        });
    });
    child.on('close', code => {
        if (settled) return;
        settled = true;

        if (code !== 0) {
            updateProjectJob(database, jobId, {
                status: 'failed',
                message: 'Forensic-Scan fehlgeschlagen',
                error_message: `${lastMessage} (Exit ${code})`.slice(0, 1000),
            });
            return;
        }

        updateProjectJob(database, jobId, {
            status: 'running',
            message: 'Reine Unterstrich-Funde werden automatisch gefiltert …',
        });

        runOpenFindingsFilter(project, jobId);
    });
}

function runOpenFindingsFilter(project, jobId) {
    const child = spawn(
        process.execPath,
        [
            OPEN_FINDINGS_FILTER_FILE,
            '--apply',
            '--project',
            project.project,
            '--database',
            DATABASE_FILE,
            '--pdf-root',
            PDF_ROOT,
        ],
        {
            cwd: PROJECT_DIR,
            env: process.env,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    let settled = false;
    let output = '';

    const consumeOutput = chunk => {
        output = `${output}${chunk}`.slice(-12_000);
    };

    child.stdout.on('data', consumeOutput);
    child.stderr.on('data', consumeOutput);
    child.on('error', error => {
        if (settled) return;
        settled = true;
        updateProjectJob(database, jobId, {
            status: 'failed',
            message: 'Scan abgeschlossen, Unterstrich-Filter konnte nicht gestartet werden',
            error_message: String(error?.message || error).slice(0, 1000),
        });
    });
    child.on('close', code => {
        if (settled) return;
        settled = true;
        const skipped = Number(output.match(/Written as skipped:\s+(\d+)/)?.[1] || 0);

        updateProjectJob(database, jobId, {
            status: code === 0 ? 'completed' : 'failed',
            message:
                code === 0
                    ? `Forensic-Scan abgeschlossen · ${skipped} Unterstrich-Funde automatisch übersprungen`
                    : 'Scan abgeschlossen, Unterstrich-Filter fehlgeschlagen',
            error_message: code === 0 ? null : output.trim().slice(-1000) || `Filter Exit ${code}`,
        });
    });
}

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(APP_DIR, 'public'), { index: false }));

app.get('/', (request, response) => {
    response.sendFile(path.join(APP_DIR, 'public', 'index.html'));
});

app.get('/api/projects', async (request, response, next) => {
    try {
        response.json({ projects: await listProjects() });
    } catch (error) {
        next(error);
    }
});

app.post('/api/projects', async (request, response, next) => {
    try {
        const projectName = stringOrNull(request.body?.project);
        const organization = stringOrNull(request.body?.organization);

        if (!projectName || projectName.length > 120) {
            throw httpError('Projektname ist erforderlich und darf höchstens 120 Zeichen haben.');
        }

        if (/[\u0000-\u001f\u007f]/.test(projectName)) {
            throw httpError('Projektname darf keine Steuerzeichen enthalten.');
        }

        if (organization && organization.length > 200) {
            throw httpError('Organisation darf höchstens 200 Zeichen haben.');
        }

        let project;
        try {
            project = createProject(database, { project: projectName, organization });
        } catch (error) {
            if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
                throw httpError('Ein Projekt mit diesem Namen existiert bereits.', 409);
            }
            throw error;
        }

        await fs.mkdir(projectPdfDirectory(project.id), { recursive: true });
        response.status(201).json({ project: { ...project, pdf_count: 0 } });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/projects/:projectId', (request, response, next) => {
    try {
        const project = requireProject(request.params.projectId);
        const deleted = deleteProject(database, project.id);

        response.json({ deleted: { id: deleted.id, project: deleted.project } });
    } catch (error) {
        next(error);
    }
});

app.post('/api/projects/:projectId/uploads', async (request, response, next) => {
    try {
        const project = requireProject(request.params.projectId);
        const totalCount = Number(request.body?.total_count);

        if (!Number.isInteger(totalCount) || totalCount < 1 || totalCount > 100_000) {
            throw httpError('total_count must be an integer between 1 and 100000');
        }

        const job = createProjectJob(database, project.id, 'import', 'Browser-Upload wird vorbereitet …');
        response.status(201).json({
            job: updateProjectJob(database, job.id, {
                status: 'running',
                total_count: totalCount,
                message: `0 von ${totalCount} PDFs übertragen`,
            }),
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/projects/:projectId/uploads/:jobId', async (request, response, next) => {
    let project;
    let job;

    try {
        project = requireProject(request.params.projectId);
        job = requireUploadJob(project.id, request.params.jobId);
        const filename = stringOrNull(request.query.filename);
        const result = await receiveUploadedPdf(request, project.id, filename);
        const current = requireUploadJob(project.id, job.id);
        const processedCount = current.processed_count + 1;
        const updatedJob = updateProjectJob(database, job.id, {
            status: 'running',
            processed_count: processedCount,
            imported_count: current.imported_count + (result.imported ? 1 : 0),
            skipped_count: current.skipped_count + (result.imported ? 0 : 1),
            message: `${processedCount} von ${current.total_count} PDFs übertragen`,
        });

        response.status(result.imported ? 201 : 200).json({ file: result.file, imported: result.imported, job: updatedJob });
    } catch (error) {
        if (project && job) {
            const current = getProjectJob(database, project.id, job.id);
            if (current && ['queued', 'running'].includes(current.status)) {
                updateProjectJob(database, job.id, {
                    status: 'running',
                    processed_count: current.processed_count + 1,
                    error_count: current.error_count + 1,
                    message: `${current.processed_count + 1} von ${current.total_count} PDFs übertragen`,
                });
            }
        }
        next(error);
    }
});

app.post('/api/projects/:projectId/uploads/:jobId/complete', async (request, response, next) => {
    try {
        const project = requireProject(request.params.projectId);
        const job = requireUploadJob(project.id, request.params.jobId);
        const clientErrorCount = Math.max(0, Number(request.body?.error_count) || 0);
        const errorCount = Math.max(job.error_count, clientErrorCount);
        const processedCount = Math.min(job.total_count, job.imported_count + job.skipped_count + errorCount);
        const message = `${job.imported_count} importiert, ${job.skipped_count} bereits vorhanden${errorCount ? `, ${errorCount} Fehler` : ''}`;
        const completed = updateProjectJob(database, job.id, {
            status: 'completed',
            processed_count: processedCount,
            error_count: errorCount,
            message,
        });

        response.json({ job: completed });
    } catch (error) {
        next(error);
    }
});

app.post('/api/projects/:projectId/scan', async (request, response, next) => {
    try {
        const project = requireProject(request.params.projectId);
        const pdfCount = await countProjectPdfs(project.id);

        if (pdfCount === 0) throw httpError('Für dieses Projekt wurden noch keine PDFs importiert.');

        const job = createProjectJob(database, project.id, 'scan', 'Scan wartet …');
        runScanJob(project, job.id);
        response.status(202).json({ job });
    } catch (error) {
        next(error);
    }
});

app.get('/api/problems', async (request, response, next) => {
    try {
        const project = requireProject(request.query.project_id);
        const problems = await loadProblems(project);

        response.json({
            project,
            problems,
            total: problems.length,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/progress', async (request, response, next) => {
    try {
        const project = requireProject(request.query.project_id);
        response.json({
            reviewed: listReviewDecisions(database, project.project),
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/recovered-text', async (request, response, next) => {
    try {
        const project = requireProject(request.query.project_id);
        const problemId = stringOrNull(request.query.problem_id);

        if (!problemId) {
            response.status(400).json({ error: 'problem_id is required' });
            return;
        }

        const databaseProblem = getDatabaseProblem(database, project.project, problemId);
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
            ...(await recoverTextForProblem(project.id, problem)),
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/pdf-metadata', async (request, response, next) => {
    try {
        const project = requireProject(request.query.project_id);
        const problemId = stringOrNull(request.query.problem_id);

        if (!problemId) {
            response.status(400).json({ error: 'problem_id is required' });
            return;
        }

        const problem = getDatabaseProblem(database, project.project, problemId);

        if (!problem) {
            response.status(404).json({ error: 'Unknown problem_id' });
            return;
        }

        response.set({
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        response.json({
            problem_id: problemId,
            ...(await readPdfMetadata(project.id, problem)),
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
        const project = requireProject(request.query.project_id);
        const descriptor = await resolvePdfDescriptor(project.id, filename);
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
        const project = requireProject(request.query.project_id);
        const [{ Util }, descriptor] = await Promise.all([getPdfjs(), resolvePdfDescriptor(project.id, filename)]);
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
        const project = requireProject(request.body?.project_id);
        response.json(saveReview(database, project.project, problemId, decision));
    } catch (error) {
        next(error);
    }
});

app.get('/pdf/:filename', async (request, response, next) => {
    try {
        const project = requireProject(request.query.project_id);
        const filename = request.params.filename;
        const pdfPath = await resolvePdfPath(project.id, filename);

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
        console.log(`PDF root: ${PDF_ROOT}`);
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
