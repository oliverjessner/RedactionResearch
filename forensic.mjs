import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { AnnotationMode, Util, VerbosityLevel, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, 'output');
const DISCOVERY_DIR = path.join(OUTPUT_DIR, 'discovery');
const DOWNLOAD_DIR = path.join(OUTPUT_DIR, 'download');
const PDF_DIR = path.join(DOWNLOAD_DIR, 'pdfs');
const FORENSIC_DIR = path.join(OUTPUT_DIR, 'forensic');

const CANDIDATES_FILE = path.join(DISCOVERY_DIR, 'candidates.json');

const PROBLEMS_FILE = path.join(FORENSIC_DIR, 'redaction_problems.json');

const PROGRESS_FILE = path.join(FORENSIC_DIR, 'redaction_scan_progress.json');

// ---------------------------------------------------------
// PDF.js resources
// ---------------------------------------------------------

const PDFJS_MODULE = fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'));

const PDFJS_ROOT = path.resolve(path.dirname(PDFJS_MODULE), '../..');

const CMAP_URL = path.join(PDFJS_ROOT, 'cmaps') + path.sep;

const STANDARD_FONT_DATA_URL = path.join(PDFJS_ROOT, 'standard_fonts') + path.sep;

const ICC_URL = path.join(PDFJS_ROOT, 'iccs') + path.sep;

const WASM_URL = path.join(PDFJS_ROOT, 'wasm') + path.sep;

// ---------------------------------------------------------
// Configuration
// ---------------------------------------------------------

const DEFAULT_SCALE = 1.5;
const DEFAULT_MIN_SCORE = 60;

const MAX_REGIONS_PER_FINDING = 30;

const LARGE_DOCUMENT_PAGE_THRESHOLD = 100;
const PAGE_PROGRESS_INTERVAL = 25;

const MIN_TEXT_LENGTH = 3;
const MIN_TEXT_WIDTH_PX = 8;
const MIN_TEXT_HEIGHT_PX = 4;

// "Text exists, but rendered area is nearly black"
const DARK_MEAN_LUMA = 55;
const DARK_PIXEL_RATIO = 0.78;
const DARK_MAX_WHITE_RATIO = 0.03;
const DARK_MAX_STDDEV = 55;

// "Text exists, but rendered area is essentially white"
const WHITE_MEAN_LUMA = 249;
const WHITE_PIXEL_RATIO = 0.985;
const WHITE_MAX_DARK_RATIO = 0.004;
const WHITE_MAX_STDDEV = 10;

const REDACTION_HINT_RE = /(geschw[aä]rzt|geschwaerzt|schw[aä]rzung|teilgeschw|anonymis|redact|unkenntlich)/i;

const SUSPICIOUS_ATTACHMENT_NAME_RE =
    /(ungeschw[aä]rzt|ungeschwaerzt|unredacted|unredact|original|rohfassung|raw|source|backup|altfassung)/i;

// Wir speichern niemals die gefundenen Inhalte.
// Nur welche Datenart erkannt wurde.
const SENSITIVE_PATTERNS = {
    email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,

    iban: /\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,30}\b/i,

    phone: /(?:\+|00)(?:43|49)[\s()\-\/0-9]{7,}/,
};

// ---------------------------------------------------------
// CLI
// ---------------------------------------------------------

function parseArgs() {
    const args = process.argv.slice(2);

    const options = {
        limit: null,
        file: null,
        minScore: DEFAULT_MIN_SCORE,
        scale: DEFAULT_SCALE,
        force: false,
        noRender: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--limit':
                options.limit = Number(args[++i]);
                break;

            case '--file':
                options.file = args[++i];
                break;

            case '--min-score':
                options.minScore = Number(args[++i]);
                break;

            case '--scale':
                options.scale = Number(args[++i]);
                break;

            case '--force':
                options.force = true;
                break;

            case '--no-render':
                options.noRender = true;
                break;

            case '--help':
                printHelp();
                process.exit(0);

            default:
                throw new Error(`Unknown argument: ${args[i]}`);
        }
    }

    if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
        throw new Error('--limit must be a positive integer');
    }

    if (!Number.isFinite(options.minScore) || options.minScore < 0 || options.minScore > 100) {
        throw new Error('--min-score must be between 0 and 100');
    }

    if (!Number.isFinite(options.scale) || options.scale <= 0 || options.scale > 4) {
        throw new Error('--scale must be > 0 and <= 4');
    }

    return options;
}

