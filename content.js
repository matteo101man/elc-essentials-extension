(function () {
    'use strict';


    // ── GM shims: localStorage-backed (Chrome & Firefox WebExtension) ──
    // Keys are namespaced so they don't collide with the page's own localStorage.
    const _ELC_NS = 'elc_ext_';

    function GM_getValue(key, defaultVal) {
        try {
            const v = localStorage.getItem(_ELC_NS + key);
            return v !== null ? v : (defaultVal !== undefined ? defaultVal : '');
        } catch (e) {
            return defaultVal !== undefined ? defaultVal : '';
        }
    }

    function GM_setValue(key, value) {
        try { localStorage.setItem(_ELC_NS + key, String(value)); } catch (e) {}
    }

    function GM_deleteValue(key) {
        try { localStorage.removeItem(_ELC_NS + key); } catch (e) {}
    }

    // Cross-origin requests are proxied through the background service worker.
    function GM_xmlhttpRequest(opts) {
        chrome.runtime.sendMessage(
            {
                type: 'GM_xmlhttpRequest',
                method: opts.method || 'GET',
                url: opts.url,
                headers: opts.headers || {},
                data: opts.data || null
            },
            function (response) {
                if (chrome.runtime.lastError) {
                    if (typeof opts.onerror === 'function') {
                        opts.onerror({ error: chrome.runtime.lastError.message });
                    }
                    return;
                }
                if (!response) {
                    if (typeof opts.onerror === 'function') opts.onerror({ error: 'No response from background' });
                    return;
                }
                if (response.error) {
                    if (typeof opts.onerror === 'function') opts.onerror({ error: response.error });
                } else {
                    if (typeof opts.onload === 'function') opts.onload({ status: response.status, responseText: response.responseText });
                }
            }
        );
    }

    // ── Original ELC Essentials logic (runs only when extension is enabled in popup) ──
    function elcMain() {

    // Paste a raw HTTPS URL to your JSON (e.g. GitHub raw). Add a matching // @connect host if not listed above.
    // Leave empty to load from file once (cached) or use Tampermonkey storage from a previous load.
    const EXAM_DATA_URL = '';

    const EXAM_CACHE_KEY = 'pt_practice_exam_json_v1';
    /** Same-tab refresh: which practice screen to reopen (list / summary / attempt). */
    const PT_SESSION_ROUTE_KEY = 'pt_session_route_v1';

    /** @type {null | Array<{id:string,name:string,category:string,description:string,questions:Array}>} */
    let PRACTICE_TESTS = null;

    const LETTERS = ['a', 'b', 'c', 'd', 'e'];

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Set HTML on an element without assigning to innerHTML (Mozilla add-ons linter / unsanitized-innerHTML).
     * Parsed with DOMParser; use only with trusted template strings or data you already escaped.
     */
    function elcSetHtml(el, html) {
        if (!el) return;
        const str = html == null ? '' : String(html);
        const doc = new DOMParser().parseFromString(str, 'text/html');
        el.replaceChildren();
        while (doc.body.firstChild) {
            el.appendChild(doc.body.firstChild);
        }
    }


    function normalizeExamPayload(parsed) {
        if (!parsed || !Array.isArray(parsed.tests)) throw new Error('JSON must contain a "tests" array');
        return parsed.tests.map(test => ({
            id: test.id,
            name: test.name,
            category: test.category,
            description: test.description,
            questionsPerAttempt:
                typeof test.questionsPerAttempt === 'number' && test.questionsPerAttempt > 0
                    ? Math.floor(test.questionsPerAttempt)
                    : null,
            displayMode: test.displayMode === 'single' || test.displayMode === 'all' ? test.displayMode : 'all',
            questions: (test.questions || []).map((q, i) => ({
                id: i + 1,
                text: q.text,
                choices: q.choices.map((t, j) => ({ letter: LETTERS[j], text: t })),
                correctAnswer: LETTERS[q.correct],
                explanation: typeof q.explanation === 'string' ? q.explanation : ''
            }))
        }));
    }

    function serializeExamPayload(tests) {
        return {
            tests: tests.map(t => {
                const o = {
                    id: t.id,
                    name: t.name,
                    category: t.category,
                    description: t.description,
                    questions: t.questions.map(q => {
                        const row = {
                            text: q.text,
                            choices: q.choices.map(c => c.text),
                            correct: LETTERS.indexOf(q.correctAnswer)
                        };
                        if (q.explanation && String(q.explanation).trim()) row.explanation = q.explanation;
                        return row;
                    })
                };
                if (t.questionsPerAttempt && t.questionsPerAttempt > 0) o.questionsPerAttempt = t.questionsPerAttempt;
                if (t.displayMode === 'single' || t.displayMode === 'all') o.displayMode = t.displayMode;
                return o;
            })
        };
    }

    /** How many questions each attempt draws from the bank (or full bank if unset). */
    function resolveAttemptSize(test) {
        const pool = test.questions.length;
        const n = test.questionsPerAttempt;
        if (typeof n !== 'number' || n <= 0) return pool;
        return Math.min(Math.floor(n), pool);
    }

    /** Uniform random subset, random order (new draw each attempt). */
    function shuffleAndTake(questions, take) {
        const copy = questions.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = copy[i];
            copy[i] = copy[j];
            copy[j] = t;
        }
        return copy.slice(0, take);
    }

    function poolSummaryLine(test) {
        const pool = test.questions.length;
        const n = resolveAttemptSize(test);
        if (n < pool) return `${n} per attempt (${pool} in bank)`;
        return `${pool} multiple choice`;
    }

    /** Default layout when starting or retaking: last choice, then exam JSON, then "all". */
    function getDefaultDisplayMode(test) {
        try {
            const g = GM_getValue('pt_display_mode_pref_' + test.id, '');
            if (g === 'single' || g === 'all') return g;
        } catch (e) {}
        return test.displayMode === 'single' || test.displayMode === 'all' ? test.displayMode : 'all';
    }

    /** Path + query so restore only runs after refresh on this page, not after navigating to Course Home etc. */
    function currentPageKey() {
        return window.location.pathname + window.location.search;
    }

    function savePracticeRoute(view, testId) {
        try {
            sessionStorage.setItem(PT_SESSION_ROUTE_KEY, JSON.stringify({
                view,
                testId: testId != null ? String(testId) : null,
                path: currentPageKey()
            }));
        } catch (e) { /* private mode */ }
    }

    function ensurePracticeTestsLoaded() {
        if (PRACTICE_TESTS && PRACTICE_TESTS.length) return true;
        try {
            const cached = GM_getValue(EXAM_CACHE_KEY, '');
            if (cached) {
                PRACTICE_TESTS = normalizeExamPayload(JSON.parse(cached));
                return PRACTICE_TESTS.length > 0;
            }
        } catch (e) {}
        return false;
    }

    function tryRestorePracticeSession() {
        if (!getMainContent()) return;
        let route;
        try {
            const raw = sessionStorage.getItem(PT_SESSION_ROUTE_KEY);
            if (!raw) return;
            route = JSON.parse(raw);
        } catch (e) { return; }
        if (!route || !route.view) return;
        if (route.path && route.path !== currentPageKey()) {
            try { sessionStorage.removeItem(PT_SESSION_ROUTE_KEY); } catch (e2) {}
            return;
        }
        if (!route.path) {
            try { sessionStorage.removeItem(PT_SESSION_ROUTE_KEY); } catch (e3) {}
            return;
        }
        if (!ensurePracticeTestsLoaded()) return;
        const findT = id => PRACTICE_TESTS.find(t => String(t.id) === String(id));
        if (route.view === 'attempt' && route.testId) {
            const t = findT(route.testId);
            if (t) {
                const dk = 'pt_draft_' + t.id;
                const rawDraft = GM_getValue(dk, '');
                if (rawDraft && String(rawDraft).trim()) showQuiz(t);
                else showTestSummary(t);
                return;
            }
        }
        if (route.view === 'summary' && route.testId) {
            const t = findT(route.testId);
            if (t) { showTestSummary(t); return; }
        }
        if (route.view === 'list') {
            renderTestList();
            return;
        }
        renderTestList();
    }

    function schedulePracticeSessionRestore() {
        if (practiceSessionRestoreScheduled) return;
        practiceSessionRestoreScheduled = true;
        let tries = 0;
        const tick = () => {
            tries++;
            if (!getMainContent()) {
                if (tries < 100) setTimeout(tick, 100);
                return;
            }
            if (practiceSessionRestoreAttempted) return;
            practiceSessionRestoreAttempted = true;
            try {
                if (!sessionStorage.getItem(PT_SESSION_ROUTE_KEY)) return;
                tryRestorePracticeSession();
            } catch (e) {}
        };
        setTimeout(tick, 0);
    }

    function persistExamData() {
        GM_setValue(EXAM_CACHE_KEY, JSON.stringify(serializeExamPayload(PRACTICE_TESTS)));
    }

    function applyExamJsonString(jsonText) {
        const parsed = JSON.parse(jsonText);
        PRACTICE_TESTS = normalizeExamPayload(parsed);
        GM_setValue(EXAM_CACHE_KEY, jsonText);
    }

    function importMoreExamsFromJson(jsonText) {
        const parsed = JSON.parse(jsonText);
        if (!parsed || !Array.isArray(parsed.tests)) throw new Error('JSON must contain a "tests" array');
        const incoming = normalizeExamPayload(parsed);
        const existingIds = new Set(PRACTICE_TESTS.map(t => t.id));
        const skipped = [];
        for (const t of incoming) {
            if (existingIds.has(t.id)) {
                skipped.push(t.id);
                continue;
            }
            existingIds.add(t.id);
            PRACTICE_TESTS.push(t);
        }
        persistExamData();
        if (skipped.length) {
            alert('Skipped ' + skipped.length + ' exam(s) with an id that already exists: ' + skipped.join(', '));
        }
    }

    function deleteTestById(testId) {
        const t = PRACTICE_TESTS.find(x => x.id === testId);
        if (!t) return;
        if (!confirm('Delete "' + t.name + '"? Its attempt history will be removed.')) return;
        PRACTICE_TESTS = PRACTICE_TESTS.filter(x => x.id !== testId);
        GM_setValue('pt_' + testId, '[]');
        persistExamData();
        renderTestList();
    }

    function exportAllExamsJson() {
        const blob = new Blob([JSON.stringify(serializeExamPayload(PRACTICE_TESTS), null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'practice-exams.json';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function showLoadExamUI() {
        takeover(`<div class="pt-page">
            <h1>Load practice exam</h1>
            <p class="pt-detail-value">Choose a JSON file below (saved in Tampermonkey storage).</p>
            <p style="margin-top:16px;"><input type="file" id="pt-exam-file" accept=".json,application/json"></p>
            <p style="margin-top:16px;"><button type="button" class="pt-d2l-btn pt-d2l-btn-primary" id="pt-loadui-create">Create an exam instead</button></p>
            <p style="font-size:12px;color:#6e7376;">Or set <code>EXAM_DATA_URL</code> in the script to a hosted copy and reload the page.</p>
        </div>`);
        savePracticeRoute('list');
        const createBtn = document.getElementById('pt-loadui-create');
        if (createBtn) createBtn.addEventListener('click', () => showExamBuilder());
        const input = document.getElementById('pt-exam-file');
        input.addEventListener('change', () => {
            const f = input.files && input.files[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = () => {
                try {
                    applyExamJsonString(r.result);
                    renderTestList();
                } catch (e) {
                    alert('Invalid exam JSON: ' + (e && e.message ? e.message : e));
                }
            };
            r.readAsText(f);
        });
    }

    function renderTestList() {
        if (!PRACTICE_TESTS) PRACTICE_TESTS = [];
        if (!PRACTICE_TESTS.length) {
            takeover(`<div class="pt-page">
            <h1>Practice Test List</h1>
            <div class="pt-toolbar" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:20px;">
                <button type="button" class="pt-d2l-btn pt-d2l-btn-primary" id="pt-create-exam-btn">Create an Exam</button>
                <button type="button" class="pt-d2l-btn" id="pt-import-first-btn">Import exams (JSON)</button>
                <input type="file" id="pt-import-first" accept=".json,application/json" style="display:none;">
            </div>
            <p class="pt-detail-value" style="margin-bottom:12px;">No exams loaded yet. Create your own or import a JSON file.</p>
            <p style="font-size:12px;color:#6e7376;">Optional: set <code>EXAM_DATA_URL</code> in the script to load from a URL.</p>
        </div>`);
            savePracticeRoute('list');
            document.getElementById('pt-create-exam-btn').addEventListener('click', () => showExamBuilder());
            document.getElementById('pt-import-first-btn').addEventListener('click', () => document.getElementById('pt-import-first').click());
            document.getElementById('pt-import-first').addEventListener('change', ev => {
                const f = ev.target.files && ev.target.files[0];
                ev.target.value = '';
                if (!f) return;
                const r = new FileReader();
                r.onload = () => {
                    try {
                        applyExamJsonString(r.result);
                        renderTestList();
                    } catch (e) {
                        alert('Invalid exam JSON: ' + (e && e.message ? e.message : e));
                    }
                };
                r.readAsText(f);
            });
            return;
        }
        let rows = '';
        const cats = {};
        PRACTICE_TESTS.forEach(t => {
            if (!cats[t.category]) cats[t.category] = [];
            cats[t.category].push(t);
        });
        for (const [cat, tests] of Object.entries(cats)) {
            rows += `<tr><th colspan="4" style="background:#eee;font-size:13px;font-weight:600;padding:8px 16px;">${cat}</th></tr>`;
            tests.forEach(t => {
                const attempts = getAttempts(t.id);
                const best = attempts.length ? Math.max(...attempts.map(a=>a.percentage)).toFixed(0)+'%' : '';
                rows += `<tr>
                    <td><a class="pt-test-link" data-testid="${t.id}">${t.name}</a><br><span style="font-size:12px;color:#6e7376;">${poolSummaryLine(t)}</span></td>
                    <td>${best ? 'Best: '+best : ''}</td>
                    <td>${attempts.length} / unlimited</td>
                    <td class="pt-manage-cell">
                        <div style="display:flex;gap:6px;align-items:center;">
                            <button type="button" class="pt-d2l-btn pt-edit-exam" data-edit-id="${t.id}" style="font-size:12px;padding:4px 8px;">Edit</button>
                            <button type="button" class="pt-d2l-btn pt-btn-danger pt-delete-exam" data-delete-id="${t.id}" style="font-size:12px;padding:4px 8px;">Delete</button>
                        </div>
                    </td>
                </tr>`;
            });
        }
        takeover(`<div class="pt-page">
            <h1>Practice Test List</h1>
            <div class="pt-toolbar" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:20px;">
                <button type="button" class="pt-d2l-btn pt-d2l-btn-primary" id="pt-create-exam-btn">Create an Exam</button>
                <button type="button" class="pt-d2l-btn" id="pt-import-more-btn">Import more exams (JSON)</button>
                <input type="file" id="pt-import-more" accept=".json,application/json" style="display:none;">
                <button type="button" class="pt-d2l-btn" id="pt-export-all-btn">Export all</button>
                <span style="font-size:12px;color:#6e7376;">Import merges with your list; same <code>id</code> is skipped.</span>
            </div>
            <table class="pt-table"><thead><tr><th>Practice Exams</th><th>Best Score</th><th>Attempts</th><th style="width:100px;">Manage</th></tr></thead><tbody>${rows}</tbody></table>
        </div>`);
        savePracticeRoute('list');
        document.querySelectorAll('.pt-test-link').forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                const t = PRACTICE_TESTS.find(x => x.id === link.dataset.testid);
                if (t) showTestSummary(t);
            });
        });
        document.querySelectorAll('.pt-edit-exam').forEach(btn => {
            btn.addEventListener('click', () => {
                const t = PRACTICE_TESTS.find(x => x.id === btn.dataset.editId);
                if (t) showExamBuilder(t);
            });
        });
        document.querySelectorAll('.pt-delete-exam').forEach(btn => {
            btn.addEventListener('click', () => deleteTestById(btn.dataset.deleteId));
        });
        document.getElementById('pt-import-more-btn').addEventListener('click', () => document.getElementById('pt-import-more').click());
        document.getElementById('pt-import-more').addEventListener('change', ev => {
            const f = ev.target.files && ev.target.files[0];
            ev.target.value = '';
            if (!f) return;
            const r = new FileReader();
            r.onload = () => {
                try {
                    importMoreExamsFromJson(r.result);
                    renderTestList();
                } catch (e) {
                    alert('Could not import: ' + (e && e.message ? e.message : e));
                }
            };
            r.readAsText(f);
        });
        document.getElementById('pt-export-all-btn').addEventListener('click', exportAllExamsJson);
        document.getElementById('pt-create-exam-btn').addEventListener('click', () => showExamBuilder());
    }

    function showExamBuilder(existingTest = null) {
        if (!PRACTICE_TESTS) PRACTICE_TESTS = [];
        savePracticeRoute('builder');
        
        let builderTest = existingTest ? JSON.parse(JSON.stringify(existingTest)) : { 
            id: 'test_' + Date.now(), 
            name: 'New Custom Exam', 
            category: 'Custom', 
            description: '',
            questions: [] 
        };
        let aiKey = GM_getValue('pt_openai_key', '');

        const genId = () => 'q_' + Math.random().toString(36).substr(2, 9);
        let lastPrompt = '';

        function renderBuilder() {
            let qHtml = '';
            builderTest.questions.forEach((q, i) => {
                qHtml += `<div style="border:1px solid #d0d2d3; padding:16px; margin-bottom:16px; border-radius:4px; background:#fff;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <strong style="color:#006fbf;font-size:16px;">Question ${i+1}</strong>
                        <button class="pt-d2l-btn pt-btn-danger b-del-q" data-idx="${i}" style="padding:4px 10px;font-size:12px;">Delete</button>
                    </div>
                    <textarea class="b-q-text" data-idx="${i}" style="width:100%; height:60px; padding:8px; border:1px solid #ccc; font-family:inherit; margin-bottom:12px; box-sizing:border-box;" placeholder="Question text...">${escapeHtml(q.text || '')}</textarea>
                    
                    <div style="font-weight:600; margin-bottom:8px; font-size:14px; color:#565a5c;">Choices (Select radio for correct answer)</div>
                    <table style="width:100%; border-collapse:collapse;">
                    <tbody>`;
                q.choices.forEach((c, ci) => {
                    let checked = q.correctAnswer === c.letter ? 'checked' : '';
                    qHtml += `<tr>
                       <td style="width:30px; padding:4px 0; text-align:center;">
                           <input type="radio" name="bq_${i}_corr" value="${c.letter}" ${checked} style="cursor:pointer;" title="Mark ${c.letter} as correct">
                       </td>
                       <td style="padding:4px 0; width:30px; font-weight:600;">${c.letter})</td>
                       <td style="padding:4px 0;">
                           <input type="text" class="b-c-text" data-qidx="${i}" data-cidx="${ci}" value="${escapeHtml(c.text || '')}" style="width:100%; padding:6px; border:1px solid #ccc; border-radius:3px; font-family:inherit; box-sizing:border-box;">
                       </td>
                    </tr>`;
                });
                qHtml += `</tbody></table>
                    <div style="margin-top:10px;">
                        <input type="text" class="b-q-expl" data-idx="${i}" placeholder="Optional explanation..." value="${escapeHtml(q.explanation || '')}" style="width:100%; padding:6px; font-size:13px; border:1px solid #ccc; border-radius:3px; box-sizing:border-box;">
                    </div>
                </div>`;
            });
            if (builderTest.questions.length === 0) {
                qHtml = `<div style="padding:20px; text-align:center; color:#6e7376; border:1px dashed #ccc; margin-bottom:16px;">No questions yet. Use AI below or add one manually.</div>`;
            }

            takeover(`<div class="pt-page">
                <div class="pt-breadcrumb"><a id="pt-back-list">Practice Test List</a> <span>&rsaquo;</span> <span>Exam Builder</span></div>
                
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; margin-top:16px;">
                    <h1 style="margin:0;">Exam Builder</h1>
                    <div style="display:flex; gap:10px;">
                       <button class="pt-d2l-btn" id="pt-builder-export">Export JSON</button>
                       <button class="pt-d2l-btn pt-d2l-btn-primary" id="pt-builder-save">Save Exam to List</button>
                    </div>
                </div>
                
                <div style="margin-bottom:24px; display:flex; gap:16px;">
                    <div style="flex:1;">
                        <label style="display:block; font-weight:600; font-size:14px; margin-bottom:4px; color:#565a5c;">Exam Name</label>
                        <input type="text" id="pt-builder-name" value="${escapeHtml(builderTest.name)}" style="width:100%; box-sizing:border-box; padding:8px; border:1px solid #ccc; border-radius:4px; font-size:15px; font-family:inherit;">
                    </div>
                    <div style="flex:1;">
                        <label style="display:block; font-weight:600; font-size:14px; margin-bottom:4px; color:#565a5c;">Description</label>
                        <input type="text" id="pt-builder-desc" value="${escapeHtml(builderTest.description || '')}" style="width:100%; box-sizing:border-box; padding:8px; border:1px solid #ccc; border-radius:4px; font-size:15px; font-family:inherit;">
                    </div>
                </div>

                <div style="background:#f9fbfd;border:1px solid #dce8f5;border-radius:4px;padding:20px;margin-bottom:24px;">
                    <h3 style="margin-top:0;margin-bottom:12px;color:#006fbf;font-size:16px;font-weight:600;">AI Question Generator</h3>
                    <div style="margin-bottom:12px;">
                        <label style="font-weight:600;font-size:14px;display:block;margin-bottom:4px;">OpenAI API Key</label>
                        <div style="display:flex; align-items:center;">
                            <input type="password" id="pt-oai-key" value="${escapeHtml(aiKey)}" style="width:320px;padding:6px 10px; border:1px solid #ccc; border-radius:3px; font-family:monospace;" placeholder="sk-...">
                            <a href="https://platform.openai.com/api-keys" target="_blank" style="margin-left:12px;font-size:13px;color:#006fbf;text-decoration:none;">View/Create your API Key &rarr;</a>
                        </div>
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-weight:600;font-size:14px;display:block;margin-bottom:4px;">Prompt & Context</label>
                        <textarea id="pt-oai-prompt" style="width:100%;height:100px;padding:10px;border:1px solid #ccc;border-radius:3px;font-family:inherit;font-size:14px;box-sizing:border-box;" placeholder="Hint: Paste study notes, questions, answers, and any context to help build an exam here..."></textarea>
                    </div>
                    <div style="display:flex; align-items:center;">
                        <button class="pt-d2l-btn pt-d2l-btn-primary" id="pt-generate-btn">Generate Questions with AI</button>
                        <span id="pt-gen-status" style="margin-left:16px;font-size:14px;font-weight:600;color:#555;"></span>
                    </div>
                </div>

                <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:12px;">
                    <h3 style="margin:0; font-size:18px;">Questions (${builderTest.questions.length})</h3>
                    <button class="pt-d2l-btn" id="pt-add-q" style="font-size:13px; padding:6px 12px;">+ Add Empty Question</button>
                </div>
                
                <div id="pt-builder-questions" style="background:#f5f5f5; padding:16px; border-radius:4px; border:1px solid #e6e6e6;">
                    ${qHtml}
                </div>

            </div>`);

            document.getElementById('pt-back-list').addEventListener('click', showTestList);
            
            document.getElementById('pt-builder-name').addEventListener('input', e => builderTest.name = e.target.value);
            document.getElementById('pt-builder-desc').addEventListener('input', e => builderTest.description = e.target.value);
            
            let pEl = document.getElementById('pt-oai-prompt');
            if (pEl && lastPrompt) pEl.value = lastPrompt;
            if (pEl) pEl.addEventListener('input', e => lastPrompt = e.target.value);
            
            document.querySelectorAll('.b-q-text').forEach(t => t.addEventListener('input', e => builderTest.questions[e.target.dataset.idx].text = e.target.value));
            document.querySelectorAll('.b-c-text').forEach(t => t.addEventListener('input', e => builderTest.questions[e.target.dataset.qidx].choices[e.target.dataset.cidx].text = e.target.value));
            document.querySelectorAll('.b-q-expl').forEach(t => t.addEventListener('input', e => builderTest.questions[e.target.dataset.idx].explanation = e.target.value));
            
            document.querySelectorAll('input[type="radio"][name^="bq_"]').forEach(r => r.addEventListener('change', e => {
                let idx = e.target.name.split('_')[1];
                builderTest.questions[idx].correctAnswer = e.target.value;
            }));

            document.querySelectorAll('.b-del-q').forEach(btn => btn.addEventListener('click', e => {
                let idx = e.target.dataset.idx;
                if (confirm('Remove this question?')) {
                    builderTest.questions.splice(idx, 1);
                    renderBuilder();
                }
            }));

            document.getElementById('pt-add-q').addEventListener('click', () => {
                builderTest.questions.push({
                    id: genId(),
                    text: '',
                    choices: [ {letter:'A', text:''}, {letter:'B', text:''}, {letter:'C', text:''}, {letter:'D', text:''} ],
                    correctAnswer: 'A',
                    explanation: ''
                });
                renderBuilder();
                setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 50);
            });

            document.getElementById('pt-builder-save').addEventListener('click', () => {
                let qErr = builderTest.questions.findIndex(q => !q.text.trim());
                if (qErr !== -1) {
                    alert('Question ' + (qErr+1) + ' is missing text. Please fill it out or delete it before saving.');
                    return;
                }
                if (!builderTest.name.trim()) return alert("Exam name is required.");
                
                let existingIdx = PRACTICE_TESTS.findIndex(t => t.id === builderTest.id);
                if (existingIdx !== -1) PRACTICE_TESTS[existingIdx] = builderTest;
                else PRACTICE_TESTS.unshift(builderTest);
                
                persistExamData();
                alert("Exam saved securely!");
                showTestList();
            });

            document.getElementById('pt-builder-export').addEventListener('click', () => {
                let jsonStr = JSON.stringify([builderTest], null, 2);
                let blob = new Blob([jsonStr], { type: "application/json" });
                let url = URL.createObjectURL(blob);
                let a = document.createElement("a");
                a.href = url;
                a.download = (builderTest.name || "Custom_Exam").replace(/[^a-z0-9]/gi, '_').toLowerCase() + ".json";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });

            document.getElementById('pt-generate-btn').addEventListener('click', () => {
                let key = document.getElementById('pt-oai-key').value.trim();
                let promptText = document.getElementById('pt-oai-prompt').value.trim();
                if (!key) return alert("Please enter an OpenAI API key.");
                if (!promptText) return alert("Please enter context/study notes for the AI to parse.");
                GM_setValue('pt_openai_key', key);
                aiKey = key;
                
                let btn = document.getElementById('pt-generate-btn');
                let stat = document.getElementById('pt-gen-status');
                btn.disabled = true;
                stat.textContent = "AI is thinking. This may take a minute...";

                const sysPrompt = `You are an expert test creator. Generate a set of rigorous, humanized, multiple-choice questions based on the provided context. Follow these rules exactly:
1. Return ONLY valid JSON matching this array format:
[
  { "id": "generated_id", "text": "Question?", "choices": [ {"letter":"A", "text":"Choice 1"}, {"letter":"B", "text":"Choice 2"}, {"letter":"C", "text":"Choice 3"}, {"letter":"D", "text":"Choice 4"} ], "correctAnswer": "C", "explanation": "Why." }
]
2. Include exactly 4 choices labeled A, B, C, D.
3. Generate between 5 to 15 useful questions strictly driven from the provided text.
4. Output nothing but the raw JSON array.`;

                GM_xmlhttpRequest({
                    method: 'POST',
                    url: 'https://api.openai.com/v1/chat/completions',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + key
                    },
                    data: JSON.stringify({
                        model: 'gpt-4o',
                        messages: [
                            { role: 'system', content: sysPrompt },
                            { role: 'user', content: promptText }
                        ],
                        temperature: 0.7
                    }),
                    onload(res) {
                        btn.disabled = false;
                        if (res.status === 401) {
                            alert("Invalid API Key. Please check it and try again.");
                            stat.textContent = "Error: Invalid API Key";
                            return;
                        }
                        if (res.status !== 200) {
                            alert("API Error: " + res.status + " " + res.responseText);
                            stat.textContent = "API Error";
                            return;
                        }
                        try {
                            let data = JSON.parse(res.responseText);
                            let text = data.choices[0].message.content.trim();
                            if (text.startsWith('```json')) {
                                text = text.substring(7);
                                if (text.endsWith('```')) text = text.substring(0, text.length-3);
                            } else if (text.startsWith('```')) {
                                text = text.substring(3);
                                if (text.endsWith('```')) text = text.substring(0, text.length-3);
                            }
                            let added = JSON.parse(text);
                            if (!Array.isArray(added)) throw new Error("JSON is not an array");
                            
                            added.forEach(q => {
                                q.id = genId();
                                builderTest.questions.push(q);
                            });
                            lastPrompt = '';
                            renderBuilder();
                            setTimeout(() => { document.getElementById('pt-gen-status').textContent = "Successfully generated " + added.length + " questions!"; }, 100);
                        } catch(e) {
                             alert("Error parsing AI response: " + e.message);
                             stat.textContent = "Extraction Error";
                        }
                    },
                    onerror(err) {
                        btn.disabled = false;
                        stat.textContent = "Network error calling OpenAI.";
                    }
                });
            });
        }
        
        renderBuilder();
    }

    function showTestList() {
        if (PRACTICE_TESTS && PRACTICE_TESTS.length) {
            renderTestList();
            return;
        }
        try {
            const cached = GM_getValue(EXAM_CACHE_KEY, '');
            if (cached) {
                PRACTICE_TESTS = normalizeExamPayload(JSON.parse(cached));
                renderTestList();
                return;
            }
        } catch (e) {
            GM_setValue(EXAM_CACHE_KEY, '');
        }
        const url = typeof EXAM_DATA_URL === 'string' && EXAM_DATA_URL.trim();
        if (url) {
            takeover(`<div class="pt-page"><h1>Practice Tests</h1><p>Loading exam data…</p></div>`);
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload(res) {
                    if (res.status !== 200) {
                        takeover(`<div class="pt-page"><h1>Practice Tests</h1><p>Could not load exam (HTTP ${res.status}). Check <code>EXAM_DATA_URL</code>.</p><button class="pt-d2l-btn" id="pt-load-file">Load JSON file instead</button></div>`);
                        document.getElementById('pt-load-file').addEventListener('click', showLoadExamUI);
                        return;
                    }
                    try {
                        applyExamJsonString(res.responseText);
                        renderTestList();
                    } catch (e) {
                        alert('Invalid exam JSON: ' + (e && e.message ? e.message : e));
                        showLoadExamUI();
                    }
                },
                onerror() {
                    takeover(`<div class="pt-page"><h1>Practice Tests</h1><p>Network error loading exam URL.</p><button class="pt-d2l-btn" id="pt-load-file">Load JSON file instead</button></div>`);
                    document.getElementById('pt-load-file').addEventListener('click', showLoadExamUI);
                }
            });
            return;
        }
        PRACTICE_TESTS = [];
        renderTestList();
    }

    // ── STORAGE ──
    function getAttempts(testId) {
        try { return JSON.parse(GM_getValue(`pt_${testId}`, '[]')); } catch { return []; }
    }
    function saveAttempt(testId, attempt) {
        const a = getAttempts(testId); a.push(attempt);
        GM_setValue(`pt_${testId}`, JSON.stringify(a));
    }
    function clearAttempts(testId) {
        GM_setValue(`pt_${testId}`, '[]');
    }

    // ── EXTRACT COURSE ID ──
    function getCourseId() {
        const m = window.location.pathname.match(/\/d2l\/[^/]+\/(\d+)/);
        if (m) return m[1];
        const m2 = window.location.search.match(/ou=(\d+)/);
        return m2 ? m2[1] : null;
    }

    // ── PAGE BUILDER: replaces D2L main content area ──
    function getMainContent() {
        return document.querySelector('.d2l-page-main') ||
               document.querySelector('#ContentView') ||
               document.querySelector('.d2l-main-content') ||
               document.querySelector('[role="main"]') ||
               document.querySelector('.d2l-body');
    }

    /** @type {DocumentFragment|null} Saved D2L main-region nodes (no innerHTML read/write for AMO linter). */
    let savedMainFragment = null;
    let practiceTestActive = false;
    let practiceSessionRestoreAttempted = false;
    let practiceSessionRestoreScheduled = false;
    let csSessionRestoreAttempted = false;
    let csSessionRestoreScheduled = false;
    let tasksSessionRestoreAttempted = false;
    let tasksSessionRestoreScheduled = false;
    let csHighlightTimer = null;
    /** In-memory for Tasks & To-Do re-filter without re-fetch. */
    let tasksDataCache = null;

    function takeover(html) {
        if (csHighlightTimer) {
            clearInterval(csHighlightTimer);
            csHighlightTimer = null;
        }
        const main = getMainContent();
        if (!main) { alert('Could not find D2L content area.'); return; }
        if (!practiceTestActive) {
            savedMainFragment = document.createDocumentFragment();
            while (main.firstChild) {
                savedMainFragment.appendChild(main.firstChild);
            }
            savedMainOverflow = main.style.overflow;
            savedMainMaxHeight = main.style.maxHeight;
            savedMainHeight = main.style.height;
            practiceTestActive = true;
        }
        main.style.overflow = 'visible';
        main.style.maxHeight = 'none';
        main.style.height = 'auto';
        elcSetHtml(main, html);
        let el = main.parentElement;
        while (el && el !== document.body) {
            if (getComputedStyle(el).overflow === 'hidden') {
                el.style.overflow = 'visible';
            }
            el = el.parentElement;
        }
        window.scrollTo(0, 0);
    }

    let savedMainOverflow = null;
    let savedMainMaxHeight = null;
    let savedMainHeight = null;

    function restore() {
        if (savedMainFragment === null) return;
        const main = getMainContent();
        if (main) {
            main.replaceChildren();
            main.appendChild(savedMainFragment);
            main.style.overflow = savedMainOverflow || '';
            main.style.maxHeight = savedMainMaxHeight || '';
            main.style.height = savedMainHeight || '';
        }
        savedMainFragment = null;
        practiceTestActive = false;
    }

    // ── CSS (D2L-native look) ──
    const css = document.createElement('style');
    css.textContent = `
.pt-page { max-width: 960px; margin: 0 auto; padding: 24px 20px 60px; font-family: 'Lato','Open Sans',sans-serif; color: #333; }
.pt-page h1 { font-size: 28px; font-weight: 300; color: #333; margin: 0 0 24px; }
.pt-breadcrumb { font-size: 14px; margin-bottom: 8px; }
.pt-breadcrumb a { color: #006fbf; text-decoration: none; cursor: pointer; }
.pt-breadcrumb a:hover { text-decoration: underline; }
.pt-breadcrumb span { color: #6e7376; }
.pt-table { width: 100%; border-collapse: collapse; background: #fff; }
.pt-table th { text-align: left; padding: 10px 16px; background: #f5f5f5; border-bottom: 2px solid #ddd; font-size: 13px; font-weight: 600; color: #6e7376; }
.pt-table td { padding: 14px 16px; border-bottom: 1px solid #e6e6e6; font-size: 14px; vertical-align: top; }
.pt-table tr:hover td { background: #fafbfc; }
.pt-test-link { color: #006fbf; text-decoration: none; cursor: pointer; font-weight: 400; }
.pt-test-link:hover { text-decoration: underline; }
.pt-detail-label { font-weight: 700; font-size: 14px; color: #333; margin-bottom: 4px; margin-top: 20px; }
.pt-detail-value { font-size: 16px; color: #333; margin-bottom: 0; }
.pt-d2l-btn { display: inline-block; padding: 8px 20px; border-radius: 4px; font-size: 14px; font-weight: 400; cursor: pointer; border: 1px solid #787a7c; background: #fff; color: #333; text-decoration: none; line-height: 1.4; }
.pt-d2l-btn:hover { background: #f2f2f2; }
.pt-d2l-btn-primary { background: #006fbf; color: #fff; border-color: #006fbf; }
.pt-d2l-btn-primary:hover { background: #004489; border-color: #004489; }

/* ── Quiz layout with sidebar ── */
.pt-quiz-layout { display: flex; gap: 0; font-family: 'Lato','Open Sans',sans-serif; min-height: 600px; }
.pt-sidebar { width: 210px; flex-shrink: 0; border-right: 1px solid #e6e6e6; background: #fff; position: sticky; top: 0; align-self: flex-start; max-height: 100vh; overflow-y: auto; }
.pt-sidebar-title { font-size: 14px; font-weight: 700; color: #202020; padding: 12px 12px 8px; margin: 0; text-transform: none; letter-spacing: 0; border-bottom: none; }
.pt-sidebar-list { list-style: none; margin: 0; padding: 0 10px 14px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.pt-sidebar-list li { margin: 0; width: 100%; min-width: 0; }
.pt-sidebar-list li a { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; width: 100%; min-height: 52px; padding: 8px 2px 6px; box-sizing: border-box; color: #006fbf; text-decoration: none; cursor: pointer; border: 1px solid #c8c9ca; border-radius: 3px; background: #fff; gap: 4px; transition: background 0.12s, border-color 0.12s; }
.pt-sidebar-num { font-size: 14px; font-weight: 400; line-height: 1.15; }
.pt-sidebar-check { display: flex; align-items: center; justify-content: center; min-height: 14px; margin-top: 2px; }
.pt-sidebar-check-mark { font-size: 13px; font-weight: 600; color: #bdbdbd; opacity: 0.4; line-height: 1; }
.pt-sidebar-check.answered .pt-sidebar-check-mark { opacity: 1; color: #757575; }
.pt-sidebar-check.correct .pt-sidebar-check-mark { opacity: 1; color: #2e7d32; }
.pt-sidebar-check.incorrect .pt-sidebar-check-mark { opacity: 1; color: #c62828; }
.pt-sidebar-check.skipped .pt-sidebar-check-mark { opacity: 0.35; color: #bdbdbd; }
.pt-sidebar-list li a:hover { background: #fafafa; }
.pt-sidebar-list li a.active { border-color: #006fbf; box-shadow: 0 0 0 1px #006fbf; background: #fff; }
.pt-sidebar-list li a.active .pt-sidebar-num { font-weight: 700; }
.pt-quiz-main { flex: 1; min-width: 0; padding: 0 24px 80px; }

.pt-quiz-mc-bar { background: #565a5c; color: #fff; font-size: 15px; font-weight: 700; padding: 10px 14px; margin: 12px 0 0; border-radius: 2px 2px 0 0; border-bottom: 1px solid #46494b; }
.pt-quiz-mc-bar + .pt-single-nav + .pt-q-block .pt-q-header-bar { border-top: none; }
.pt-quiz-mc-bar + .pt-q-block .pt-q-header-bar { border-top: none; }
.pt-q-hidden { display: none !important; }
.pt-single-nav { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 0 10px; margin: 0; border-bottom: 1px solid #e6e6e6; }
.pt-single-nav-pos { font-size: 14px; font-weight: 600; color: #565a5c; }
.pt-single-nav .pt-d2l-btn:disabled { opacity: 0.45; cursor: default; }
.pt-q-block { margin: 0 0 0; padding: 0 0 20px; scroll-margin-top: 10px; border-bottom: 1px solid #e0e0e0; }
.pt-q-block:last-of-type { border-bottom: none; }
.pt-q-header-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #e8e9ea; padding: 10px 14px; margin: 0; border: 1px solid #d0d2d3; border-bottom: none; }
.pt-q-header-bar .pt-q-header { display: block; margin: 0; padding: 0; font-size: 16px; font-weight: 700; color: #000; background: none; border: none; line-height: 1.3; }
.pt-q-header-bar .pt-q-pts { font-size: 15px; font-weight: 700; color: #000; white-space: nowrap; }
.pt-q-text { font-size: 15px; line-height: 1.55; margin: 0; padding: 12px 14px 10px; color: #202020; border: 1px solid #d0d2d3; border-top: none; background: #fff; }
.pt-q-choices { padding: 0; margin: 0; border: 1px solid #d0d2d3; border-top: none; background: #fff; }
.pt-q-fieldset { position: relative; border: none; margin: 0; padding: 0; min-width: 0; }
.pt-q-options-legend { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.pt-q-choice-table { width: 100%; border-collapse: collapse; border: none; font-size: 14px; line-height: 1.45; }
.pt-q-choice-table tbody tr.pt-q-choice { border-bottom: 1px solid #e6e6e6; cursor: pointer; }
.pt-q-choice-table tbody tr.pt-q-choice:last-child { border-bottom: none; }
.pt-q-choice-table tbody tr.pt-q-choice:hover { background: #f5f5f5; }
.pt-q-choice-table tbody tr.pt-q-choice:has(input[type="radio"]:checked) { background: #eff3f9 !important; }
.pt-q-choice-table tbody tr.pt-q-choice:has(input[type="radio"]:checked):hover { background: #e5ecf7 !important; }
.pt-q-radio-cell { width: 40px; padding: 8px 6px 8px 12px; vertical-align: middle; text-align: left; }
.pt-q-text-cell { padding: 0; vertical-align: middle; }
.pt-q-text-cell label { display: block; padding: 10px 14px 10px 4px; cursor: pointer; font-weight: 400; color: #202020; }
.pt-q-choice-table input[type="radio"] { width: 16px; height: 16px; max-width: 16px; max-height: 16px; margin: 0; padding: 0; vertical-align: middle; accent-color: #006fbf; cursor: pointer; box-sizing: border-box; }
.pt-q-choice-table tbody tr.pt-q-choice.review-correct { background: #e8f5e9 !important; }
.pt-q-choice-table tbody tr.pt-q-choice.review-incorrect { background: #fdecea !important; }
.pt-q-choice-table tbody tr.pt-q-choice.review-correct:has(input[type="radio"]:checked) { background: #e8f5e9 !important; }
.pt-q-choice-table tbody tr.pt-q-choice.review-incorrect:has(input[type="radio"]:checked) { background: #fdecea !important; }
.pt-q-text-cell .pt-label-tag { float: right; margin: 8px 0 4px 8px; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 3px; }
.pt-label-correct { background: #c8e6c9; color: #2e7d32; }
.pt-label-incorrect { background: #ffcdd2; color: #c62828; }
.pt-submit-bar { background: #fff; border-top: 2px solid #e6e6e6; padding: 16px 0; display: flex; justify-content: center; align-items: center; gap: 16px; margin-top: 24px; }
.pt-results-box { text-align: center; padding: 40px 20px; }
.pt-score-big { font-size: 56px; font-weight: 700; margin-bottom: 4px; color: #333; }
.pt-results-sub { font-size: 16px; color: #6e7376; margin-bottom: 24px; }
.pt-stats-row { display: flex; justify-content: center; gap: 40px; margin-bottom: 28px; }
.pt-stat { text-align: center; }
.pt-stat .num { display: block; font-size: 28px; font-weight: 700; color: #333; }
.pt-stat .lbl { font-size: 12px; color: #6e7376; text-transform: uppercase; }
.pt-attempt-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #e6e6e6; }
.pt-attempt-row:hover { background: #fafbfc; }
.pt-attempt-score { font-weight: 700; font-size: 14px; padding: 4px 10px; border-radius: 3px; color: #333; border: 1px solid #ccc; background: #f5f5f5; }
.pt-progress-info { font-size: 13px; color: #6e7376; margin-bottom: 12px; }
.pt-btn-danger { color: #333; border: 1px solid #787a7c; background: #fff; }
.pt-btn-danger:hover { background: #f2f2f2; }
.pt-quiz-title-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 4px; }
.pt-quiz-title-row h1 { flex: 1; min-width: 200px; margin: 16px 0 4px !important; }
.pt-q-block .pt-idk-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 0; padding: 12px 14px; border: 1px solid #d0d2d3; border-top: none; background: #fafafa; }
.pt-q-block .pt-check-feedback { margin-left: 0; margin-right: 0; }
.pt-q-block .pt-explanation { margin-top: 0; border-radius: 0; border: 1px solid #d0d2d3; border-top: none; }
.pt-idk-bar .pt-idk-right { margin-left: auto; }
.pt-idk-btn { font-size: 13px; }
.pt-idk-btn:disabled { opacity: 0.55; cursor: default; }
.pt-check-btn:disabled { opacity: 0.55; cursor: default; }
.pt-q-choice-table tbody tr.pt-idk-correct { background: #e8f5e9 !important; }
.pt-q-choice-table tbody tr.pt-idk-correct td:first-child { box-shadow: inset 3px 0 0 #2e7d32; }
.pt-q-choice-table tbody tr.pt-idk-correct:has(input[type="radio"]:checked) { background: #e8f5e9 !important; }
.pt-check-feedback { display: none; margin-top: 10px; padding: 10px 12px; border-radius: 4px; font-size: 14px; line-height: 1.45; }
.pt-check-feedback.pt-check-show.pt-check-correct { display: block; background: #e8f5e9; border: 1px solid #a5d6a7; color: #1b5e20; }
.pt-check-feedback.pt-check-show.pt-check-wrong { display: block; background: #ffebee; border: 1px solid #ef9a9a; color: #b71c1c; }
.pt-check-feedback.pt-check-show.pt-check-hint { display: block; background: #fff8e1; border: 1px solid #ffe082; color: #5d4037; }
.pt-explanation { display: none; margin-top: 12px; padding: 12px 14px; background: #f5f9fc; border: 1px solid #dce8f5; border-radius: 4px; font-size: 14px; line-height: 1.55; color: #333; }
.pt-explanation.pt-explanation-visible { display: block; }
.pt-explanation-title { font-weight: 700; color: #006fbf; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px; }

/* ── Course Schedule ── */
.cs-toolbar { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.cs-toolbar-row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.cs-day-details { margin-bottom: 8px; border: 1px solid #e0e0e0; border-radius: 6px; background: #fff; overflow: hidden; }
.cs-day-details > summary { list-style: none; cursor: pointer; font-size: 13px; font-weight: 700; color: #565a5c; padding: 10px 14px; border-bottom: 1px solid #e8e8e8; display: flex; align-items: center; justify-content: space-between; user-select: none; }
.cs-day-details > summary::-webkit-details-marker { display: none; }
.cs-day-details > summary::after { content: '\\25BC'; font-size: 10px; color: #888; transition: transform 0.15s; }
.cs-day-details[open] > summary::after { transform: rotate(-180deg); }
.cs-day-details.cs-day-details-today > summary { color: #006fbf; border-bottom-color: #b8d4eb; background: #f7fbfd; }
.cs-day-details.cs-day-details-today[open] > summary { border-bottom-color: #006fbf; }
.cs-day-details-body { padding: 0 4px 4px; }
.cs-day-section { margin-bottom: 12px; }
.cs-schedule-row { display: flex; gap: 16px; align-items: flex-start; padding: 10px 8px; border-bottom: 1px solid #f0f0f0; border-radius: 4px; transition: background 0.2s, box-shadow 0.2s; }
.cs-schedule-row:last-child { border-bottom: none; }
.cs-schedule-row:hover { background: #fafbfc; }
.cs-schedule-row.cs-schedule-row-current { background: #e8f5e9 !important; box-shadow: inset 3px 0 0 #2e7d32; }
.cs-schedule-row.cs-schedule-row-upnext { background: #fff8e1 !important; box-shadow: inset 3px 0 0 #f9a825; }
.cs-schedule-time { font-size: 13px; font-weight: 700; color: #006fbf; white-space: nowrap; min-width: 140px; padding-top: 1px; }
.cs-schedule-time-wrap { min-width: 158px; flex-shrink: 0; padding-top: 1px; }
.cs-time-display { font-size: 13px; font-weight: 700; color: #006fbf; white-space: nowrap; }
.cs-time-display.cs-schedule-time-past { color: #aaa; }
.cs-time-edited-tag { font-size: 10px; font-weight: 600; color: #8d6e63; margin-left: 4px; vertical-align: middle; }
.cs-time-edit-row { margin-bottom: 6px; }
.cs-time-edit-row label { font-size: 12px; color: #565a5c; display: block; }
.cs-time-edit-row input { margin-top: 2px; padding: 4px 6px; width: 100px; max-width: 100%; border: 1px solid #ccc; border-radius: 3px; font-size: 13px; font-family: inherit; box-sizing: border-box; }
.cs-time-edit-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
.cs-schedule-time-past { color: #aaa; }
.cs-schedule-info { flex: 1; min-width: 0; }
.cs-schedule-title { font-size: 15px; font-weight: 500; color: #202020; margin-bottom: 2px; }
.cs-schedule-title a { color: #006fbf; text-decoration: none; }
.cs-schedule-title a:hover { text-decoration: underline; }
.cs-schedule-sub { font-size: 13px; color: #6e7376; }
.cs-async-label { font-size: 13px; font-weight: 600; color: #aaa; white-space: nowrap; min-width: 140px; padding-top: 1px; }
.cs-live-pill { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; vertical-align: middle; }
.cs-live-pill-now { background: #c8e6c9; color: #1b5e20; }
.cs-live-pill-next { background: #ffe082; color: #5d4037; }

/* ── Tasks & To-Do ── */
.pt-tasks-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-bottom: 16px; }
.pt-tasks-toolbar label { font-size: 13px; color: #565a5c; display: flex; align-items: center; gap: 6px; }
.pt-tasks-toolbar select { font-size: 14px; padding: 6px 8px; border: 1px solid #c8c9ca; border-radius: 4px; font-family: inherit; }
.pt-tasks-toolbar .pt-tasks-ck { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #333; }
.pt-tasks-cache-hint { font-size: 12px; color: #888; }
.pt-tasks-section { margin: 16px 0; }
.pt-tasks-section h2 { font-size: 16px; font-weight: 700; color: #202020; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 2px solid #e6e6e6; }
.pt-tasks-details { margin: 10px 0; border: 1px solid #e0e0e0; border-radius: 6px; background: #fff; overflow: hidden; }
.pt-tasks-details > summary { cursor: pointer; list-style: none; font-size: 15px; font-weight: 600; color: #202020; padding: 10px 12px; background: #f5f5f5; }
.pt-tasks-details > summary::-webkit-details-marker { display: none; }
.pt-tasks-details > summary::after { content: '\\00a0\\25BC'; float: right; font-size: 10px; color: #888; }
.pt-tasks-details[open] > summary { border-bottom: 1px solid #e8e8e8; }
.pt-tasks-details[open] > summary::after { transform: rotate(0deg); }
.pt-tasks-details-in { padding: 4px 6px; }
.pt-tasks-course { margin: 8px 0; padding: 0; border: none; background: transparent; }
.pt-tasks-course > .pt-tasks-details { background: #fafbfc; }
.pt-tasks-course h3 { font-size: 15px; font-weight: 600; color: #006fbf; margin: 0 0 10px; }
.pt-tasks-list { list-style: none; margin: 0; padding: 0; }
.pt-tasks-list li { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 16px; padding: 10px 8px; border-bottom: 1px solid #eee; font-size: 14px; border-radius: 4px; }
.pt-tasks-list li:last-child { border-bottom: none; }
.pt-tasks-row--urgent { background: #fff8e1 !important; box-shadow: inset 3px 0 0 #ffc107; }
.pt-tasks-row--overdue { background: #ffebee !important; }
.pt-tasks-type { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #888; min-width: 100px; padding-top: 1px; }
.pt-tasks-title { flex: 1; min-width: 0; }
.pt-tasks-title a { color: #006fbf; text-decoration: none; }
.pt-tasks-title a:hover { text-decoration: underline; }
.pt-tasks-meta { font-size: 12px; color: #6e7376; white-space: nowrap; }
.pt-tasks-bycourse { font-size: 12px; color: #888; }
.pt-tasks-err { color: #b71c1c; font-size: 14px; margin: 6px 0; }
.pt-tasks-hint { font-size: 13px; color: #6e7376; margin: 4px 0 12px; }
.pt-tasks-quad-wrap { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
.pt-tasks-quad-ov { border: 1px solid #ef9a9a; border-radius: 6px; padding: 8px; background: #fff5f5; }
.pt-tasks-quad-ov h4 { margin: 0 0 6px; font-size: 14px; color: #b71c1c; }
.pt-tasks-quad { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 700px) { .pt-tasks-quad { grid-template-columns: 1fr; } }
.pt-tasks-q { border: 1px solid #d0d0d0; border-radius: 6px; background: #fafafa; min-height: 80px; }
.pt-tasks-q h4 { margin: 0; padding: 8px 10px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; color: #555; background: #eee; }
.pt-tasks-q .pt-tasks-list { max-height: 220px; overflow-y: auto; }
.pt-tasks-q-urgent { border-color: #ffe082; background: #fffef7; }
.pt-tasks-q-urgent h4 { background: #fff8e1; color: #856404; }
.pt-tasks-q-late h4 { color: #b71c1c; }
    `;
    document.head.appendChild(css);

    // ── PAGES ──
    function showTestSummary(test) {
        const attempts = getAttempts(test.id);
        let historyHtml = '';
        if (attempts.length) {
            historyHtml = `<div class="pt-detail-label" style="margin-top:32px;">Previous Attempts</div>`;
            [...attempts].reverse().forEach((a, i) => {
                const d = new Date(a.date);
                const pc = a.percentage.toFixed(0);
                historyHtml += `<div class="pt-attempt-row">
                    <div><span style="font-size:14px;font-weight:500;">Attempt ${attempts.length-i}</span>
                    <span style="font-size:12px;color:#6e7376;margin-left:12px;">${d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})} ${d.toLocaleTimeString()}</span>
                    <span style="font-size:12px;color:#6e7376;margin-left:12px;">${a.correct}/${a.total} correct</span></div>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <a class="pt-test-link pt-review-link" data-aidx="${attempts.length-1-i}">Review</a>
                        <span class="pt-attempt-score">${pc}%</span>
                    </div>
                </div>`;
            });
            historyHtml += `<div style="margin-top:16px;"><button class="pt-d2l-btn pt-btn-danger" id="pt-clear-attempts">Delete All Attempts</button></div>`;
        }
        takeover(`<div class="pt-page">
            <div class="pt-breadcrumb"><a id="pt-back-list">Practice Test List</a> <span>&rsaquo; Summary</span></div>
            <h1>Summary - ${test.name}</h1>
            <div class="pt-detail-label">Description</div>
            <p class="pt-detail-value">${test.description}</p>
            <div class="pt-detail-label">Questions</div>
            <p class="pt-detail-value">${poolSummaryLine(test)}</p>
            <div class="pt-detail-label">Attempts</div>
            <p class="pt-detail-value">Allowed - unlimited, Completed - ${attempts.length}</p>
            <div class="pt-detail-label" style="margin-top:24px;">Test layout</div>
            <p class="pt-detail-value" style="margin-bottom:8px;">Choose how questions appear during the attempt.</p>
            <div class="pt-display-mode-options" style="display:flex;flex-direction:column;gap:10px;margin-bottom:8px;font-size:15px;">
                <label style="cursor:pointer;display:flex;align-items:flex-start;gap:10px;">
                    <input type="radio" name="pt-display-mode" value="all"${getDefaultDisplayMode(test) === 'all' ? ' checked' : ''}>
                    <span>All questions on one page (scroll through the full attempt)</span>
                </label>
                <label style="cursor:pointer;display:flex;align-items:flex-start;gap:10px;">
                    <input type="radio" name="pt-display-mode" value="single"${getDefaultDisplayMode(test) === 'single' ? ' checked' : ''}>
                    <span>One question at a time (use Next and Previous to move)</span>
                </label>
            </div>
            <div style="margin-top: 20px;">
                <button class="pt-d2l-btn pt-d2l-btn-primary" id="pt-start">Start Quiz!</button>
            </div>
            ${historyHtml}
        </div>`);
        savePracticeRoute('summary', test.id);
        document.getElementById('pt-back-list').addEventListener('click', showTestList);
        document.getElementById('pt-start').addEventListener('click', () => {
            const sel = document.querySelector('input[name="pt-display-mode"]:checked');
            const mode = sel && (sel.value === 'single' || sel.value === 'all') ? sel.value : 'all';
            GM_setValue('pt_display_mode_pref_' + test.id, mode);
            showQuiz(test, mode);
        });
        const clearBtn = document.getElementById('pt-clear-attempts');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (confirm('Are you sure you want to delete all attempts for this test?')) {
                    clearAttempts(test.id);
                    showTestSummary(test);
                }
            });
        }
        document.querySelectorAll('.pt-review-link').forEach(link => {
            link.addEventListener('click', () => {
                const idx = parseInt(link.dataset.aidx);
                showReview(test, attempts[idx]);
            });
        });
    }

    function buildSidebarItems(questions, mode, attempt) {
        return questions.map((q, i) => {
            let checkClass = 'pt-sidebar-check';
            if (mode === 'review' && attempt) {
                const r = attempt.results.find(x => x.questionId === q.id);
                if (!r || !r.userAnswer) checkClass += ' skipped';
                else if (r.isCorrect) checkClass += ' correct';
                else checkClass += ' incorrect';
            }
            return `<li><a data-qnav="${q.id}" data-q-idx="${i}" title="Question ${i + 1}">
                <span class="pt-sidebar-num">${i + 1}</span>
                <span class="${checkClass}" id="pt-dot-${q.id}"><span class="pt-sidebar-check-mark" aria-hidden="true">&#10003;</span></span>
            </a></li>`;
        }).join('');
    }

    function attachSidebarNav(displayMode, onSingleNavigate) {
        document.querySelectorAll('[data-qnav]').forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                if (displayMode === 'single' && typeof onSingleNavigate === 'function') {
                    const idx = parseInt(link.dataset.qIdx, 10);
                    if (!Number.isNaN(idx)) onSingleNavigate(idx);
                    return;
                }
                const qid = link.dataset.qnav;
                const target = document.getElementById('pt-qblock-' + qid);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                document.querySelectorAll('[data-qnav]').forEach(l => l.classList.remove('active'));
                link.classList.add('active');
            });
        });
    }

    function attachQuizChoiceRowClicks() {
        document.querySelectorAll('.pt-q-choice-table tbody tr').forEach(tr => {
            tr.addEventListener('click', e => {
                const el = e.target;
                if (el && (el.tagName === 'INPUT' || el.tagName === 'LABEL' || el.closest && el.closest('label'))) return;
                const radio = tr.querySelector('input[type="radio"]');
                if (radio && !radio.disabled) {
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        });
    }

    function showQuiz(test, displayModeOverride) {
        savePracticeRoute('attempt', test.id);
        const draftKey = 'pt_draft_' + test.id;
        const take = resolveAttemptSize(test);
        const pool = test.questions;
        let draft = null;
        try {
            const raw = GM_getValue(draftKey, '');
            if (raw) draft = JSON.parse(raw);
        } catch (e) { /* ignore */ }

        let displayMode = 'all';
        if (typeof displayModeOverride === 'string' && (displayModeOverride === 'all' || displayModeOverride === 'single')) {
            displayMode = displayModeOverride;
        } else if (draft && (draft.displayMode === 'all' || draft.displayMode === 'single')) {
            displayMode = draft.displayMode;
        } else {
            displayMode = getDefaultDisplayMode(test);
        }

        let quizQuestions;
        const userAnswers = {};
        const idkRevealed = new Set();
        try {
            if (draft && Array.isArray(draft.questionOrder) && draft.questionOrder.length) {
                const ordered = draft.questionOrder.map(id => pool.find(q => String(q.id) === String(id))).filter(Boolean);
                if (ordered.length === take) {
                    quizQuestions = ordered;
                    if (draft.answers && typeof draft.answers === 'object') {
                        Object.keys(draft.answers).forEach(k => { userAnswers[String(k)] = draft.answers[k]; });
                    }
                    if (Array.isArray(draft.idk)) draft.idk.forEach(x => idkRevealed.add(String(x)));
                }
            }
        } catch (e) { /* ignore bad draft */ }
        if (!quizQuestions) {
            quizQuestions = shuffleAndTake(pool, take);
            GM_setValue(draftKey, JSON.stringify({
                questionOrder: quizQuestions.map(q => q.id),
                answers: {},
                idk: [],
                displayMode,
                currentIndex: 0
            }));
        }
        const quizCount = quizQuestions.length;

        let currentIndex = 0;
        if (displayMode === 'single' && draft && draft.displayMode === 'single' &&
            Array.isArray(draft.questionOrder) &&
            draft.questionOrder.join('|') === quizQuestions.map(q => q.id).join('|') &&
            typeof draft.currentIndex === 'number') {
            currentIndex = Math.max(0, Math.min(draft.currentIndex, quizCount - 1));
        }

        function saveDraft() {
            GM_setValue(draftKey, JSON.stringify({
                questionOrder: quizQuestions.map(q => q.id),
                answers: { ...userAnswers },
                idk: [...idkRevealed],
                displayMode,
                currentIndex: displayMode === 'single' ? currentIndex : 0
            }));
        }

        function updateSingleView() {
            if (displayMode !== 'single') return;
            quizQuestions.forEach((q, i) => {
                const el = document.getElementById('pt-qblock-' + q.id);
                if (!el) return;
                el.classList.toggle('pt-q-hidden', i !== currentIndex);
            });
            document.querySelectorAll('[data-qnav]').forEach(link => {
                const idx = parseInt(link.dataset.qIdx, 10);
                if (!Number.isNaN(idx)) link.classList.toggle('active', idx === currentIndex);
            });
            const pos = document.getElementById('pt-single-pos');
            if (pos) pos.textContent = `Question ${currentIndex + 1} of ${quizCount}`;
            const prev = document.getElementById('pt-prev-q');
            const next = document.getElementById('pt-next-q');
            if (prev) prev.disabled = currentIndex <= 0;
            if (next) next.disabled = currentIndex >= quizCount - 1;
            saveDraft();
        }

        function buildExplanationInner(q) {
            const correctLine = q.choices.find(c => c.letter === q.correctAnswer);
            const body = (q.explanation && String(q.explanation).trim())
                ? escapeHtml(q.explanation).replace(/\n/g, '<br>')
                : ('The correct answer is <strong>' + escapeHtml(q.correctAnswer) + ')</strong> ' + escapeHtml(correctLine ? correctLine.text : '') + '.');
            return '<div class="pt-explanation-title">Explanation</div><div class="pt-explanation-body">' + body + '</div>';
        }

        function updateProgressLine() {
            const n = new Set([...Object.keys(userAnswers), ...idkRevealed]).size;
            const el = document.getElementById('pt-prog');
            if (el) el.textContent = `${n} of ${quizCount} answered or revealed`;
        }

        function syncDotsFromState() {
            quizQuestions.forEach(q => {
                const qid = String(q.id);
                const dot = document.getElementById('pt-dot-' + qid);
                if (!dot) return;
                const touched = userAnswers[qid] !== undefined || idkRevealed.has(qid);
                dot.classList.toggle('answered', touched);
            });
        }

        function revealIdk(qid) {
            const q = quizQuestions.find(x => String(x.id) === String(qid));
            if (!q || idkRevealed.has(String(qid))) return;
            const idkBtn = document.querySelector('.pt-idk-btn[data-idk-qid="' + qid + '"]');
            if (idkBtn) idkBtn.disabled = true;
            idkRevealed.add(String(qid));
            document.querySelectorAll('.pt-q-choice[data-qid="' + qid + '"]').forEach(lab => {
                const inp = lab.querySelector('input[type="radio"]');
                if (inp) inp.disabled = true;
                if (lab.dataset.letter === q.correctAnswer) lab.classList.add('pt-idk-correct');
            });
            const box = document.getElementById('pt-expl-' + qid);
            if (box) {
                box.innerHTML = buildExplanationInner(q);
                box.classList.add('pt-explanation-visible');
            }
            const chkBtn = document.querySelector('.pt-check-btn[data-check-qid="' + qid + '"]');
            if (chkBtn) chkBtn.disabled = true;
            updateProgressLine();
            saveDraft();
            const dot = document.getElementById('pt-dot-' + qid);
            if (dot) dot.classList.add('answered');
        }

        const singleNavHtml = displayMode === 'single'
            ? `<div class="pt-single-nav" id="pt-single-nav">
                <button type="button" class="pt-d2l-btn" id="pt-prev-q">Previous</button>
                <span class="pt-single-nav-pos" id="pt-single-pos">Question ${currentIndex + 1} of ${quizCount}</span>
                <button type="button" class="pt-d2l-btn pt-d2l-btn-primary" id="pt-next-q">Next</button>
            </div>`
            : '';

        let questionsHtml = '';
        quizQuestions.forEach((q, i) => {
            const qid = String(q.id);
            const idkOn = idkRevealed.has(qid);
            const sel = userAnswers[qid];
            const choicesHtml = q.choices.map(c => {
                const checked = sel === c.letter ? ' checked' : '';
                const dis = idkOn ? ' disabled' : '';
                const cls = (idkOn && c.letter === q.correctAnswer) ? ' pt-idk-correct' : '';
                const rid = 'pt_r_' + String(q.id).replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + c.letter;
                return `<tr class="pt-q-choice${cls}" data-qid="${q.id}" data-letter="${c.letter}">
                    <td class="pt-q-radio-cell"><input type="radio" id="${rid}" name="ptq_${q.id}" value="${c.letter}"${checked}${dis}></td>
                    <td class="pt-q-text-cell"><label for="${rid}">${c.letter}) ${c.text}</label></td>
                </tr>`;
            }).join('');
            const explHtml = idkOn ? buildExplanationInner(q) : '';
            const explVis = idkOn ? ' pt-explanation-visible' : '';
            const idkDis = idkOn ? ' disabled' : '';
            const hiddenCls = displayMode === 'single' && i !== currentIndex ? ' pt-q-hidden' : '';
            questionsHtml += `<div class="pt-q-block${hiddenCls}" id="pt-qblock-${q.id}">
                <div class="pt-q-header-bar">
                    <h2 class="pt-q-header"><strong>Question ${i + 1}</strong></h2>
                    <span class="pt-q-pts">1 / 1 points</span>
                </div>
                <div class="pt-q-text">${q.text}</div>
                <div class="pt-q-choices">
                <fieldset class="pt-q-fieldset">
                <legend class="pt-q-options-legend">Question ${i + 1} options</legend>
                <table class="pt-q-choice-table" role="presentation"><tbody>${choicesHtml}</tbody></table>
                </fieldset>
                </div>
                <div class="pt-idk-bar">
                    <div class="pt-idk-left">
                        <button type="button" class="pt-d2l-btn pt-check-btn" data-check-qid="${q.id}"${idkDis}>Check Answer</button>
                    </div>
                    <div class="pt-idk-right">
                        <button type="button" class="pt-d2l-btn pt-idk-btn" data-idk-qid="${q.id}"${idkDis}>I don't know.</button>
                    </div>
                </div>
                <div class="pt-check-feedback" id="pt-check-${q.id}" aria-live="polite"></div>
                <div class="pt-explanation${explVis}" id="pt-expl-${q.id}" aria-live="polite">${explHtml}</div>
            </div>`;
        });
        const sidebarItems = buildSidebarItems(quizQuestions, 'quiz', null);
        takeover(`<div class="pt-breadcrumb" style="padding:12px 20px 0;"><a id="pt-back-list">Practice Test List</a> <span>&rsaquo;</span> <a id="pt-back-summary">${test.name}</a> <span>&rsaquo; Attempt</span></div>
        <div class="pt-quiz-layout">
            <div class="pt-sidebar">
                <div class="pt-sidebar-title">Page 1:</div>
                <ul class="pt-sidebar-list">${sidebarItems}</ul>
            </div>
            <div class="pt-quiz-main">
                <div class="pt-quiz-title-row">
                    <h1 style="font-size:24px;font-weight:300;">${test.name}</h1>
                    <button type="button" class="pt-d2l-btn" id="pt-clear-all">Clear all answers</button>
                </div>
                <p class="pt-progress-info" style="font-size:13px;color:#6e7376;margin:0 0 8px;">This attempt: ${quizCount} questions drawn at random from ${test.questions.length} in the bank.</p>
                <div class="pt-progress-info" id="pt-prog">0 of ${quizCount} answered or revealed</div>
                <div class="pt-quiz-mc-bar">Multiple Choice</div>
                ${singleNavHtml}
                ${questionsHtml}
                <div class="pt-submit-bar">
                    <button class="pt-d2l-btn" id="pt-cancel">Cancel</button>
                    <button class="pt-d2l-btn pt-d2l-btn-primary" id="pt-submit">Submit Quiz</button>
                </div>
            </div>
        </div>`);
        attachSidebarNav(displayMode, idx => {
            if (displayMode !== 'single') return;
            currentIndex = idx;
            updateSingleView();
            window.scrollTo(0, 0);
        });
        attachQuizChoiceRowClicks();
        updateProgressLine();
        syncDotsFromState();
        if (displayMode === 'single') {
            document.getElementById('pt-prev-q').addEventListener('click', () => {
                if (currentIndex > 0) {
                    currentIndex--;
                    updateSingleView();
                    window.scrollTo(0, 0);
                }
            });
            document.getElementById('pt-next-q').addEventListener('click', () => {
                if (currentIndex < quizCount - 1) {
                    currentIndex++;
                    updateSingleView();
                    window.scrollTo(0, 0);
                }
            });
            updateSingleView();
        } else {
            saveDraft();
        }

        document.getElementById('pt-back-list').addEventListener('click', showTestList);
        document.getElementById('pt-back-summary').addEventListener('click', () => showTestSummary(test));
        document.getElementById('pt-cancel').addEventListener('click', () => showTestSummary(test));
        document.getElementById('pt-clear-all').addEventListener('click', () => {
            if (!confirm('Clear all selections and reset this attempt?')) return;
            Object.keys(userAnswers).forEach(k => { delete userAnswers[k]; });
            idkRevealed.clear();
            quizQuestions.forEach(q => {
                const qid = String(q.id);
                document.querySelectorAll('.pt-q-choice[data-qid="' + qid + '"]').forEach(lab => {
                    lab.classList.remove('pt-idk-correct');
                    const inp = lab.querySelector('input[type="radio"]');
                    if (inp) { inp.checked = false; inp.disabled = false; }
                });
                const idkBtn = document.querySelector('.pt-idk-btn[data-idk-qid="' + qid + '"]');
                if (idkBtn) idkBtn.disabled = false;
                const chkBtn = document.querySelector('.pt-check-btn[data-check-qid="' + qid + '"]');
                if (chkBtn) chkBtn.disabled = false;
                const fb = document.getElementById('pt-check-' + qid);
                if (fb) { fb.className = 'pt-check-feedback'; fb.textContent = ''; }
                const expl = document.getElementById('pt-expl-' + qid);
                if (expl) { expl.innerHTML = ''; expl.classList.remove('pt-explanation-visible'); }
                const dot = document.getElementById('pt-dot-' + qid);
                if (dot) dot.classList.remove('answered');
            });
            currentIndex = 0;
            if (displayMode === 'single') updateSingleView();
            else saveDraft();
            updateProgressLine();
        });

        document.querySelectorAll('.pt-q-choice input[type="radio"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const qid = radio.name.replace('ptq_', '');
                userAnswers[qid] = radio.value;
                updateProgressLine();
                saveDraft();
                const fb = document.getElementById('pt-check-' + qid);
                if (fb) { fb.className = 'pt-check-feedback'; fb.textContent = ''; }
                const dot = document.getElementById('pt-dot-' + qid);
                if (dot) dot.classList.add('answered');
            });
        });
        document.querySelectorAll('.pt-idk-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                revealIdk(btn.dataset.idkQid);
            });
        });
        document.querySelectorAll('.pt-check-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const qid = String(btn.dataset.checkQid);
                const q = quizQuestions.find(x => String(x.id) === qid);
                const fb = document.getElementById('pt-check-' + qid);
                if (!q || !fb || btn.disabled) return;
                const sel = document.querySelector('input[name="ptq_' + q.id + '"]:checked');
                fb.className = 'pt-check-feedback';
                if (!sel) {
                    fb.classList.add('pt-check-show', 'pt-check-hint');
                    fb.textContent = 'Select an answer first.';
                    return;
                }
                const ok = sel.value === q.correctAnswer;
                fb.classList.add('pt-check-show', ok ? 'pt-check-correct' : 'pt-check-wrong');
                fb.textContent = ok
                    ? 'Correct.'
                    : ('Incorrect. The correct answer is ' + q.correctAnswer + ').');
            });
        });
        document.getElementById('pt-submit').addEventListener('click', () => {
            const touched = new Set([...Object.keys(userAnswers), ...idkRevealed]);
            const unanswered = quizQuestions.filter(q => !touched.has(String(q.id))).length;
            if (unanswered > 0 && !confirm(`You have ${unanswered} question${unanswered > 1 ? 's' : ''} with no answer and no “I don't know.” Submit anyway?`)) return;
            let correct = 0;
            const results = quizQuestions.map(q => {
                const ua = userAnswers[q.id] || null;
                const ic = ua === q.correctAnswer;
                if (ic) correct++;
                return { questionId: q.id, userAnswer: ua, correctAnswer: q.correctAnswer, isCorrect: ic };
            });
            const pct = (correct / quizCount) * 100;
            const attempt = { date: new Date().toISOString(), results, correct, total: quizCount, percentage: pct };
            saveAttempt(test.id, attempt);
            GM_deleteValue(draftKey);
            showResults(test, attempt);
        });
    }

    function showResults(test, attempt) {
        const skipped = attempt.results.filter(r=>!r.userAnswer).length;
        const wrong = attempt.total-attempt.correct-skipped;
        takeover(`<div class="pt-page">
            <div class="pt-breadcrumb"><a id="pt-back-list">Practice Test List</a> <span>&rsaquo;</span> <a id="pt-back-summary">${test.name}</a> <span>&rsaquo; Results</span></div>
            <h1 style="font-size:24px;font-weight:300;">Quiz Results</h1>
            <div class="pt-results-box">
                <div class="pt-score-big">${attempt.percentage.toFixed(0)}%</div>
                <div class="pt-results-sub">${attempt.correct} out of ${attempt.total} correct</div>
                <div class="pt-stats-row">
                    <div class="pt-stat"><span class="num">${attempt.correct}</span><span class="lbl">Correct</span></div>
                    <div class="pt-stat"><span class="num">${wrong}</span><span class="lbl">Incorrect</span></div>
                    <div class="pt-stat"><span class="num">${skipped}</span><span class="lbl">Skipped</span></div>
                </div>
                <div style="display:flex;gap:10px;justify-content:center;">
                    <button class="pt-d2l-btn pt-d2l-btn-primary" id="pt-review-btn">Review Answers</button>
                    <button class="pt-d2l-btn" id="pt-retake">Retake</button>
                    <button class="pt-d2l-btn" id="pt-done">Done</button>
                </div>
            </div>
        </div>`);
        savePracticeRoute('summary', test.id);
        document.getElementById('pt-back-list').addEventListener('click', showTestList);
        document.getElementById('pt-back-summary').addEventListener('click', () => showTestSummary(test));
        document.getElementById('pt-review-btn').addEventListener('click', () => showReview(test, attempt));
        document.getElementById('pt-retake').addEventListener('click', () => showQuiz(test, getDefaultDisplayMode(test)));
        document.getElementById('pt-done').addEventListener('click', () => showTestSummary(test));
    }

    function showReview(test, attempt) {
        const orderedQs = attempt.results
            .map(r => test.questions.find(q => q.id === r.questionId))
            .filter(Boolean);
        let questionsHtml = '';
        orderedQs.forEach((q, i) => {
            const r = attempt.results.find(x=>x.questionId===q.id);
            const ua = r?r.userAnswer:null;
            const ca = q.correctAnswer;
            let choicesHtml = q.choices.map(c => {
                let cls = 'pt-q-choice';
                let tag = '';
                if (c.letter === ca) { cls += ' review-correct'; tag = '<span class="pt-label-tag pt-label-correct">Correct Answer</span>'; }
                else if (c.letter === ua && ua !== ca) { cls += ' review-incorrect'; tag = '<span class="pt-label-tag pt-label-incorrect">Your Answer</span>'; }
                const checked = c.letter === ua ? 'checked' : '';
                const rid = 'rv_r_' + String(q.id).replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + c.letter;
                return `<tr class="${cls}" style="pointer-events:none;" data-qid="${q.id}" data-letter="${c.letter}">
                    <td class="pt-q-radio-cell"><input type="radio" id="${rid}" name="rv_${q.id}" value="${c.letter}" ${checked} disabled></td>
                    <td class="pt-q-text-cell"><label for="${rid}">${c.letter}) ${c.text}</label>${tag}</td>
                </tr>`;
            }).join('');
            const ptsEarned = r && r.userAnswer && r.isCorrect ? 1 : 0;
            const sColor = !r || !r.userAnswer ? '#565a5c' : (r.isCorrect ? '#2e7d32' : '#c62828');
            questionsHtml += `<div class="pt-q-block" id="pt-qblock-${q.id}">
                <div class="pt-q-header-bar">
                    <h2 class="pt-q-header"><strong>Question ${i + 1}</strong></h2>
                    <span class="pt-q-pts" style="color:${sColor}">${ptsEarned} / 1 points</span>
                </div>
                <div class="pt-q-text">${q.text}</div>
                <div class="pt-q-choices">
                <fieldset class="pt-q-fieldset">
                <legend class="pt-q-options-legend">Question ${i + 1} options</legend>
                <table class="pt-q-choice-table" role="presentation"><tbody>${choicesHtml}</tbody></table>
                </fieldset>
                </div>
            </div>`;
        });
        const sidebarItems = buildSidebarItems(orderedQs, 'review', attempt);
        takeover(`<div class="pt-breadcrumb" style="padding:12px 20px 0;"><a id="pt-back-list">Practice Test List</a> <span>&rsaquo;</span> <a id="pt-back-summary">${test.name}</a> <span>&rsaquo; Review</span></div>
        <div class="pt-quiz-layout">
            <div class="pt-sidebar">
                <div class="pt-sidebar-title">Page 1:</div>
                <ul class="pt-sidebar-list">${sidebarItems}</ul>
            </div>
            <div class="pt-quiz-main">
                <h1 style="font-size:24px;font-weight:300;margin:16px 0 4px;">Review - ${test.name}</h1>
                <div class="pt-progress-info">Score: ${attempt.percentage.toFixed(0)}% (${attempt.correct}/${attempt.total})</div>
                <div class="pt-quiz-mc-bar">Multiple Choice</div>
                ${questionsHtml}
                <div class="pt-submit-bar">
                    <button class="pt-d2l-btn" id="pt-back-done">Done</button>
                </div>
            </div>
        </div>`);
        savePracticeRoute('summary', test.id);
        attachSidebarNav('all');
        document.getElementById('pt-back-list').addEventListener('click', showTestList);
        document.getElementById('pt-back-summary').addEventListener('click', () => showTestSummary(test));
        document.getElementById('pt-back-done').addEventListener('click', () => showTestSummary(test));
    }

    // ── GRADE CALCULATOR ──
    function parseGradesTable() {
        const table = document.querySelector('table[summary="List of grade items and their values"]');
        if (!table) return null;

        let pointsIdx = -1, weightIdx = -1;
        const headerRow = table.querySelector('tr[header]');
        if (headerRow) {
            let colOffset = 0;
            Array.from(headerRow.children).forEach(th => {
                const text = th.innerText.trim().toLowerCase();
                const cs = parseInt(th.getAttribute('colspan') || '1', 10);
                if (text === 'points') pointsIdx = colOffset;
                if (text === 'weight achieved') weightIdx = colOffset;
                colOffset += cs;
            });
        }

        if (pointsIdx === -1 && weightIdx === -1) {
            pointsIdx = 2; weightIdx = 3; 
        }

        const items = [];
        let currentCategory = 'Overall';

        const rows = table.querySelectorAll('tbody > tr');
        rows.forEach(row => {
            if (row.hasAttribute('header')) return;

            const th = row.querySelector('th[scope="row"]');
            if (!th) return;

            const hasTreeImage = row.querySelector('.d_g_treeNodeImage, img');
            const colspan = parseInt(th.getAttribute('colspan') || '1', 10);
            
            let label = th.innerText.trim();
            if ((colspan === 2 && !hasTreeImage) || row.classList.contains('d_ggl1') || row.classList.contains('d_ggl2')) {
                currentCategory = label || 'Overall';
                return;
            }

            let cellOffset = 0;
            let pointsText = '', weightText = '';
            Array.from(row.children).forEach(cell => {
                const cs = parseInt(cell.getAttribute('colspan') || '1', 10);
                if (pointsIdx >= cellOffset && pointsIdx < cellOffset + cs) pointsText = cell.innerText.trim();
                if (weightIdx >= cellOffset && weightIdx < cellOffset + cs) weightText = cell.innerText.trim();
                cellOffset += cs;
            });

            let pts = null, maxPts = null;
            if (pointsText && pointsText.includes('/')) {
                const parts = pointsText.split('/');
                pts = parseFloat(parts[0].replace(/[^0-9.-]/g, ''));
                maxPts = parseFloat(parts[1].replace(/[^0-9.-]/g, ''));
            } else if (pointsText) {
                let num = parseFloat(pointsText.replace(/[^0-9.-]/g, ''));
                pts = isNaN(num) ? null : num;
            }

            let w = null, maxW = null;
            if (weightText && weightText.includes('/')) {
                const parts = weightText.split('/');
                w = parseFloat(parts[0].replace(/[^0-9.-]/g, ''));
                maxW = parseFloat(parts[1].replace(/[^0-9.-]/g, ''));
            }

            if (!label) return;

            items.push({
                id: 'item_' + items.length,
                category: currentCategory,
                name: label,
                pts: isNaN(pts) ? null : pts,
                maxPts: isNaN(maxPts) ? null : maxPts,
                w: isNaN(w) ? null : w,
                maxW: isNaN(maxW) ? null : maxW,
                dropped: false
            });
        });

        return { items, hasWeight: weightIdx !== -1 };
    }

    function showGradeCalculatorUI(data) {
        let { items, hasWeight } = data;
        let calcItems = items.map(x => ({...x}));
        let manualSectionWeights = {};
        let currentlyWeighted = null;
        
        let initialSectionWeights = {};
        for (let item of calcItems) {
            if (!initialSectionWeights[item.category]) initialSectionWeights[item.category] = { maxW: 0 };
            initialSectionWeights[item.category].maxW += (parseFloat(item.maxW) || 0);
        }

        const safeBtoa = str => { try { return btoa(unescape(encodeURIComponent(str))).replace(/[^a-zA-Z0-9]/g, ''); } catch(e) { return 'c' + Date.now(); } };

        function renderCalc(forceRebuild = false) {
            const cats = {};
            calcItems.forEach(item => {
                if (!cats[item.category]) cats[item.category] = [];
                cats[item.category].push(item);
            });

            let totalPts = 0, totalMaxPts = 0, totalW = 0, totalMaxW = 0;
            let isWeightedSystem = hasWeight || Object.keys(manualSectionWeights).length > 0;
            
            const catAgg = {};
            for (const cat in cats) {
                catAgg[cat] = { itemEarnedW: 0, itemMaxW: 0, itemPts: 0, itemMaxPts: 0 };
                
                cats[cat].forEach(item => {
                    if (item.dropped) return;
                    const pts = parseFloat(item.pts) || 0;
                    const maxPts = parseFloat(item.maxPts) || 0;
                    const w = parseFloat(item.w) || 0;
                    const maxW = parseFloat(item.maxW) || 0;
                    
                    let computedW = w;
                    if (maxPts > 0 && maxW > 0) computedW = (pts / maxPts) * maxW;
                    else if (maxW > 0 && pts === 0) computedW = 0;
                    
                    catAgg[cat].itemEarnedW += computedW;
                    catAgg[cat].itemMaxW += maxW;
                    catAgg[cat].itemPts += pts;
                    catAgg[cat].itemMaxPts += maxPts;
                });
            }

            for (const cat in cats) {
                let secWStr = manualSectionWeights[cat];
                let isManual = secWStr !== undefined && secWStr !== '';
                
                if (isManual) {
                    let secW = parseFloat(secWStr) || 0;
                    let secEarned = 0;
                    if (catAgg[cat].itemMaxPts > 0) {
                        secEarned = (catAgg[cat].itemPts / catAgg[cat].itemMaxPts) * secW;
                    } else if (catAgg[cat].itemMaxW > 0) {
                        secEarned = (catAgg[cat].itemEarnedW / catAgg[cat].itemMaxW) * secW;
                    }
                    totalW += secEarned;
                    totalMaxW += secW;
                    totalPts += catAgg[cat].itemPts;
                    totalMaxPts += catAgg[cat].itemMaxPts;
                } else if (isWeightedSystem) {
                    totalW += catAgg[cat].itemEarnedW;
                    totalMaxW += catAgg[cat].itemMaxW;
                    totalPts += catAgg[cat].itemPts;
                    totalMaxPts += catAgg[cat].itemMaxPts;
                } else {
                    totalPts += catAgg[cat].itemPts;
                    totalMaxPts += catAgg[cat].itemMaxPts;
                }
            }

            const finalScore = isWeightedSystem 
                ? (totalMaxW > 0 ? (totalW / totalMaxW) * 100 : 0)
                : (totalMaxPts > 0 ? (totalPts / totalMaxPts) * 100 : 0);

            // Calculate item strings logic
            const itemStrings = {};
            for (const cat in cats) {
                cats[cat].forEach(item => {
                    let computedWStr = '-';
                    if (isWeightedSystem) {
                        let isSecManual = manualSectionWeights[cat] !== undefined && manualSectionWeights[cat] !== '';
                        if (isSecManual) {
                            let secW = parseFloat(manualSectionWeights[cat]) || 0;
                            let ptsNum = parseFloat(item.pts)||0;
                            let mPtsNum = parseFloat(item.maxPts)||0;
                            if (mPtsNum > 0 && secW > 0) {
                                let ratio = mPtsNum / catAgg[cat].itemMaxPts;
                                let expectedW = ratio * secW;
                                computedWStr = ((ptsNum / mPtsNum) * expectedW).toFixed(2);
                            } else {
                                computedWStr = '0.00';
                            }
                        } else {
                            let ptsNum = parseFloat(item.pts)||0;
                            let mPtsNum = parseFloat(item.maxPts)||0;
                            let mwNum = parseFloat(item.maxW)||0;
                            if (mPtsNum > 0 && mwNum > 0) computedWStr = ((ptsNum / mPtsNum) * mwNum).toFixed(2);
                            else if (mwNum > 0) computedWStr = '0.00';
                        }
                    }
                    const isManaged = manualSectionWeights[cat] !== undefined && manualSectionWeights[cat] !== '';
                    itemStrings[item.id] = { str: computedWStr, managed: isManaged };
                });
            }

            let needsRebuild = forceRebuild || currentlyWeighted !== isWeightedSystem || !document.getElementById('pt-gc-final-score');
            currentlyWeighted = isWeightedSystem;

            if (!needsRebuild) {
                // DOM Fast Path
                const finalEl = document.getElementById('pt-gc-final-score');
                if (finalEl) finalEl.innerText = finalScore.toFixed(2) + '%';
                
                const statBox = document.getElementById('pt-gc-stat-box');
                if (statBox) {
                    statBox.innerHTML = isWeightedSystem 
                        ? `<span class="num">${totalW.toFixed(2)} / ${totalMaxW.toFixed(2)}</span><span class="lbl">Total Weight</span>`
                        : `<span class="num">${totalPts.toFixed(2)} / ${totalMaxPts.toFixed(2)}</span><span class="lbl">Total Points</span>`;
                }
                
                for (const cat in cats) {
                    cats[cat].forEach(item => {
                        const cwsEl = document.getElementById(`gc-cws-${item.id}`);
                        if (cwsEl) cwsEl.innerText = itemStrings[item.id].str;
                        
                        const mwInp = document.getElementById(`gc-maxw-${item.id}`);
                        if (mwInp) mwInp.disabled = itemStrings[item.id].managed;
                    });
                }
                return;
            }

            // Full render slow path
            let html = `<div class="pt-page">
                <div class="pt-breadcrumb"><a id="pt-gc-back" style="cursor:pointer;color:#006fbf;">&larr; Back to Actual Grades</a></div>
                <h1 style="margin: 16px 0;">Projected Grade Calculator</h1>
                
                <div class="pt-results-box" style="background:#f9fbfd;border:1px solid #dce8f5;margin-bottom:24px;border-radius:4px;padding:30px 20px;">
                    <div id="pt-gc-final-score" class="pt-score-big" style="color:#006fbf;margin-bottom:8px;">${finalScore.toFixed(2)}%</div>
                    <div class="pt-results-sub" style="margin-bottom:16px;">Current Projected Score (${isWeightedSystem ? 'Weighted' : 'Points Based'})</div>
                    <div id="pt-gc-stat-box" class="pt-stats-row" style="margin:0;">
                        ${isWeightedSystem 
                            ? `<div class="pt-stat"><span class="num">${totalW.toFixed(2)} / ${totalMaxW.toFixed(2)}</span><span class="lbl">Total Weight</span></div>`
                            : `<div class="pt-stat"><span class="num">${totalPts.toFixed(2)} / ${totalMaxPts.toFixed(2)}</span><span class="lbl">Total Points</span></div>`
                        }
                    </div>
                </div>

                <p style="margin-bottom:16px;color:#6e7376;font-size:14px;">Modify your scores below to see how it affects your final grade. Changes are simulated and not saved.</p>

                <table class="pt-table">
                    <thead>
                        <tr>
                            <th>Item</th>
                            <th style="width:160px;text-align:center;">Points</th>
                            ${isWeightedSystem ? `<th style="width:160px;text-align:center;">Weight</th>` : ''}
                            <th style="width:60px;text-align:center;">Drop?</th>
                        </tr>
                    </thead>
                    <tbody>`;

            for (const cat in cats) {
                let secWVal = manualSectionWeights[cat] !== undefined ? manualSectionWeights[cat] : '';
                let initialW = initialSectionWeights[cat].maxW;
                let overridePlaceholder = initialW > 0 ? initialW : 'Add Weight';
                let catId = safeBtoa(cat);
                
                html += `<tr><th colspan="${isWeightedSystem ? 4 : 3}" style="background:#f5f5f5;font-size:13px;font-weight:600;padding:6px 16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span>${escapeHtml(cat)}</span>
                        <span style="font-size:12px; font-weight:normal; color:#555;">Section Weight: 
                            <input type="number" step="any" id="gc-secwinp-${catId}" class="gc-secwinp" data-cat="${escapeHtml(cat)}" value="${secWVal}" placeholder="${overridePlaceholder}" style="width:70px;padding:3px;border:1px solid #ccc;border-radius:3px;text-align:center;">
                        </span>
                    </div>
                </th></tr>`;
                
                cats[cat].forEach(item => {
                    let ptsVal = item.pts !== null ? item.pts : '';
                    let maxPtsVal = item.maxPts !== null ? item.maxPts : '';
                    let maxWVal = item.maxW !== null ? item.maxW : '';
                    let computedWStr = itemStrings[item.id].str;

                    const lt = item.dropped ? 'opacity:0.4;' : '';
                    const isManaged = itemStrings[item.id].managed;

                    html += `<tr style="${lt}" id="gc-row-${item.id}">
                        <td style="vertical-align:middle;">${item.dropped ? '<s>' + escapeHtml(item.name) + '</s>' : escapeHtml(item.name)}</td>
                        <td style="text-align:center;white-space:nowrap;">
                            <input type="number" step="any" id="gc-pts-${item.id}" class="gc-inp gc-ptsinp" data-id="${item.id}" value="${ptsVal}" style="width:60px;padding:4px;border:1px solid #ccc;border-radius:3px;text-align:center;">
                            /
                            <input type="number" step="any" id="gc-maxpts-${item.id}" class="gc-inp gc-maxptsinp" data-id="${item.id}" value="${maxPtsVal}" style="width:60px;padding:4px;border:1px solid #ccc;border-radius:3px;text-align:center;">
                        </td>
                        ${isWeightedSystem ? `<td style="text-align:center;white-space:nowrap;">
                            <span id="gc-cws-${item.id}" style="display:inline-block;width:50px;text-align:right;font-weight:600;" title="Calculated weight earned">${computedWStr}</span>
                            /
                            <input type="number" step="any" id="gc-maxw-${item.id}" class="gc-inp gc-maxwinp" data-id="${item.id}" value="${maxWVal}" style="width:60px;padding:4px;border:1px solid #ccc;border-radius:3px;text-align:center;" ${isManaged ? 'disabled title="Managed by Section Weight"' : ''}>
                        </td>` : ''}
                        <td style="text-align:center;vertical-align:middle;">
                            <input type="checkbox" id="gc-drop-${item.id}" class="gc-dropchk" data-id="${item.id}" ${item.dropped ? 'checked' : ''} style="cursor:pointer;width:18px;height:18px;">
                        </td>
                    </tr>`;
                });
            }

            html += `</tbody></table>
                <div style="margin-top:24px;display:flex;gap:12px;">
                    <button class="pt-d2l-btn pt-d2l-btn-primary" id="pt-gc-reset">Reset Simulation</button>
                    <button class="pt-d2l-btn" id="pt-gc-max-all">Max Out All Grades</button>
                </div>
            </div>`;

            takeover(html);

            document.getElementById('pt-gc-back').addEventListener('click', restore);
            document.getElementById('pt-gc-reset').addEventListener('click', () => { 
                calcItems = items.map(x => ({...x})); 
                manualSectionWeights = {};
                renderCalc(true); 
            });
            
            const maxAllBtn = document.getElementById('pt-gc-max-all');
            if (maxAllBtn) {
                maxAllBtn.addEventListener('click', () => {
                    calcItems.forEach(item => {
                        if (!item.dropped && item.maxPts !== null) {
                            item.pts = item.maxPts;
                            let ptsEl = document.getElementById(`gc-pts-${item.id}`);
                            if (ptsEl) ptsEl.value = item.maxPts;
                        }
                    });
                    renderCalc(false);
                });
            }

            document.querySelectorAll('.gc-secwinp').forEach(inp => {
                inp.addEventListener('input', e => {
                    const cat = e.target.dataset.cat;
                    const val = e.target.value;
                    if (val === '') delete manualSectionWeights[cat];
                    else manualSectionWeights[cat] = val;
                    renderCalc(false);
                });
            });

            document.querySelectorAll('.gc-inp').forEach(inp => {
                inp.addEventListener('input', e => {
                    const id = e.target.dataset.id;
                    const item = calcItems.find(x => x.id === id);
                    if (!item) return;
                    let val = parseFloat(e.target.value);
                    if (isNaN(val)) val = document.activeElement === e.target ? null : 0;
                    if (e.target.classList.contains('gc-ptsinp')) item.pts = val;
                    if (e.target.classList.contains('gc-maxptsinp')) item.maxPts = val;
                    if (e.target.classList.contains('gc-maxwinp')) item.maxW = val;
                    renderCalc(false);
                });
            });

            document.querySelectorAll('.gc-dropchk').forEach(chk => {
                chk.addEventListener('change', e => {
                    const id = e.target.dataset.id;
                    const item = calcItems.find(x => x.id === id);
                    if (item) item.dropped = e.target.checked;
                    renderCalc(true);
                });
            });
        }

        renderCalc(true);
    }

    function initGradeCalculator() {
        if (!window.location.href.includes('/grades/')) return;
        if (!window.__elcGradeCalcDelegated) {
            window.__elcGradeCalcDelegated = true;
            document.addEventListener('click', function (e) {
                const btn = e.target && e.target.closest && e.target.closest('#pt-grade-calc-wrap button.pt-d2l-btn-primary');
                if (!btn) return;
                e.preventDefault();
                const data = parseGradesTable();
                if (data && data.items.length) showGradeCalculatorUI(data);
                else alert('Could not extract any grade items.');
            }, true);
        }
        const checkTable = () => {
            const table = document.querySelector('table[summary="List of grade items and their values"]');
            if (table && !document.getElementById('pt-grade-calc-wrap')) {
                const wrap = document.createElement('div');
                wrap.id = 'pt-grade-calc-wrap';
                wrap.style.margin = '20px 0';

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'pt-d2l-btn pt-d2l-btn-primary';
                btn.innerText = 'Grade Calculator';
                wrap.appendChild(btn);

                let parent = table.closest('d2l-table-wrapper');
                if (!parent) parent = table;
                parent.parentNode.insertBefore(wrap, parent);
            }
        };
        checkTable();
        const obs = new MutationObserver(checkTable);
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // ── COURSE SCHEDULE ──
    const SCHEDULE_CACHE_KEY = 'elc_schedule_v1';
    const CS_SESSION_KEY = 'elc_cs_session_v1';
    const TASKS_SESSION_KEY = 'elc_tasks_session_v1';
    const TASKS_CACHE_KEY = 'elc_tasks_snapshot_v2';
    const TASKS_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
    const TASKS_BG_STALE_MS = 1000 * 60 * 2;
    /** Cached D2L course-selector list so the schedule can paint immediately; refreshed in background. */
    const D2L_COURSES_CACHE_KEY = 'elc_d2l_courses_cache_v1';
    const D2L_COURSES_CACHE_TTL_MS = 1000 * 60 * 60 * 4;

    function saveCSRoute(view) {
        try {
            sessionStorage.setItem(CS_SESSION_KEY, JSON.stringify({ view, path: currentPageKey() }));
        } catch (e) {}
    }

    function saveTasksRoute(view) {
        try {
            sessionStorage.setItem(TASKS_SESSION_KEY, JSON.stringify({ view, path: currentPageKey() }));
        } catch (e) {}
    }

    /** In-memory mirror; also synced via chrome.storage.local so Athena imports reach D2L (different origins). */
    let _scheduleCross = undefined;

    function loadScheduleFromGm() {
        try {
            const raw = GM_getValue(SCHEDULE_CACHE_KEY, '');
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return null;
    }

    function getStoredSchedule() {
        if (_scheduleCross !== undefined) return _scheduleCross;
        return loadScheduleFromGm();
    }

    function preloadScheduleFromChrome(done) {
        chrome.storage.local.get(SCHEDULE_CACHE_KEY, (r) => {
            try {
                const raw = r[SCHEDULE_CACHE_KEY];
                if (raw) _scheduleCross = JSON.parse(raw);
                else _scheduleCross = loadScheduleFromGm();
            } catch (e) {
                _scheduleCross = loadScheduleFromGm();
            }
            if (done) done();
        });
    }

    function saveScheduleData(data, done) {
        const s = JSON.stringify(data);
        GM_setValue(SCHEDULE_CACHE_KEY, s);
        _scheduleCross = data;
        chrome.storage.local.set({ [SCHEDULE_CACHE_KEY]: s }, () => {
            if (done) done();
        });
    }

    function getCachedD2LCourses() {
        try {
            const raw = GM_getValue(D2L_COURSES_CACHE_KEY, '');
            if (!raw) return [];
            const o = JSON.parse(raw);
            if (!o || !Array.isArray(o.courses) || typeof o.savedAt !== 'number') return [];
            if (Date.now() - o.savedAt > D2L_COURSES_CACHE_TTL_MS) return [];
            return o.courses;
        } catch (e) {
            return [];
        }
    }

    function saveD2LCoursesCache(courses) {
        try {
            GM_setValue(D2L_COURSES_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), courses }));
        } catch (e) {}
    }

    function d2lCourseListsEqual(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return JSON.stringify(a.map(x => [x.orgUnitId, x.name, x.href]).sort()) ===
            JSON.stringify(b.map(x => [x.orgUnitId, x.name, x.href]).sort());
    }

    /** MM/DD/YYYY → Date (local midnight). */
    function parseDateFromMDY(mdy) {
        const m = String(mdy).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return null;
        return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    }

    function tryRestoreCSSession() {
        if (!getMainContent()) return;
        let route;
        try {
            const raw = sessionStorage.getItem(CS_SESSION_KEY);
            if (!raw) return;
            route = JSON.parse(raw);
        } catch (e) { return; }
        if (!route || !route.view) return;
        if (!route.path || route.path !== currentPageKey()) {
            try { sessionStorage.removeItem(CS_SESSION_KEY); } catch (e2) {}
            return;
        }
        if (route.view === 'main') showCourseSchedulePage();
    }

    function tryRestoreTasksSession() {
        if (!getMainContent()) return;
        let route;
        try {
            const raw = sessionStorage.getItem(TASKS_SESSION_KEY);
            if (!raw) return;
            route = JSON.parse(raw);
        } catch (e) { return; }
        if (!route || !route.view) return;
        if (!route.path || route.path !== currentPageKey()) {
            try { sessionStorage.removeItem(TASKS_SESSION_KEY); } catch (e2) {}
            return;
        }
        if (route.view === 'main') showTasksPage();
    }

    function scheduleCSSessionRestore() {
        if (csSessionRestoreScheduled) return;
        csSessionRestoreScheduled = true;
        let tries = 0;
        const tick = () => {
            tries++;
            if (!getMainContent()) {
                if (tries < 100) setTimeout(tick, 100);
                return;
            }
            if (csSessionRestoreAttempted) return;
            csSessionRestoreAttempted = true;
            try {
                if (!sessionStorage.getItem(CS_SESSION_KEY)) return;
                tryRestoreCSSession();
            } catch (e) {}
        };
        setTimeout(tick, 0);
    }

    function scheduleTasksSessionRestore() {
        if (tasksSessionRestoreScheduled) return;
        tasksSessionRestoreScheduled = true;
        let tries = 0;
        const tick = () => {
            tries++;
            if (!getMainContent()) {
                if (tries < 100) setTimeout(tick, 100);
                return;
            }
            if (tasksSessionRestoreAttempted) return;
            tasksSessionRestoreAttempted = true;
            try {
                if (!sessionStorage.getItem(TASKS_SESSION_KEY)) return;
                tryRestoreTasksSession();
            } catch (e) {}
        };
        setTimeout(tick, 0);
    }

    /** Parse Athena Schedule Details tab DOM into course objects. */
    function parseAthenaScheduleDOM() {
        const container = document.getElementById('scheduleListView');
        if (!container) return null;
        const courses = [];

        container.querySelectorAll('.listViewWrapper').forEach(wrapper => {
            const titleEl = wrapper.querySelector('.list-view-course-title a');
            if (!titleEl) return;
            const title = titleEl.textContent.trim();

            const subjCourseEl = wrapper.querySelector('.list-view-subj-course-section');
            const subjCourse = subjCourseEl ? subjCourseEl.textContent.trim() : '';

            const statusEl = wrapper.querySelector('.list-view-status span');
            const status = statusEl ? statusEl.textContent.trim() : '';

            const instructorEl = wrapper.querySelector('.listViewInstructorInformation .email');
            const instructor = instructorEl ? instructorEl.textContent.trim() : '';

            const crnEl = wrapper.querySelector('.listViewInstructorInformation .list-view-crn-schedule');
            const crn = crnEl ? crnEl.textContent.trim() : '';

            // "FHCE - Fin Plan Hous Con Econ 6235S Section 8" → subjectCode=FHCE, courseNumber=6235S
            const codeMatch = subjCourse.match(/^([A-Z]{2,6})\s*-[^0-9]*?(\d+[A-Z0-9]*)\s+Section/i);
            const subjectCode = codeMatch ? codeMatch[1].trim() : '';
            const courseNumber = codeMatch ? codeMatch[2].trim() : '';
            const courseCode = subjectCode + courseNumber;

            const meetings = [];
            const meetDiv = wrapper.querySelector('.listViewMeetingInformation');
            if (meetDiv) {
                meetDiv.querySelectorAll('.list-view-pillbox').forEach(pillbox => {
                    const pillTitle = pillbox.getAttribute('title') || '';
                    const daysStr = pillTitle.replace(/^class on:\s*/i, '').trim();
                    const days = (daysStr === 'None' || !daysStr)
                        ? [] : daysStr.split(',').map(d => d.trim()).filter(Boolean);

                    // Collect text of siblings after this pillbox until next BR or meetingTimes
                    let text = '';
                    let node = pillbox.nextSibling;
                    while (node) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.tagName === 'BR') break;
                            if (node.classList && (node.classList.contains('meetingTimes') || node.classList.contains('list-view-pillbox'))) break;
                            text += node.textContent;
                        } else if (node.nodeType === Node.TEXT_NODE) {
                            text += node.textContent;
                        }
                        node = node.nextSibling;
                    }

                    const tMatch = text.match(/(\d{2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{2}):(\d{2})\s*(AM|PM)/i);
                    const startTime = tMatch ? `${tMatch[1]}:${tMatch[2]} ${tMatch[3].toUpperCase()}` : '';
                    const endTime   = tMatch ? `${tMatch[4]}:${tMatch[5]} ${tMatch[6].toUpperCase()}` : '';

                    const bldgMatch = text.match(/Building:\s+([\w\s,&.'()-]+?)\s+Room:/i);
                    const roomMatch = text.match(/Room:\s+(\S+)/i);
                    const building  = bldgMatch ? bldgMatch[1].trim() : '';
                    const room      = roomMatch ? roomMatch[1].trim() : '';

                    meetings.push({ days, startTime, endTime, building, room });
                });
            }

            let classDateRange = null;
            const mtFirst = wrapper.querySelector('.listViewMeetingInformation .meetingTimes');
            if (mtFirst) {
                const rm = mtFirst.textContent.trim().match(/(\d{2}\/\d{2}\/\d{4})\s*--\s*(\d{2}\/\d{2}\/\d{4})/);
                if (rm) classDateRange = { start: rm[1], end: rm[2] };
            }

            if (title && courseCode) {
                courses.push({ title, subjectCode, courseNumber, courseCode, crn, subjCourse, status: status.trim(), instructor, meetings, classDateRange });
            }
        });

        return courses.length > 0 ? courses : null;
    }

    /** Inject "Import to D2L Essentials" button on the Athena registration history page. */
    function injectAthenaImportButton() {
        if (!window.location.href.includes('registrationHistory')) return;

        const doInject = () => {
            if (document.getElementById('elc-import-btn-wrap')) return;
            const descDiv = document.querySelector('#lookup-registrations .description');
            if (!descDiv) return;

            const wrap = document.createElement('span');
            wrap.id = 'elc-import-btn-wrap';
            wrap.style.cssText = 'display:inline-block; margin-left:14px; vertical-align:middle;';

            const btn = document.createElement('button');
            btn.id = 'elc-import-btn';
            btn.textContent = 'Import to D2L Essentials';
            btn.style.cssText = 'padding:5px 13px; background:#006fbf; color:#fff; border:none; border-radius:4px; font-size:13px; cursor:pointer; font-family:inherit;';
            btn.title = 'Save your course schedule to ELC Essentials in D2L';

            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Importing...';
                try {
                    // Ensure Schedule Details tab is active and content loaded
                    let listView = document.getElementById('scheduleListView');
                    if (!listView || !listView.querySelector('.listViewWrapper')) {
                        const detailsTab = document.getElementById('scheduleDetailsViewLink');
                        if (detailsTab) {
                            detailsTab.click();
                            await new Promise(resolve => {
                                let t = 0;
                                const chk = () => {
                                    if (document.querySelector('#scheduleListView .listViewWrapper') || t > 40) resolve();
                                    else { t++; setTimeout(chk, 200); }
                                };
                                setTimeout(chk, 300);
                            });
                        }
                    }

                    const termLabel = document.querySelector('#s2id_lookupFilter .select2-chosen')?.textContent?.trim()
                        || document.querySelector('.select2-chosen')?.textContent?.trim()
                        || 'Unknown Term';

                    const courses = parseAthenaScheduleDOM();
                    if (!courses || courses.length === 0) {
                        alert('No course data found. Make sure the Schedule Details tab has loaded.');
                        btn.disabled = false;
                        btn.textContent = 'Import to D2L Essentials';
                        return;
                    }

                    let tMin = null;
                    let tMax = null;
                    courses.forEach(c => {
                        if (!c.classDateRange) return;
                        const s = parseDateFromMDY(c.classDateRange.start);
                        const e = parseDateFromMDY(c.classDateRange.end);
                        if (s && (!tMin || s < tMin)) tMin = s;
                        if (e && (!tMax || e > tMax)) tMax = e;
                    });
                    const payload = { term: termLabel, importedAt: new Date().toISOString(), courses };
                    if (tMin && tMax) payload.termBounds = { start: tMin.toISOString(), end: tMax.toISOString() };
                    saveScheduleData(payload);
                    btn.textContent = 'Imported ' + courses.length + ' courses';
                    btn.style.background = '#2e7d32';
                    setTimeout(() => {
                        btn.disabled = false;
                        btn.textContent = 'Import to D2L Essentials';
                        btn.style.background = '#006fbf';
                    }, 3000);
                } catch (err) {
                    alert('Import error: ' + (err && err.message ? err.message : err));
                    btn.disabled = false;
                    btn.textContent = 'Import to D2L Essentials';
                }
            });

            wrap.appendChild(btn);
            const subMenu = descDiv.querySelector('.sub-menu-items');
            if (subMenu) descDiv.insertBefore(wrap, subMenu);
            else descDiv.appendChild(wrap);
        };

        doInject();
        const obs = new MutationObserver(doInject);
        obs.observe(document.body, { childList: true, subtree: true });
    }

    /** Read the D2L course selector items from the DOM, triggering the dropdown if needed. */
    function loadD2LCourseList(callback) {
        const existing = document.querySelectorAll('.d2l-course-selector-item[data-org-unit-id]');
        if (existing.length > 0) { callback(parseD2LCourseItems(existing)); return; }

        // Trigger the course dropdown to load
        const menuBtn = document.querySelector('.d2l-navigation-s-course-menu d2l-labs-navigation-dropdown-button-icon');
        if (!menuBtn) { callback([]); return; }

        let resolved = false;
        const obs = new MutationObserver(() => {
            const items = document.querySelectorAll('.d2l-course-selector-item[data-org-unit-id]');
            if (items.length > 0 && !resolved) {
                resolved = true;
                obs.disconnect();
                setTimeout(() => document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })), 80);
                callback(parseD2LCourseItems(items));
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        menuBtn.click();
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                obs.disconnect();
                callback(parseD2LCourseItems(document.querySelectorAll('.d2l-course-selector-item[data-org-unit-id]')));
            }
        }, 2200);
    }

    function parseD2LCourseItems(nodeList) {
        return Array.from(nodeList).map(item => {
            const link = item.querySelector('.d2l-course-selector-item-name a');
            return {
                orgUnitId: item.dataset.orgUnitId || '',
                name: link ? link.textContent.trim() : '',
                href: link ? (link.getAttribute('href') || '') : ''
            };
        });
    }

    /** Find the D2L course that best matches a schedule course by course code or CRN. */
    function matchD2LCourse(scheduleCourse, d2lCourses) {
        const code = (scheduleCourse.courseCode || '').toUpperCase();
        const crn  = scheduleCourse.crn || '';
        for (const d of d2lCourses) {
            const n = d.name.toUpperCase();
            if (code && n.includes(code)) return d;
            if (crn && d.name.includes(crn)) return d;
        }
        return null;
    }

    /**
     * D2L org units that match the imported Athena schedule (Tasks tab only lists these).
     * @returns {{ list: Array<{orgUnitId:string,name:string,href:string,scheduleCourse:object}>, error: string|null }}
     */
    function buildScheduleMatchedD2LCourses(d2lCourses) {
        const saved = getStoredSchedule();
        if (!saved || !Array.isArray(saved.courses) || saved.courses.length === 0) {
            return { list: [], error: 'no_schedule' };
        }
        if (!Array.isArray(d2lCourses) || d2lCourses.length === 0) {
            return { list: [], error: 'no_d2l' };
        }
        const list = [];
        const seen = new Set();
        saved.courses.forEach(sc => {
            const m = matchD2LCourse(sc, d2lCourses);
            if (m && m.orgUnitId && !seen.has(m.orgUnitId)) {
                seen.add(m.orgUnitId);
                list.push({ ...m, scheduleCourse: sc });
            }
        });
        if (!list.length) {
            return { list: [], error: 'no_match' };
        }
        return { list, error: null };
    }

    /** Stable key for per-meeting time overrides (stored in saved.timeOverrides). */
    function meetingOverrideKey(course, meetingIndex) {
        const id = (course.crn && String(course.crn).trim()) ? String(course.crn).trim() : String(course.courseCode || 'course');
        return id + '|' + meetingIndex;
    }

    /** Athena times merged with user edits from saved.timeOverrides. */
    function getEffectiveMeetingTimes(course, meeting, meetingIndex, saved) {
        const key = meetingOverrideKey(course, meetingIndex);
        const ov = saved && saved.timeOverrides && saved.timeOverrides[key];
        const startTime = ov && ov.startTime != null && String(ov.startTime).trim()
            ? String(ov.startTime).trim() : meeting.startTime;
        const endTime = ov && ov.endTime != null && String(ov.endTime).trim()
            ? String(ov.endTime).trim() : meeting.endTime;
        return { startTime, endTime };
    }

    function formatMinutesAsAmPm(totalMins) {
        if (totalMins < 0 || totalMins >= 24 * 60) return '';
        const h = Math.floor(totalMins / 60);
        const mi = totalMins % 60;
        const ap = h >= 12 ? 'PM' : 'AM';
        let hr = h % 12;
        if (hr === 0) hr = 12;
        return hr + ':' + String(mi).padStart(2, '0') + ' ' + ap;
    }

    /** Athena-style "2:55 PM" or 24h "14:55" → minutes, or null if invalid. */
    function tryParseTimeFlexible(s) {
        const t = String(s).trim();
        if (!t) return null;
        if (/am|pm/i.test(t)) {
            if (!/(\d{1,2}):(\d{2})\s*(am|pm)/i.test(t)) return null;
            return parseTimeToMinutes(t);
        }
        const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
        if (m24) {
            const hh = parseInt(m24[1], 10);
            const mm = parseInt(m24[2], 10);
            if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) return hh * 60 + mm;
        }
        return null;
    }

    /** Parse "08:15 AM" → minutes since midnight for sorting. */
    function parseTimeToMinutes(timeStr) {
        if (!timeStr) return 0;
        const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (!m) return 0;
        let h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        const ap = m[3].toUpperCase();
        if (ap === 'PM' && h !== 12) h += 12;
        if (ap === 'AM' && h === 12) h = 0;
        return h * 60 + min;
    }

    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const ICS_BYDAY = { Monday: 'MO', Tuesday: 'TU', Wednesday: 'WE', Thursday: 'TH', Friday: 'FR', Saturday: 'SA', Sunday: 'SU' };

    function getTermBounds(saved) {
        if (saved.termBounds && saved.termBounds.start && saved.termBounds.end) {
            return { start: new Date(saved.termBounds.start), end: new Date(saved.termBounds.end) };
        }
        const y = new Date(saved.importedAt || Date.now()).getFullYear();
        return { start: new Date(y, 0, 15), end: new Date(y, 4, 15) };
    }

    /**
     * Last day for weekly RRULE UNTIL: Spring May 12, Fall Dec 21, Summer Aug 1 (local end of day).
     * Parsed from saved.term (e.g. "Spring 2026"); falls back to termBounds.end or Spring May 12.
     */
    function getIcsRecurrenceEndDate(saved) {
        const term = String(saved.term || '');
        const yearMatch = term.match(/\b(20\d{2})\b/);
        const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date(saved.importedAt || Date.now()).getFullYear();
        const lower = term.toLowerCase();

        if (lower.includes('spring')) {
            return new Date(year, 4, 12, 23, 59, 59);
        }
        if (lower.includes('summer')) {
            return new Date(year, 7, 1, 23, 59, 59);
        }
        if (lower.includes('fall')) {
            return new Date(year, 11, 21, 23, 59, 59);
        }

        if (saved.termBounds && saved.termBounds.end) {
            return new Date(saved.termBounds.end);
        }
        return new Date(year, 4, 12, 23, 59, 59);
    }

    function firstWeekdayOnOrAfter(d, dayName) {
        const want = DAY_NAMES.indexOf(dayName);
        if (want < 0) return new Date(d);
        const cur = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        let guard = 0;
        while (cur.getDay() !== want && guard++ < 14) cur.setDate(cur.getDate() + 1);
        return cur;
    }

    function earliestWeekdayOnOrAfter(termStart, dayNames) {
        let best = null;
        dayNames.forEach(dn => {
            const d = firstWeekdayOnOrAfter(termStart, dn);
            const plain = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            if (!best || plain < best) best = plain;
        });
        return best;
    }

    function minutesToClock(totalMins) {
        const h = Math.floor(totalMins / 60);
        const m = totalMins % 60;
        return { h, m };
    }

    function formatICSLocalDateTime(dateObj, minsFromMidnight) {
        const { h, m } = minutesToClock(minsFromMidnight);
        const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), h, m, 0);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    }

    function escapeICS(text) {
        return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
    }

    function foldICSLine(line) {
        if (line.length <= 75) return line;
        let out = '';
        let rest = line;
        while (rest.length > 75) {
            out += rest.slice(0, 75) + '\r\n ';
            rest = rest.slice(75);
        }
        return out + rest;
    }

    function buildScheduleICS(saved) {
        const tb = getTermBounds(saved);
        const recurEnd = getIcsRecurrenceEndDate(saved);
        const pad = n => String(n).padStart(2, '0');
        const untilStr = `${recurEnd.getUTCFullYear()}${pad(recurEnd.getUTCMonth() + 1)}${pad(recurEnd.getUTCDate())}T${pad(recurEnd.getUTCHours())}${pad(recurEnd.getUTCMinutes())}${pad(recurEnd.getUTCSeconds())}Z`;
        const now = new Date();
        const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ELC Essentials//Course Schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
        const uidBase = Date.now().toString(36);
        let ev = 0;

        (saved.courses || []).forEach(course => {
            (course.meetings || []).forEach((meeting, mi) => {
                if (!meeting.days || meeting.days.length === 0) return;
                const eff = getEffectiveMeetingTimes(course, meeting, mi, saved);
                const startM = parseTimeToMinutes(eff.startTime);
                const endM = parseTimeToMinutes(eff.endTime);
                if (endM <= startM) return;

                const byday = meeting.days.map(d => ICS_BYDAY[d]).filter(Boolean).join(',');
                if (!byday) return;

                const firstStart = earliestWeekdayOnOrAfter(tb.start, meeting.days);
                if (firstStart.getTime() > recurEnd.getTime()) return;

                const dtStart = formatICSLocalDateTime(firstStart, startM);
                const dtEnd = formatICSLocalDateTime(firstStart, endM);
                const loc = [meeting.building, meeting.room ? 'Rm ' + meeting.room : ''].filter(Boolean).join(', ');
                const sum = `${course.subjectCode} ${course.courseNumber} ${course.title}`;
                const desc = `Instructor: ${course.instructor || 'N/A'}\\nCRN: ${course.crn || 'N/A'}`;

                lines.push('BEGIN:VEVENT');
                lines.push('UID:' + uidBase + '-' + ev + '@elc-essentials');
                ev++;
                lines.push('DTSTAMP:' + stamp);
                lines.push('DTSTART:' + dtStart);
                lines.push('DTEND:' + dtEnd);
                lines.push('RRULE:FREQ=WEEKLY;BYDAY=' + byday + ';UNTIL=' + untilStr);
                lines.push('SUMMARY:' + escapeICS(sum));
                if (loc) lines.push('LOCATION:' + escapeICS(loc));
                lines.push('DESCRIPTION:' + escapeICS(desc));
                lines.push('END:VEVENT');
            });
        });

        lines.push('END:VCALENDAR');
        return lines.map(foldICSLine).join('\r\n');
    }

    function updateScheduleRowHighlights() {
        const rows = document.querySelectorAll('#cs-schedule .cs-schedule-row[data-start-min]');
        const todayName = DAY_NAMES[new Date().getDay()];
        const now = new Date();
        const nowM = now.getHours() * 60 + now.getMinutes();

        rows.forEach(r => {
            r.classList.remove('cs-schedule-row-current', 'cs-schedule-row-upnext');
            const badge = r.querySelector('.cs-live-badge');
            if (badge) {
                badge.textContent = '';
                badge.className = 'cs-live-badge';
            }
        });

        const todayRows = Array.from(rows).filter(r => r.getAttribute('data-day') === todayName);
        if (todayRows.length === 0) return;

        let currentRow = null;
        for (const r of todayRows) {
            const s = parseInt(r.getAttribute('data-start-min'), 10);
            const e = parseInt(r.getAttribute('data-end-min'), 10);
            if (nowM >= s && nowM < e) {
                currentRow = r;
                break;
            }
        }

        if (currentRow) {
            currentRow.classList.add('cs-schedule-row-current');
            const b = currentRow.querySelector('.cs-live-badge');
            if (b) {
                b.textContent = 'Now';
                b.className = 'cs-live-badge cs-live-pill cs-live-pill-now';
            }
            return;
        }

        const later = todayRows
            .map(r => ({
                r,
                s: parseInt(r.getAttribute('data-start-min'), 10)
            }))
            .filter(x => x.s > nowM)
            .sort((a, b) => a.s - b.s);

        if (later.length > 0) {
            const next = later[0].r;
            next.classList.add('cs-schedule-row-upnext');
            const b = next.querySelector('.cs-live-badge');
            if (b) {
                b.textContent = 'Next';
                b.className = 'cs-live-badge cs-live-pill cs-live-pill-next';
            }
        }
    }

    function wireScheduleTimeEditors() {
        const root = document.getElementById('cs-schedule');
        if (!root) return;
        root.addEventListener('click', e => {
            const t = e.target;
            const row = t.closest && t.closest('.cs-schedule-row[data-meeting-key]');
            if (!row) return;
            const key = row.getAttribute('data-meeting-key');
            const disp = row.querySelector('.cs-time-display');
            const edit = row.querySelector('.cs-time-edit');
            const btnEdit = row.querySelector('.cs-edit-times-btn');
            const inpS = row.querySelector('.cs-inp-start');
            const inpE = row.querySelector('.cs-inp-end');

            if (t.closest && t.closest('.cs-edit-times-btn')) {
                if (disp) disp.style.display = 'none';
                if (btnEdit) btnEdit.style.display = 'none';
                if (edit) edit.style.display = 'block';
                return;
            }
            if (t.closest && t.closest('.cs-cancel-times-btn')) {
                if (edit) edit.style.display = 'none';
                if (disp) disp.style.display = '';
                if (btnEdit) btnEdit.style.display = '';
                if (inpS) inpS.value = row.getAttribute('data-start-str') || '';
                if (inpE) inpE.value = row.getAttribute('data-end-str') || '';
                return;
            }
            if (t.closest && t.closest('.cs-reset-times-btn')) {
                const cur = getStoredSchedule();
                if (!cur || !key) return;
                if (!cur.timeOverrides) cur.timeOverrides = {};
                delete cur.timeOverrides[key];
                if (Object.keys(cur.timeOverrides).length === 0) delete cur.timeOverrides;
                saveScheduleData(cur);
                renderCourseSchedulePage(cur, getCachedD2LCourses());
                return;
            }
            if (t.closest && t.closest('.cs-save-times-btn')) {
                const sm = tryParseTimeFlexible(inpS ? inpS.value : '');
                const em = tryParseTimeFlexible(inpE ? inpE.value : '');
                if (sm === null || em === null) {
                    alert('Could not parse times. Use 2:55 PM or 14:55 style.');
                    return;
                }
                if (em <= sm) {
                    alert('End time must be after start time.');
                    return;
                }
                const cur = getStoredSchedule();
                if (!cur || !key) return;
                if (!cur.timeOverrides) cur.timeOverrides = {};
                cur.timeOverrides[key] = {
                    startTime: formatMinutesAsAmPm(sm),
                    endTime: formatMinutesAsAmPm(em)
                };
                saveScheduleData(cur);
                renderCourseSchedulePage(cur, getCachedD2LCourses());
            }
        });
    }

    function attachCourseSchedulePageUI(saved) {
        if (csHighlightTimer) {
            clearInterval(csHighlightTimer);
            csHighlightTimer = null;
        }

        wireScheduleTimeEditors();

        const clearBtn = document.getElementById('cs-btn-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (!confirm('Clear the saved schedule? You can re-import from Athena anytime.')) return;
                try { GM_deleteValue(SCHEDULE_CACHE_KEY); } catch (e) {}
                try { sessionStorage.removeItem(CS_SESSION_KEY); } catch (e2) {}
                showCourseSchedulePage();
            });
        }

        const dlBtn = document.getElementById('cs-btn-ics');
        if (dlBtn) {
            dlBtn.addEventListener('click', () => {
                try {
                    const sched = getStoredSchedule() || saved;
                    const ics = buildScheduleICS(sched);
                    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'elc-course-schedule.ics';
                    a.click();
                    URL.revokeObjectURL(a.href);
                } catch (err) {
                    alert('Could not build calendar: ' + (err && err.message ? err.message : err));
                }
            });
        }

        updateScheduleRowHighlights();
        csHighlightTimer = setInterval(updateScheduleRowHighlights, 15000);
    }

    /** Main Course Schedule page entry point. */
    function showCourseSchedulePage() {
        saveCSRoute('main');
        const saved = getStoredSchedule();

        if (!saved || !saved.courses || saved.courses.length === 0) {
            takeover(`<div class="pt-page">
                <h1>Course Schedule</h1>
                <div style="padding:48px 20px;text-align:center;color:#6e7376;">
                    <div style="font-size:18px;font-weight:500;margin-bottom:12px;color:#333;">No schedule imported yet</div>
                    <p style="max-width:500px;margin:0 auto 24px;font-size:15px;">
                        Visit the <strong>UGA Athena registration page</strong>, switch to the
                        <strong>Schedule Details</strong> tab, then click
                        <strong>"Import to D2L Essentials"</strong> next to Class Schedule.
                    </p>
                    <a href="https://athena-prod.uga.edu/StudentRegistrationSsb/ssb/registrationHistory/registrationHistory"
                       target="_blank" class="pt-d2l-btn pt-d2l-btn-primary" style="text-decoration:none;">
                        Open Athena Registration Page
                    </a>
                </div>
            </div>`);
            return;
        }

        const cached = getCachedD2LCourses();
        renderCourseSchedulePage(saved, cached);

        loadD2LCourseList(fresh => {
            if (fresh.length > 0) {
                saveD2LCoursesCache(fresh);
                if (!d2lCourseListsEqual(fresh, cached)) renderCourseSchedulePage(saved, fresh);
            }
        });
    }

    function renderCourseSchedulePage(saved, d2lCourses) {
        saveCSRoute('main');
        const { term, importedAt, courses } = saved;
        const importDate = new Date(importedAt);
        const importStr  = importDate.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
                         + ' ' + importDate.toLocaleTimeString();

        // Cross-validate: match each Athena course to a D2L course
        const enriched = courses.map(c => ({ ...c, d2lMatch: matchD2LCourse(c, d2lCourses) }));

        // ── Build day → [{course, meeting}] map ──
        const dayMap   = {}; // day name → array of {course, meeting}
        const asyncCourses = [];

        enriched.forEach(course => {
            let hasDays = false;
            (course.meetings || []).forEach((meeting, mi) => {
                if (!meeting.days || meeting.days.length === 0) return;
                hasDays = true;
                const eff = getEffectiveMeetingTimes(course, meeting, mi, saved);
                meeting.days.forEach(day => {
                    if (!dayMap[day]) dayMap[day] = [];
                    dayMap[day].push({ course, meeting, meetingIndex: mi, eff });
                });
            });
            if (!hasDays) asyncCourses.push(course);
        });

        Object.keys(dayMap).forEach(day => {
            dayMap[day].sort((a, b) =>
                parseTimeToMinutes(a.eff.startTime) - parseTimeToMinutes(b.eff.startTime)
            );
        });

        // ── Determine display day order ──
        const now = new Date();
        const todayName     = DAY_NAMES[now.getDay()];
        const yesterdayDate = new Date(now); yesterdayDate.setDate(now.getDate() - 1);
        const yesterdayName = DAY_NAMES[yesterdayDate.getDay()];

        const toMF = d => (d + 6) % 7;
        const todayMF = toMF(now.getDay());
        const startMF = todayMF > 0 ? todayMF - 1 : 0;

        const MF_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const orderedDays = [];
        for (let i = 0; i < 7; i++) {
            orderedDays.push(MF_DAYS[(startMF + i) % 7]);
        }

        let sectionsHtml = '';
        let anyRendered = false;

        orderedDays.forEach(day => {
            const entries = dayMap[day];
            if (!entries || entries.length === 0) return;
            anyRendered = true;

            let label = day;
            let summaryExtraClass = '';
            if (day === todayName) {
                label = 'Today - ' + day;
                summaryExtraClass = ' cs-day-details-today';
            } else if (day === yesterdayName && todayMF > 0) {
                label = 'Yesterday - ' + day;
            }

            const isTodaySection = day === todayName;
            const openAttr = isTodaySection ? ' open' : '';

            let rowsHtml = '';
            entries.forEach(({ course, meeting, meetingIndex, eff }) => {
                const loc = [meeting.building, meeting.room ? 'Rm\u00a0' + meeting.room : ''].filter(Boolean).join(', ');
                const titleHtml = course.d2lMatch
                    ? `<a href="${escapeHtml(course.d2lMatch.href || '/d2l/home/' + course.d2lMatch.orgUnitId)}" target="_blank">${escapeHtml(course.title)}</a>`
                    : escapeHtml(course.title);
                const sub = [
                    `${escapeHtml(course.subjectCode)}\u00a0${escapeHtml(course.courseNumber)}`,
                    loc ? escapeHtml(loc) : '',
                    course.instructor ? escapeHtml(course.instructor) : ''
                ].filter(Boolean).join(' &nbsp;&#183;&nbsp; ');

                const timeClass = (day === yesterdayName && todayMF > 0)
                    ? 'cs-schedule-time cs-schedule-time-past' : 'cs-schedule-time';

                const sm = parseTimeToMinutes(eff.startTime);
                const em = parseTimeToMinutes(eff.endTime);
                const okey = meetingOverrideKey(course, meetingIndex);
                const hasOv = !!(saved.timeOverrides && saved.timeOverrides[okey]);
                const k = escapeHtml(okey);
                const effSt = escapeHtml(eff.startTime);
                const effEn = escapeHtml(eff.endTime);

                rowsHtml += `<div class="cs-schedule-row" data-day="${escapeHtml(day)}" data-start-min="${sm}" data-end-min="${em}" data-meeting-key="${k}" data-start-str="${effSt}" data-end-str="${effEn}">
                    <div class="cs-schedule-time-wrap">
                        <div class="cs-time-display ${timeClass}">
                            ${effSt}<br><span style="font-weight:400;font-size:12px;color:inherit;">&ndash; ${effEn}</span>
                            ${hasOv ? '<span class="cs-time-edited-tag" title="You changed these times">(edited)</span>' : ''}
                        </div>
                        <div class="cs-time-edit" style="display:none;">
                            <div class="cs-time-edit-row"><label>Start <input type="text" class="cs-inp-start" value="${effSt}" autocomplete="off" spellcheck="false" placeholder="2:55 PM"></label></div>
                            <div class="cs-time-edit-row"><label>End <input type="text" class="cs-inp-end" value="${effEn}" autocomplete="off" spellcheck="false" placeholder="4:15 PM"></label></div>
                            <div class="cs-time-edit-actions">
                                <button type="button" class="pt-d2l-btn pt-d2l-btn-primary cs-save-times-btn" style="font-size:12px;padding:4px 10px;">Save</button>
                                <button type="button" class="pt-d2l-btn cs-cancel-times-btn" style="font-size:12px;padding:4px 10px;">Cancel</button>
                                <button type="button" class="pt-d2l-btn cs-reset-times-btn" style="font-size:12px;padding:4px 10px;">Reset to Athena</button>
                            </div>
                        </div>
                        <button type="button" class="pt-d2l-btn cs-edit-times-btn" style="font-size:11px;padding:3px 8px;margin-top:6px;">Edit times</button>
                    </div>
                    <div class="cs-schedule-info">
                        <div class="cs-schedule-title">${titleHtml}<span class="cs-live-badge" aria-live="polite"></span></div>
                        <div class="cs-schedule-sub">${sub}</div>
                    </div>
                </div>`;
            });

            sectionsHtml += `<details class="cs-day-details${summaryExtraClass}"${openAttr}>
                <summary>${escapeHtml(label)}</summary>
                <div class="cs-day-details-body">${rowsHtml}</div>
            </details>`;
        });

        if (asyncCourses.length > 0) {
            let asyncRows = '';
            asyncCourses.forEach(course => {
                const titleHtml = course.d2lMatch
                    ? `<a href="${escapeHtml(course.d2lMatch.href || '/d2l/home/' + course.d2lMatch.orgUnitId)}" target="_blank">${escapeHtml(course.title)}</a>`
                    : escapeHtml(course.title);
                asyncRows += `<div class="cs-schedule-row">
                    <div class="cs-async-label">Online / Async</div>
                    <div class="cs-schedule-info">
                        <div class="cs-schedule-title">${titleHtml}</div>
                        <div class="cs-schedule-sub">${escapeHtml(course.subjectCode)}\u00a0${escapeHtml(course.courseNumber)}${course.instructor ? ' &nbsp;&#183;&nbsp; ' + escapeHtml(course.instructor) : ''}</div>
                    </div>
                </div>`;
            });
            sectionsHtml += `<details class="cs-day-details">
                <summary>Online / Async</summary>
                <div class="cs-day-details-body">${asyncRows}</div>
            </details>`;
        }

        if (!anyRendered && asyncCourses.length === 0) {
            sectionsHtml = `<p style="color:#6e7376;font-size:15px;">No courses with meeting times found in the imported schedule.</p>`;
        }

        takeover(`<div class="pt-page">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;margin-bottom:28px;">
                <div>
                    <h1 style="margin-bottom:4px;">Course Schedule</h1>
                    <div style="font-size:14px;color:#6e7376;">
                        ${escapeHtml(term)} &nbsp;&#183;&nbsp; ${enriched.length} course${enriched.length !== 1 ? 's' : ''}
                        &nbsp;&#183;&nbsp; Last imported: ${importStr}
                    </div>
                </div>
                <div class="cs-toolbar">
                    <div class="cs-toolbar-row">
                        <a href="https://athena-prod.uga.edu/StudentRegistrationSsb/ssb/registrationHistory/registrationHistory"
                           target="_blank" class="pt-d2l-btn" style="text-decoration:none;font-size:13px;white-space:nowrap;">
                            Update from Athena
                        </a>
                    </div>
                    <div class="cs-toolbar-row">
                        <button type="button" class="pt-d2l-btn pt-btn-danger" id="cs-btn-clear" style="font-size:13px;">Clear schedule</button>
                        <button type="button" class="pt-d2l-btn pt-d2l-btn-primary" id="cs-btn-ics" style="font-size:13px;">Download .ics</button>
                    </div>
                </div>
            </div>
            <div id="cs-schedule">${sectionsHtml}</div>
        </div>`);

        attachCourseSchedulePageUI(saved);
    }

    // ── TASKS & TO-DO (assignments + quizzes across courses) ──
    function gmFetchD2L(url) {
        const full = (url && url.startsWith('http')) ? url : (window.location.origin + (String(url).startsWith('/') ? url : '/' + url));
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: full,
                onload(res) {
                    if (res.status >= 200 && res.status < 400) resolve(res.responseText);
                    else reject(new Error('HTTP ' + res.status));
                },
                onerror() { reject(new Error('Network error')); }
            });
        });
    }

    function parseTaskDueToTs(label) {
        if (!label || !String(label).trim()) return null;
        const t = Date.parse(String(label).trim());
        return isNaN(t) ? null : t;
    }

    function sortTasksByDue(items) {
        return items.slice().sort((a, b) => {
            const at = a.dueTs, bt = b.dueTs;
            if (at == null && bt == null) return 0;
            if (at == null) return 1;
            if (bt == null) return -1;
            return at - bt;
        });
    }

    function parseDropboxAssignments(html, orgUnitId) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const table = doc.querySelector('table[summary="List of assignments for this course"]');
        if (!table) return [];
        const out = [];
        const rows = table.querySelectorAll('tbody > tr');
        rows.forEach(tr => {
            if (tr.getAttribute('header') != null) return;
            if (tr.querySelector('th[scope="col"]')) return;
            if (tr.querySelector('td[colspan]') && !tr.querySelector('th[scope="row"]')) return;
            const th = tr.querySelector('th[scope="row"]');
            if (!th) return;
            const nameA = th.querySelector('.d2l-foldername-medium-font a');
            const tEl = nameA || th.querySelector('.d2l-foldername-medium-font strong, label strong, strong');
            if (!tEl) return;
            const title = tEl.textContent.replace(/\s+/g, ' ').trim();
            if (!title) return;
            const tds = tr.querySelectorAll('td');
            if (tds.length < 1) return;
            const statusCell = tds[0];
            const statusText = statusCell.textContent.replace(/\s+/g, ' ').trim();
            const histA = tr.querySelector('a[href*="folders_history"]');
            const nameSubA = th.querySelector('a[href*="folder_submit_files"]');
            const stSubA = statusCell.querySelector('a[href*="folder_submit_files"]');
            let submitted = false;
            if (histA) submitted = true;
            else if (/\b\d+\s*Submission/i.test(statusText)) submitted = true;
            else if (/not submitted/i.test(statusText)) submitted = false;
            else if (statusCell.querySelector('a[href*="folders_history"]')) submitted = true;
            else submitted = false;
            let targetHref = '';
            if (submitted) {
                if (histA) targetHref = histA.getAttribute('href') || '';
                else {
                    const dbm = tr.innerHTML.match(/[?&]db=(\d+)/);
                    if (dbm) {
                        targetHref = `/d2l/lms/dropbox/user/folders_history.d2l?db=${dbm[1]}&grpid=0&isprv=0&bp=0&ou=${orgUnitId}`;
                    }
                }
            } else {
                if (nameSubA) targetHref = nameSubA.getAttribute('href') || '';
                else if (stSubA) targetHref = stSubA.getAttribute('href') || '';
                else {
                    const dbm = tr.innerHTML.match(/[?&]db=(\d+)/);
                    if (dbm) {
                        targetHref = `/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${dbm[1]}&grpid=0&isprv=0&bp=0&ou=${orgUnitId}`;
                    }
                }
            }
            if (!targetHref) {
                targetHref = `/d2l/lms/dropbox/dropbox.d2l?ou=${orgUnitId}`;
            }
            if (targetHref.startsWith('/')) {
                targetHref = window.location.origin + targetHref;
            }
            let dueLabel = '';
            const dueEl = th.querySelector('.d2l-dates-text label');
            if (dueEl) {
                const m = dueEl.textContent.replace(/\s+/g, ' ').match(/Due on\s+(.+)/i);
                dueLabel = m ? m[1].trim() : dueEl.textContent.trim();
            }
            out.push({
                kind: 'assignment',
                courseId: orgUnitId,
                title,
                submitted,
                href: targetHref,
                dueLabel,
                dueTs: parseTaskDueToTs(dueLabel)
            });
        });
        return out;
    }

    function parseQuizzesFromHtml(html, orgUnitId) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const out = [];
        doc.querySelectorAll('a[onclick*="GoToQuiz"]').forEach(a => {
            const oc = a.getAttribute('onclick') || '';
            const m = oc.match(/GoToQuiz\(\s*(\d+)/);
            if (!m) return;
            const qi = m[1];
            const tr = a.closest('tr');
            if (!tr) return;
            const title = a.textContent.replace(/\s+/g, ' ').trim();
            if (!title) return;
            const attCell = tr.querySelector('td:last-child');
            let submitted = false;
            if (attCell) {
                const am = attCell.textContent.replace(/\s+/g, ' ').match(/(\d+)\s*\/\s*(\d+)/);
                if (am) submitted = parseInt(am[1], 10) > 0;
            }
            const path = submitted
                ? `/d2l/lms/quizzing/user/quiz_submissions.d2l?qi=${qi}&ou=${orgUnitId}`
                : `/d2l/lms/quizzing/user/attempt/quiz_start.d2l?qi=${qi}&ou=${orgUnitId}`;
            let dueLabel = '';
            const ds = tr.querySelector('.ds_b');
            if (ds) {
                const tm = ds.textContent.replace(/\s+/g, ' ').match(/Due on\s*([^\n<]+?)(?=\s*(?:Available|$))/i);
                if (tm) dueLabel = tm[1].trim();
                else {
                    const tm2 = ds.textContent.replace(/\s+/g, ' ').match(/Due on\s+(.+)/i);
                    dueLabel = tm2 ? tm2[1].trim().split('Available')[0].trim() : '';
                }
            }
            out.push({
                kind: 'quiz',
                courseId: orgUnitId,
                title,
                submitted,
                href: window.location.origin + path,
                dueLabel,
                dueTs: parseTaskDueToTs(dueLabel)
            });
        });
        return out;
    }

    function fetchTasksForSingleCourse(course) {
        const ou = course && course.orgUnitId;
        if (!ou) {
            return Promise.resolve({ course, items: [], error: 'Missing org unit' });
        }
        const o = window.location.origin;
        const dUrl = o + '/d2l/lms/dropbox/dropbox.d2l?ou=' + encodeURIComponent(ou);
        const qUrl = o + '/d2l/lms/quizzing/quizzing.d2l?ou=' + encodeURIComponent(ou);
        return Promise.all([
            gmFetchD2L(dUrl).catch(err => err),
            gmFetchD2L(qUrl).catch(err => err)
        ]).then(([h1, h2]) => {
            const errBits = [];
            if (h1 instanceof Error) errBits.push('Assignments: ' + h1.message);
            if (h2 instanceof Error) errBits.push('Quizzes: ' + h2.message);
            const s1 = typeof h1 === 'string' ? h1 : '';
            const s2 = typeof h2 === 'string' ? h2 : '';
            let items = [];
            if (s1) items = items.concat(parseDropboxAssignments(s1, String(ou)));
            if (s2) items = items.concat(parseQuizzesFromHtml(s2, String(ou)));
            const name = (course && course.name) || 'Course ' + ou;
            items.forEach(it => { it.courseName = name; });
            return { course, items, error: errBits.length ? errBits.join(' — ') : null };
        });
    }

    function tasksScheduleFingerprint() {
        try {
            const s = getStoredSchedule();
            if (!s || !Array.isArray(s.courses)) return '';
            return JSON.stringify(s.courses.map(c => [c.courseCode, c.crn, c.title]));
        } catch (e) { return ''; }
    }

    function readTasksCache() {
        try {
            const raw = GM_getValue(TASKS_CACHE_KEY, '');
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) { return null; }
    }

    function writeTasksCache(payload) {
        try { GM_setValue(TASKS_CACHE_KEY, JSON.stringify(payload)); } catch (e) {}
    }

    function tasksCacheUsable(cached, courseList) {
        if (!cached || typeof cached.savedAt !== 'number' || !Array.isArray(cached.results) || !Array.isArray(cached.courses)) return false;
        if (Date.now() - cached.savedAt > TASKS_CACHE_TTL_MS) return false;
        if (cached.scheduleFp !== tasksScheduleFingerprint()) return false;
        const want = (courseList || []).map(c => String(c.orgUnitId)).sort().join(',');
        const have = (cached.courses || []).map(c => String(c.orgUnitId)).sort().join(',');
        if (want !== have) return false;
        return true;
    }

    function startOfLocalDay(d) {
        const x = new Date(d);
        return new Date(x.getFullYear(), x.getMonth(), x.getDate());
    }

    function isPastDueIncomplete(it) {
        if (it.submitted || it.dueTs == null) return false;
        return it.dueTs < Date.now();
    }

    /** Not submitted, not yet past due, due calendar = today or tomorrow. */
    function isDueUrgentHighlight(it) {
        if (it.submitted || it.dueTs == null) return false;
        if (it.dueTs < Date.now()) return false;
        const t0 = startOfLocalDay(new Date());
        const t1 = new Date(t0);
        t1.setDate(t0.getDate() + 1);
        const d = startOfLocalDay(new Date(it.dueTs));
        return d.getTime() === t0.getTime() || d.getTime() === t1.getTime();
    }

    function taskRowExtraClass(it) {
        if (!it.submitted && isPastDueIncomplete(it)) return 'pt-tasks-row--overdue';
        if (isDueUrgentHighlight(it)) return 'pt-tasks-row--urgent';
        return '';
    }

    function filterVisibleIncomplete(incomplete, showPastDue) {
        if (showPastDue) return incomplete.slice();
        return incomplete.filter(t => !isPastDueIncomplete(t));
    }

    function taskOneRowHtml(it, showCourse) {
        const kindLabel = it.kind === 'quiz' ? 'Quiz' : 'Assignment';
        const ex = taskRowExtraClass(it);
        const main = it.href
            ? `<a href="${escapeHtml(it.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a>`
            : escapeHtml(it.title);
        const courseBit = (showCourse && it.courseName)
            ? ' <span class="pt-tasks-bycourse">— ' + escapeHtml(it.courseName) + '</span>'
            : '';
        const due = it.dueLabel
            ? 'Due: ' + escapeHtml(it.dueLabel)
            : (it.dueTs ? 'Due: (see Brightspace)' : '—');
        return `<li${ex ? ` class="${ex}"` : ''}>
            <span class="pt-tasks-type">${escapeHtml(kindLabel)}</span>
            <div class="pt-tasks-title">${main}${courseBit}</div>
            <span class="pt-tasks-meta">${escapeHtml(due)}</span>
        </li>`;
    }

    function tasksListUl(arr, showCourse) {
        if (!arr.length) return '<p class="pt-tasks-hint" style="padding:0 6px 8px;">None in this list.</p>';
        const u = sortTasksByDue(arr).map(t => taskOneRowHtml(t, showCourse)).join('');
        return `<ul class="pt-tasks-list">${u}</ul>`;
    }

    function buildQuadrantViewHtml(visibleIncomplete, allIncomplete, showPastDue, showCourse) {
        const nHidden = allIncomplete.filter(t => isPastDueIncomplete(t)).length;
        const buckets = { overdue: [], urgent: [], week: [], ahead: [], undated: [] };
        visibleIncomplete.forEach(it => {
            if (isPastDueIncomplete(it)) { buckets.overdue.push(it); return; }
            if (it.dueTs == null) { buckets.undated.push(it); return; }
            const t0 = startOfLocalDay(new Date());
            const d = startOfLocalDay(new Date(it.dueTs));
            const diff = Math.round((d - t0) / 864e5);
            if (diff <= 1) buckets.urgent.push(it);
            else if (diff >= 2 && diff <= 7) buckets.week.push(it);
            else buckets.ahead.push(it);
        });
        let html = '<div class="pt-tasks-quad-wrap">';
        if (!showPastDue && nHidden > 0) {
            html += `<p class="pt-tasks-hint"><strong>${nHidden}</strong> not-completed, past-due item${nHidden === 1 ? '' : 's'} hidden. Turn on <strong>Show past-due, not completed</strong> to see them (and in the “Past due” area below in quadrant view).</p>`;
        }
        if (buckets.overdue.length) {
            html += '<div class="pt-tasks-quad-ov pt-tasks-q-late"><h4>Past due (not completed)</h4>' + tasksListUl(buckets.overdue, showCourse) + '</div>';
        }
        html += '<div class="pt-tasks-quad">';
        const qUrgent = { title: 'Due today or tomorrow', cls: 'pt-tasks-q-urgent', items: sortTasksByDue(buckets.urgent) };
        const qWeek = { title: 'Due in 2–7 days', cls: '', items: sortTasksByDue(buckets.week) };
        const qAhead = { title: 'Get ahead (8+ days)', cls: '', items: sortTasksByDue(buckets.ahead) };
        const qUn = { title: 'No due date', cls: '', items: sortTasksByDue(buckets.undated) };
        [qUrgent, qWeek, qAhead, qUn].forEach(q => {
            html += `<div class="pt-tasks-q ${q.cls}"><h4>${escapeHtml(q.title)}</h4>${tasksListUl(q.items, showCourse)}</div>`;
        });
        html += '</div><p class="pt-tasks-hint">Quadrant view helps you <strong>do first</strong> (this week) vs <strong>plan ahead</strong> (later). Yellow highlights in the list view mark items due today or tomorrow (when still not past the due time).</p></div>';
        return html;
    }

    function buildTasksPageInner(tasksData, courseKey, groupKey, viewType, showPastDue) {
        const results = (tasksData && tasksData.results) ? tasksData.results : [];
        let re = courseKey && courseKey !== 'all'
            ? results.filter(r => String((r.course && r.course.orgUnitId) || '') === String(courseKey))
            : results.slice();
        if (!re.length) {
            return '<p class="pt-tasks-err">No data for the selected filter. Check <strong>Refresh</strong> or re-import your schedule in Course Schedule if classes changed.</p>';
        }
        const byCourse = (groupKey === 'byCourse') && (!courseKey || courseKey === 'all');

        if (viewType === 'quadrant') {
            const all = [];
            re.forEach(e => (e.items || []).forEach(x => { all.push(x); }));
            const inc = all.filter(i => !i.submitted);
            const allInc = inc.slice();
            const vis = filterVisibleIncomplete(inc, showPastDue);
            return buildQuadrantViewHtml(vis, allInc, showPastDue, (courseKey === 'all')) +
                (function () {
                    const d = all.filter(i => i.submitted);
                    if (!d.length) return '';
                    return `<details class="pt-tasks-details" style="margin-top:20px"><summary>Submitted / done (${d.length})</summary><div class="pt-tasks-details-in">` + tasksListUl(d, (courseKey === 'all')) + `</div></details>`;
                }());
        }

        if (byCourse) {
            let out = '<details class="pt-tasks-details" open><summary>Not completed</summary><div class="pt-tasks-details-in">';
            re.forEach(e => {
                if (!e.items) e.items = [];
                const inc = e.items.filter(i => !i.submitted);
                const v = filterVisibleIncomplete(inc, showPastDue);
                if (e.error) {
                    out += '<div class="pt-tasks-course"><p class="pt-tasks-err">' + escapeHtml(e.error) + '</p></div>';
                    return;
                }
                const cname = (e.course && e.course.name) ? e.course.name : 'Course';
                out += '<details class="pt-tasks-details" open><summary>' + escapeHtml(cname) + ' (' + v.length + ')</summary><div class="pt-tasks-details-in">';
                out += v.length ? tasksListUl(v, false) : '<p class="pt-tasks-hint">Nothing due here (or all past-due hidden).</p>';
                out += '</div></details>';
            });
            if (!showPastDue) {
                const pastN = re.reduce((acc, e) => {
                    return acc + (e.items || []).filter(t => !t.submitted && isPastDueIncomplete(t)).length;
                }, 0);
                if (pastN > 0) {
                    out += '<p class="pt-tasks-hint">' + pastN + ' past-due, not completed hidden — use the filter above to show them.</p>';
                }
            }
            out += '</div></details>';
            out += '<details class="pt-tasks-details" style="margin-top:8px"><summary>Submitted / done</summary><div class="pt-tasks-details-in">';
            re.forEach(e => {
                if (!e.items) e.items = [];
                const d = e.items.filter(i => i.submitted);
                const cname = (e.course && e.course.name) ? e.course.name : 'Course';
                out += '<details class="pt-tasks-details" style="margin-top:4px" ' + (d.length ? 'open' : '') + '><summary>' + escapeHtml(cname) + ' (' + d.length + ')</summary><div class="pt-tasks-details-in">';
                out += d.length ? tasksListUl(d, false) : '<p class="pt-tasks-hint">—</p>';
                out += '</div></details>';
            });
            out += '</div></details>';
            return out;
        }

        const all = [];
        re.forEach(e => (e.items || []).forEach(x => { all.push(x); }));
        const inc = all.filter(i => !i.submitted);
        const allInc = inc.slice();
        const vis = filterVisibleIncomplete(inc, showPastDue);
        const d = all.filter(i => i.submitted);
        const showTag = (courseKey === 'all');
        let html = '<details class="pt-tasks-details" open><summary>Not completed (' + vis.length + ')</summary><div class="pt-tasks-details-in">';
        if (!showPastDue) {
            const pN = allInc.filter(t => isPastDueIncomplete(t)).length;
            if (pN) html += '<p class="pt-tasks-hint">' + pN + ' past-due, not completed hidden</p>';
        }
        html += vis.length ? tasksListUl(vis, showTag) : '<p class="pt-tasks-hint">You are caught up, or all remaining items are past-due (toggle the filter to see them), or have no due date in Brightspace yet.</p>';
        html += '</div></details>';
        html += '<details class="pt-tasks-details" style="margin-top:8px"><summary>Submitted / done (' + d.length + ')</summary><div class="pt-tasks-details-in">';
        html += d.length ? tasksListUl(d, showTag) : '<p class="pt-tasks-hint">—</p>';
        html += '</div></details>';
        return html;
    }

    function formatTasksCacheLabel(savedAt) {
        if (typeof savedAt !== 'number') return '';
        const s = Math.floor((Date.now() - savedAt) / 1000);
        if (s < 60) return 'Updated just now';
        if (s < 3600) return 'Updated ' + Math.floor(s / 60) + ' min ago';
        return 'Updated ' + new Date(savedAt).toLocaleString();
    }

    function getTasksPageShell() {
        const c = (tasksDataCache && tasksDataCache.courses) ? tasksDataCache.courses : [];
        const src = (tasksDataCache && tasksDataCache._source) || '';
        const sa = (tasksDataCache && tasksDataCache._savedAt) || 0;
        const hint = sa ? formatTasksCacheLabel(sa) + (src === 'cache' ? ' (cached — refreshing in background if stale)' : '') : '';
        let opt = '<option value="all">All schedule courses</option>';
        c.forEach(x => {
            if (!x || !x.orgUnitId) return;
            opt += '<option value="' + escapeHtml(String(x.orgUnitId)) + '">' + escapeHtml(x.name || ('Course ' + x.orgUnitId)) + '</option>';
        });
        return `<div class="pt-page pt-tasks-page">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:8px;">
                <div>
                    <h1 style="margin:0;">Track work & get ahead</h1>
                    <span id="pt-tasks-cache-hint" class="pt-tasks-cache-hint">${escapeHtml(hint)}</span>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button type="button" class="pt-d2l-btn" id="pt-tasks-refresh" title="Fetch latest from Brightspace">Refresh from D2L</button>
                </div>
            </div>
            <p style="color:#6e7376;font-size:14px;max-width:52em; margin-bottom:8px;">See what is still <strong>due soon</strong>, what you can <strong>get ahead on</strong>, and what is already done. Only courses from your <strong>imported Athena schedule</strong> appear. Past-due work stays out of the way until you want it. Brightspace is loaded once and cached so reopening this tab is fast; use Refresh to pull changes.</p>
            <div class="pt-tasks-toolbar">
                <label>Course
                    <select id="pt-tasks-course">${opt}</select>
                </label>
                <label>Group
                    <select id="pt-tasks-group">
                        <option value="byCourse">By course</option>
                        <option value="all">All items (flat)</option>
                    </select>
                </label>
                <label>View
                    <select id="pt-tasks-viewtype">
                        <option value="list">List (collapsible)</option>
                        <option value="quadrant">Quadrant (planning)</option>
                    </select>
                </label>
                <label class="pt-tasks-ck">
                    <input type="checkbox" id="pt-tasks-past" />
                    <span>Show past-due, not completed</span>
                </label>
            </div>
            <div id="pt-tasks-body"></div>
        </div>`;
    }

    function mountTasksPageBody() {
        const c = document.getElementById('pt-tasks-course');
        const g = document.getElementById('pt-tasks-group');
        const v = document.getElementById('pt-tasks-viewtype');
        const p = document.getElementById('pt-tasks-past');
        const kc = c ? c.value : 'all';
        const kg = g ? g.value : 'byCourse';
        const kv = v ? v.value : 'list';
        const showPast = !!(p && p.checked);
        const body = document.getElementById('pt-tasks-body');
        if (body) {
            body.innerHTML = buildTasksPageInner(tasksDataCache, kc, kg, kv, showPast);
        }
    }

    function attachTasksPageUI() {
        const ref = document.getElementById('pt-tasks-refresh');
        if (ref) {
            ref.addEventListener('click', () => showTasksPage({ forceNetwork: true }));
        }
        ['pt-tasks-course', 'pt-tasks-group', 'pt-tasks-viewtype', 'pt-tasks-past'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                const ev = (id === 'pt-tasks-past') ? 'change' : 'change';
                el.addEventListener(ev, mountTasksPageBody);
            }
        });
    }

    function runTasksLoad(courseList, options) {
        const opts = options || {};
        const inBackground = !!opts.background;
        if (!courseList || !courseList.length) {
            if (!inBackground) {
                tasksDataCache = { courses: [], results: [], _source: 'empty' };
                takeover(getTasksPageShell());
                document.getElementById('pt-tasks-body').innerHTML =
                    '<p class="pt-tasks-err">No courses from your <strong>schedule</strong> matched D2L. Import your class schedule in <strong>Course Schedule</strong> and ensure course codes match, then open the course switcher (waffle) once so D2L lists your orgs.</p>';
                attachTasksPageUI();
            }
            return;
        }
        return Promise.all(courseList.map(c => fetchTasksForSingleCourse(c))).then(results => {
            const payload = { courses: courseList, results, _source: inBackground ? 'background' : 'network', _savedAt: Date.now() };
            tasksDataCache = payload;
            writeTasksCache({ savedAt: Date.now(), scheduleFp: tasksScheduleFingerprint(), courses: courseList, results, source: 'ok' });
            if (!inBackground) {
                takeover(getTasksPageShell());
                const sel = document.getElementById('pt-tasks-course');
                if (sel && courseList.length === 1) {
                    sel.value = String(courseList[0].orgUnitId);
                }
                const hint = document.getElementById('pt-tasks-cache-hint');
                if (hint) hint.textContent = formatTasksCacheLabel(Date.now());
            } else {
                const hint = document.getElementById('pt-tasks-cache-hint');
                if (hint) hint.textContent = formatTasksCacheLabel(Date.now()) + ' (refreshed)';
            }
            if (document.getElementById('pt-tasks-body')) {
                if (!inBackground) {
                    mountTasksPageBody();
                    attachTasksPageUI();
                } else {
                    mountTasksPageBody();
                }
            }
        }).catch(err => {
            if (!inBackground) {
                tasksDataCache = { courses: courseList, results: [], _source: 'err', _savedAt: Date.now() };
                takeover(getTasksPageShell());
                const b = document.getElementById('pt-tasks-body');
                if (b) b.innerHTML = '<p class="pt-tasks-err">Could not load tasks: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
                attachTasksPageUI();
            }
        });
    }

    function maybeBackgroundRefreshTasks(courseList) {
        if (!Array.isArray(courseList) || !courseList.length) return;
        const c = readTasksCache();
        if (!c || typeof c.savedAt !== 'number') return;
        if (Date.now() - c.savedAt < TASKS_BG_STALE_MS) return;
        runTasksLoad(courseList, { background: true });
    }

    function showTasksPage(opt) {
        const forceNetwork = opt && opt.forceNetwork;
        saveTasksRoute('main');
        takeover(`<div class="pt-page pt-tasks-page"><h1>Track work & get ahead</h1><p style="color:#6e7376;">Loading your schedule and Brightspace…</p></div>`);
        loadD2LCourseList(fresh => {
            const d2l = (fresh && fresh.length) ? fresh : getCachedD2LCourses();
            if (fresh && fresh.length) {
                try { saveD2LCoursesCache(fresh); } catch (e) {}
            }
            const m = buildScheduleMatchedD2LCourses(d2l);
            if (m.error === 'no_schedule') {
                takeover(`<div class="pt-page"><h1>Track work & get ahead</h1>
                    <p class="pt-tasks-err">You need a schedule first. In <strong>Course Schedule</strong>, import your classes from Athena, then return here.</p>
                    <a href="https://athena-prod.uga.edu/StudentRegistrationSsb/ssb/registrationHistory/registrationHistory" target="_blank" class="pt-d2l-btn pt-d2l-btn-primary" style="text-decoration:none;">Open Athena registration</a></div>`);
                return;
            }
            if (m.error === 'no_d2l' || !d2l.length) {
                takeover(`<div class="pt-page"><h1>Track work & get ahead</h1>
                    <p class="pt-tasks-err">No D2L course list yet. Open the <strong>course switcher (waffle)</strong> in the minibar, then try again.</p></div>`);
                return;
            }
            if (m.error === 'no_match' || !m.list.length) {
                takeover(`<div class="pt-page"><h1>Track work & get ahead</h1>
                    <p class="pt-tasks-err">No D2L course matched your imported schedule. Check that section names/codes in D2L match (same as Course Schedule), then use <strong>Refresh from D2L</strong> after the switcher has loaded.</p></div>`);
                return;
            }
            const list = m.list;
            if (!forceNetwork) {
                const snap = readTasksCache();
                if (tasksCacheUsable(snap, list) && Array.isArray(snap.results) && snap.results.length) {
                    tasksDataCache = {
                        courses: list,
                        results: snap.results,
                        _source: 'cache',
                        _savedAt: snap.savedAt
                    };
                    takeover(getTasksPageShell());
                    if (list.length === 1) {
                        const sel = document.getElementById('pt-tasks-course');
                        if (sel) sel.value = String(list[0].orgUnitId);
                    }
                    mountTasksPageBody();
                    attachTasksPageUI();
                    setTimeout(() => maybeBackgroundRefreshTasks(list), 400);
                    return;
                }
            }
            runTasksLoad(list, {});
        });
    }

    // Auto-restore when user navigates away from a takeover view
    function clearTakeoverState() {
        if (!practiceTestActive) return;
        savedMainFragment = null;
        practiceTestActive = false;
        savedMainOverflow = null;
        savedMainMaxHeight = null;
        savedMainHeight = null;
        try { sessionStorage.removeItem(PT_SESSION_ROUTE_KEY); } catch (e) {}
        try { sessionStorage.removeItem(CS_SESSION_KEY); } catch (e) {}
        try { sessionStorage.removeItem(TASKS_SESSION_KEY); } catch (e) {}
        if (csHighlightTimer) { clearInterval(csHighlightTimer); csHighlightTimer = null; }
    }

    function installNavInterceptors() {
        // Intercept clicks on D2L's native nav links (not our injected tabs).
        document.addEventListener('click', function (e) {
            if (!practiceTestActive) return;
            const link = e.target && e.target.closest
                ? e.target.closest('.d2l-navigation-s-link, .d2l-navigation-s-item a')
                : null;
            if (!link) return;
            if (link.closest('#pt-practice-tab, #pt-schedule-tab, #pt-tasks-tab')) return;
            clearTakeoverState();
        }, true);

        // Patch pushState / replaceState to catch SPA navigation.
        const _push = history.pushState.bind(history);
        const _replace = history.replaceState.bind(history);
        history.pushState = function (state, title, url) {
            if (practiceTestActive) clearTakeoverState();
            return _push(state, title, url);
        };
        history.replaceState = function (state, title, url) {
            if (practiceTestActive) clearTakeoverState();
            return _replace(state, title, url);
        };

        // Catch browser back/forward.
        window.addEventListener('popstate', function () {
            if (practiceTestActive) clearTakeoverState();
        });
    }

    // ── NAV TAB INJECTION ──
    function makeNavTab(id, label, onClick) {
        const tab = document.createElement('div');
        tab.className = 'd2l-navigation-s-item';
        tab.id = id;
        tab.setAttribute('role', 'listitem');
        const link = document.createElement('a');
        link.className = 'd2l-navigation-s-link';
        link.href = 'javascript:void(0)';
        link.textContent = label;
        link.addEventListener('click', e => { e.preventDefault(); onClick(); });
        tab.appendChild(link);
        return tab;
    }

    function injectNavTab() {
        const navWrapper = document.querySelector('.d2l-navigation-s-main-wrapper');
        if (!navWrapper) return;

        // Inject Practice Tests tab
        if (!navWrapper.querySelector('#pt-practice-tab')) {
            const items = navWrapper.querySelectorAll('.d2l-navigation-s-item:not(.d2l-navigation-s-more)');
            const last = items[items.length - 1];
            const tab = makeNavTab('pt-practice-tab', 'Practice Tests', showTestList);
            if (last && last.nextSibling) navWrapper.insertBefore(tab, last.nextSibling);
            else navWrapper.appendChild(tab);
        }

        // Inject Course Schedule tab right after Practice Tests
        if (!navWrapper.querySelector('#pt-schedule-tab')) {
            const practiceTab = navWrapper.querySelector('#pt-practice-tab');
            const tab = makeNavTab('pt-schedule-tab', 'Course Schedule', showCourseSchedulePage);
            if (practiceTab && practiceTab.nextSibling) navWrapper.insertBefore(tab, practiceTab.nextSibling);
            else navWrapper.appendChild(tab);
        }

        if (!navWrapper.querySelector('#pt-tasks-tab')) {
            const schedTab = navWrapper.querySelector('#pt-schedule-tab');
            const tab = makeNavTab('pt-tasks-tab', 'Tasks', showTasksPage);
            if (schedTab && schedTab.nextSibling) navWrapper.insertBefore(tab, schedTab.nextSibling);
            else navWrapper.appendChild(tab);
        }
    }

    // ── INIT ──
    const isAthenaPage = window.location.hostname.includes('athena-prod.uga.edu');

    function init() {
        if (isAthenaPage) {
            // On Athena: inject the import button into the registration history page
            injectAthenaImportButton();
            return;
        }

        preloadScheduleFromChrome(() => {
            installNavInterceptors();

            if (!window.__elcD2lMessageListener) {
                window.__elcD2lMessageListener = true;
                chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
                    if (msg && msg.type === 'ELC_REFRESH_SCHEDULE') {
                        chrome.storage.local.get(SCHEDULE_CACHE_KEY, (r) => {
                            try {
                                const raw = r[SCHEDULE_CACHE_KEY];
                                _scheduleCross = raw ? JSON.parse(raw) : null;
                            } catch (e) {
                                _scheduleCross = loadScheduleFromGm();
                            }
                            try {
                                showCourseSchedulePage();
                            } catch (e2) {}
                            sendResponse({ ok: true });
                        });
                        return true;
                    }
                });
            }

            chrome.storage.local.get('elc_pending_open_schedule', (r) => {
                if (window.__elcPendingScheduleHandled) return;
                if (r.elc_pending_open_schedule) {
                    window.__elcPendingScheduleHandled = true;
                    chrome.storage.local.remove('elc_pending_open_schedule', () => {
                        setTimeout(() => {
                            try {
                                showCourseSchedulePage();
                            } catch (e) {}
                        }, 900);
                    });
                }
            });

        // On D2L: inject nav tabs
        if (document.querySelector('.d2l-navigation-s-main-wrapper')) injectNavTab();
        else {
            const obs = new MutationObserver(() => {
                if (document.querySelector('.d2l-navigation-s-main-wrapper')) { obs.disconnect(); injectNavTab(); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }

        schedulePracticeSessionRestore();
        scheduleCSSessionRestore();
        scheduleTasksSessionRestore();
        initGradeCalculator();
        });
    }
    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);
    setTimeout(init, 1500);
    setTimeout(init, 4000);    }

    chrome.storage.local.get({ elc_extension_enabled: true }, function (cfg) {
        // Default is enabled (true). Only skip when the user has explicitly turned the extension off.
        if (chrome.runtime.lastError) {
            elcMain();
            return;
        }
        if (cfg && cfg.elc_extension_enabled === false) return;
        elcMain();
    });
})();

