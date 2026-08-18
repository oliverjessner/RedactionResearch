const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

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

        if (!/^[a-zA-Z0-9._-]+\.pdf$/i.test(filename) || path.basename(filename) !== filename) {
            response.status(400).json({ error: 'Invalid PDF filename' });
            return;
        }

        const pdfRoot = await fs.realpath(PDF_DIR);
        const pdfPath = await fs.realpath(path.join(pdfRoot, filename));

        if (!pdfPath.startsWith(`${pdfRoot}${path.sep}`)) {
            response.status(403).json({ error: 'PDF path is outside the allowed directory' });
            return;
        }

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

    console.error(error);
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
    startServer,
};