function printHelp() {
    console.log(`
PDF redaction scanner

Usage:

  node forensic.mjs

Options:

  --limit N
      Scan only first N PDFs

  --file NAME
      Scan one PDF

  --min-score N
      Minimum risk score written to output
      Default: ${DEFAULT_MIN_SCORE}

  --scale N
      PDF rendering scale
      Default: ${DEFAULT_SCALE}

  --force
      Re-scan already scanned PDFs

  --no-render
      Only structural checks.
      Skip pixel/rendering checks.

Examples:

  node forensic.mjs --limit 20

  node forensic.mjs \
    --file 12345.pdf \
    --force

  node forensic.mjs \
    --min-score 50
`);
}

// ---------------------------------------------------------
// Files
// ---------------------------------------------------------

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return fallback;
        }

        throw error;
    }
}

async function writeJsonAtomic(file, data) {
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;

    try {
        await fs.writeFile(tmp, JSON.stringify(data, null, 2));

        await fs.rename(tmp, file);
    } catch (error) {
        try {
            await fs.unlink(tmp);
        } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
                error.cleanupError = cleanupError;
            }
        }

        throw error;
    }
}

// ---------------------------------------------------------
// Rectangles / geometry
// ---------------------------------------------------------

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeRect(rect) {
    const [x0, y0, x1, y1] = rect;

    return {
        x0: Math.min(x0, x1),
        y0: Math.min(y0, y1),
        x1: Math.max(x0, x1),
        y1: Math.max(y0, y1),
    };
}

function rectArea(r) {
    return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
}

function intersectRect(a, b) {
    const r = {
        x0: Math.max(a.x0, b.x0),

        y0: Math.max(a.y0, b.y0),

        x1: Math.min(a.x1, b.x1),

        y1: Math.min(a.y1, b.y1),
    };

    return rectArea(r) > 0 ? r : null;
}

function rectToArray(r) {
    return [Number(r.x0.toFixed(2)), Number(r.y0.toFixed(2)), Number(r.x1.toFixed(2)), Number(r.y1.toFixed(2))];
}

// ---------------------------------------------------------
// Text bounding boxes
// ---------------------------------------------------------

function nearHorizontal(angle) {
    let a = Math.abs(angle % Math.PI);

    if (a > Math.PI / 2) {
        a = Math.PI - a;
    }

    // About 10 degrees tolerance
    return a < 0.18;
}

function textItemToRect(item, viewport) {
    if (!item || typeof item.str !== 'string') {
        return null;
    }

    const normalized = item.str.replace(/\s+/g, ' ').trim();

    if (normalized.length < MIN_TEXT_LENGTH) {
        return null;
    }

    if (!Array.isArray(item.transform)) {
        return null;
    }

    const tx = Util.transform(viewport.transform, item.transform);

    const angle = Math.atan2(tx[1], tx[0]);

    // Precision-first:
    // rotated text is ignored for now.
    if (!nearHorizontal(angle)) {
        return null;
    }

    const height = Math.max(
        Math.abs(item.height || 0) * viewport.scale,

        Math.hypot(tx[2], tx[3]),
    );

    const width = Math.abs(item.width || 0) * viewport.scale;

    if (width < MIN_TEXT_WIDTH_PX || height < MIN_TEXT_HEIGHT_PX) {
        return null;
    }

    let x0 = tx[4];

    if (Math.cos(angle) < 0) {
        x0 -= width;
    }

    return {
        x0,
        y0: tx[5] - height,
        x1: x0 + width,
        y1: tx[5],

        // IMPORTANT:
        // Text only remains in RAM.
        // Never serialize this.
        _text: normalized,
    };
}

// ---------------------------------------------------------
// Pixel analysis
// ---------------------------------------------------------

