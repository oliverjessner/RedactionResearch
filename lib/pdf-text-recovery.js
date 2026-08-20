const FORENSIC_RENDER_SCALE = 1.5;

function normalizeRegion(value) {
    if (!Array.isArray(value) || value.length !== 4) {
        return null;
    }

    const coordinates = value.map(Number);

    if (!coordinates.every(Number.isFinite)) {
        return null;
    }

    return {
        x0: Math.min(coordinates[0], coordinates[2]),
        y0: Math.min(coordinates[1], coordinates[3]),
        x1: Math.max(coordinates[0], coordinates[2]),
        y1: Math.max(coordinates[1], coordinates[3]),
        bbox: coordinates,
    };
}

function intersects(a, b) {
    return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}

function nearHorizontal(angle) {
    let normalized = Math.abs(angle % Math.PI);

    if (normalized > Math.PI / 2) {
        normalized = Math.PI - normalized;
    }

    return normalized < 0.18;
}

function textItemToRect(item, viewport, Util) {
    if (!item || typeof item.str !== 'string' || !item.str.trim() || !Array.isArray(item.transform)) {
        return null;
    }

    const transform = Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(transform[1], transform[0]);

    if (!nearHorizontal(angle)) {
        return null;
    }

    const height = Math.max(Math.abs(item.height || 0) * viewport.scale, Math.hypot(transform[2], transform[3]));
    const width = Math.abs(item.width || 0) * viewport.scale;

    if (width <= 0 || height <= 0) {
        return null;
    }

    let x0 = transform[4];

    if (Math.cos(angle) < 0) {
        x0 -= width;
    }

    return {
        x0,
        y0: transform[5] - height,
        x1: x0 + width,
        y1: transform[5],
        text: item.str.replace(/\s+/g, ' ').trim(),
    };
}

function problemRegions(problem) {
    const rawRegions = Array.isArray(problem.evidence?.regions) ? [...problem.evidence.regions] : [];

    if (Array.isArray(problem.evidence?.bbox)) {
        rawRegions.push(problem.evidence.bbox);
    }

    return rawRegions.map(normalizeRegion).filter(Boolean);
}

function recoverProblemRegions(problem, textItems) {
    return problemRegions(problem).map(region => {
        const matchingItems = textItems.filter(item => intersects(region, item));
        const text = matchingItems
            .map(item => item.text)
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        return {
            bbox: region.bbox,
            text,
            text_item_count: matchingItems.length,
        };
    });
}

function combineRecoveredText(regions) {
    return regions
        .map(region => region.text)
        .filter(Boolean)
        .join('\n');
}

function classifyRecoveredText(value) {
    const text = typeof value === 'string' ? value : '';
    const compact = text.replace(/\s/gu, '');

    if (/\p{L}|\p{N}/u.test(text)) return 'alphanumeric';
    if (compact && /^_+$/u.test(compact)) return 'underscores_only';
    if (!compact) return 'empty';
    return 'symbols_only';
}

module.exports = {
    FORENSIC_RENDER_SCALE,
    classifyRecoveredText,
    combineRecoveredText,
    problemRegions,
    recoverProblemRegions,
    textItemToRect,
};
