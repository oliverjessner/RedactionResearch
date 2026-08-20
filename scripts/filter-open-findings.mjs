import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Util, VerbosityLevel, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const {
    DEFAULT_PROJECT,
    getProjectId,
    listOpenProblems,
    openForensicDatabase,
    skipOpenProblems,
} = require('../lib/forensic-db.js');
const {
    FORENSIC_RENDER_SCALE,
    classifyRecoveredText,
    combineRecoveredText,
    problemRegions,
    recoverProblemRegions,
    textItemToRect,
} = require('../lib/pdf-text-recovery.js');

const DEFAULT_DATABASE_FILE = path.join(PROJECT_DIR, 'output', 'forensic', 'forensic.sqlite');
const DEFAULT_PDF_ROOT = path.join(PROJECT_DIR, 'output', 'download', 'pdfs');
const PDFJS_MODULE = fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
const PDFJS_ROOT = path.resolve(path.dirname(PDFJS_MODULE), '../..');
const CMAP_URL = `${path.join(PDFJS_ROOT, 'cmaps')}${path.sep}`;
const STANDARD_FONT_DATA_URL = `${path.join(PDFJS_ROOT, 'standard_fonts')}${path.sep}`;
const ICC_URL = `${path.join(PDFJS_ROOT, 'iccs')}${path.sep}`;
const WASM_URL = `${path.join(PDFJS_ROOT, 'wasm')}${path.sep}`;

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        apply: false,
        databaseFile: DEFAULT_DATABASE_FILE,
        file: null,
        limit: null,
        pdfRoot: DEFAULT_PDF_ROOT,
        project: process.env.FORENSIC_PROJECT || DEFAULT_PROJECT,
        scale: FORENSIC_RENDER_SCALE,
    };

    for (let index = 0; index < args.length; index++) {
        switch (args[index]) {
            case '--apply':
                options.apply = true;
                break;
            case '--database':
                options.databaseFile = path.resolve(args[++index]);
                break;
            case '--file':
                options.file = args[++index];
                break;
            case '--limit':
                options.limit = Number(args[++index]);
                break;
            case '--pdf-root':
                options.pdfRoot = path.resolve(args[++index]);
                break;
            case '--project':
                options.project = args[++index];
                break;
            case '--scale':
                options.scale = Number(args[++index]);
                break;
            case '--help':
                printHelp();
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown argument: ${args[index]}`);
        }
    }

    if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
        throw new Error('--limit must be a positive integer');
    }

    if (!Number.isFinite(options.scale) || options.scale <= 0 || options.scale > 4) {
        throw new Error('--scale must be > 0 and <= 4');
    }

    if (typeof options.project !== 'string' || !options.project.trim()) {
        throw new Error('--project must be a non-empty string');
    }

    if (options.file && path.basename(options.file) !== options.file) {
        throw new Error('--file must be a filename without a directory');
    }

    return options;
}

function printHelp() {
    console.log(`
Filter recovered text in open forensic findings

Usage:
  node scripts/filter-open-findings.mjs [options]

Options:
  --apply             Write underscore-only findings as skipped.
                      Without this flag the script is a dry run.
  --project NAME      SQLite project name (default: ${DEFAULT_PROJECT}).
  --file NAME.pdf     Process one PDF only.
  --limit N           Process the first N PDFs with open findings.
  --scale NUMBER      Coordinate scale used by the forensic scan (default: ${FORENSIC_RENDER_SCALE}).
  --database PATH     Override the SQLite database file.
  --pdf-root PATH     Override the PDF root containing project-ID directories.
  --help              Show this help.
`);
}

function groupByFile(problems) {
    const groups = new Map();

    for (const problem of problems) {
        const existing = groups.get(problem.file);

        if (existing) {
            existing.push(problem);
        } else {
            groups.set(problem.file, [problem]);
        }
    }

    return groups;
}

function createCounts() {
    return {
        alphanumeric: 0,
        underscores_only: 0,
        empty: 0,
        symbols_only: 0,
        unavailable: 0,
        errors: 0,
        skipped: 0,
    };
}

function addCounts(target, source) {
    for (const key of Object.keys(target)) {
        target[key] += source[key] || 0;
    }
}

async function openPdf(pdfPath) {
    const bytes = await fs.readFile(pdfPath);
    const loadingTask = getDocument({
        data: new Uint8Array(bytes),
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: STANDARD_FONT_DATA_URL,
        iccUrl: ICC_URL,
        wasmUrl: WASM_URL,
        useWorkerFetch: false,
        verbosity: VerbosityLevel.ERRORS,
    });

    try {
        return {
            document: await loadingTask.promise,
            loadingTask,
        };
    } catch (error) {
        await loadingTask.destroy().catch(() => null);
        throw error;
    }
}

async function processDocument({ database, file, pdfDirectory, problems, options }) {
    const counts = createCounts();
    const skipIds = [];
    const pageGroups = new Map();

    for (const problem of problems) {
        if (!Number.isInteger(problem.page) || problem.page < 1 || problemRegions(problem).length === 0) {
            counts.unavailable++;
            continue;
        }

        const existing = pageGroups.get(problem.page);

        if (existing) {
            existing.push(problem);
        } else {
            pageGroups.set(problem.page, [problem]);
        }
    }

    if (pageGroups.size === 0) return counts;

    let handle;

    try {
        handle = await openPdf(path.join(pdfDirectory, file));
    } catch (error) {
        counts.errors += [...pageGroups.values()].reduce((sum, pageProblems) => sum + pageProblems.length, 0);
        console.error(`    ERROR opening ${file}: ${error.message}`);
        return counts;
    }

    try {
        for (const [pageNumber, pageProblems] of pageGroups) {
            if (pageNumber > handle.document.numPages) {
                counts.unavailable += pageProblems.length;
                continue;
            }

            let page;

            try {
                page = await handle.document.getPage(pageNumber);
                const viewport = page.getViewport({ scale: options.scale });
                const textContent = await page.getTextContent({ includeMarkedContent: true });
                const textItems = textContent.items.map(item => textItemToRect(item, viewport, Util)).filter(Boolean);

                for (const problem of pageProblems) {
                    const recoveredRegions = recoverProblemRegions(problem, textItems);
                    const classification = classifyRecoveredText(combineRecoveredText(recoveredRegions));

                    counts[classification]++;

                    if (classification === 'underscores_only') {
                        skipIds.push(problem.problem_id);
                    }
                }
            } catch (error) {
                counts.errors += pageProblems.length;
                console.error(`    ERROR ${file}, page ${pageNumber}: ${error.message}`);
            } finally {
                page?.cleanup();
            }
        }
    } finally {
        await handle.loadingTask.destroy().catch(() => null);
    }

    if (options.apply && skipIds.length > 0) {
        counts.skipped = skipOpenProblems(database, options.project, skipIds);
    }

    return counts;
}

function printSummary({ counts, documentCount, findingCount, options }) {
    console.log('');
    console.log('================================');
    console.log('RECOVERED TEXT FILTER COMPLETE');
    console.log('================================');
    console.log(`PDFs processed:                  ${documentCount}`);
    console.log(`Open findings selected:          ${findingCount}`);
    console.log(`Letter or number found (open):   ${counts.alphanumeric}`);
    console.log(`Underscores only:                ${counts.underscores_only}`);
    console.log(`Empty recovered text (open):     ${counts.empty}`);
    console.log(`Other symbols only (open):       ${counts.symbols_only}`);
    console.log(`No page/region available (open): ${counts.unavailable}`);
    console.log(`Extraction errors (open):        ${counts.errors}`);

    if (options.apply) {
        console.log(`Written as skipped:              ${counts.skipped}`);
    } else {
        console.log(`Would be written as skipped:     ${counts.underscores_only}`);
        console.log('SQLite was not changed. Use --apply after checking this dry run.');
    }

    console.log('Recovered text was processed in memory and was not stored or printed.');
}

async function main() {
    const options = parseArgs();

    await fs.access(options.databaseFile);
    const database = openForensicDatabase(options.databaseFile, { readOnly: !options.apply });

    try {
        const projectId = getProjectId(database, options.project);

        if (!projectId) throw new Error(`Unknown forensic project: ${options.project}`);

        const pdfDirectory = path.join(options.pdfRoot, String(projectId));
        await fs.access(pdfDirectory);

        let problems = listOpenProblems(database, options.project);

        if (options.file) {
            problems = problems.filter(problem => problem.file === options.file);
        }

        let documentGroups = groupByFile(problems);

        if (options.limit !== null) {
            documentGroups = new Map([...documentGroups].slice(0, options.limit));
        }

        const findingCount = [...documentGroups.values()].reduce((sum, group) => sum + group.length, 0);
        const counts = createCounts();

        console.log('Open forensic recovered-text filter');
        console.log('------------------------------------');
        console.log(`Project:       ${options.project}`);
        console.log(`Project ID:    ${projectId}`);
        console.log(`PDFs selected: ${documentGroups.size}`);
        console.log(`Open findings: ${findingCount}`);
        console.log(`Scale:         ${options.scale}`);
        console.log(`Mode:          ${options.apply ? 'APPLY' : 'DRY RUN'}`);
        console.log('');

        let index = 0;

        for (const [file, documentProblems] of documentGroups) {
            index++;
            const documentCounts = await processDocument({
                database,
                file,
                pdfDirectory,
                problems: documentProblems,
                options,
            });
            addCounts(counts, documentCounts);
            console.log(
                `[${index}/${documentGroups.size}] ${file} | ` +
                    `text ${documentCounts.alphanumeric} | underscores ${documentCounts.underscores_only} | ` +
                    `empty ${documentCounts.empty} | unavailable ${documentCounts.unavailable} | errors ${documentCounts.errors}`,
            );
        }

        printSummary({
            counts,
            documentCount: documentGroups.size,
            findingCount,
            options,
        });

        if (counts.errors > 0) process.exitCode = 1;
    } finally {
        database.close();
    }
}

main().catch(error => {
    console.error(`FATAL ERROR: ${error.message}`);
    process.exitCode = 1;
});