function getPixelStats(context, rect, canvasWidth, canvasHeight) {
    const x0 = clamp(Math.floor(rect.x0), 0, canvasWidth - 1);

    const y0 = clamp(Math.floor(rect.y0), 0, canvasHeight - 1);

    const x1 = clamp(Math.ceil(rect.x1), x0 + 1, canvasWidth);

    const y1 = clamp(Math.ceil(rect.y1), y0 + 1, canvasHeight);

    const width = x1 - x0;

    const height = y1 - y0;

    if (width <= 0 || height <= 0) {
        return null;
    }

    const image = context.getImageData(x0, y0, width, height);

    const data = image.data;

    let dark = 0;
    let white = 0;

    let sum = 0;
    let sumSq = 0;

    let pixels = 0;

    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3] / 255;

        const r = data[i] * alpha + 255 * (1 - alpha);

        const g = data[i + 1] * alpha + 255 * (1 - alpha);

        const b = data[i + 2] * alpha + 255 * (1 - alpha);

        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        if (lum <= 70) {
            dark++;
        }

        if (lum >= 245) {
            white++;
        }

        sum += lum;

        sumSq += lum * lum;

        pixels++;
    }

    if (!pixels) {
        return null;
    }

    const mean = sum / pixels;

    const variance = Math.max(0, sumSq / pixels - mean * mean);

    return {
        mean,

        stddev: Math.sqrt(variance),

        darkRatio: dark / pixels,

        whiteRatio: white / pixels,
    };
}

function isSolidDark(stats) {
    return Boolean(
        stats &&
        stats.mean <= DARK_MEAN_LUMA &&
        stats.darkRatio >= DARK_PIXEL_RATIO &&
        stats.whiteRatio <= DARK_MAX_WHITE_RATIO &&
        stats.stddev <= DARK_MAX_STDDEV,
    );
}

function isSolidWhite(stats) {
    return Boolean(
        stats &&
        stats.mean >= WHITE_MEAN_LUMA &&
        stats.whiteRatio >= WHITE_PIXEL_RATIO &&
        stats.darkRatio <= WHITE_MAX_DARK_RATIO &&
        stats.stddev <= WHITE_MAX_STDDEV,
    );
}

// ---------------------------------------------------------
// Scoring
// ---------------------------------------------------------

function scoreToSeverity(score) {
    if (score >= 90) {
        return 'critical';
    }

    if (score >= 75) {
        return 'high';
    }

    if (score >= 60) {
        return 'medium';
    }

    return 'low';
}

function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
    }

    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function candidateHasRedactionHint(candidate, fileName) {
    return REDACTION_HINT_RE.test(
        `${fileName} ${candidate?.title || ''} ${(candidate?.matched_terms || []).join(' ')}`,
    );
}

// ---------------------------------------------------------
// Sensitive-pattern detector
// ---------------------------------------------------------

function detectSensitiveCategories(value) {
    const text = String(value ?? '');

    const categories = [];

    for (const [name, re] of Object.entries(SENSITIVE_PATTERNS)) {
        if (re.test(text)) {
            categories.push(name);
        }
    }

    return categories;
}

// ---------------------------------------------------------
// Recursive string collection
// ---------------------------------------------------------

function collectStrings(value, out = [], depth = 0, max = 250) {
    if (out.length >= max || depth > 6 || value == null) {
        return out;
    }

    if (typeof value === 'string') {
        out.push(value);
        return out;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectStrings(item, out, depth + 1, max);
        }

        return out;
    }

    if (value instanceof Map) {
        for (const [k, v] of value.entries()) {
            collectStrings(k, out, depth + 1, max);

            collectStrings(v, out, depth + 1, max);
        }

        return out;
    }

    if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            collectStrings(k, out, depth + 1, max);

            collectStrings(v, out, depth + 1, max);
        }
    }

    return out;
}

// ---------------------------------------------------------
// Form fields
// ---------------------------------------------------------

function countNonEmptyFieldValues(fieldObjects) {
    if (!fieldObjects) {
        return {
            nonEmpty: 0,
            sensitiveCategories: [],
        };
    }

    const sensitive = new Set();

    let nonEmpty = 0;

    const visit = (value, key = '', depth = 0) => {
        if (depth > 8 || value == null) {
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item, key, depth + 1);
            }

            return;
        }

        if (value instanceof Map) {
            for (const [k, v] of value.entries()) {
                visit(v, String(k), depth + 1);
            }

            return;
        }

        if (typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) {
                visit(v, k, depth + 1);
            }

            return;
        }

        if (/^(value|fieldValue|defaultValue)$/i.test(key)) {
            const str = String(value).trim();

            if (str) {
                nonEmpty++;

                for (const category of detectSensitiveCategories(str)) {
                    sensitive.add(category);
                }
            }
        }
    };

    visit(fieldObjects);

    return {
        nonEmpty,

        sensitiveCategories: [...sensitive],
    };
}

