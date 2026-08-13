/**
 * Rebuilds content.js from d2l-practice-tests.user.js + extension-only glue.
 * Run: node merge-elc-content.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userPath = path.join(__dirname, '..', 'ELC Tampermonkey Practice Test', 'd2l-practice-tests.user.js');
const outPath = path.join(__dirname, 'content.js');

const user = fs.readFileSync(userPath, 'utf8');

// Use a single \n after 'use strict' so the next line's indentation (e.g. "    // …") is preserved.
const m = user.match(
    /^\(function \(\) \{\s*'use strict';\r?\n([\s\S]*?)\r?\n\}\)\(\);\r?\n?$/m
);
if (!m) {
    console.error('Could not parse userscript IIFE');
    process.exit(1);
}
let core = m[1];

// Extension: DocumentFragment takeover + elcSetHtml (AMO / no innerHTML assignment on main)
const elcSetHtmlFn = `
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
`;

const fragBlock = `    /** @type {DocumentFragment|null} Saved D2L main-region nodes (no innerHTML read/write for AMO linter). */
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
    }`;

// Remove userscript's savedMain + takeover + restore + duplicate lets (tasks may be in user block)
core = core.replace(
    /    let savedMainContent = null;[\s\S]*?    function restore\(\) \{[\s\S]*?        \}\n    \}/m,
    fragBlock
);

// Insert elcSetHtml after escapeHtml
if (!core.includes('function elcSetHtml(')) {
    core = core.replace(
        /(    function escapeHtml\(s\) \{[\s\S]*?    \})\n/,
        `$1\n${elcSetHtmlFn}\n`
    );
}

// Chrome: schedule storage bridge
const schedBridge = `    /** In-memory mirror; also synced via chrome.storage.local so Athena imports reach D2L (different origins). */
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
    }`;

const beforeSched = core;
core = core.replace(
    /    function getStoredSchedule\(\) \{[\s\S]*?    \}\r?\n\r?\n    function saveScheduleData\(data\) \{[\s\S]*?    \}/m,
    schedBridge
);
if (core === beforeSched) {
    console.error('getStoredSchedule/saveScheduleData replace failed — pattern mismatch.');
    process.exit(1);
}

// Init: preload + chrome messages + task restore
const newInit = `    function init() {
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
    }`;

{
    const initStart = core.indexOf('    function init() {');
    const initEndMarker = "\n    if (document.readyState === 'complete') init();";
    const initEnd = core.indexOf(initEndMarker, initStart);
    if (initStart === -1 || initEnd === -1) {
        console.error('init() block not found for splice');
        process.exit(1);
    }
    core = core.slice(0, initStart) + newInit + core.slice(initEnd);
}

// clearTakeoverState: use savedMainFragment + TASKS key
core = core.replace(
    /    function clearTakeoverState\(\) \{[\s\S]*?    \}/m,
    `    function clearTakeoverState() {
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
    }`
);

// Nav intercept: include tasks tab
core = core.replace(
    /if \(link\.closest\('#pt-practice-tab, #pt-schedule-tab'\)\) return;/g,
    "if (link.closest('#pt-practice-tab, #pt-schedule-tab, #pt-tasks-tab')) return;"
);

const header = `(function () {
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
`;

const footer = `    }

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

`;

// Dedupe: user core might still have duplicate "let practiceTestActive" if frag replace failed
if ((core.match(/let practiceTestActive/g) || []).length > 1) {
    console.error('Duplicate variable declarations — check savedMain block replace.');
    process.exit(1);
}

if (!core.includes('scheduleTasksSessionRestore()')) {
    console.warn('Warning: scheduleTasksSessionRestore not found in core');
}

fs.writeFileSync(outPath, header + core + footer, 'utf8');
console.log('Wrote', outPath, 'lines:', (header + core + footer).split('\n').length);
