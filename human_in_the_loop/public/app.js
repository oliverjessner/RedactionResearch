const state = {
    problems: [],
    filtered: [],
    reviewed: {},
    currentIndex: -1,
    saving: false,
};

const elements = Object.fromEntries(
    [
        'accept',
        'accepted-count',
        'affected-items',
        'decision-badge',
        'document-id',
        'document-title',
        'empty-viewer',
        'evidence',
        'filename',
        'message',
        'next',
        'no-source',
        'open-pdf',
        'page',
        'pdf-viewer',
        'previous',
        'problem-counter',
        'problem-type',
        'progress-fill',
        'remaining-count',
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
    ].map(id => [id, document.getElementById(id)]),
);

function currentProblem() {
    return state.filtered[state.currentIndex] || null;
}

function reviewCounts() {
    const decisions = Object.values(state.reviewed);
    const accepted = decisions.filter(value => value === 'accepted').length;
    const skipped = decisions.filter(value => value === 'skipped').length;

    return {
        accepted,
        skipped,
        remaining: Math.max(0, state.problems.length - accepted - skipped),
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

function renderProgress() {
    const counts = reviewCounts();
    const problem = currentProblem();
    const overallIndex = problem ? state.problems.findIndex(item => item.problem_id === problem.problem_id) : -1;
    const reviewedCount = counts.accepted + counts.skipped;
    const percentage = state.problems.length ? (reviewedCount / state.problems.length) * 100 : 0;

    elements['review-position'].textContent = `Review ${overallIndex >= 0 ? overallIndex + 1 : '–'} / ${state.problems.length}`;
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

function renderProblem() {
    const problem = currentProblem();

    renderProgress();

    if (!problem) {
        elements['review-content'].hidden = true;
        elements['review-empty'].hidden = false;
        elements['review-empty'].innerHTML =
            '<strong>Keine Fälle in diesem Filter</strong><p>Wähle einen anderen Filter oder prüfe den Datenbestand.</p>';
        elements['empty-viewer'].hidden = false;
        elements['empty-viewer'].innerHTML = '<p>Kein PDF ausgewählt.</p>';
        elements['pdf-viewer'].removeAttribute('src');
        elements['open-pdf'].hidden = true;
        setBusy(false);
        return;
    }

    elements['review-empty'].hidden = true;
    elements['review-content'].hidden = false;
    elements['empty-viewer'].hidden = true;

    const url = pdfUrl(problem);
    const documentProblems = state.problems.filter(item => item.document_id === problem.document_id);
    const documentProblemIndex = documentProblems.findIndex(item => item.problem_id === problem.problem_id);

    if (elements['pdf-viewer'].dataset.problemId !== problem.problem_id) {
        elements['pdf-viewer'].src = url;
        elements['pdf-viewer'].dataset.problemId = problem.problem_id;
    }

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

    if (problem.source_url) {
        elements['source-url'].href = problem.source_url;
        elements['source-url'].hidden = false;
        elements['no-source'].hidden = true;
    } else {
        elements['source-url'].hidden = true;
        elements['no-source'].hidden = false;
    }

    renderDecision(problem);
    setBusy(false);
}

function applyFilters({ preserveProblemId = null, preferUnreviewed = false } = {}) {
    const severity = elements['severity-filter'].value;
    const type = elements['type-filter'].value;

    state.filtered = state.problems.filter(problem => {
        const severityMatches = severity === 'all' || problem.severity === severity;
        const typeMatches = type === 'all' || problem.type === type;

        return severityMatches && typeMatches;
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

function moveToNextUnreviewed(previousProblemId) {
    if (state.filtered.length === 0) return;

    const previousIndex = state.filtered.findIndex(problem => problem.problem_id === previousProblemId);

    for (let offset = 1; offset <= state.filtered.length; offset++) {
        const index = (Math.max(previousIndex, 0) + offset) % state.filtered.length;

        if (!state.reviewed[state.filtered[index].problem_id]) {
            state.currentIndex = index;
            renderProblem();
            return;
        }
    }

    state.currentIndex = Math.max(previousIndex, 0);
    renderProblem();
    setMessage('Alle Fälle in diesem Filter wurden geprüft.', 'success');
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
        moveToNextUnreviewed(problem.problem_id);
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