// ---------------------------------------------------------
// Outline / bookmarks
// ---------------------------------------------------------

function flattenOutlineTitles(nodes, out = []) {
    if (!Array.isArray(nodes)) {
        return out;
    }

    for (const node of nodes) {
        if (typeof node?.title === 'string') {
            out.push(node.title);
        }

        if (Array.isArray(node?.items)) {
            flattenOutlineTitles(node.items, out);
        }
    }

    return out;
}

// ---------------------------------------------------------
// Merge neighbouring suspicious text boxes
// ---------------------------------------------------------

function mergeRects(rects, gap = 6) {
    const pending = rects.map(r => ({
        ...r,
    }));

    const merged = [];

    while (pending.length) {
        let current = pending.pop();

        let changed = true;

        while (changed) {
            changed = false;

            for (let i = pending.length - 1; i >= 0; i--) {
                const other = pending[i];

                const expanded = {
                    x0: current.x0 - gap,

                    y0: current.y0 - gap,

                    x1: current.x1 + gap,

                    y1: current.y1 + gap,
                };

                if (intersectRect(expanded, other)) {
                    current = {
                        x0: Math.min(current.x0, other.x0),

                        y0: Math.min(current.y0, other.y0),

                        x1: Math.max(current.x1, other.x1),

                        y1: Math.max(current.y1, other.y1),
                    };

                    pending.splice(i, 1);

                    changed = true;
                }
            }
        }

        merged.push(current);
    }

    return merged;
}

// ---------------------------------------------------------
// Rendering
// ---------------------------------------------------------

async function renderPage(pdfDocument, page, viewport, annotationMode) {
    const canvasFactory = pdfDocument.canvasFactory;

    const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);

    const renderTask = page.render({
        canvasContext: canvasAndContext.context,

        viewport,

        annotationMode,
    });

    await renderTask.promise;

    return {
        ...canvasAndContext,
        canvasFactory,
    };
}

function destroyCanvas(rendered) {
    try {
        rendered?.canvasFactory?.destroy(rendered);
    } catch {
        // best effort
    }
}

// ---------------------------------------------------------
// Annotations
// ---------------------------------------------------------

function annotationRectToViewport(annotation, viewport) {
    if (!Array.isArray(annotation?.rect) || annotation.rect.length !== 4) {
        return null;
    }

    try {
        return normalizeRect(viewport.convertToViewportRectangle(annotation.rect));
    } catch {
        return null;
    }
}

function isDarkColor(color) {
    if (!color || typeof color.length !== 'number' || color.length < 3) {
        return false;
    }

    const vals = [Number(color[0]), Number(color[1]), Number(color[2])];

    const max = Math.max(...vals);

    const normalized = max > 1 ? vals.map(v => v / 255) : vals;

    const lum = 0.2126 * normalized[0] + 0.7152 * normalized[1] + 0.0722 * normalized[2];

    return lum < 0.18;
}

function annotationLooksDark(annotation) {
    return isDarkColor(annotation?.color) || isDarkColor(annotation?.backgroundColor);
}

function countTextOverlaps(rect, textRects) {
    let count = 0;

    for (const textRect of textRects) {
        if (intersectRect(rect, textRect)) {
            count++;
        }
    }

    return count;
}

// ---------------------------------------------------------
// Scan one page
// ---------------------------------------------------------

