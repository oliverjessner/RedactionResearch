const state = {
    problems: [],
    filtered: [],
    reviewed: {},
    currentIndex: -1,
    saving: false,
    recoveredText: new Map(),
    recoveryRequest: 0,
    pdfFile: null,
    pdfLoadRequest: 0,
    pdfPage: 1,
    pdfPageCount: 0,
    pdfZoom: 1,
    pdfObserver: null,
    pdfScrollFrame: null,
};

const elements = Object.fromEntries(
    [
        'accept',
        'accepted-count',
        'affected-items',
        'decision-badge',
        'document-id',
        'document-findings',
        'document-findings-summary',
        'document-title',
        'empty-viewer',
        'evidence',
        'filename',
        'message',
        'next',
        'no-source',
        'open-documents-count',
        'open-pdf',
        'page',
        'pdf-loading',
        'pdf-page-count',
        'pdf-page-next',
        'pdf-page-number',
        'pdf-pages',
        'pdf-page-previous',
        'pdf-scroll',
        'pdf-zoom-in',
        'pdf-zoom-label',
        'pdf-zoom-out',
        'previous',
        'problem-counter',
        'problem-type',
        'progress-fill',
        'remaining-count',
        'recovered-status',
        'recovered-text',
        'review-content',
        'review-empty',
        'review-position',
        'risk-score',
        'severity',
        'severity-filter',
        'skip',
        'skipped-count',
        'source-url',
        'type-filter',
        'viewer-label',
        'viewer-page-findings',
    ].map(id => [id, document.getElementById(id)]),
);

function currentProblem() {
    return state.filtered[state.currentIndex] || null;
}

function reviewCounts() {
    const decisions = state.problems.map(problem => state.reviewed[problem.problem_id]).filter(Boolean);
    const accepted = decisions.filter(value => value === 'accepted').length;
    const skipped = decisions.filter(value => value === 'skipped').length;
    const openProblems = state.problems.filter(problem => !state.reviewed[problem.problem_id]);

    return {
        accepted,
        skipped,
        remaining: openProblems.length,
        openDocuments: new Set(openProblems.map(problem => problem.document_id)).size,
    };
}

function setMessage(text, kind = '') {
    elements.message.textContent = text;
    elements.message.className = `message ${kind}`.trim();
}

function setBusy(busy) {
    state.saving = busy;

    for (const id of ['accept', 'skip', 'previous', 'next']) {
        elements[id].disabled = busy || state.filtered.length === 0;
    }
}

function pdfUrl(problem) {
    const pageFragment = Number.isFinite(problem.page) && problem.page > 0 ? `#page=${problem.page}` : '';

    return `/pdf/${encodeURIComponent(problem.file)}${pageFragment}`;
}

function updatePdfControls() {
    const pageCount = state.pdfPageCount;

    elements['pdf-page-number'].value = state.pdfPage;
    elements['pdf-page-number'].max = pageCount || 1;
    elements['pdf-page-count'].textContent = pageCount || '–';
    elements['pdf-page-previous'].disabled = !pageCount || state.pdfPage <= 1;
    elements['pdf-page-next'].disabled = !pageCount || state.pdfPage >= pageCount;
    elements['pdf-zoom-label'].textContent = `${Math.round(state.pdfZoom * 100)}%`;
}

function setPdfLoading(message = 'PDF-Seite wird geladen …') {
    elements['pdf-loading'].textContent = message;
    elements['pdf-loading'].hidden = false;
}

function problemRegionCount(problem) {
    const regions = Array.isArray(problem.evidence?.regions) ? problem.evidence.regions.length : 0;
    const boundingBox = Array.isArray(problem.evidence?.bbox) ? 1 : 0;

    return regions || boundingBox || Number(problem.evidence?.affected_text_items) || 1;
}

