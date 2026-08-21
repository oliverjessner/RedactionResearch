const state = {
    view: 'projects',
    projects: [],
    activeProject: null,
    projectPollTimer: null,
    newProjectFiles: [],
    uploadTargetProject: null,
    foundDetail: false,
    problems: [],
    filtered: [],
    reviewed: {},
    currentIndex: -1,
    saving: false,
    recoveredText: new Map(),
    recoveryRequest: 0,
    metadataCache: new Map(),
    metadataRequest: 0,
    pdfFile: null,
    pdfLoadRequest: 0,
    pdfPage: 1,
    pdfPageCount: 0,
    pdfZoom: 1,
    pdfObserver: null,
    pdfResizeObserver: null,
    pdfScrollFrame: null,
    coordinateBox: null,
};

const PDF_RENDER_WIDTH = 1500;

const elements = Object.fromEntries(
    [
        'accept',
        'accepted-count',
        'affected-items',
        'coordinate-clear',
        'coordinate-form',
        'coordinate-input',
        'decision-badge',
        'document-id',
        'document-findings',
        'document-title',
        'empty-viewer',
        'evidence',
        'filename',
        'found-back',
        'found-documents',
        'found-empty',
        'found-overview',
        'found-overview-summary',
        'message',
        'metadata-content',
        'metadata-section',
        'metadata-status',
        'next',
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
        'problem-documents-count',
        'progress-block',
        'filters',
        'organization-input',
        'project-create',
        'project-folder-button',
        'project-folder-input',
        'project-folder-status',
        'project-form',
        'project-input',
        'project-list',
        'project-message',
        'project-upload-input',
        'projects-empty',
        'projects-overview',
        'project-detail',
        'project-name',
        'recovered-status',
        'recovered-text',
        'remaining-count',
        'review-content',
        'review-empty',
        'review-actions',
        'review-panel',
        'risk-score',
        'severity',
        'severity-filter',
        'skip',
        'skipped-count',
        'type-filter',
        'viewer-label',
        'viewer-page-findings',
        'view-found',
        'view-investigate',
        'view-projects',
        'viewer-panel',
        'workspace',
    ].map(id => [id, document.getElementById(id)]),
);

function currentProblem() {
    return state.filtered[state.currentIndex] || null;
}

function problemMatchesView(problem) {
    const decision = state.reviewed[problem.problem_id];

    return state.view === 'found' ? decision === 'accepted' : !decision;
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
        totalDocuments: new Set(state.problems.map(problem => problem.document_id)).size,
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

function setProjectMessage(text, kind = '') {
    elements['project-message'].textContent = text;
    elements['project-message'].className = `project-message ${kind}`.trim();
}

async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(payload.error || `Anfrage fehlgeschlagen (${response.status})`);

    return payload;
}

function projectJobText(job) {
    if (!job) return 'Noch kein Import oder Scan gestartet.';

    const kind = job.kind === 'import' ? 'Import' : 'Forensic-Scan';
    const statusLabels = {
        queued: 'wartet',
        running: 'läuft',
        completed: 'abgeschlossen',
        failed: 'fehlgeschlagen',
    };
    const progress = job.total_count > 0 ? ` · ${job.processed_count}/${job.total_count}` : '';
    const detail = job.error_message || job.message;

    return `${kind} ${statusLabels[job.status] || job.status}${progress}${detail ? ` · ${detail}` : ''}`;
}

function projectAction(label, className, disabled, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button ${className}`;
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', handler);
    return button;
}

function selectedPdfFiles(fileList) {
    return [...(fileList || [])].filter(file => file.name.toLowerCase().endsWith('.pdf'));
}

function folderSelectionText(files) {
    if (files.length === 0) return 'Keine PDFs im Ordner gefunden';

    const relativePath = files[0].webkitRelativePath || '';
    const folderName = relativePath.includes('/') ? relativePath.split('/')[0] : null;
    const count = `${files.length} PDF${files.length === 1 ? '' : 's'}`;

    return folderName ? `${folderName} · ${count}` : count;
}

function openProjectUploadDialog(project) {
    state.uploadTargetProject = project;
    elements['project-upload-input'].value = '';
    elements['project-upload-input'].click();
}

async function removeProject(project) {
    const confirmed = window.confirm(
        `Projekt „${project.project}“ und alle zugehörigen Analyse- und Review-Daten aus SQLite löschen?\n\nDie PDF-Dateien bleiben erhalten.`,
    );

    if (!confirmed) return;

    setProjectMessage(`Projekt ${project.project} wird gelöscht …`);

    try {
        await fetchJson(`/api/projects/${project.id}`, { method: 'DELETE' });

        if (state.activeProject?.id === project.id) {
            state.activeProject = null;
            state.problems = [];
            state.reviewed = {};
            state.filtered = [];
            state.currentIndex = -1;
        }

        await refreshProjects();
        setProjectMessage(`Projekt ${project.project} wurde aus SQLite gelöscht.`, 'success');
    } catch (error) {
        setProjectMessage(error.message, 'error');
    }
}

async function uploadFilesToProject(project, files) {
    const pdfFiles = selectedPdfFiles(files);

    if (pdfFiles.length === 0) throw new Error('Der ausgewählte Ordner enthält keine PDFs.');

    const startPayload = await fetchJson(`/api/projects/${project.id}/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ total_count: pdfFiles.length }),
    });
    const jobId = startPayload.job.id;
    let nextIndex = 0;
    let completed = 0;
    let failed = 0;

    await refreshProjects();

    async function uploadWorker() {
        while (nextIndex < pdfFiles.length) {
            const file = pdfFiles[nextIndex++];

            try {
                await fetchJson(
                    `/api/projects/${project.id}/uploads/${jobId}?filename=${encodeURIComponent(file.name)}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/pdf' },
                        body: file,
                    },
                );
            } catch {
                failed++;
            }

            completed++;
            setProjectMessage(`${completed} von ${pdfFiles.length} PDFs werden importiert …`);
        }
    }

    const workerCount = Math.min(3, pdfFiles.length);
    await Promise.all(Array.from({ length: workerCount }, () => uploadWorker()));
    await fetchJson(`/api/projects/${project.id}/uploads/${jobId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error_count: failed }),
    });
    await refreshProjects();

    if (failed > 0) {
        setProjectMessage(`${pdfFiles.length - failed} PDFs importiert, ${failed} fehlgeschlagen.`, 'error');
    } else {
        setProjectMessage(`${pdfFiles.length} PDFs wurden lokal importiert.`, 'success');
    }
}

