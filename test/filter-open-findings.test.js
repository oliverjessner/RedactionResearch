const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
    listOpenProblems,
    listReviewDecisions,
    openForensicDatabase,
    saveDocumentScanResult,
} = require('../lib/forensic-db.js');
const { classifyRecoveredText } = require('../lib/pdf-text-recovery.js');

const execFileAsync = promisify(execFile);
const scriptFile = path.resolve(__dirname, '../scripts/filter-open-findings.mjs');

function createTextPdf(text) {
    const escapedText = text.replace(/([\\()])/g, '\\$1');
    const content = `BT\n/F1 20 Tf\n20 100 Td\n(${escapedText}) Tj\nET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
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
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return pdf;
}

test('recovered-text classification is conservative', () => {
    assert.equal(classifyRecoveredText('___ ___'), 'underscores_only');
    assert.equal(classifyRecoveredText('Ä'), 'alphanumeric');
    assert.equal(classifyRecoveredText('7'), 'alphanumeric');
    assert.equal(classifyRecoveredText('___ A'), 'alphanumeric');
    assert.equal(classifyRecoveredText(''), 'empty');
    assert.equal(classifyRecoveredText('---'), 'symbols_only');
});

test('batch filter skips only open underscore-only findings and never prints recovered text', async () => {
    const temporaryDirectory = await fs.mkdtemp('/tmp/redaction-open-filter-test-');
    const databaseFile = path.join(temporaryDirectory, 'forensic.sqlite');
    const pdfRoot = path.join(temporaryDirectory, 'pdfs');
    const projectPdfDirectory = path.join(pdfRoot, '1');
    const database = openForensicDatabase(databaseFile);
    const fixtures = [
        { file: 'underscores.pdf', problemId: 'underscores:1:TEST:0', text: '____' },
        { file: 'letters.pdf', problemId: 'letters:1:TEST:0', text: 'Secret7' },
        { file: 'symbols.pdf', problemId: 'symbols:1:TEST:0', text: '---' },
        { file: 'empty.pdf', problemId: 'empty:1:TEST:0', text: '' },
    ];

    try {
        await fs.mkdir(projectPdfDirectory, { recursive: true });

        for (const fixture of fixtures) {
            await fs.writeFile(path.join(projectPdfDirectory, fixture.file), createTextPdf(fixture.text));
            saveDocumentScanResult(database, 'fragdenstaat.de', {
                file: fixture.file,
                document_id: path.basename(fixture.file, '.pdf'),
                page_count: 1,
                problems: [
                    {
                        problem_id: fixture.problemId,
                        type: 'TEST',
                        risk_score: 80,
                        page: 1,
                        severity: 'high',
                        evidence: { regions: [[0, 0, 300, 300]] },
                    },
                ],
            });
        }
    } finally {
        database.close();
    }

    const commonArguments = [
        scriptFile,
        '--database',
        databaseFile,
        '--pdf-root',
        pdfRoot,
        '--project',
        'fragdenstaat.de',
    ];

    try {
        const dryRun = await execFileAsync(process.execPath, commonArguments, {
            cwd: path.resolve(__dirname, '..'),
        });
        let verificationDatabase = openForensicDatabase(databaseFile, { readOnly: true });

        assert.match(dryRun.stdout, /Would be written as skipped:\s+1/);
        assert.equal(dryRun.stdout.includes('Secret7'), false);
        assert.equal(dryRun.stdout.includes('____'), false);
        assert.deepEqual(listReviewDecisions(verificationDatabase, 'fragdenstaat.de'), {});
        verificationDatabase.close();

        const applied = await execFileAsync(process.execPath, [...commonArguments, '--apply'], {
            cwd: path.resolve(__dirname, '..'),
        });
        verificationDatabase = openForensicDatabase(databaseFile, { readOnly: true });

        assert.match(applied.stdout, /Written as skipped:\s+1/);
        assert.deepEqual(listReviewDecisions(verificationDatabase, 'fragdenstaat.de'), {
            'underscores:1:TEST:0': 'skipped',
        });
        assert.equal(listOpenProblems(verificationDatabase, 'fragdenstaat.de').length, 3);
        verificationDatabase.close();
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});