function problemTypeLabel(type) {
    const labels = {
        ANNOTATION_OVERLAY_HIDES_LIVE_TEXT: 'Separate PDF-Annotation',
        DARK_ANNOTATION_OVER_LIVE_TEXT: 'Dunkle PDF-Annotation',
        DARK_PAGE_CONTENT_HIDES_LIVE_TEXT: 'Eingebrannter Seiteninhalt',
        LIVE_TEXT_NOT_VISIBLE_ON_WHITE_REGION: 'Unsichtbarer Text',
        REDACTION_ANNOTATION_WITH_LIVE_TEXT: 'PDF-Redaction-Annotation',
    };

    return labels[type] || type;
}

function problemsForDocument(problem) {
    return state.problems
        .filter(item => item.document_id === problem.document_id && !state.reviewed[item.problem_id])
        .sort((a, b) => (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER));
}

function updateViewerPageFindingSummary() {
    const problem = currentProblem();

    if (!problem) {
        elements['viewer-page-findings'].textContent = '';
        return;
    }

    const pageProblems = problemsForDocument(problem).filter(item => item.page === state.pdfPage);
    const regionCount = pageProblems.reduce((total, item) => total + problemRegionCount(item), 0);

    elements['viewer-page-findings'].textContent = regionCount
        ? `Seite ${state.pdfPage}: ${regionCount} Verdachtsregion${regionCount === 1 ? '' : 'en'}`
        : `Seite ${state.pdfPage}: kein technischer Fund`;
}

function renderDocumentFindings(problem) {
    const documentProblems = problemsForDocument(problem);
    const totalRegions = documentProblems.reduce((total, item) => total + problemRegionCount(item), 0);
    const affectedPages = new Set(documentProblems.map(item => item.page).filter(Number.isFinite));

    elements['document-findings-summary'].textContent =
        `${totalRegions} Verdachtsregion${totalRegions === 1 ? '' : 'en'} in ` +
        `${documentProblems.length} technischen Fund${documentProblems.length === 1 ? '' : 'en'} auf ` +
        `${affectedPages.size} Seite${affectedPages.size === 1 ? '' : 'n'}.`;
    elements['document-findings'].replaceChildren();

    for (const relatedProblem of documentProblems) {
        const button = document.createElement('button');
        const heading = document.createElement('strong');
        const type = document.createElement('span');
        const regionCount = problemRegionCount(relatedProblem);

        button.type = 'button';
        button.className = 'document-finding';
        button.classList.toggle('active', relatedProblem.problem_id === problem.problem_id);
        button.setAttribute('aria-current', relatedProblem.problem_id === problem.problem_id ? 'true' : 'false');
        heading.textContent =
            `Seite ${relatedProblem.page ?? 'dokumentweit'} · ` +
            `${regionCount} Region${regionCount === 1 ? '' : 'en'}`;
        type.textContent = problemTypeLabel(relatedProblem.type);
        button.append(heading, type);
        button.addEventListener('click', () => {
            const targetIndex = state.filtered.findIndex(item => item.problem_id === relatedProblem.problem_id);

            if (targetIndex < 0) {
                setMessage('Dieser Fund ist durch den aktuellen Filter ausgeblendet.', 'error');
                return;
            }

            state.currentIndex = targetIndex;
            setMessage('');
            renderProblem();
        });
        elements['document-findings'].append(button);
    }
}

function loadPdfPage(pageElement) {
    if (!state.pdfFile || !pageElement || pageElement.dataset.requested === 'true') return;

    const image = pageElement.querySelector('img');
    const status = pageElement.querySelector('.pdf-page-status');
    const pageNumber = Number(pageElement.dataset.page);
    const requestId = state.pdfLoadRequest;

    pageElement.dataset.requested = 'true';
    status.textContent = `Seite ${pageNumber} wird geladen …`;
    image.onload = () => {
        if (requestId !== state.pdfLoadRequest) return;

        image.hidden = false;
        status.hidden = true;

        if (pageNumber === state.pdfPage) {
            elements['pdf-loading'].hidden = true;
        }
    };
    image.onerror = () => {
        if (requestId !== state.pdfLoadRequest) return;

        status.textContent = `Seite ${pageNumber} konnte nicht dargestellt werden.`;
    };
    image.src =
        `/api/pdf-page?filename=${encodeURIComponent(state.pdfFile)}` +
        `&page=${pageNumber}&width=1800&request=${requestId}-${pageNumber}`;
}

