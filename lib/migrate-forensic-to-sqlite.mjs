import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DEFAULT_PROJECT, migrateLegacySnapshot, openForensicDatabase } = require('./forensic-db.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORENSIC_DIR = path.join(__dirname, 'output', 'forensic');
const LEGACY_FILES = {
    problemDocuments: path.join(FORENSIC_DIR, 'redaction_problems.json'),
    scanProgress: path.join(FORENSIC_DIR, 'redaction_scan_progress.json'),
    acceptedProblems: path.join(FORENSIC_DIR, 'human_found_redaction_problems.json'),
    humanProgress: path.join(FORENSIC_DIR, 'human_review_progress.json'),
};

function parseArgs() {
    const options = {
        database: path.join(FORENSIC_DIR, 'forensic.sqlite'),
        project: DEFAULT_PROJECT,
        deleteJson: false,
    };

    for (let index = 2; index < process.argv.length; index++) {
        const argument = process.argv[index];

        if (argument === '--database') {
            options.database = path.resolve(process.argv[++index]);
        } else if (argument === '--project') {
            options.project = process.argv[++index];
        } else if (argument === '--delete-json') {
            options.deleteJson = true;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    return options;
}

async function readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function main() {
    const options = parseArgs();
    const snapshot = Object.fromEntries(
        await Promise.all(Object.entries(LEGACY_FILES).map(async ([key, file]) => [key, await readJson(file)])),
    );
    const database = openForensicDatabase(options.database);
    let summary;

    try {
        summary = migrateLegacySnapshot(database, options.project, snapshot);

        const integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check;
        const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();

        if (integrity !== 'ok' || foreignKeyErrors.length > 0) {
            throw new Error(
                `SQLite validation failed: integrity=${integrity}, foreign_key_errors=${foreignKeyErrors.length}`,
            );
        }
    } finally {
        database.close();
    }

    if (summary.missingReviews > 0) {
        throw new Error(`${summary.missingReviews} review decisions could not be matched to a finding`);
    }

    if (options.deleteJson) {
        await Promise.all(Object.values(LEGACY_FILES).map(file => fs.unlink(file)));
    }

    console.log('Forensic JSON migration complete');
    console.log(`Database:  ${options.database}`);
    console.log(`Project:   ${summary.project}`);
    console.log(`Documents: ${summary.documents}`);
    console.log(`Findings:  ${summary.findings}`);
    console.log(`Reviews:   ${summary.reviews}`);
    console.log(`Accepted:  ${summary.accepted}`);
    console.log(`JSON:      ${options.deleteJson ? 'removed after validation' : 'kept'}`);
}

main().catch(error => {
    console.error('\nFATAL ERROR');
    console.error(error);
    process.exitCode = 1;
});
