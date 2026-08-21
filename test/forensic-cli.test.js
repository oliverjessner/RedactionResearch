const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { ensureProject, openForensicDatabase } = require('../lib/forensic-db.js');

const execFileAsync = promisify(execFile);

function createFixturePdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
        '<< /Length 4 >>\nstream\nq\nQ\nendstream',
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

test('root forensic worker scans a project in a fresh workspace', async () => {
    const temporaryDirectory = await fs.mkdtemp('/tmp/redaction-scanner-test-');
    const outputDirectory = path.join(temporaryDirectory, 'output');
    const pdfRoot = path.join(outputDirectory, 'download', 'pdfs');
    const databaseFile = path.join(outputDirectory, 'forensic', 'forensic.sqlite');
    const database = openForensicDatabase(databaseFile);
    const projectId = ensureProject(database, 'fresh-clone.test');
    database.close();

    try {
        const pdfDirectory = path.join(pdfRoot, String(projectId));
        await fs.mkdir(pdfDirectory, { recursive: true });
        await fs.writeFile(path.join(pdfDirectory, 'fixture.pdf'), createFixturePdf());

        const { stdout } = await execFileAsync(
            process.execPath,
            [path.resolve('forensic.mjs'), '--project', 'fresh-clone.test', '--no-render'],
            {
                cwd: path.resolve('.'),
                env: {
                    ...process.env,
                    FORENSIC_DATABASE_FILE: databaseFile,
                    FORENSIC_OUTPUT_DIR: outputDirectory,
                    FORENSIC_PDF_ROOT: pdfRoot,
                },
                timeout: 30_000,
            },
        );

        assert.match(stdout, /SCAN COMPLETE/);
        const resultDatabase = openForensicDatabase(databaseFile, { readOnly: true });
        try {
            assert.equal(resultDatabase.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 1);
            assert.equal(resultDatabase.prepare("SELECT status FROM scan_status").get().status, 'completed');
        } finally {
            resultDatabase.close();
        }
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});