function renderPdfDocument() {
    if (!state.pdfFile) return;

    const requestId = ++state.pdfLoadRequest;
    const fragment = document.createDocumentFragment();

    state.pdfObserver?.disconnect();
    elements['pdf-pages'].replaceChildren();
    elements['pdf-pages'].style.setProperty('--pdf-zoom', state.pdfZoom);
    setPdfLoading('PDF wird vorbereitet …');
    updatePdfControls();

    for (let pageNumber = 1; pageNumber <= state.pdfPageCount; pageNumber++) {
        const pageElement = document.createElement('section');
        const pageLabel = document.createElement('span');
        const image = document.createElement('img');
        const status = document.createElement('span');

        pageElement.className = 'pdf-page';
        pageElement.dataset.page = String(pageNumber);
        pageElement.setAttribute('aria-label', `PDF-Seite ${pageNumber}`);
        pageLabel.className = 'pdf-page-label';
        pageLabel.textContent = `Seite ${pageNumber}`;
        image.alt = `Gerenderte PDF-Seite ${pageNumber}`;
        image.draggable = false;
        image.hidden = true;
        status.className = 'pdf-page-status';
        status.textContent = `Seite ${pageNumber}`;
        pageElement.append(pageLabel, image, status);
        fragment.append(pageElement);
    }

    elements['pdf-pages'].append(fragment);

    if ('IntersectionObserver' in window) {
        state.pdfObserver = new IntersectionObserver(
            entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) loadPdfPage(entry.target);
                }
            },
            {
                root: elements['pdf-scroll'],
                rootMargin: '1000px 0px',
            },
        );

        for (const pageElement of elements['pdf-pages'].children) {
            state.pdfObserver.observe(pageElement);
        }
    } else {
        for (const pageElement of elements['pdf-pages'].children) {
            loadPdfPage(pageElement);
        }
    }

    const target = elements['pdf-pages'].querySelector(`[data-page="${state.pdfPage}"]`);

    loadPdfPage(target);
    window.requestAnimationFrame(() => {
        if (requestId !== state.pdfLoadRequest || !target) return;

        elements['pdf-scroll'].scrollTop = Math.max(0, target.offsetTop - 16);
    });
}

function loadPdf(problem) {
    const targetPage = Number.isInteger(problem.page) && problem.page > 0 ? problem.page : 1;

    state.pdfFile = problem.file;
    state.pdfPageCount = Number.isInteger(problem.page_count) && problem.page_count > 0 ? problem.page_count : targetPage;
    state.pdfPage = Math.min(targetPage, state.pdfPageCount);
    state.pdfZoom = 1;
    renderPdfDocument();
}

function changePdfPage(nextPage) {
    if (!state.pdfFile) return;

    const parsedPage = Number(nextPage);

    if (!Number.isInteger(parsedPage)) {
        updatePdfControls();
        return;
    }

    state.pdfPage = Math.min(Math.max(parsedPage, 1), state.pdfPageCount);
    const target = elements['pdf-pages'].querySelector(`[data-page="${state.pdfPage}"]`);

    loadPdfPage(target);
    elements['pdf-scroll'].scrollTo({
        top: Math.max(0, (target?.offsetTop || 0) - 16),
        behavior: 'smooth',
    });
    updatePdfControls();
}

function changePdfZoom(delta) {
    if (!state.pdfFile) return;

    state.pdfZoom = Math.min(Math.max(state.pdfZoom + delta, 0.5), 2.5);
    elements['pdf-pages'].style.setProperty('--pdf-zoom', state.pdfZoom);
    updatePdfControls();
}

