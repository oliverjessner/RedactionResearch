const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PROJECT = 'fragdenstaat.de';

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL UNIQUE,
        organization TEXT,
        source_type TEXT NOT NULL DEFAULT 'local-directory',
        source_location TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        file TEXT NOT NULL,
        title TEXT,
        source_url TEXT,
        file_url TEXT,
        page_count INTEGER,
        highest_risk_score REAL,
        problem_count INTEGER NOT NULL DEFAULT 0,
        supporting_signals_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_signals_json)),
        scanned_at TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, file)
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY,
        document_pk INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        problem_id TEXT NOT NULL,
        finding_index INTEGER NOT NULL,
        type TEXT NOT NULL,
        risk_score REAL NOT NULL,
        page INTEGER,
        severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
        evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
        scan_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (document_pk, problem_id)
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS reviews (
        finding_pk INTEGER PRIMARY KEY REFERENCES findings(id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK (decision IN ('accepted', 'skipped')),
        reviewed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS scan_status (
        document_pk INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('completed', 'error')),
        completed_at TEXT,
        error_message TEXT,
        error_at TEXT,
        updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS scan_runs (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'scan',
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'imported')),
        selected_count INTEGER NOT NULL DEFAULT 0,
        processed_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        problem_documents_total INTEGER NOT NULL DEFAULT 0,
        min_score REAL,
        render_scale REAL,
        render_checks INTEGER CHECK (render_checks IN (0, 1)),
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS forensic_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS project_jobs (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('import', 'scan')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        total_count INTEGER NOT NULL DEFAULT 0,
        processed_count INTEGER NOT NULL DEFAULT 0,
        imported_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        error_message TEXT,
        started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
    ) STRICT`,
    `CREATE VIEW IF NOT EXISTS forensic_documents AS
     SELECT
        project.project,
        document.document_id,
        document.file,
        document.title,
        document.source_url,
        document.file_url,
        document.page_count,
        document.highest_risk_score,
        document.problem_count,
        document.supporting_signals_json,
        document.scanned_at,
        status.status AS scan_status,
        status.error_message,
        status.updated_at AS scan_status_updated_at
     FROM documents document
     JOIN projects project ON project.id = document.project_id
     LEFT JOIN scan_status status ON status.document_pk = document.id`,
    `CREATE VIEW IF NOT EXISTS forensic_findings AS
     SELECT
        project.project,
        finding.problem_id,
        document.document_id,
        document.file,
        document.title,
        finding.page,
        finding.type,
        finding.risk_score,
        finding.severity,
        finding.evidence_json,
        document.source_url,
        document.file_url,
        document.page_count,
        review.decision,
        review.reviewed_at
     FROM findings finding
     JOIN documents document ON document.id = finding.document_pk
     JOIN projects project ON project.id = document.project_id
     LEFT JOIN reviews review ON review.finding_pk = finding.id`,
    `CREATE INDEX IF NOT EXISTS idx_documents_project_problems
     ON documents(project_id, problem_count)`,
    `CREATE INDEX IF NOT EXISTS idx_findings_document_score
     ON findings(document_pk, risk_score DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_findings_problem_id
     ON findings(problem_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reviews_decision
     ON reviews(decision)`,
    `CREATE INDEX IF NOT EXISTS idx_project_jobs_project_created
     ON project_jobs(project_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_project_jobs_active
     ON project_jobs(project_id, status)
     WHERE status IN ('queued', 'running')`,
];

function nowIso() {
    return new Date().toISOString();
}

function jsonString(value, fallback) {
    return JSON.stringify(value ?? fallback);
}

function parseJson(value, fallback) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function withTransaction(database, operation) {
    database.exec('BEGIN IMMEDIATE');

    try {
        const result = operation();
        database.exec('COMMIT');
        return result;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

function ensureColumn(database, table, name, definition) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();

    if (!columns.some(column => column.name === name)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
}

function initializeDatabase(database) {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = NORMAL');
    database.exec('PRAGMA busy_timeout = 5000');

    for (const statement of SCHEMA_STATEMENTS) {
        database.exec(statement);
    }

    ensureColumn(database, 'projects', 'organization', 'TEXT');
    ensureColumn(database, 'projects', 'source_type', "TEXT NOT NULL DEFAULT 'local-directory'");
    ensureColumn(database, 'projects', 'source_location', 'TEXT');
    ensureColumn(database, 'projects', 'updated_at', 'TEXT');
    database.exec('UPDATE projects SET updated_at = created_at WHERE updated_at IS NULL');
    database.exec('PRAGMA user_version = 2');
    database.exec('PRAGMA optimize');
}

function openForensicDatabase(databaseFile, { readOnly = false } = {}) {
    const resolved = path.resolve(databaseFile);

    if (!readOnly) {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
    }

    const database = new DatabaseSync(resolved, { readOnly });

    if (readOnly) {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('PRAGMA busy_timeout = 5000');
    } else {
        initializeDatabase(database);
    }

    return database;
}

function getOrCreateProjectId(database, project = DEFAULT_PROJECT) {
    const normalized = textOrNull(project);

    if (!normalized) throw new Error('project is required');

    const timestamp = nowIso();
    database
        .prepare(
            `INSERT INTO projects (project, created_at, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(project) DO NOTHING`,
        )
        .run(normalized, timestamp, timestamp);

    return database.prepare('SELECT id FROM projects WHERE project = ?').get(normalized).id;
}

function projectRow(row) {
    if (!row) return null;

    return {
        id: Number(row.id),
        project: row.project,
        organization: row.organization,
        source_type: row.source_type,
        source_location: row.source_location,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function getProject(database, projectId) {
    return projectRow(database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
}

function createProject(
    database,
    { project, organization = null, sourceLocation = null, sourceType = 'local-directory' },
) {
    const normalizedProject = textOrNull(project);

    if (!normalizedProject) throw new Error('project is required');
    if (!['local-directory', 'browser-upload'].includes(sourceType)) throw new Error('Invalid project source type');

    return withTransaction(database, () => {
        const timestamp = nowIso();
        const result = database
            .prepare(
                `INSERT INTO projects (
                    project, organization, source_type, source_location, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
                normalizedProject,
                textOrNull(organization),
                sourceType,
                textOrNull(sourceLocation),
                timestamp,
                timestamp,
            );

        return getProject(database, Number(result.lastInsertRowid));
    });
}

function normalizeProjectJob(row) {
    if (!row) return null;

    return {
        ...row,
        id: Number(row.id),
        project_id: Number(row.project_id),
        total_count: Number(row.total_count || 0),
        processed_count: Number(row.processed_count || 0),
        imported_count: Number(row.imported_count || 0),
        skipped_count: Number(row.skipped_count || 0),
        error_count: Number(row.error_count || 0),
    };
}

function listProjects(database) {
    const rows = database
        .prepare(
            `SELECT
                project.*,
                COUNT(DISTINCT document.id) AS scanned_documents,
                COUNT(DISTINCT CASE WHEN document.problem_count > 0 THEN document.id END) AS problem_documents,
                COUNT(DISTINCT finding.id) AS findings,
                COUNT(DISTINCT CASE WHEN review.decision = 'accepted' THEN finding.id END) AS accepted,
                COUNT(DISTINCT CASE WHEN review.decision = 'skipped' THEN finding.id END) AS skipped,
                COUNT(DISTINCT CASE WHEN review.finding_pk IS NULL THEN finding.id END) AS open
             FROM projects project
             LEFT JOIN documents document ON document.project_id = project.id
             LEFT JOIN findings finding ON finding.document_pk = document.id
             LEFT JOIN reviews review ON review.finding_pk = finding.id
             GROUP BY project.id
             ORDER BY project.id`,
        )
        .all();
    const latestJob = database.prepare('SELECT * FROM project_jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1');

    return rows.map(row => ({
        ...projectRow(row),
        scanned_documents: Number(row.scanned_documents || 0),
        problem_documents: Number(row.problem_documents || 0),
        findings: Number(row.findings || 0),
        accepted: Number(row.accepted || 0),
        skipped: Number(row.skipped || 0),
        open: Number(row.open || 0),
        latest_job: normalizeProjectJob(latestJob.get(row.id)),
    }));
}

function getLatestProjectJob(database, projectId) {
    return normalizeProjectJob(
        database.prepare('SELECT * FROM project_jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId),
    );
}

function getProjectJob(database, projectId, jobId) {
    return normalizeProjectJob(
        database.prepare('SELECT * FROM project_jobs WHERE project_id = ? AND id = ?').get(projectId, jobId),
    );
}

function findActiveProjectJob(database, projectId) {
    return normalizeProjectJob(
        database
            .prepare(
                `SELECT * FROM project_jobs
                 WHERE project_id = ? AND status IN ('queued', 'running')
                 ORDER BY id DESC LIMIT 1`,
            )
            .get(projectId),
    );
}

function createProjectJob(database, projectId, kind, message = null) {
    if (!['import', 'scan'].includes(kind)) throw new Error('Invalid project job kind');

    return withTransaction(database, () => {
        if (findActiveProjectJob(database, projectId)) {
            const error = new Error('Für dieses Projekt läuft bereits ein Job.');
            error.status = 409;
            throw error;
        }

        const timestamp = nowIso();
        const result = database
            .prepare(
                `INSERT INTO project_jobs (
                    project_id, kind, status, message, created_at, updated_at
                ) VALUES (?, ?, 'queued', ?, ?, ?)`,
            )
            .run(projectId, kind, textOrNull(message), timestamp, timestamp);

        return normalizeProjectJob(database.prepare('SELECT * FROM project_jobs WHERE id = ?').get(result.lastInsertRowid));
    });
}

function updateProjectJob(database, jobId, changes = {}) {
    const current = normalizeProjectJob(database.prepare('SELECT * FROM project_jobs WHERE id = ?').get(jobId));

    if (!current) throw new Error('Unknown project job');

    const status = changes.status || current.status;
    const timestamp = nowIso();
    database
        .prepare(
            `UPDATE project_jobs SET
                status = ?, total_count = ?, processed_count = ?, imported_count = ?,
                skipped_count = ?, error_count = ?, message = ?, error_message = ?,
                started_at = ?, updated_at = ?, completed_at = ?
             WHERE id = ?`,
        )
        .run(
            status,
            Number(changes.total_count ?? current.total_count),
            Number(changes.processed_count ?? current.processed_count),
            Number(changes.imported_count ?? current.imported_count),
            Number(changes.skipped_count ?? current.skipped_count),
            Number(changes.error_count ?? current.error_count),
            textOrNull(changes.message) ?? current.message,
            Object.prototype.hasOwnProperty.call(changes, 'error_message')
                ? textOrNull(changes.error_message)
                : current.error_message,
            changes.started_at || current.started_at || (status === 'running' ? timestamp : null),
            timestamp,
            ['completed', 'failed'].includes(status) ? changes.completed_at || timestamp : null,
            jobId,
        );

    return normalizeProjectJob(database.prepare('SELECT * FROM project_jobs WHERE id = ?').get(jobId));
}

function failStaleProjectJobs(database) {
    const timestamp = nowIso();
    return Number(
        database
            .prepare(
                `UPDATE project_jobs SET
                    status = 'failed',
                    error_message = 'Server wurde während des Jobs beendet.',
                    message = 'Abgebrochen',
                    updated_at = ?,
                    completed_at = ?
                 WHERE status IN ('queued', 'running')`,
            )
            .run(timestamp, timestamp).changes,
    );
}

function getProjectId(database, project = DEFAULT_PROJECT) {
    const row = database.prepare('SELECT id FROM projects WHERE project = ?').get(project);
    return row?.id ?? null;
}

function ensureProject(database, project = DEFAULT_PROJECT) {
    return withTransaction(database, () => getOrCreateProjectId(database, project));
}

function upsertDocument(database, projectId, document, timestamp) {
    const file = textOrNull(document.file);

    if (!file) throw new Error('document.file is required');

    const documentId = textOrNull(document.document_id) || path.basename(file, path.extname(file));
    const problems = Array.isArray(document.problems) ? document.problems : [];
    const scores = problems.map(problem => numberOrNull(problem?.risk_score)).filter(Number.isFinite);
    const highestRiskScore = numberOrNull(document.highest_risk_score) ?? (scores.length ? Math.max(...scores) : null);

    database
        .prepare(
            `INSERT INTO documents (
                project_id, document_id, file, title, source_url, file_url, page_count,
                highest_risk_score, problem_count, supporting_signals_json, scanned_at,
                note, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, file) DO UPDATE SET
                document_id = excluded.document_id,
                title = excluded.title,
                source_url = excluded.source_url,
                file_url = excluded.file_url,
                page_count = excluded.page_count,
                highest_risk_score = excluded.highest_risk_score,
                problem_count = excluded.problem_count,
                supporting_signals_json = excluded.supporting_signals_json,
                scanned_at = excluded.scanned_at,
                note = excluded.note,
                updated_at = excluded.updated_at`,
        )
        .run(
            projectId,
            documentId,
            file,
            textOrNull(document.title),
            textOrNull(document.source_url),
            textOrNull(document.file_url),
            numberOrNull(document.page_count),
            highestRiskScore,
            problems.length,
            jsonString(Array.isArray(document.supporting_signals) ? document.supporting_signals : [], []),
            textOrNull(document.scanned_at) || timestamp,
            textOrNull(document.note),
            timestamp,
            timestamp,
        );

    return database.prepare('SELECT id FROM documents WHERE project_id = ? AND file = ?').get(projectId, file).id;
}

function writeCompletedScan(database, projectId, document, completedAt = nowIso()) {
    const timestamp = nowIso();
    const documentPk = upsertDocument(database, projectId, document, timestamp);
    const documentId = textOrNull(document.document_id) || path.basename(document.file, path.extname(document.file));
    const problems = Array.isArray(document.problems) ? document.problems : [];
    const scanToken = crypto.randomUUID();
    const upsertFinding = database.prepare(
        `INSERT INTO findings (
            document_pk, problem_id, finding_index, type, risk_score, page, severity,
            evidence_json, scan_token, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_pk, problem_id) DO UPDATE SET
            finding_index = excluded.finding_index,
            type = excluded.type,
            risk_score = excluded.risk_score,
            page = excluded.page,
            severity = excluded.severity,
            evidence_json = excluded.evidence_json,
            scan_token = excluded.scan_token,
            updated_at = excluded.updated_at`,
    );

    for (const [index, problem] of problems.entries()) {
        const type = textOrNull(problem?.type) || 'UNKNOWN_PROBLEM';
        const pageNumber = numberOrNull(problem?.page);
        const riskScore = numberOrNull(problem?.risk_score) ?? 0;
        const problemId = textOrNull(problem?.problem_id) || createProblemId(documentId, pageNumber, type, index);
        const severity = textOrNull(problem?.severity)?.toLowerCase() || severityFromScore(riskScore);

        upsertFinding.run(
            documentPk,
            problemId,
            index,
            type,
            riskScore,
            pageNumber,
            severity,
            jsonString(problem?.evidence && typeof problem.evidence === 'object' ? problem.evidence : {}, {}),
            scanToken,
            timestamp,
            timestamp,
        );
    }

    database.prepare('DELETE FROM findings WHERE document_pk = ? AND scan_token <> ?').run(documentPk, scanToken);
    database
        .prepare(
            `INSERT INTO scan_status (
                document_pk, status, completed_at, error_message, error_at, updated_at
            ) VALUES (?, 'completed', ?, NULL, NULL, ?)
            ON CONFLICT(document_pk) DO UPDATE SET
                status = 'completed',
                completed_at = excluded.completed_at,
                error_message = NULL,
                error_at = NULL,
                updated_at = excluded.updated_at`,
        )
        .run(documentPk, completedAt, timestamp);

    return documentPk;
}

function saveDocumentScanResult(database, project, document, completedAt = nowIso()) {
    return withTransaction(database, () => {
        const projectId = getOrCreateProjectId(database, project);
        return writeCompletedScan(database, projectId, document, completedAt);
    });
}

function recordDocumentScanError(database, project, { file, document_id, title, source_url, file_url }, error) {
    return withTransaction(database, () => {
        const projectId = getOrCreateProjectId(database, project);
        const timestamp = nowIso();
        const normalizedFile = textOrNull(file);

        if (!normalizedFile) throw new Error('file is required');

        database
            .prepare(
                `INSERT INTO documents (
                    project_id, document_id, file, title, source_url, file_url,
                    supporting_signals_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)
                ON CONFLICT(project_id, file) DO UPDATE SET
                    title = COALESCE(excluded.title, documents.title),
                    source_url = COALESCE(excluded.source_url, documents.source_url),
                    file_url = COALESCE(excluded.file_url, documents.file_url),
                    updated_at = excluded.updated_at`,
            )
            .run(
                projectId,
                textOrNull(document_id) || path.basename(normalizedFile, path.extname(normalizedFile)),
                normalizedFile,
                textOrNull(title),
                textOrNull(source_url),
                textOrNull(file_url),
                timestamp,
                timestamp,
            );

        const documentPk = database
            .prepare('SELECT id FROM documents WHERE project_id = ? AND file = ?')
            .get(projectId, normalizedFile).id;
        database
            .prepare(
                `INSERT INTO scan_status (
                    document_pk, status, completed_at, error_message, error_at, updated_at
                ) VALUES (?, 'error', NULL, ?, ?, ?)
                ON CONFLICT(document_pk) DO UPDATE SET
                    status = 'error',
                    error_message = excluded.error_message,
                    error_at = excluded.error_at,
                    updated_at = excluded.updated_at`,
            )
            .run(documentPk, String(error?.message || error), timestamp, timestamp);
    });
}

function isDocumentScanCompleted(database, project, file) {
    return Boolean(
        database
            .prepare(
                `SELECT 1
                 FROM scan_status status
                 JOIN documents document ON document.id = status.document_pk
                 JOIN projects project ON project.id = document.project_id
                 WHERE project.project = ? AND document.file = ? AND status.status = 'completed'`,
            )
            .get(project, file),
    );
}

function countProblemDocuments(database, project) {
    return Number(
        database
            .prepare(
                `SELECT COUNT(*) AS count
                 FROM documents document
                 JOIN projects project ON project.id = document.project_id
                 WHERE project.project = ? AND document.problem_count > 0`,
            )
            .get(project)?.count || 0,
    );
}

function startScanRun(database, project, options) {
    return withTransaction(database, () => {
        const projectId = getOrCreateProjectId(database, project);
        const timestamp = nowIso();
        const result = database
            .prepare(
                `INSERT INTO scan_runs (
                    project_id, kind, status, selected_count, min_score, render_scale,
                    render_checks, started_at, updated_at
                ) VALUES (?, 'scan', 'running', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                projectId,
                Number(options.selectedCount || 0),
                numberOrNull(options.minScore),
                numberOrNull(options.renderScale),
                options.renderChecks ? 1 : 0,
                timestamp,
                timestamp,
            );

        return Number(result.lastInsertRowid);
    });
}

function updateScanRun(database, runId, counts, { complete = false, failed = false } = {}) {
    const timestamp = nowIso();
    const status = failed ? 'failed' : complete ? 'completed' : 'running';

    database
        .prepare(
            `UPDATE scan_runs SET
                status = ?,
                processed_count = ?,
                skipped_count = ?,
                problem_documents_total = ?,
                updated_at = ?,
                completed_at = ?
             WHERE id = ?`,
        )
        .run(
            status,
            Number(counts.processed || 0),
            Number(counts.skipped || 0),
            Number(counts.problemDocumentsTotal || 0),
            timestamp,
            complete || failed ? timestamp : null,
            runId,
        );
}

function listProblems(database, project = DEFAULT_PROJECT) {
    const rows = database
        .prepare(
            `SELECT
                project.project,
                finding.problem_id,
                document.document_id,
                document.file,
                document.title,
                finding.page,
                finding.type,
                finding.risk_score,
                finding.severity,
                finding.evidence_json,
                document.source_url,
                document.page_count
             FROM findings finding
             JOIN documents document ON document.id = finding.document_pk
             JOIN projects project ON project.id = document.project_id
             WHERE project.project = ?
             ORDER BY finding.risk_score DESC, document.document_id, finding.page, finding.finding_index`,
        )
        .all(project);

    return rows.map(row => ({
        project: row.project,
        problem_id: row.problem_id,
        document_id: row.document_id,
        file: row.file,
        title: row.title,
        page: row.page,
        type: row.type,
        risk_score: row.risk_score,
        severity: row.severity,
        evidence: parseJson(row.evidence_json, {}),
        source_url: row.source_url,
        page_count: row.page_count,
    }));
}

function listOpenProblems(database, project = DEFAULT_PROJECT) {
    const rows = database
        .prepare(
            `SELECT
                project.project,
                finding.problem_id,
                document.document_id,
                document.file,
                document.title,
                finding.page,
                finding.type,
                finding.risk_score,
                finding.severity,
                finding.evidence_json,
                document.source_url,
                document.page_count
             FROM findings finding
             JOIN documents document ON document.id = finding.document_pk
             JOIN projects project ON project.id = document.project_id
             LEFT JOIN reviews review ON review.finding_pk = finding.id
             WHERE project.project = ? AND review.finding_pk IS NULL
             ORDER BY document.document_id, finding.page, finding.finding_index`,
        )
        .all(project);

    return rows.map(row => ({
        project: row.project,
        problem_id: row.problem_id,
        document_id: row.document_id,
        file: row.file,
        title: row.title,
        page: row.page,
        type: row.type,
        risk_score: row.risk_score,
        severity: row.severity,
        evidence: parseJson(row.evidence_json, {}),
        source_url: row.source_url,
        page_count: row.page_count,
    }));
}

function getProblem(database, project, problemId) {
    const row = database
        .prepare(
            `SELECT
                project.project,
                finding.problem_id,
                document.document_id,
                document.file,
                document.title,
                finding.page,
                finding.type,
                finding.risk_score,
                finding.severity,
                finding.evidence_json,
                document.source_url,
                document.page_count
             FROM findings finding
             JOIN documents document ON document.id = finding.document_pk
             JOIN projects project ON project.id = document.project_id
             WHERE project.project = ? AND finding.problem_id = ?`,
        )
        .get(project, problemId);

    if (!row) return null;

    return {
        project: row.project,
        problem_id: row.problem_id,
        document_id: row.document_id,
        file: row.file,
        title: row.title,
        page: row.page,
        type: row.type,
        risk_score: row.risk_score,
        severity: row.severity,
        evidence: parseJson(row.evidence_json, {}),
        source_url: row.source_url,
        page_count: row.page_count,
    };
}

function listReviewDecisions(database, project = DEFAULT_PROJECT) {
    const rows = database
        .prepare(
            `SELECT finding.problem_id, review.decision
             FROM reviews review
             JOIN findings finding ON finding.id = review.finding_pk
             JOIN documents document ON document.id = finding.document_pk
             JOIN projects project ON project.id = document.project_id
             WHERE project.project = ?`,
        )
        .all(project);

    return Object.fromEntries(rows.map(row => [row.problem_id, row.decision]));
}

function saveReview(database, project, problemId, decision, reviewedAt = nowIso()) {
    if (!['accepted', 'skipped'].includes(decision)) throw new Error('Invalid review decision');

    return withTransaction(database, () => {
        const finding = database
            .prepare(
                `SELECT finding.id
                 FROM findings finding
                 JOIN documents document ON document.id = finding.document_pk
                 JOIN projects project ON project.id = document.project_id
                 WHERE project.project = ? AND finding.problem_id = ?`,
            )
            .get(project, problemId);

        if (!finding) {
            const error = new Error('Unknown problem_id');
            error.status = 404;
            throw error;
        }

        const timestamp = nowIso();
        database
            .prepare(
                `INSERT INTO reviews (finding_pk, decision, reviewed_at, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(finding_pk) DO UPDATE SET
                    decision = excluded.decision,
                    reviewed_at = excluded.reviewed_at,
                    updated_at = excluded.updated_at`,
            )
            .run(finding.id, decision, reviewedAt, timestamp);

        const acceptedTotal = Number(
            database
                .prepare(
                    `SELECT COUNT(*) AS count
                     FROM reviews review
                     JOIN findings finding ON finding.id = review.finding_pk
                     JOIN documents document ON document.id = finding.document_pk
                     JOIN projects project ON project.id = document.project_id
                     WHERE project.project = ? AND review.decision = 'accepted'`,
                )
                .get(project).count,
        );

        return { problem_id: problemId, decision, accepted_total: acceptedTotal };
    });
}

function skipOpenProblems(database, project, problemIds, reviewedAt = nowIso()) {
    const normalizedIds = [...new Set(problemIds.map(textOrNull).filter(Boolean))];

    if (normalizedIds.length === 0) return 0;

    return withTransaction(database, () => {
        const timestamp = nowIso();
        const insert = database.prepare(
            `INSERT INTO reviews (finding_pk, decision, reviewed_at, updated_at)
             SELECT finding.id, 'skipped', ?, ?
             FROM findings finding
             JOIN documents document ON document.id = finding.document_pk
             JOIN projects project ON project.id = document.project_id
             LEFT JOIN reviews review ON review.finding_pk = finding.id
             WHERE project.project = ?
               AND finding.problem_id = ?
               AND review.finding_pk IS NULL`,
        );
        let skipped = 0;

        for (const problemId of normalizedIds) {
            skipped += Number(insert.run(reviewedAt, timestamp, project, problemId).changes);
        }

        return skipped;
    });
}


module.exports = {
    DEFAULT_PROJECT,
    countProblemDocuments,
    createProject,
    createProjectJob,
    createProblemId,
    ensureProject,
    failStaleProjectJobs,
    findActiveProjectJob,
    getProblem,
    getLatestProjectJob,
    getProject,
    getProjectJob,
    getProjectId,
    isDocumentScanCompleted,
    listOpenProblems,
    listProblems,
    listProjects,
    listReviewDecisions,
    openForensicDatabase,
    recordDocumentScanError,
    saveDocumentScanResult,
    saveReview,
    skipOpenProblems,
    severityFromScore,
    startScanRun,
    updateProjectJob,
    updateScanRun,
};
