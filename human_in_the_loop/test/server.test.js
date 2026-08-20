const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');
const { openForensicDatabase, saveDocumentScanResult } = require('../../lib/forensic-db.js');

function createFixturePdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
        '<< /Length 4 >>\nstream\nq\nQ\nendstream',
        '<< /Title (Fixture metadata) /Author (reviewer@example.test) >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];

    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    pdf += offsets
        .slice(1)
        .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return pdf;
}

test('API safely serves, reviews, and persists SQLite findings', async () => {
    const temporaryDirectory = await fs.mkdtemp('/tmp/redaction-hitl-test-');
    const pdfDirectory = path.join(temporaryDirectory, 'pdfs', '1');
    const databaseFile = path.join(temporaryDirectory, 'forensic.sqlite');
    const port = 32_000 + (process.pid % 1_000);

    await fs.mkdir(pdfDirectory, { recursive: true });
    await fs.writeFile(path.join(pdfDirectory, '123.pdf'), createFixturePdf());
    const fixtureDatabase = openForensicDatabase(databaseFile);

    saveDocumentScanResult(fixtureDatabase, 'fragdenstaat.de', {
        file: '123.pdf',
        document_id: '123',
        title: 'Fixture',
        source_url: 'https://example.test/source',
        page_count: 2,
        problems: [
            {
                type: 'MEDIUM_FINDING',
                risk_score: 72,
                page: null,
                severity: 'medium',
                evidence: {
                    affected_text_items: 2,
                    hidden_text: 'must never leave the server',
                },
            },
            {
                type: 'CRITICAL_FINDING',
                risk_score: 98,
                page: 2,
                severity: 'critical',
                evidence: {
                    regions: [[1, 2, 3, 4]],
                },
            },
        ],
    });
    fixtureDatabase.close();

    process.env.HITL_DATABASE_FILE = databaseFile;
    process.env.HITL_PROJECT = 'fragdenstaat.de';
    process.env.HITL_PDF_DIR = pdfDirectory;
    process.env.PORT = String(port);

    const { startServer } = require('../server');
    const server = startServer();

    function readReviews() {
        const reviewDatabase = openForensicDatabase(databaseFile, { readOnly: true });

        try {
            return reviewDatabase
                .prepare(
                    `SELECT finding.problem_id, review.decision
                     FROM reviews review
                     JOIN findings finding ON finding.id = review.finding_pk
                     ORDER BY finding.problem_id`,
                )
                .all();
        } finally {
            reviewDatabase.close();
        }
    }

    try {
        await once(server, 'listening');

        const baseUrl = `http://127.0.0.1:${port}`;
        const appResponse = await fetch(`${baseUrl}/`);
        const appMarkup = await appResponse.text();
        const appScript = await (await fetch(`${baseUrl}/app.js?v=20260820-5`)).text();

        assert.equal(appResponse.status, 200);
        assert.match(appMarkup, /id="pdf-scroll"/);
        assert.match(appMarkup, /id="pdf-pages"/);
        assert.match(appMarkup, /id="document-findings"/);
        assert.match(appMarkup, /PDFs mit Problemen/);
        assert.match(appMarkup, /id="remaining-count"/);
        assert.match(appMarkup, /Noch offen/);
        assert.doesNotMatch(appMarkup, /Funde offen/);
        assert.doesNotMatch(appMarkup, /problem-counter/);
        assert.doesNotMatch(appMarkup, /document-findings-summary/);
        assert.doesNotMatch(appMarkup, /source-section/);
        assert.match(appScript, /renderProblem\(\{ preservePdf:/);
        assert.match(appMarkup, /id="view-investigate"/);
        assert.match(appMarkup, /id="view-found"/);
        assert.match(appMarkup, /id="found-overview"/);
        assert.match(appMarkup, /id="found-documents"/);
        assert.match(appMarkup, /id="found-back"/);
        assert.match(appMarkup, /id="project-detail"/);
        assert.match(appMarkup, /id="project-name"/);
        assert.match(appMarkup, /id="coordinate-input"/);
        assert.match(appMarkup, /id="coordinate-clear"/);
        assert.match(appMarkup, /id="metadata-section"/);
        assert.doesNotMatch(appMarkup, /id="metadata-toggle"/);
        assert.doesNotMatch(appMarkup, /id="problem-type"/);
        assert.doesNotMatch(appMarkup, /privacy-note/);
        assert.match(appScript, /decision === 'accepted'/);
        assert.match(appScript, /function foundDocumentGroups\(\)/);
        assert.match(appScript, /project: problem\.project \|\| 'Ohne Projekt'/);
        assert.equal(appScript.includes("addEventListener('wheel'"), false);
        assert.equal(appScript.includes('&request='), false);
        assert.match(appScript, /const PDF_RENDER_WIDTH = 1500/);
        assert.match(appScript, /function drawCoordinateBox\(\)/);
        assert.match(appScript, /async function renderPdfMetadata\(problem\)/);
        assert.match(appScript, /void renderPdfMetadata\(problem\)/);
        assert.match(appScript, /function renderMetadataWithEmailHighlights\(formatted\)/);
        assert.match(appScript, /metadata-email-match/);
        assert.doesNotMatch(appScript, /togglePdfMetadata/);
        assert.match(appScript, /Der Webserver läuft noch mit der vorherigen Version/);
        assert.match(appScript, /const viewMatches = problemMatchesView\(problem\)/);

        const problemsResponse = await fetch(`${baseUrl}/api/problems`);
        const problemsPayload = await problemsResponse.json();

        assert.equal(problemsResponse.status, 200);
        assert.equal(problemsPayload.total, 2);
        assert.equal(problemsPayload.problems[0].project, 'fragdenstaat.de');
        assert.equal(problemsPayload.problems[0].risk_score, 98);
        assert.equal(problemsPayload.problems[1].page, null);
        assert.equal(problemsPayload.problems[1].evidence.hidden_text, undefined);

        const invalidPageResponse = await fetch(`${baseUrl}/api/pdf-page?filename=123.pdf&page=0`);
        assert.equal(invalidPageResponse.status, 400);

        const invalidTextLayerResponse = await fetch(`${baseUrl}/api/pdf-text-layer?filename=123.pdf&page=0`);
        assert.equal(invalidTextLayerResponse.status, 400);

        const textLayerResponse = await fetch(`${baseUrl}/api/pdf-text-layer?filename=123.pdf&page=1&width=600`);
        const textLayerPayload = await textLayerResponse.json();
        assert.equal(textLayerResponse.status, 200);
        assert.equal(textLayerPayload.coordinate_width, 300);
        assert.equal(textLayerPayload.coordinate_height, 300);

        const renderedPageUrl = `${baseUrl}/api/pdf-page?filename=123.pdf&page=1&width=600`;
        const firstRenderedPage = await fetch(renderedPageUrl);
        assert.equal(firstRenderedPage.status, 200);
        assert.equal(firstRenderedPage.headers.get('x-pdf-cache'), 'MISS');
        assert.match(firstRenderedPage.headers.get('cache-control'), /max-age=3600/);
        assert.match(firstRenderedPage.headers.get('content-type'), /image\/png/);
        await firstRenderedPage.arrayBuffer();

        const cachedRenderedPage = await fetch(renderedPageUrl);
        assert.equal(cachedRenderedPage.status, 200);
        assert.equal(cachedRenderedPage.headers.get('x-pdf-cache'), 'HIT');
        await cachedRenderedPage.arrayBuffer();

        const noPageResponse = await fetch(
            `${baseUrl}/api/recovered-text?problem_id=${encodeURIComponent(problemsPayload.problems[1].problem_id)}`,
        );
        const noPagePayload = await noPageResponse.json();
        assert.equal(noPageResponse.status, 200);
        assert.equal(noPagePayload.available, false);
        assert.equal(JSON.stringify(noPagePayload).includes('must never leave the server'), false);

        const metadataResponse = await fetch(
            `${baseUrl}/api/pdf-metadata?problem_id=${encodeURIComponent(problemsPayload.problems[1].problem_id)}`,
        );
        const metadataPayload = await metadataResponse.json();
        assert.equal(metadataResponse.status, 200);
        assert.equal(metadataResponse.headers.get('cache-control'), 'private, no-store');
        assert.equal(metadataPayload.available, true);
        assert.equal(metadataPayload.info.Title, 'Fixture metadata');
        assert.equal(metadataPayload.info.Author, 'reviewer@example.test');

        const unknownMetadataResponse = await fetch(`${baseUrl}/api/pdf-metadata?problem_id=unknown`);
        assert.equal(unknownMetadataResponse.status, 404);

        const problemId = problemsPayload.problems[0].problem_id;
        const accept = () =>
            fetch(`${baseUrl}/api/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ problem_id: problemId, decision: 'accept' }),
            });

        assert.equal((await accept()).status, 200);
        assert.equal((await accept()).status, 200);

        let reviews = readReviews();
        assert.equal(reviews.length, 1);
        assert.equal(reviews[0].problem_id, problemId);
        assert.equal(reviews[0].decision, 'accepted');

        const skipResponse = await fetch(`${baseUrl}/api/review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ problem_id: problemId, decision: 'skip' }),
        });

        assert.equal(skipResponse.status, 200);
        reviews = readReviews();
        assert.equal(reviews.length, 1);
        assert.equal(reviews[0].problem_id, problemId);
        assert.equal(reviews[0].decision, 'skipped');

        const progressPayload = await (await fetch(`${baseUrl}/api/progress`)).json();
        assert.equal(progressPayload.reviewed[problemId], 'skipped');

        const pdfResponse = await fetch(`${baseUrl}/pdf/123.pdf`, {
            headers: { Range: 'bytes=0-4' },
        });
        assert.equal(pdfResponse.status, 206);
        assert.equal(await pdfResponse.text(), '%PDF-');

        const traversalResponse = await fetch(`${baseUrl}/pdf/%2e%2e%2fproblems.json`);
        assert.equal(traversalResponse.status, 400);

        const forensicJsonFiles = (await fs.readdir(temporaryDirectory)).filter(file => file.endsWith('.json'));
        assert.deepEqual(forensicJsonFiles, []);
    } finally {
        server.close();
        await once(server, 'close');
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});