function updateCurrentPdfPageFromScroll() {
    const scroller = elements['pdf-scroll'];
    const marker = scroller.scrollTop + Math.min(140, scroller.clientHeight / 3);
    let closestPage = state.pdfPage;

    for (const pageElement of elements['pdf-pages'].children) {
        if (pageElement.offsetTop <= marker) {
            closestPage = Number(pageElement.dataset.page);
        } else {
            break;
        }
    }

    if (closestPage !== state.pdfPage) {
        state.pdfPage = closestPage;
        updatePdfControls();
        updateViewerPageFindingSummary();
    }
}

function renderProgress() {
    const counts = reviewCounts();
    const problem = currentProblem();
    const filteredDocumentIds = [...new Set(state.filtered.map(item => item.document_id))];
    const documentIndex = problem ? filteredDocumentIds.indexOf(problem.document_id) : -1;
    const reviewedCount = counts.accepted + counts.skipped;
    const percentage = state.problems.length ? (reviewedCount / state.problems.length) * 100 : 0;

    elements['review-position'].textContent =
        `PDF ${documentIndex >= 0 ? documentIndex + 1 : '–'} / ${filteredDocumentIds.length} · ` +
        `Fund ${state.currentIndex >= 0 ? state.currentIndex + 1 : '–'} / ${state.filtered.length}`;
    elements['open-documents-count'].textContent = counts.openDocuments;
    elements['accepted-count'].textContent = counts.accepted;
    elements['skipped-count'].textContent = counts.skipped;
    elements['remaining-count'].textContent = counts.remaining;
    elements['progress-fill'].style.width = `${percentage}%`;
}

function renderDecision(problem) {
    const decision = state.reviewed[problem.problem_id];

    if (!decision) {
        elements['decision-badge'].hidden = true;
        return;
    }

    elements['decision-badge'].hidden = false;
    elements['decision-badge'].textContent = decision === 'accepted' ? 'Accepted' : 'Skipped';
    elements['decision-badge'].className = `decision-badge ${decision}`;
}

function formatRecoveredText(payload) {
    const populatedRegions = (payload.regions || []).filter(region => region.text);

    return populatedRegions
        .map((region, index) => {
            const coordinates = Array.isArray(region.bbox) ? region.bbox.join(', ') : 'unbekannt';

            return `Region ${index + 1} [${coordinates}]\n${region.text}`;
        })
        .join('\n\n');
}

async function renderRecoveredText(problem) {
    const requestId = ++state.recoveryRequest;
    const cached = state.recoveredText.get(problem.problem_id);

    elements['recovered-text'].hidden = true;
    elements['recovered-text'].textContent = '';
    elements['recovered-status'].hidden = false;
    elements['recovered-status'].textContent = 'Text wird lokal aus der markierten PDF-Region gelesen …';

    try {
        let payload = cached;

        if (!payload) {
            const response = await fetch(`/api/recovered-text?problem_id=${encodeURIComponent(problem.problem_id)}`);
            payload = await response.json();

            if (!response.ok) {
                throw new Error(payload.error || 'Text konnte nicht rekonstruiert werden');
            }

            state.recoveredText.set(problem.problem_id, payload);
        }

        if (requestId !== state.recoveryRequest || currentProblem()?.problem_id !== problem.problem_id) {
            return;
        }

        const recovered = formatRecoveredText(payload);

        if (!payload.available) {
            elements['recovered-status'].textContent = payload.reason || 'Für diesen Fund ist keine Textextraktion möglich.';
        } else if (!recovered) {
            elements['recovered-status'].textContent = 'In der markierten Region wurde kein maschinenlesbarer Text gefunden.';
        } else {
            elements['recovered-status'].hidden = true;
            elements['recovered-text'].hidden = false;
            elements['recovered-text'].textContent = recovered;
        }
    } catch (error) {
        if (requestId === state.recoveryRequest) {
            elements['recovered-status'].textContent = error.message;
        }
    }
}