async function scanPage({ pdfDocument, page, pageNumber, scale, noRender }) {
    const findings = [];

    const viewport = page.getViewport({
        scale,
    });

    const textContent = await page.getTextContent({
        includeMarkedContent: true,
    });

    const textRects = textContent.items.map(item => textItemToRect(item, viewport)).filter(Boolean);

    const annotations = await page
        .getAnnotations({
            intent: 'any',
        })
        .catch(() => []);

    // -------------------------------------------------------
    // Explicit PDF redaction annotations
    // -------------------------------------------------------

    for (const annotation of annotations) {
        const rect = annotationRectToViewport(annotation, viewport);

        if (!rect) {
            continue;
        }

        const overlapCount = countTextOverlaps(rect, textRects);

        if (!overlapCount) {
            continue;
        }

        const subtype = String(annotation.subtype || '').toLowerCase();

        if (subtype === 'redact') {
            findings.push({
                type: 'REDACTION_ANNOTATION_WITH_LIVE_TEXT',

                risk_score: 100,

                page: pageNumber,

                evidence: {
                    affected_text_items: overlapCount,

                    bbox: rectToArray(rect),
                },
            });

            continue;
        }

        if (annotationLooksDark(annotation) && ['square', 'stamp', 'freetext', 'ink'].includes(subtype)) {
            findings.push({
                type: 'DARK_ANNOTATION_OVER_LIVE_TEXT',

                risk_score: 82,

                page: pageNumber,

                evidence: {
                    affected_text_items: overlapCount,

                    annotation_subtype: annotation.subtype || 'unknown',

                    bbox: rectToArray(rect),
                },
            });
        }
    }

    if (noRender || textRects.length === 0) {
        return findings;
    }

    let rendered = null;

    let renderedNoAnnotations = null;

    try {
        // Normal page rendering
        rendered = await renderPage(pdfDocument, page, viewport, AnnotationMode.ENABLE);

        const darkRects = [];
        const whiteRects = [];

        for (const rect of textRects) {
            const stats = getPixelStats(rendered.context, rect, rendered.canvas.width, rendered.canvas.height);

            if (!stats) {
                continue;
            }

            if (isSolidDark(stats)) {
                darkRects.push({
                    rect,
                    stats,
                });
            } else if (isSolidWhite(stats)) {
                whiteRects.push({
                    rect,
                    stats,
                });
            }
        }

        // If annotations exist, render the same page
        // without annotations.
        //
        // If the black region disappears, we know an
        // annotation hid the text.
        if (darkRects.length > 0 && annotations.length > 0) {
            renderedNoAnnotations = await renderPage(pdfDocument, page, viewport, AnnotationMode.DISABLE);
        }

        const annotationHidden = [];

        const contentHidden = [];

        for (const item of darkRects) {
            let annotationCaused = false;

            if (renderedNoAnnotations) {
                const disabledStats = getPixelStats(
                    renderedNoAnnotations.context,

                    item.rect,

                    renderedNoAnnotations.canvas.width,

                    renderedNoAnnotations.canvas.height,
                );

                if (disabledStats && disabledStats.mean >= item.stats.mean + 45 && disabledStats.darkRatio <= 0.55) {
                    annotationCaused = true;
                }
            }

            if (annotationCaused) {
                annotationHidden.push(item.rect);
            } else {
                contentHidden.push(item.rect);
            }
        }

        // -----------------------------------------------------
        // Annotation hides text
        // -----------------------------------------------------

        if (annotationHidden.length) {
            const merged = mergeRects(annotationHidden).slice(0, MAX_REGIONS_PER_FINDING);

            findings.push({
                type: 'ANNOTATION_OVERLAY_HIDES_LIVE_TEXT',

                risk_score: 98,

                page: pageNumber,

                evidence: {
                    affected_text_items: annotationHidden.length,

                    regions: merged.map(rectToArray),
                },
            });
        }

        // -----------------------------------------------------
        // Black page object / image / rectangle hides text
        // -----------------------------------------------------

        if (contentHidden.length) {
            const merged = mergeRects(contentHidden).slice(0, MAX_REGIONS_PER_FINDING);

            findings.push({
                type: 'DARK_PAGE_CONTENT_HIDES_LIVE_TEXT',

                risk_score: contentHidden.length >= 2 ? 94 : 88,

                page: pageNumber,

                evidence: {
                    affected_text_items: contentHidden.length,

                    regions: merged.map(rectToArray),
                },
            });
        }

        // -----------------------------------------------------
        // Text exists but rendering is essentially white
        // -----------------------------------------------------

        if (whiteRects.length) {
            const merged = mergeRects(whiteRects.map(item => item.rect)).slice(0, MAX_REGIONS_PER_FINDING);

            findings.push({
                type: 'LIVE_TEXT_NOT_VISIBLE_ON_WHITE_REGION',

                risk_score: whiteRects.length >= 2 ? 82 : 72,

                page: pageNumber,

                evidence: {
                    affected_text_items: whiteRects.length,

                    regions: merged.map(rectToArray),
                },
            });
        }
    } finally {
        destroyCanvas(renderedNoAnnotations);

        destroyCanvas(rendered);
    }

    return findings;
}

// ---------------------------------------------------------
// Scan one document
// ---------------------------------------------------------