function renderProjects() {
    elements['project-list'].replaceChildren();
    elements['projects-empty'].hidden = state.projects.length > 0;

    for (const project of state.projects) {
        const card = document.createElement('article');
        const heading = document.createElement('div');
        const headingText = document.createElement('div');
        const title = document.createElement('h3');
        const organization = document.createElement('p');
        const id = document.createElement('span');
        const source = document.createElement('p');
        const stats = document.createElement('div');
        const job = document.createElement('div');
        const actions = document.createElement('div');
        const activeJob = ['queued', 'running'].includes(project.latest_job?.status);
        const statValues = [
            ['PDFs', project.pdf_count],
            ['Problem-PDFs', project.problem_documents],
            ['Bestätigt', project.accepted],
            ['Offen', project.open],
        ];

        card.className = 'project-card';
        heading.className = 'project-card-heading';
        title.textContent = project.project;
        organization.textContent = project.organization || 'Organisation nicht angegeben';
        id.className = 'project-id';
        id.textContent = `ID ${project.id}`;
        headingText.append(title, organization);
        heading.append(headingText, id);
        source.className = 'project-source';
        source.textContent = project.source_location
            ? `PDF-Quelle: ${project.source_location}`
            : project.source_type === 'browser-upload'
              ? 'PDF-Quelle: über lokalen Ordnerdialog importiert'
              : 'PDF-Quelle: verwalteter Projektordner';
        stats.className = 'project-stats';

        for (const [label, value] of statValues) {
            const stat = document.createElement('div');
            const number = document.createElement('b');
            const caption = document.createElement('span');
            stat.className = 'project-stat';
            number.textContent = value;
            caption.textContent = label;
            stat.append(number, caption);
            stats.append(stat);
        }

        job.className = `project-job ${project.latest_job?.status || ''}`.trim();
        job.textContent = projectJobText(project.latest_job);
        actions.className = 'project-actions';
        actions.append(
            projectAction('Review öffnen', 'button-secondary', false, () => loadProjectReview(project)),
            projectAction('PDFs hinzufügen', 'button-secondary', activeJob, () =>
                openProjectUploadDialog(project),
            ),
            projectAction('Forensic-Run', 'button-accept', activeJob || project.pdf_count === 0, () =>
                startProjectJob(project, 'scan'),
            ),
            projectAction('Projekt löschen', 'button-danger', activeJob, () => removeProject(project)),
        );
        card.append(heading, source, stats, job, actions);
        elements['project-list'].append(card);
    }
}

function scheduleProjectPolling() {
    window.clearTimeout(state.projectPollTimer);
    state.projectPollTimer = null;

    if (!state.projects.some(project => ['queued', 'running'].includes(project.latest_job?.status))) return;

    state.projectPollTimer = window.setTimeout(async () => {
        try {
            await refreshProjects();
        } catch (error) {
            setProjectMessage(error.message, 'error');
        } finally {
            scheduleProjectPolling();
        }
    }, 1500);
}

async function refreshProjects() {
    const payload = await fetchJson('/api/projects');
    state.projects = Array.isArray(payload.projects) ? payload.projects : [];

    if (state.activeProject) {
        state.activeProject = state.projects.find(project => project.id === state.activeProject.id) || null;
    }

    renderProjects();
}

async function startProjectJob(project, kind) {
    setProjectMessage(kind === 'import' ? 'Import wird gestartet …' : 'Forensic-Run wird gestartet …');

    try {
        await fetchJson(`/api/projects/${project.id}/${kind}`, { method: 'POST' });
        await refreshProjects();
        scheduleProjectPolling();
        setProjectMessage(kind === 'import' ? 'Import läuft im Hintergrund.' : 'Forensic-Scan läuft im Hintergrund.', 'success');
    } catch (error) {
        setProjectMessage(error.message, 'error');
    }
}