function renderProblem() {
    const problem = currentProblem();

    renderProgress();

    if (!problem) {
        const allReviewed = state.problems.length > 0 && reviewCounts().remaining === 0;

        elements['review-content'].hidden = true;
        elements['review-empty'].hidden = false;
        elements['review-empty'].innerHTML = allReviewed
            ? '<strong>Alle Verdachtsfälle geprüft</strong><p>Es sind keine offenen Funde mehr vorhanden.</p>'
            : '<strong>Keine offenen Fälle in diesem Filter</strong><p>Wähle einen anderen Filter oder prüfe den Datenbestand.</p>';
        elements['empty-viewer'].hidden = false;
        elements['empty-viewer'].innerHTML = '<p>Kein PDF ausgewählt.</p>';
        state.pdfObserver?.disconnect();
        elements['pdf-pages'].replaceChildren();
        elements['pdf-loading'].hidden = true;
        elements['open-pdf'].hidden = true;
        elements['viewer-page-findings'].textContent = '';
        setBusy(false);
        return;
    }

    elements['review-empty'].hidden = true;
    elements['review-content'].hidden = false;
    elements['empty-viewer'].hidden = true;

    const url = pdfUrl(problem);
    const documentProblems = state.problems.filter(item => item.document_id === problem.document_id);
    const documentProblemIndex = documentProblems.findIndex(item => item.problem_id === problem.problem_id);

    elements['open-pdf'].href = url;
    elements['open-pdf'].hidden = false;
    elements['viewer-label'].textContent = `${problem.file}${problem.page ? ` · Seite ${problem.page}` : ''}`;
    elements['problem-counter'].textContent =
        `Problem ${documentProblemIndex + 1} von ${documentProblems.length}` +
        ` · Fall ${state.currentIndex + 1} von ${state.filtered.length}`;
    elements['document-title'].textContent = problem.title || 'Ohne Titel';
    elements['filename'].textContent = problem.file;
    elements['document-id'].textContent = problem.document_id;
    elements.page.textContent = problem.page ?? 'Dokumentweit';
    elements['problem-type'].textContent = problem.type;
    elements['risk-score'].textContent = problem.risk_score;
    elements['risk-score'].className = `risk-score score-${problem.severity}`;
    elements.severity.textContent = problem.severity.toUpperCase();
    elements['affected-items'].textContent = problem.evidence?.affected_text_items ?? '–';
    elements.evidence.textContent = JSON.stringify(problem.evidence || {}, null, 2);
    renderDocumentFindings(problem);

    if (problem.source_url) {
        elements['source-url'].href = problem.source_url;
        elements['source-url'].hidden = false;
        elements['no-source'].hidden = true;
    } else {
        elements['source-url'].hidden = true;
        elements['no-source'].hidden = false;
    }

    renderDecision(problem);
    renderRecoveredText(problem);
    loadPdf(problem);
    updateViewerPageFindingSummary();
    setBusy(false);
}

function applyFilters({ preserveProblemId = null, preferUnreviewed = false } = {}) {
    const severity = elements['severity-filter'].value;
    const type = elements['type-filter'].value;

    state.filtered = state.problems.filter(problem => {
        const severityMatches = severity === 'all' || problem.severity === severity;
        const typeMatches = type === 'all' || problem.type === type;
        const isUnreviewed = !state.reviewed[problem.problem_id];

        return severityMatches && typeMatches && isUnreviewed;
    });

    let nextIndex = preserveProblemId
        ? state.filtered.findIndex(problem => problem.problem_id === preserveProblemId)
        : -1;

    if (nextIndex < 0 && preferUnreviewed) {
        nextIndex = state.filtered.findIndex(problem => !state.reviewed[problem.problem_id]);
    }

    state.currentIndex = nextIndex >= 0 ? nextIndex : state.filtered.length ? 0 : -1;
    renderProblem();
}

function populateTypeFilter() {
    const types = [...new Set(state.problems.map(problem => problem.type))].sort();

    for (const type of types) {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type;
        elements['type-filter'].append(option);
    }
}

