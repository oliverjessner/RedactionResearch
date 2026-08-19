const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
    countProblemDocuments,
    isDocumentScanCompleted,
    listProblems,
    listReviewDecisions,
    migrateLegacySnapshot,
    openForensicDatabase,
    saveDocumentScanResult,
    saveReview,
} = require('../lib/forensic-db.js');

test('legacy forensic data migrates to relational SQLite state', async () => {
    const temporaryDirectory = await fs.mkdtemp('/tmp/redaction-forensic-db-test-');
    const databaseFile = path.join(temporaryDirectory, 'forensic.sqlite');
    const database = openForensicDatabase(databaseFile);
    const problemId = '123:1:TEST_FINDING:0';

    try {
        const summary = migrateLegacySnapshot(database, 'fragdenstaat.de', {
            problemDocuments: [
                {
                    file: '123.pdf',
                    document_id: '123',
                    title: 'Problem document',
                    highest_risk_score: 91,
                    problem_count: 1,
                    problems: [
                        {
                            type: 'TEST_FINDING',
                            risk_score: 91,
                            page: 1,
                            severity: 'critical',
                            evidence: { affected_text_items: 1 },
                        },
                    ],
                    supporting_signals: [{ type: 'TEST_SIGNAL' }],
                    scanned_at: '2026-08-17T00:00:00.000Z',
                },
            ],
            scanProgress: {
                completed: {
                    '123.pdf': '2026-08-17T00:00:00.000Z',
                    '456.pdf': '2026-08-17T00:01:00.000Z',
                },
                errors: {},
                selected: 2,
                processed_this_run: 2,
                skipped_this_run: 0,
                problem_documents_total: 1,
                updated_at: '2026-08-17T00:02:00.000Z',
            },
            acceptedProblems: [{ problem_id: problemId, reviewed_at: '2026-08-19T00:00:00.000Z' }],
            humanProgress: {
                reviewed: { [problemId]: 'accepted' },
                updated_at: '2026-08-19T00:00:00.000Z',
            },
        });

        assert.deepEqual(summary, {
            project: 'fragdenstaat.de',
            documents: 2,
            findings: 1,
            reviews: 1,
            accepted: 1,
            missingReviews: 0,
        });
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