async function scanDocument(pdfPath, candidate, options, onPageProgress = null) {
    const fileName = path.basename(pdfPath);

    const bytes = await fs.readFile(pdfPath);

    // Some redaction problems survive in incremental
    // revisions. We do not recover content here.
    const rawLatin1 = bytes.toString('latin1');

    const redactionHint = candidateHasRedactionHint(candidate, fileName);

    const eofCount = (rawLatin1.match(/%%EOF/g) || []).length;

    const prevCount = (rawLatin1.match(/\/Prev\b/g) || []).length;

    const hasOptionalContentRaw = /\/OCProperties\b/.test(rawLatin1);

    const loadingTask = getDocument({
        data: new Uint8Array(bytes),

        cMapUrl: CMAP_URL,

        cMapPacked: true,

        standardFontDataUrl: STANDARD_FONT_DATA_URL,

        iccUrl: ICC_URL,

        wasmUrl: WASM_URL,

        useWorkerFetch: false,

        // Malformed PDFs often trigger recoverable font/metadata warnings.
        // Keep scanner output focused on actual document failures.
        verbosity: VerbosityLevel.ERRORS,

        stopAtErrors: false,
    });

    const pdfDocument = await loadingTask.promise;

    const pageCount = pdfDocument.numPages;

    const reportPageProgress = pageCount >= LARGE_DOCUMENT_PAGE_THRESHOLD && onPageProgress;

    if (reportPageProgress) {
        await onPageProgress({
            page: 0,
            total: pageCount,
        });
    }

    const findings = [];

    const supportingSignals = [];

    try {
        // -----------------------------------------------------
        // Digital signatures
        // -----------------------------------------------------

        const signatures =
            typeof pdfDocument.getSignatures === 'function'
                ? await pdfDocument.getSignatures().catch(() => null)
                : null;

        const signatureCount = Array.isArray(signatures) ? signatures.length : 0;

        // -----------------------------------------------------
        // Incremental revisions
        // -----------------------------------------------------

        if (eofCount > 1 || prevCount > 0) {
            supportingSignals.push({
                type: 'INCREMENTAL_PDF_REVISIONS_PRESENT',

                eof_markers: eofCount,

                prev_entries: prevCount,

                digital_signatures: signatureCount,
            });

            // Multiple revisions alone are NOT proof
            // of a leak.
            const score = redactionHint && signatureCount === 0 ? 52 : 25;

            if (score >= options.minScore) {
                findings.push({
                    type: 'INCREMENTAL_PDF_REVISIONS_PRESENT',

                    risk_score: score,

                    page: null,

                    evidence: {
                        eof_markers: eofCount,

                        prev_entries: prevCount,

                        digital_signatures: signatureCount,
                    },
                });
            }
        }

        // -----------------------------------------------------
        // Optional / hidden layers
        // -----------------------------------------------------

        if (hasOptionalContentRaw) {
            supportingSignals.push({
                type: 'OPTIONAL_CONTENT_LAYERS_PRESENT',
            });
        }

        // -----------------------------------------------------
        // Embedded attachments
        // -----------------------------------------------------

        const attachments = await pdfDocument.getAttachments().catch(() => null);

        if (attachments) {
            const strings = collectStrings(attachments);

            const suspiciousName = strings.some(value => SUSPICIOUS_ATTACHMENT_NAME_RE.test(value));

            supportingSignals.push({
                type: 'EMBEDDED_ATTACHMENTS_PRESENT',

                suspicious_unredacted_name_pattern: suspiciousName,
            });

            if (suspiciousName) {
                findings.push({
                    type: 'SUSPICIOUS_EMBEDDED_ATTACHMENT',

                    risk_score: 78,

                    page: null,

                    evidence: {
                        suspicious_unredacted_name_pattern: true,
                    },
                });
            }
        }

        // -----------------------------------------------------
        // Form fields
        // -----------------------------------------------------

        const fieldObjects = await pdfDocument.getFieldObjects().catch(() => null);

        const formValues = countNonEmptyFieldValues(fieldObjects);

        if (formValues.nonEmpty > 0) {
            supportingSignals.push({
                type: 'FORM_FIELDS_WITH_VALUES_PRESENT',

                non_empty_value_count: formValues.nonEmpty,

                sensitive_categories: formValues.sensitiveCategories,
            });

            const score = formValues.sensitiveCategories.length ? 82 : redactionHint ? 58 : 35;

            if (score >= options.minScore) {
                findings.push({
                    type: 'FORM_FIELD_VALUES_REMAIN_MACHINE_READABLE',

                    risk_score: score,

                    page: null,

                    evidence: {
                        non_empty_value_count: formValues.nonEmpty,

                        sensitive_categories: formValues.sensitiveCategories,
                    },
                });
            }
        }

        // -----------------------------------------------------
        // PDF metadata
        // -----------------------------------------------------

        const metadataResult = await pdfDocument.getMetadata().catch(() => null);

        if (metadataResult) {
            const metadataValues = collectStrings({
                info: metadataResult.info,

                xmp: typeof metadataResult.metadata?.getAll === 'function' ? metadataResult.metadata.getAll() : null,
            });

            const metadataSensitive = new Set();

            for (const value of metadataValues) {
                for (const category of detectSensitiveCategories(value)) {
                    metadataSensitive.add(category);
                }
            }

            if (metadataSensitive.size) {
                findings.push({
                    type: 'SENSITIVE_PATTERN_IN_PDF_METADATA',

                    risk_score: redactionHint ? 78 : 65,

                    page: null,

                    evidence: {
                        sensitive_categories: [...metadataSensitive],
                    },
                });
            }
        }

        // -----------------------------------------------------
        // PDF bookmarks / outline
        // -----------------------------------------------------

        const outline = await pdfDocument.getOutline().catch(() => null);

        if (outline) {
            const outlineSensitive = new Set();

            for (const title of flattenOutlineTitles(outline)) {
                for (const category of detectSensitiveCategories(title)) {
                    outlineSensitive.add(category);
                }
            }

            if (outlineSensitive.size) {
                findings.push({
                    type: 'SENSITIVE_PATTERN_IN_BOOKMARK_OUTLINE',

                    risk_score: redactionHint ? 82 : 68,

                    page: null,

                    evidence: {
                        sensitive_categories: [...outlineSensitive],
                    },
                });
            }
        }

        // -----------------------------------------------------
        // Pages
        // -----------------------------------------------------

        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
            const page = await pdfDocument.getPage(pageNumber);

            try {
                const pageFindings = await scanPage({
                    pdfDocument,
                    page,
                    pageNumber,

                    scale: options.scale,

                    noRender: options.noRender,
                });

                findings.push(...pageFindings);
            } finally {
                page.cleanup();
            }

            if (
                reportPageProgress &&
                (pageNumber === 1 || pageNumber % PAGE_PROGRESS_INTERVAL === 0 || pageNumber === pageCount)
            ) {
                await onPageProgress({
                    page: pageNumber,
                    total: pageCount,
                });
            }
        }
    } finally {
        await loadingTask.destroy();
    }

    const filtered = findings
        .filter(finding => finding.risk_score >= options.minScore)

        .map(finding => ({
            ...finding,

            severity: scoreToSeverity(finding.risk_score),
        }))

        .sort((a, b) => b.risk_score - a.risk_score);

    if (filtered.length === 0) {
        return null;
    }

    return {
        file: fileName,

        document_id: path.basename(fileName, path.extname(fileName)),

        title: candidate?.title || null,

        source_url: candidate?.site_url || candidate?.document_url || null,

        file_url: candidate?.file_url || null,

        page_count: pageCount,

        highest_risk_score: filtered[0].risk_score,

        problem_count: filtered.length,

        problems: filtered,

        supporting_signals: supportingSignals,

        scanned_at: new Date().toISOString(),

        note: 'No hidden/redacted text content is stored in this output; only detection metadata.',
    };
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------