async function loadProjectReview(project, view = 'investigate') {
    setProjectMessage(`Projekt ${project.project} wird geöffnet …`);

    try {
        const query = `project_id=${encodeURIComponent(project.id)}`;
        const [problemsPayload, progressPayload] = await Promise.all([
            fetchJson(`/api/problems?${query}`),
            fetchJson(`/api/progress?${query}`),
        ]);

        state.activeProject = project;
        state.problems = Array.isArray(problemsPayload.problems) ? problemsPayload.problems : [];
        state.reviewed = progressPayload.reviewed && typeof progressPayload.reviewed === 'object' ? progressPayload.reviewed : {};
        state.recoveredText.clear();
        state.metadataCache.clear();
        state.view = view;
        state.foundDetail = false;
        elements['severity-filter'].value = 'all';
        elements['type-filter'].value = 'all';
        populateTypeFilter();
        setProjectMessage('');
        setMessage(state.problems.length ? '' : 'Für dieses Projekt wurden noch keine Verdachtsfälle gefunden.');
        applyFilters();
    } catch (error) {
        setProjectMessage(error.message, 'error');
    }
}

function renderViewControls() {
    const projectsView = state.view === 'projects';
    const foundView = state.view === 'found';
    const foundOverview = foundView && !state.foundDetail;

    elements['view-projects'].classList.toggle('active', projectsView);
    elements['view-projects'].setAttribute('aria-selected', String(projectsView));
    elements['view-investigate'].classList.toggle('active', state.view === 'investigate');
    elements['view-investigate'].setAttribute('aria-selected', String(state.view === 'investigate'));
    elements['view-found'].classList.toggle('active', foundView);
    elements['view-found'].setAttribute('aria-selected', String(foundView));
    elements['projects-overview'].hidden = !projectsView;
    elements['progress-block'].hidden = projectsView;
    elements.filters.hidden = projectsView;
    elements.accept.hidden = foundView || projectsView;
    elements.skip.hidden = foundView || projectsView;
    elements['found-back'].hidden = !foundView || foundOverview;
    elements['found-overview'].hidden = !foundOverview;
    elements['viewer-panel'].hidden = projectsView || foundOverview;
    elements['review-panel'].hidden = projectsView || foundOverview;
    elements['project-detail'].hidden = !foundView;
    elements['review-actions'].classList.toggle('found-view', foundView);
}

function foundDocumentGroups() {
    const groups = new Map();

    for (const problem of state.filtered) {
        const key = `${problem.project}\u0000${problem.document_id}\u0000${problem.file}`;
        const existing = groups.get(key);

        if (existing) {
            existing.problems.push(problem);
            if (problem.risk_score > existing.maxScore) {
                existing.maxScore = problem.risk_score;
                existing.severity = problem.severity;
            }
        } else {
            groups.set(key, {
                documentId: problem.document_id,
                file: problem.file,
                project: problem.project || 'Ohne Projekt',
                title: problem.title || 'Ohne Titel',
                maxScore: problem.risk_score,
                severity: problem.severity,
                problems: [problem],
            });
        }
    }

    return [...groups.values()].sort(
        (a, b) => b.maxScore - a.maxScore || a.file.localeCompare(b.file, 'de'),
    );
}

function renderFoundOverview() {
    const groups = foundDocumentGroups();

    renderViewControls();
    renderProgress();
    elements['found-documents'].replaceChildren();
    elements['found-overview-summary'].textContent =
        `${groups.length} Dokument${groups.length === 1 ? '' : 'e'} · ` +
        `${state.filtered.length} bestätigte${state.filtered.length === 1 ? 'r Fund' : ' Funde'}`;
    elements['found-empty'].hidden = groups.length > 0;

    for (const group of groups) {
        const card = document.createElement('button');
        const heading = document.createElement('span');
        const project = document.createElement('span');
        const title = document.createElement('strong');
        const filename = document.createElement('span');
        const metadata = document.createElement('span');
        const score = document.createElement('span');
        const pages = [...new Set(group.problems.map(problem => problem.page).filter(Number.isInteger))].sort(
            (a, b) => a - b,
        );
        const pageLabel = pages.length
            ? `Seite${pages.length === 1 ? '' : 'n'} ${pages.join(', ')}`
            : 'Dokumentweiter Fund';

        card.type = 'button';
        card.className = 'found-document';
        card.setAttribute('aria-label', `${group.title} ansehen`);
        heading.className = 'found-document-heading';
        project.className = 'found-document-project';
        project.textContent = group.project;
        title.textContent = group.title;
        filename.textContent = group.file;
        metadata.className = 'found-document-metadata';
        metadata.textContent =
            `${group.problems.length} bestätigte${group.problems.length === 1 ? 'r Fund' : ' Funde'} · ${pageLabel}`;
        score.className = `found-document-score score-${group.severity}`;
        score.textContent = `Score ${group.maxScore}`;
        heading.append(project, title, filename);
        card.append(heading, metadata, score);
        card.addEventListener('click', () => {
            const targetIndex = state.filtered.findIndex(
                problem => problem.problem_id === group.problems[0].problem_id,
            );

            if (targetIndex < 0) return;

            state.currentIndex = targetIndex;
            state.foundDetail = true;
            renderProblem({ preservePdf: state.pdfFile === group.file });
        });
        elements['found-documents'].append(card);
    }
}

function showFoundOverview() {
    if (state.view !== 'found') return;

    state.foundDetail = false;
    state.currentIndex = -1;
    setMessage('');
    renderFoundOverview();
}

