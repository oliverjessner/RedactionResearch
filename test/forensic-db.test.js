const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
    countProblemDocuments,
    isDocumentScanCompleted,
    listProblems,
    listReviewDecisions,
    openForensicDatabase,
    saveDocumentScanResult,
    saveReview,
} = require('../lib/forensic-db.js');

test('forensic data persists in relational SQLite state', async () => {
    const temporaryDirectory = await fs.mkdtemp('/tmp/redaction-forensic-db-test-');
    const databaseFile = path.join(temporaryDirectory, 'forensic.sqlite');
    const database = openForensicDatabase(databaseFile);
    const problemId = '123:1:TEST_FINDING:0';

    try {
        saveDocumentScanResult(database, 'fragdenstaat.de', {
            file: '123.pdf',
            document_id: '123',
            title: 'Problem document',
            problems: [
                {
                    problem_id: problemId,
                    type: 'TEST_FINDING',
                    risk_score: 91,
                    page: 1,
                    severity: 'critical',
                    evidence: { affected_text_items: 1 },
                },
            ],
        });
        saveDocumentScanResult(database, 'fragdenstaat.de', {
            file: '456.pdf',
            document_id: '456',
            problems: [],
        });
        saveReview(database, 'fragdenstaat.de', problemId, 'accepted');

        assert.equal(isDocumentScanCompleted(database, 'fragdenstaat.de', '456.pdf'), true);
        assert.equal(countProblemDocuments(database, 'fragdenstaat.de'), 1);
        assert.equal(listProblems(database, 'fragdenstaat.de')[0].project, 'fragdenstaat.de');
        assert.equal(listReviewDecisions(database, 'fragdenstaat.de')[problemId], 'accepted');

        saveDocumentScanResult(database, 'fragdenstaat.de', {
            file: '123.pdf',
            document_id: '123',
            title: 'Problem document',
            page_count: 1,
            problems: [
                {
                    problem_id: problemId,
                    type: 'TEST_FINDING',
                    risk_score: 94,
                    page: 1,
                    severity: 'critical',
                    evidence: { affected_text_items: 2 },
                },
            ],
        });

        assert.equal(listProblems(database, 'fragdenstaat.de')[0].risk_score, 94);
        assert.equal(listReviewDecisions(database, 'fragdenstaat.de')[problemId], 'accepted');

        saveReview(database, 'fragdenstaat.de', problemId, 'skipped');
        assert.equal(listReviewDecisions(database, 'fragdenstaat.de')[problemId], 'skipped');
        assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        database.close();
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});
