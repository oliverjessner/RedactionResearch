const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
    countProblemDocuments,
    createProject,
    createProjectJob,
    deleteProject,
    isDocumentScanCompleted,
    listProblems,
    listReviewDecisions,
    openForensicDatabase,
    saveDocumentScanResult,
    saveReview,
    startScanRun,
    updateProjectJob,
} = require('../lib/forensic-db.js');

test('opening a legacy database removes source_location without losing projects', async () => {
    const temporaryDirectory = await fs.mkdtemp('/tmp/redaction-forensic-migration-test-');
    const databaseFile = path.join(temporaryDirectory, 'forensic.sqlite');
    const legacyDatabase = new DatabaseSync(databaseFile);

    legacyDatabase.exec(`
        CREATE TABLE projects (
            id INTEGER PRIMARY KEY,
            project TEXT NOT NULL UNIQUE,
            organization TEXT,
            source_type TEXT NOT NULL DEFAULT 'local-directory',
            source_location TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO projects (
            project, organization, source_type, source_location, created_at, updated_at
        ) VALUES (
            'legacy.example', 'Legacy Org', 'local-directory', '/old/pdf/source',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
    `);
    legacyDatabase.close();

    const database = openForensicDatabase(databaseFile);

    try {
        const projectColumns = database.prepare('PRAGMA table_info(projects)').all();
        const project = database.prepare('SELECT * FROM projects WHERE project = ?').get('legacy.example');

        assert.equal(projectColumns.some(column => column.name === 'source_location'), false);
        assert.equal(project.project, 'legacy.example');
        assert.equal(project.organization, 'Legacy Org');
        assert.equal(database.prepare('PRAGMA user_version').get().user_version, 3);
        assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
        database.close();
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});

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

test('deleting a project cascades through every project-owned SQLite table', async () => {
    const temporaryDirectory = await fs.mkdtemp('/tmp/redaction-project-delete-test-');
    const databaseFile = path.join(temporaryDirectory, 'forensic.sqlite');
    const database = openForensicDatabase(databaseFile);
    const project = createProject(database, { project: 'delete.example' });
    const problemId = 'delete:1:TEST_FINDING:0';

    try {
        saveDocumentScanResult(database, project.project, {
            file: 'delete.pdf',
            document_id: 'delete',
            problems: [
                {
                    problem_id: problemId,
                    type: 'TEST_FINDING',
                    risk_score: 91,
                    page: 1,
                    severity: 'critical',
                    evidence: {},
                },
            ],
        });
        saveReview(database, project.project, problemId, 'accepted');
        startScanRun(database, project.project, {
            selectedCount: 1,
            minScore: 60,
            renderScale: 1.5,
            renderChecks: true,
        });

        const activeJob = createProjectJob(database, project.id, 'scan');
        assert.throws(
            () => deleteProject(database, project.id),
            error => error.status === 409 && /laufendes Projekt/.test(error.message),
        );
        updateProjectJob(database, activeJob.id, { status: 'completed' });

        assert.equal(deleteProject(database, project.id).project, project.project);

        for (const table of ['projects', 'documents', 'findings', 'reviews', 'scan_status', 'scan_runs', 'project_jobs']) {
            assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
        }
        assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        database.close();
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});
