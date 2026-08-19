const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

test('API safely serves, reviews, and persists flattened problems', async () => {
    const temporaryDirectory = await fs.mkdtemp('/tmp/redaction-hitl-test-');
    const pdfDirectory = path.join(temporaryDirectory, 'pdfs');
    const reviewDirectory = path.join(temporaryDirectory, 'reviews');
    const problemsFile = path.join(temporaryDirectory, 'problems.json');
    const port = 32_000 + (process.pid % 1_000);

    await fs.mkdir(pdfDirectory, { recursive: true });
    await fs.writeFile(path.join(pdfDirectory, '123.pdf'), '%PDF-1.4\nfixture\n%%EOF\n');
    await fs.writeFile(
        problemsFile,
        JSON.stringify([
            {
                file: '123.pdf',
                document_id: '123',
                title: 'Fixture',
                source_url: 'https://example.test/source',
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
            },
        ]),
    );

    process.env.HITL_PROBLEMS_FILE = problemsFile;
    process.env.HITL_PDF_DIR = pdfDirectory;
    process.env.HITL_REVIEW_DIR = reviewDirectory;
    process.env.PORT = String(port);

    const { startServer } = require('../server');
    const server = startServer();

    try {
        await once(server, 'listening');

        const baseUrl = `http://127.0.0.1:${port}`;
        const appResponse = await fetch(`${baseUrl}/`);
        const appMarkup = await appResponse.text();
        const appScript = await (await fetch(`${baseUrl}/app.js?v=20260819-8`)).text();

        assert.equal(appResponse.status, 200);
        assert.match(appMarkup, /id="pdf-scroll"/);
        assert.match(appMarkup, /id="pdf-pages"/);
        assert.match(appMarkup, /id="document-findings"/);
        assert.match(appMarkup, /PDFs mit Problemen/);
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
        assert.match(appScript, /decision === 'accepted'/);
        assert.match(appScript, /function foundDocumentGroups\(\)/);
        assert.equal(appScript.includes("addEventListener('wheel'"), false);
        assert.match(appScript, /const viewMatches = problemMatchesView\(problem\)/);

        const problemsResponse = await fetch(`${baseUrl}/api/problems`);
        const problemsPayload = await problemsResponse.json();

        assert.equal(problemsResponse.status, 200);
        assert.equal(problemsPayload.total, 2);
        assert.equal(problemsPayload.problems[0].risk_score, 98);
        assert.equal(problemsPayload.problems[1].page, null);
        assert.equal(problemsPayload.problems[1].evidence.hidden_text, undefined);

        const invalidPageResponse = await fetch(`${baseUrl}/api/pdf-page?filename=123.pdf&page=0`);
        assert.equal(invalidPageResponse.status, 400);

        const invalidTextLayerResponse = await fetch(`${baseUrl}/api/pdf-text-layer?filename=123.pdf&page=0`);
        assert.equal(invalidTextLayerResponse.status, 400);

        const noPageResponse = await fetch(
            `${baseUrl}/api/recovered-text?problem_id=${encodeURIComponent(problemsPayload.problems[1].problem_id)}`,
        );
        const noPagePayload = await noPageResponse.json();
        assert.equal(noPageResponse.status, 200);
        assert.equal(noPagePayload.available, false);
        assert.equal(JSON.stringify(noPagePayload).includes('must never leave the server'), false);

        const problemId = problemsPayload.problems[0].problem_id;
        const accept = () =>
            fetch(`${baseUrl}/api/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ problem_id: problemId, decision: 'accept' }),
            });

        assert.equal((await accept()).status, 200);
        assert.equal((await accept()).status, 200);

        let accepted = JSON.parse(await fs.readFile(path.join(reviewDirectory, 'human_found_redaction_problems.json')));
        assert.equal(accepted.length, 1);
        assert.equal(accepted[0].problem_id, problemId);

        const skipResponse = await fetch(`${baseUrl}/api/review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ problem_id: problemId, decision: 'skip' }),
        });

        assert.equal(skipResponse.status, 200);
        accepted = JSON.parse(await fs.readFile(path.join(reviewDirectory, 'human_found_redaction_problems.json')));
        const progress = JSON.parse(await fs.readFile(path.join(reviewDirectory, 'human_review_progress.json')));
        assert.deepEqual(accepted, []);
        assert.equal(progress.reviewed[problemId], 'skipped');

        const pdfResponse = await fetch(`${baseUrl}/pdf/123.pdf`, {
            headers: { Range: 'bytes=0-4' },
        });
        assert.equal(pdfResponse.status, 206);
        assert.equal(await pdfResponse.text(), '%PDF-');

        const traversalResponse = await fetch(`${baseUrl}/pdf/%2e%2e%2fproblems.json`);
        assert.equal(traversalResponse.status, 400);

        const leftovers = (await fs.readdir(reviewDirectory)).filter(file => file.endsWith('.tmp'));
        assert.deepEqual(leftovers, []);
    } finally {
        server.close();
        await once(server, 'close');
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});