function move(direction) {
    if (state.saving || state.filtered.length === 0) return;

    state.currentIndex = Math.min(Math.max(state.currentIndex + direction, 0), state.filtered.length - 1);
    setMessage('');
    renderProblem();
}

function removeReviewedAndAdvance(problemId) {
    const previousIndex = state.filtered.findIndex(problem => problem.problem_id === problemId);

    state.filtered = state.filtered.filter(problem => problem.problem_id !== problemId);
    state.currentIndex = state.filtered.length ? Math.min(Math.max(previousIndex, 0), state.filtered.length - 1) : -1;
    renderProblem();

    if (state.filtered.length === 0) {
        setMessage('Alle Fälle in diesem Filter wurden geprüft.', 'success');
    }
}

async function saveDecision(decision) {
    const problem = currentProblem();

    if (!problem || state.saving) return;

    setBusy(true);
    setMessage(decision === 'accept' ? 'Bestätigung wird gespeichert …' : 'Skip wird gespeichert …');

    try {
        const response = await fetch('/api/review', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                problem_id: problem.problem_id,
                decision,
            }),
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Review konnte nicht gespeichert werden');
        }

        state.reviewed[problem.problem_id] = result.decision;
        setMessage(result.decision === 'accepted' ? 'Als tatsächlicher Fehler bestätigt.' : 'Als nicht relevant übersprungen.', 'success');
        removeReviewedAndAdvance(problem.problem_id);
    } catch (error) {
        setBusy(false);
        setMessage(error.message, 'error');
    }
}

async function initialize() {
    try {
        const [problemsResponse, progressResponse] = await Promise.all([fetch('/api/problems'), fetch('/api/progress')]);

        if (!problemsResponse.ok || !progressResponse.ok) {
            throw new Error('Review-Daten konnten nicht geladen werden');
        }

        const problemsPayload = await problemsResponse.json();
        const progressPayload = await progressResponse.json();

        state.problems = Array.isArray(problemsPayload.problems) ? problemsPayload.problems : [];
        state.reviewed = progressPayload.reviewed && typeof progressPayload.reviewed === 'object' ? progressPayload.reviewed : {};

        populateTypeFilter();
        applyFilters({ preferUnreviewed: true });
        setMessage(state.problems.length ? '' : 'Keine Verdachtsfälle gefunden.');
    } catch (error) {
        elements['review-empty'].innerHTML = `<strong>Fehler beim Laden</strong><p>${error.message}</p>`;
        elements['empty-viewer'].innerHTML = '<p>PDF-Viewer nicht verfügbar.</p>';
        setMessage(error.message, 'error');
        setBusy(false);
    }
}

elements.previous.addEventListener('click', () => move(-1));
elements.next.addEventListener('click', () => move(1));
elements.skip.addEventListener('click', () => saveDecision('skip'));
elements.accept.addEventListener('click', () => saveDecision('accept'));
elements['pdf-page-previous'].addEventListener('click', () => changePdfPage(state.pdfPage - 1));
elements['pdf-page-next'].addEventListener('click', () => changePdfPage(state.pdfPage + 1));
elements['pdf-page-number'].addEventListener('change', event => changePdfPage(event.target.value));
elements['pdf-zoom-out'].addEventListener('click', () => changePdfZoom(-0.25));
elements['pdf-zoom-in'].addEventListener('click', () => changePdfZoom(0.25));
elements['pdf-scroll'].addEventListener('scroll', () => {
    if (state.pdfScrollFrame !== null) return;

    state.pdfScrollFrame = window.requestAnimationFrame(() => {
        state.pdfScrollFrame = null;
        updateCurrentPdfPageFromScroll();
    });
});

for (const filter of [elements['severity-filter'], elements['type-filter']]) {
    filter.addEventListener('change', () => applyFilters({ preferUnreviewed: true }));
}

document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) {
        return;
    }

    if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        saveDecision('accept');
    } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveDecision('skip');
    } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        move(-1);
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        move(1);
    }
});

initialize();