function pdfUrl(problem) {
    const pageFragment = Number.isFinite(problem.page) && problem.page > 0 ? `#page=${problem.page}` : '';

    return `/pdf/${encodeURIComponent(problem.file)}?project_id=${encodeURIComponent(state.activeProject.id)}${pageFragment}`;
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

function parseCoordinateBox(value) {
    const trimmed = value.trim();

    if (!trimmed) return null;

    try {
        const parsed = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split(',').map(item => item.trim());

        if (!Array.isArray(parsed) || parsed.length !== 4) return null;

        const coordinates = parsed.map(Number);

        if (!coordinates.every(Number.isFinite)) return null;

        const [x0, y0, x1, y1] = coordinates;

        if (x0 === x1 || y0 === y1) return null;

        return coordinates;
    } catch {
        return null;
    }
}

function renderCoordinateBox(pageElement) {
    const overlay = pageElement?.querySelector('.pdf-coordinate-overlay');

    if (!overlay) return;

    overlay.replaceChildren();

    if (!state.coordinateBox || Number(pageElement.dataset.page) !== state.coordinateBox.page) return;

    const coordinateWidth = Number(pageElement.dataset.coordinateWidth);
    const coordinateHeight = Number(pageElement.dataset.coordinateHeight);

    if (!coordinateWidth || !coordinateHeight) return;

    const [firstX, firstY, secondX, secondY] = state.coordinateBox.coordinates;
    const x0 = Math.min(firstX, secondX);
    const y0 = Math.min(firstY, secondY);
    const x1 = Math.max(firstX, secondX);
    const y1 = Math.max(firstY, secondY);

    if (x0 < 0 || y0 < 0 || x1 > coordinateWidth || y1 > coordinateHeight) {
        elements['coordinate-input'].setCustomValidity(
            `Die Koordinaten müssen innerhalb von 0–${coordinateWidth.toFixed(2)} × 0–${coordinateHeight.toFixed(2)} liegen.`,
        );
        elements['coordinate-input'].reportValidity();
        return;
    }

    elements['coordinate-input'].setCustomValidity('');

    const box = document.createElement('div');
    box.className = 'pdf-coordinate-box';
    box.style.left = `${(x0 / coordinateWidth) * 100}%`;
    box.style.top = `${(y0 / coordinateHeight) * 100}%`;
    box.style.width = `${((x1 - x0) / coordinateWidth) * 100}%`;
    box.style.height = `${((y1 - y0) / coordinateHeight) * 100}%`;
    box.setAttribute('aria-hidden', 'true');
    overlay.append(box);
}

function clearCoordinateBox({ clearInput = true } = {}) {
    state.coordinateBox = null;

    for (const pageElement of elements['pdf-pages'].children) {
        renderCoordinateBox(pageElement);
    }

    if (clearInput) elements['coordinate-input'].value = '';
    elements['coordinate-input'].setCustomValidity('');
    elements['coordinate-clear'].disabled = true;
}

function drawCoordinateBox() {
    const coordinates = parseCoordinateBox(elements['coordinate-input'].value);

    if (!coordinates) {
        elements['coordinate-input'].setCustomValidity('Bitte vier Zahlen eingeben, zum Beispiel [51.02, 373.88, 140.66, 388.13].');
        elements['coordinate-input'].reportValidity();
        return;
    }

    if (!state.pdfFile || !state.pdfPage) {
        elements['coordinate-input'].setCustomValidity('Zuerst ein PDF und eine Seite auswählen.');
        elements['coordinate-input'].reportValidity();
        return;
    }

    elements['coordinate-input'].setCustomValidity('');
    state.coordinateBox = {
        page: state.pdfPage,
        coordinates,
    };
    elements['coordinate-clear'].disabled = false;

    const pageElement = elements['pdf-pages'].querySelector(`[data-page="${state.pdfPage}"]`);
    loadPdfPage(pageElement);
    renderCoordinateBox(pageElement);
}

function fitPdfTextLayer(pageElement) {
    const layer = pageElement?.querySelector('.pdf-text-layer');
    const sourceWidth = Number(layer?.dataset.sourceWidth);

    if (!layer || !sourceWidth || !pageElement.clientWidth) return;

    layer.style.transform = `scale(${pageElement.clientWidth / sourceWidth})`;
}

async function loadPdfTextLayer(pageElement, pageNumber, requestId) {
    const layer = pageElement.querySelector('.pdf-text-layer');

    try {
        const response = await fetch(
            `/api/pdf-text-layer?filename=${encodeURIComponent(state.pdfFile)}` +
                `&page=${pageNumber}&width=${PDF_RENDER_WIDTH}&schema=2` +
                `&project_id=${encodeURIComponent(state.activeProject.id)}`,
        );
        const payload = await response.json();

        if (!response.ok) {
            throw new Error(payload.error || 'Textschicht konnte nicht geladen werden');
        }

        if (requestId !== state.pdfLoadRequest || !pageElement.isConnected) return;

        const measuringCanvas = document.createElement('canvas');
        const context = measuringCanvas.getContext('2d');
        const fragment = document.createDocumentFragment();

        layer.dataset.sourceWidth = String(payload.width);
        layer.dataset.sourceHeight = String(payload.height);
        pageElement.dataset.coordinateWidth = String(payload.coordinate_width);
        pageElement.dataset.coordinateHeight = String(payload.coordinate_height);
        layer.style.width = `${payload.width}px`;
        layer.style.height = `${payload.height}px`;

        for (const item of payload.items || []) {
            const span = document.createElement('span');
            const fontFamily = item.font_family || 'sans-serif';

            span.textContent = `${item.text}${item.has_eol ? '\n' : ' '}`;
            span.dir = item.direction === 'rtl' ? 'rtl' : 'ltr';
            span.style.left = `${item.left}px`;
            span.style.top = `${item.top}px`;
            span.style.fontSize = `${item.height}px`;
            span.style.fontFamily = fontFamily;

            let scaleX = 1;

            if (context && item.width > 0) {
                context.font = `${item.height}px ${fontFamily}`;
                const measuredWidth = context.measureText(item.text).width;

                if (measuredWidth > 0) {
                    scaleX = item.width / measuredWidth;
                }
            }

            span.style.transform = `rotate(${item.angle || 0}rad) scaleX(${scaleX})`;
            fragment.append(span);
        }

        layer.replaceChildren(fragment);
        layer.hidden = false;
        fitPdfTextLayer(pageElement);
        renderCoordinateBox(pageElement);
    } catch (error) {
        if (requestId === state.pdfLoadRequest) {
            layer.dataset.error = error.message;
        }
    }
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
        .filter(item => item.document_id === problem.document_id && problemMatchesView(item))
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
        button.title = Number.isInteger(relatedProblem.page)
            ? `Zu PDF-Seite ${relatedProblem.page} springen`
            : 'Dokumentweiten Fund auswählen';
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
            renderProblem({ preservePdf: state.pdfFile === relatedProblem.file });
        });
        elements['document-findings'].append(button);
    }
}