async function main() {
    const options = parseArgs();

    await fs.mkdir(FORENSIC_DIR, {
        recursive: true,
    });

    const entries = await fs.readdir(PDF_DIR, {
        withFileTypes: true,
    });

    let pdfFiles = entries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))

        .map(entry => entry.name)

        .sort((a, b) =>
            a.localeCompare(b, undefined, {
                numeric: true,
            }),
        );

    if (options.file) {
        pdfFiles = pdfFiles.filter(name => name === options.file || path.basename(name, '.pdf') === options.file);

        if (!pdfFiles.length) {
            throw new Error(`PDF not found: ${options.file}`);
        }
    }

    if (options.limit !== null) {
        pdfFiles = pdfFiles.slice(0, options.limit);
    }

    // -------------------------------------------------------
    // Candidate metadata
    // -------------------------------------------------------

    const candidates = await readJson(CANDIDATES_FILE, []);

    const candidateMap = new Map(
        Array.isArray(candidates) ? candidates.map(candidate => [String(candidate.document_id ?? ''), candidate]) : [],
    );

    // -------------------------------------------------------
    // Existing results
    // -------------------------------------------------------

    const existingProblems = await readJson(PROBLEMS_FILE, []);

    const problemsByFile = new Map(
        Array.isArray(existingProblems) ? existingProblems.map(item => [item.file, item]) : [],
    );

    const progress = await readJson(PROGRESS_FILE, {
        completed: {},
        errors: {},
    });

    progress.completed ||= {};

    progress.errors ||= {};

    console.log('PDF Redaction Scanner');

    console.log('---------------------');

    console.log(`PDFs selected: ${pdfFiles.length}`);

    console.log(`Min score:     ${options.minScore}`);

    console.log(`Render scale:  ${options.scale}`);

    console.log(`Render checks: ${options.noRender ? 'OFF' : 'ON'}`);

    console.log('');

    let processed = 0;
    let skipped = 0;
    let withProblems = 0;

    // -------------------------------------------------------
    // Scan
    // -------------------------------------------------------

    for (let i = 0; i < pdfFiles.length; i++) {
        const fileName = pdfFiles[i];

        const pdfPath = path.join(PDF_DIR, fileName);

        const documentId = path.basename(fileName, path.extname(fileName));

        const candidate = candidateMap.get(documentId) || null;

        if (!options.force && progress.completed[fileName]) {
            skipped++;

            console.log(`[${i + 1}/${pdfFiles.length}] ${fileName} | SKIP already scanned`);

            continue;
        }

        try {
            const scanStartedAt = Date.now();

            const result = await scanDocument(pdfPath, candidate, options, async ({ page, total }) => {
                if (page === 0) {
                    console.log(`[${i + 1}/${pdfFiles.length}] ${fileName} | SCAN large PDF (${total} pages)`);
                    return;
                }

                console.log(
                    `[${i + 1}/${pdfFiles.length}] ${fileName} | ` +
                        `page ${page}/${total} | elapsed ${formatDuration(Date.now() - scanStartedAt)}`,
                );
            });

            processed++;

            delete progress.errors[fileName];

            progress.completed[fileName] = new Date().toISOString();

            if (result) {
                problemsByFile.set(fileName, result);

                withProblems++;

                console.log(
                    `[${i + 1}/${pdfFiles.length}] ${fileName} | ` +
                        `PROBLEM ${result.highest_risk_score} | ` +
                        `${result.problems[0].type}`,
                );
            } else {
                problemsByFile.delete(fileName);

                console.log(`[${i + 1}/${pdfFiles.length}] ${fileName} | ` + `clean / no score >= ${options.minScore}`);
            }
        } catch (error) {
            processed++;

            progress.errors[fileName] = {
                error: error?.message || String(error),

                at: new Date().toISOString(),
            };

            console.error(`[${i + 1}/${pdfFiles.length}] ${fileName} | ` + `ERROR ${error?.message || error}`);
        }

        progress.updated_at = new Date().toISOString();

        progress.selected = pdfFiles.length;

        progress.processed_this_run = processed;

        progress.skipped_this_run = skipped;

        progress.problem_documents_total = problemsByFile.size;

        // Save after EVERY PDF so we don't lose work.
        const output = [...problemsByFile.values()].sort((a, b) => b.highest_risk_score - a.highest_risk_score);

        await writeJsonAtomic(PROBLEMS_FILE, output);

        await writeJsonAtomic(PROGRESS_FILE, progress);
    }

    const finalOutput = [...problemsByFile.values()].sort((a, b) => b.highest_risk_score - a.highest_risk_score);

    await writeJsonAtomic(PROBLEMS_FILE, finalOutput);

    await writeJsonAtomic(PROGRESS_FILE, progress);

    console.log('');

    console.log('==============================');

    console.log('SCAN COMPLETE');

    console.log('==============================');

    console.log(`Processed this run: ${processed}`);

    console.log(`Skipped:            ${skipped}`);

    console.log(`Problems this run:  ${withProblems}`);

    console.log(`Problem PDFs total: ${finalOutput.length}`);

    console.log(`Output: ${PROBLEMS_FILE}`);
}

main().catch(error => {
    console.error('\nFATAL ERROR');

    console.error(error);

    process.exit(1);
});
