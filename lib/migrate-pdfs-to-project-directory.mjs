import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DEFAULT_PROJECT, getProjectId, openForensicDatabase } = require('./forensic-db.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = path.join(__dirname, 'output', 'download');
const PDF_ROOT = path.join(DOWNLOAD_DIR, 'pdfs');
const DATABASE_FILE = path.join(__dirname, 'output', 'forensic', 'forensic.sqlite');
const RESULTS_FILE = path.join(DOWNLOAD_DIR, 'download-results.json');
const ERRORS_FILE = path.join(DOWNLOAD_DIR, 'download-errors.json');
const PROGRESS_FILE = path.join(DOWNLOAD_DIR, 'download-progress.json');

function parseArgs() {
    const options = {
        project: DEFAULT_PROJECT,
    };

    for (let index = 2; index < process.argv.length; index++) {
        if (process.argv[index] === '--project') {
            options.project = process.argv[++index];
        } else {
            throw new Error(`Unknown argument: ${process.argv[index]}`);
        }
    }

    return options;
}

async function readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value) {
    const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;

    try {
        await fs.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await fs.rename(temporaryFile, file);
    } catch (error) {
        await fs.unlink(temporaryFile).catch(() => {});
        throw error;
    }
}

async function fileExists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const options = parseArgs();
    const database = openForensicDatabase(DATABASE_FILE, { readOnly: true });
    let projectId;
    let projectFiles;

    try {
        projectId = getProjectId(database, options.project);

        if (!projectId) throw new Error(`Unknown forensic project: ${options.project}`);

        projectFiles = database
            .prepare(
                `SELECT document.file
                 FROM documents document
                 JOIN projects project ON project.id = document.project_id
                 WHERE project.id = ?
                 ORDER BY document.file`,
            )
            .all(projectId)
            .map(row => row.file);
    } finally {
        database.close();
    }

    const projectDirectory = path.join(PDF_ROOT, String(projectId));
    await fs.mkdir(projectDirectory, { recursive: true });

    const entries = await fs.readdir(PDF_ROOT, { withFileTypes: true });
    const rootPdfFiles = entries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
        .map(entry => entry.name);

    for (const file of rootPdfFiles) {
        const source = path.join(PDF_ROOT, file);
        const destination = path.join(projectDirectory, file);

        if (await fileExists(destination)) {
            throw new Error(`Refusing to overwrite existing project PDF: ${destination}`);
        }

        await fs.rename(source, destination);
    }

    const [results, errors, progress] = await Promise.all([
        readJson(RESULTS_FILE),
        readJson(ERRORS_FILE),
        readJson(PROGRESS_FILE),
    ]);
    const updatedResults = results.map(record => {
        const recordProjectId = Number(record.project_id || projectId);

        if (recordProjectId !== projectId) return record;

        const filename = `${path.basename(String(record.document_id))}.pdf`;
        return {
            ...record,
            project_id: projectId,
            local_file: path.relative(__dirname, path.join(projectDirectory, filename)),
        };
    });
    const updatedErrors = errors.map(record => ({
        ...record,
        project_id: Number(record.project_id || projectId),
    }));
    const updatedProgress = {
        ...progress,
        project_id: projectId,
    };

    await writeJsonAtomic(RESULTS_FILE, updatedResults);
    await writeJsonAtomic(ERRORS_FILE, updatedErrors);
    await writeJsonAtomic(PROGRESS_FILE, updatedProgress);

    const missing = [];

    for (const file of projectFiles) {
        if (!(await fileExists(path.join(projectDirectory, file)))) missing.push(file);
    }

    const remainingRootPdfs = (await fs.readdir(PDF_ROOT, { withFileTypes: true })).filter(
        entry => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'),
    );

    if (missing.length > 0 || remainingRootPdfs.length > 0) {
        throw new Error(
            `PDF migration validation failed: missing=${missing.length}, root_pdfs=${remainingRootPdfs.length}`,
        );
    }

    console.log('Project PDF migration complete');
    console.log(`Project:   ${options.project}`);
    console.log(`Project ID: ${projectId}`);
    console.log(`Moved:     ${rootPdfFiles.length}`);
    console.log(`Validated: ${projectFiles.length}`);
    console.log(`Directory: ${projectDirectory}`);
}

main().catch(error => {
    console.error('\nFATAL ERROR');
    console.error(error);
    process.exitCode = 1;
});