function startPdfPageObserver(requestId) {
    if (requestId !== state.pdfLoadRequest || state.pdfObserver || !('IntersectionObserver' in window)) return;

    state.pdfObserver = new IntersectionObserver(
        entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) loadPdfPage(entry.target);
            }
        },
        {
            root: elements['pdf-scroll'],
            rootMargin: '400px 0px',
        },
    );

    for (const pageElement of elements['pdf-pages'].children) {
        state.pdfObserver.observe(pageElement);
    }
}

function loadPdfPage(pageElement) {
    if (!state.pdfFile || !pageElement || pageElement.dataset.requested === 'true') return;

    const image = pageElement.querySelector('img');
    const status = pageElement.querySelector('.pdf-page-status');
    const pageNumber = Number(pageElement.dataset.page);
    const requestId = state.pdfLoadRequest;
    const requestTextLayer = () => {
        if (pageElement.dataset.textRequested === 'true') return;

        pageElement.dataset.textRequested = 'true';
        loadPdfTextLayer(pageElement, pageNumber, requestId);
    };

    pageElement.dataset.requested = 'true';
    status.textContent = `Seite ${pageNumber} wird geladen …`;
    image.onload = () => {
        if (requestId !== state.pdfLoadRequest) return;

        pageElement.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
        image.hidden = false;
        status.hidden = true;
        fitPdfTextLayer(pageElement);
        requestTextLayer();

        if (pageNumber === state.pdfPage) {
            elements['pdf-loading'].hidden = true;
            startPdfPageObserver(requestId);
        }
    };
    image.onerror = () => {
        if (requestId !== state.pdfLoadRequest) return;

        status.textContent = `Seite ${pageNumber} konnte nicht dargestellt werden.`;
        requestTextLayer();

        if (pageNumber === state.pdfPage) {
            startPdfPageObserver(requestId);
        }
    };
    image.src =
        `/api/pdf-page?filename=${encodeURIComponent(state.pdfFile)}` +
        `&page=${pageNumber}&width=${PDF_RENDER_WIDTH}` +
        `&project_id=${encodeURIComponent(state.activeProject.id)}`;
}

function renderPdfDocument() {
    if (!state.pdfFile) return;

    const requestId = ++state.pdfLoadRequest;
    const fragment = document.createDocumentFragment();

    state.pdfObserver?.disconnect();
    state.pdfObserver = null;
    state.pdfResizeObserver?.disconnect();
    elements['pdf-pages'].replaceChildren();
    elements['pdf-pages'].style.setProperty('--pdf-zoom', state.pdfZoom);
    setPdfLoading('PDF wird vorbereitet …');
    updatePdfControls();

    for (let pageNumber = 1; pageNumber <= state.pdfPageCount; pageNumber++) {
        const pageElement = document.createElement('section');
        const pageLabel = document.createElement('span');
        const image = document.createElement('img');
        const textLayer = document.createElement('div');
        const coordinateOverlay = document.createElement('div');
        const status = document.createElement('span');

        pageElement.className = 'pdf-page';
        pageElement.dataset.page = String(pageNumber);
        pageElement.setAttribute('aria-label', `PDF-Seite ${pageNumber}`);
        pageLabel.className = 'pdf-page-label';
        pageLabel.textContent = `Seite ${pageNumber}`;
        image.alt = `Gerenderte PDF-Seite ${pageNumber}`;
        image.draggable = false;
        image.hidden = true;
        textLayer.className = 'pdf-text-layer';
        textLayer.hidden = true;
        textLayer.setAttribute('aria-label', `Auswählbarer Text auf PDF-Seite ${pageNumber}`);
        coordinateOverlay.className = 'pdf-coordinate-overlay';
        coordinateOverlay.setAttribute('aria-hidden', 'true');
        status.className = 'pdf-page-status';
        status.textContent = `Seite ${pageNumber}`;
        pageElement.append(pageLabel, image, textLayer, coordinateOverlay, status);
        fragment.append(pageElement);
    }

    elements['pdf-pages'].append(fragment);

    if ('ResizeObserver' in window) {
        state.pdfResizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                fitPdfTextLayer(entry.target);
            }
        });

        for (const pageElement of elements['pdf-pages'].children) {
            state.pdfResizeObserver.observe(pageElement);
        }
    }

    const target = elements['pdf-pages'].querySelector(`[data-page="${state.pdfPage}"]`);

    elements['pdf-scroll'].scrollTop = Math.max(0, (target?.offsetTop || 0) - 16);
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
    clearCoordinateBox();
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
    window.requestAnimationFrame(() => {
        for (const pageElement of elements['pdf-pages'].children) {
            fitPdfTextLayer(pageElement);
        }
    });
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

    elements['problem-documents-count'].textContent = counts.totalDocuments;
    elements['accepted-count'].textContent = counts.accepted;
    elements['skipped-count'].textContent = counts.skipped;
    elements['remaining-count'].textContent = counts.remaining;
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

function resetRecoveredText() {
    elements['recovered-text'].hidden = true;
    elements['recovered-text'].textContent = '';
    elements['recovered-status'].hidden = false;
    elements['recovered-status'].textContent = 'Text wird lokal aus der markierten PDF-Region gelesen …';
}

async function renderRecoveredText(problem) {
    const requestId = ++state.recoveryRequest;
    const cacheKey = `${state.activeProject.id}:${problem.problem_id}`;
    const cached = state.recoveredText.get(cacheKey);

    resetRecoveredText();

    try {
        let payload = cached;

        if (!payload) {
            const response = await fetch(
                `/api/recovered-text?problem_id=${encodeURIComponent(problem.problem_id)}` +
                    `&project_id=${encodeURIComponent(state.activeProject.id)}`,
            );
            payload = await response.json();

            if (!response.ok) {
                throw new Error(payload.error || 'Text konnte nicht rekonstruiert werden');
            }

            state.recoveredText.set(cacheKey, payload);
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

function resetMetadataPanel(problem = null) {
    state.metadataRequest++;
    const hasProblem = Boolean(problem);

    elements['metadata-section'].hidden = !hasProblem;
    elements['metadata-status'].hidden = !hasProblem;
    elements['metadata-status'].textContent = hasProblem ? 'Metadaten werden lokal aus dem PDF gelesen …' : '';
    elements['metadata-content'].hidden = true;
    elements['metadata-content'].textContent = '';
}

function formatPdfMetadata(payload) {
    const metadata = {};

    if (payload.info && Object.keys(payload.info).length > 0) metadata.Info = payload.info;
    if (payload.xmp && Object.keys(payload.xmp).length > 0) metadata.XMP = payload.xmp;

    return Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : '';
}

function renderMetadataWithEmailHighlights(formatted) {
    const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    while ((match = emailPattern.exec(formatted)) !== null) {
        fragment.append(document.createTextNode(formatted.slice(lastIndex, match.index)));

        const highlight = document.createElement('mark');
        highlight.className = 'metadata-email-match';
        highlight.textContent = match[0];
        highlight.title = 'Erkannte E-Mail-Adresse';
        fragment.append(highlight);
        lastIndex = match.index + match[0].length;
    }

    fragment.append(document.createTextNode(formatted.slice(lastIndex)));
    elements['metadata-content'].replaceChildren(fragment);
}

async function renderPdfMetadata(problem) {
    const requestId = ++state.metadataRequest;
    const cacheKey = `${state.activeProject.id}:${problem.file}`;

    try {
        let payload = state.metadataCache.get(cacheKey);

        if (!payload) {
            const response = await fetch(
                `/api/pdf-metadata?problem_id=${encodeURIComponent(problem.problem_id)}` +
                    `&project_id=${encodeURIComponent(state.activeProject.id)}`,
            );
            const contentType = response.headers.get('content-type') || '';

            if (!contentType.includes('application/json')) {
                throw new Error(
                    response.status === 404
                        ? 'Der Webserver läuft noch mit der vorherigen Version. Bitte neu starten und die Seite neu laden.'
                        : `Der Webserver lieferte eine ungültige Antwort (${response.status}).`,
                );
            }

            payload = await response.json();

            if (!response.ok) {
                throw new Error(payload.error || 'Metadaten konnten nicht gelesen werden');
            }

            state.metadataCache.set(cacheKey, payload);
        }

        if (requestId !== state.metadataRequest || currentProblem()?.problem_id !== problem.problem_id) return;

        const formatted = formatPdfMetadata(payload);

        if (!payload.available || !formatted) {
            elements['metadata-status'].textContent = payload.reason || 'Dieses PDF enthält keine lesbaren Metadaten.';
            return;
        }

        elements['metadata-status'].hidden = true;
        elements['metadata-content'].hidden = false;
        renderMetadataWithEmailHighlights(formatted);
    } catch (error) {
        if (requestId !== state.metadataRequest) return;

        elements['metadata-status'].hidden = false;
        elements['metadata-status'].textContent = error.message;
    }
}

function renderProblem({ preservePdf = false } = {}) {
    const problem = currentProblem();

    if (state.view === 'found' && !state.foundDetail) {
        renderFoundOverview();
        return;
    }

    renderViewControls();
    renderProgress();

    if (!problem) {
        const allReviewed = state.problems.length > 0 && reviewCounts().remaining === 0;

        elements['review-content'].hidden = true;
        elements['review-empty'].hidden = false;
        elements['review-empty'].innerHTML =
            state.view === 'found'
                ? '<strong>Noch keine bestätigten Funde</strong><p>Bestätigte Funde erscheinen automatisch in dieser Ansicht.</p>'
                : allReviewed
                  ? '<strong>Alle Verdachtsfälle geprüft</strong><p>Es sind keine offenen Funde mehr vorhanden.</p>'
                  : '<strong>Keine offenen Fälle in diesem Filter</strong><p>Wähle einen anderen Filter oder prüfe den Datenbestand.</p>';
        elements['empty-viewer'].hidden = false;
        elements['empty-viewer'].innerHTML = '<p>Kein PDF ausgewählt.</p>';
        clearCoordinateBox();
        state.pdfObserver?.disconnect();
        elements['pdf-pages'].replaceChildren();
        elements['pdf-loading'].hidden = true;
        elements['open-pdf'].hidden = true;
        elements['viewer-page-findings'].textContent = '';
        resetMetadataPanel();
        setBusy(false);
        return;
    }

    elements['review-empty'].hidden = true;
    elements['review-content'].hidden = false;
    elements['empty-viewer'].hidden = true;

    const url = pdfUrl(problem);
    elements['open-pdf'].href = url;
    elements['open-pdf'].hidden = false;
    elements['viewer-label'].textContent = `${problem.file}${problem.page ? ` · Seite ${problem.page}` : ''}`;
    elements['document-title'].textContent = problem.title || 'Ohne Titel';
    elements['filename'].textContent = problem.file;
    elements['document-id'].textContent = problem.document_id;
    elements['project-name'].textContent = problem.project || 'Ohne Projekt';
    elements.page.textContent = problem.page ?? 'Dokumentweit';
    elements['risk-score'].textContent = problem.risk_score;
    elements['risk-score'].className = `risk-score score-${problem.severity}`;
    elements.severity.textContent = problem.severity.toUpperCase();
    elements['affected-items'].textContent = problem.evidence?.affected_text_items ?? '–';
    elements.evidence.textContent = JSON.stringify(problem.evidence || {}, null, 2);
    renderDocumentFindings(problem);
    resetMetadataPanel(problem);
    void renderPdfMetadata(problem);

    renderDecision(problem);

    if (preservePdf && state.pdfFile === problem.file) {
        if (Number.isInteger(problem.page) && problem.page > 0) {
            changePdfPage(problem.page);
        }
    } else {
        loadPdf(problem);
    }

    state.recoveryRequest++;
    resetRecoveredText();
    window.setTimeout(() => {
        if (currentProblem()?.problem_id === problem.problem_id) {
            renderRecoveredText(problem);
        }
    }, 100);
    updateViewerPageFindingSummary();
    setBusy(false);
}

function applyFilters({ preserveProblemId = null } = {}) {
    const previousPdfFile = state.pdfFile;
    const severity = elements['severity-filter'].value;
    const type = elements['type-filter'].value;

    state.filtered = state.problems.filter(problem => {
        const severityMatches = severity === 'all' || problem.severity === severity;
        const typeMatches = type === 'all' || problem.type === type;
        const viewMatches = problemMatchesView(problem);

        return severityMatches && typeMatches && viewMatches;
    });

    let nextIndex = preserveProblemId
        ? state.filtered.findIndex(problem => problem.problem_id === preserveProblemId)
        : -1;

    if (state.view === 'found' && !state.foundDetail) {
        state.currentIndex = -1;
        renderFoundOverview();
    } else {
        state.currentIndex = nextIndex >= 0 ? nextIndex : state.filtered.length ? 0 : -1;
        renderProblem({ preservePdf: currentProblem()?.file === previousPdfFile });
    }
}

function switchView(view) {
    if (!['projects', 'investigate', 'found'].includes(view) || state.view === view) return;

    if (view === 'projects') {
        state.view = view;
        state.foundDetail = false;
        setMessage('');
        renderViewControls();
        renderProjects();
        void refreshProjects().then(scheduleProjectPolling).catch(error => setProjectMessage(error.message, 'error'));
        return;
    }

    if (!state.activeProject) {
        setProjectMessage('Öffne zuerst ein Projekt.', 'error');
        return;
    }

    state.view = view;
    state.foundDetail = false;
    setMessage('');
    applyFilters();
}

function populateTypeFilter() {
    const types = [...new Set(state.problems.map(problem => problem.type))].sort();

    while (elements['type-filter'].options.length > 1) {
        elements['type-filter'].remove(1);
    }

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
    renderProblem({ preservePdf: currentProblem()?.file === state.pdfFile });
}

function removeReviewedAndAdvance(problemId) {
    const previousIndex = state.filtered.findIndex(problem => problem.problem_id === problemId);

    state.filtered = state.filtered.filter(problem => problem.problem_id !== problemId);
    state.currentIndex = state.filtered.length ? Math.min(Math.max(previousIndex, 0), state.filtered.length - 1) : -1;
    renderProblem({ preservePdf: currentProblem()?.file === state.pdfFile });

    if (state.filtered.length === 0) {
        setMessage('Alle Fälle in diesem Filter wurden geprüft.', 'success');
    }
}

async function saveDecision(decision) {
    const problem = currentProblem();

    if (!problem || state.saving || state.view !== 'investigate') return;

    setBusy(true);
    setMessage(decision === 'accept' ? 'Bestätigung wird gespeichert …' : 'Skip wird gespeichert …');

    try {
        const response = await fetch('/api/review', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                project_id: state.activeProject.id,
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
        renderViewControls();
        await refreshProjects();
        scheduleProjectPolling();
    } catch (error) {
        setProjectMessage(error.message, 'error');
    }
}

elements.previous.addEventListener('click', () => move(-1));
elements.next.addEventListener('click', () => move(1));
elements['view-projects'].addEventListener('click', () => switchView('projects'));
elements['view-investigate'].addEventListener('click', () => switchView('investigate'));
elements['view-found'].addEventListener('click', () => switchView('found'));
elements['found-back'].addEventListener('click', showFoundOverview);
elements.skip.addEventListener('click', () => saveDecision('skip'));
elements.accept.addEventListener('click', () => saveDecision('accept'));
elements['pdf-page-previous'].addEventListener('click', () => changePdfPage(state.pdfPage - 1));
elements['pdf-page-next'].addEventListener('click', () => changePdfPage(state.pdfPage + 1));
elements['pdf-page-number'].addEventListener('change', event => changePdfPage(event.target.value));
elements['pdf-zoom-out'].addEventListener('click', () => changePdfZoom(-0.25));
elements['pdf-zoom-in'].addEventListener('click', () => changePdfZoom(0.25));
elements['coordinate-form'].addEventListener('submit', event => {
    event.preventDefault();
    drawCoordinateBox();
});
elements['coordinate-clear'].addEventListener('click', () => clearCoordinateBox());
elements['coordinate-input'].addEventListener('input', () => elements['coordinate-input'].setCustomValidity(''));
elements['project-folder-button'].addEventListener('click', () => elements['project-folder-input'].click());
elements['project-folder-input'].addEventListener('change', event => {
    state.newProjectFiles = selectedPdfFiles(event.target.files);
    elements['project-folder-status'].textContent = folderSelectionText(state.newProjectFiles);
});
elements['project-upload-input'].addEventListener('change', async event => {
    const project = state.uploadTargetProject;
    const files = selectedPdfFiles(event.target.files);
    state.uploadTargetProject = null;

    if (!project || files.length === 0) {
        if (project) setProjectMessage('Der ausgewählte Ordner enthält keine PDFs.', 'error');
        return;
    }

    setProjectMessage(`${files.length} PDFs werden für ${project.project} vorbereitet …`);
    try {
        await uploadFilesToProject(project, files);
    } catch (error) {
        await refreshProjects().catch(() => {});
        setProjectMessage(error.message, 'error');
    }
});
elements['project-form'].addEventListener('submit', async event => {
    event.preventDefault();

    const files = [...state.newProjectFiles];
    if (files.length === 0) {
        setProjectMessage('Bitte zuerst einen Ordner mit PDFs auswählen.', 'error');
        elements['project-folder-button'].focus();
        return;
    }

    elements['project-create'].disabled = true;
    setProjectMessage('Projekt wird angelegt …');

    try {
        const payload = await fetchJson('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project: elements['project-input'].value,
                organization: elements['organization-input'].value,
            }),
        });

        elements['project-form'].reset();
        state.newProjectFiles = [];
        elements['project-folder-status'].textContent = 'Kein Ordner ausgewählt';
        await uploadFilesToProject(payload.project, files);
    } catch (error) {
        await refreshProjects().catch(() => {});
        setProjectMessage(error.message, 'error');
    } finally {
        elements['project-create'].disabled = false;
    }
});
elements['pdf-scroll'].addEventListener('scroll', () => {
    if (state.pdfScrollFrame !== null) return;

    state.pdfScrollFrame = window.requestAnimationFrame(() => {
        state.pdfScrollFrame = null;
        updateCurrentPdfPageFromScroll();
    });
});
window.addEventListener('resize', () => {
    for (const pageElement of elements['pdf-pages'].children) {
        fitPdfTextLayer(pageElement);
    }
});

for (const filter of [elements['severity-filter'], elements['type-filter']]) {
    filter.addEventListener('change', () => {
        if (state.view === 'found') state.foundDetail = false;
        applyFilters();
    });
}

document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) {
        return;
    }

    if (state.view === 'investigate' && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        saveDecision('accept');
    } else if (state.view === 'investigate' && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveDecision('skip');
    } else if (event.key === 'ArrowLeft' && (state.view !== 'found' || state.foundDetail)) {
        event.preventDefault();
        move(-1);
    } else if (event.key === 'ArrowRight' && (state.view !== 'found' || state.foundDetail)) {
        event.preventDefault();
        move(1);
    }
});

initialize();
