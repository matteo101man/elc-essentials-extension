// Background — cross-origin fetch for GM_xmlhttpRequest, Athena import → D2L tab switch.

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['elc_extension_enabled'], (r) => {
        if (r.elc_extension_enabled === undefined) {
            chrome.storage.local.set({ elc_extension_enabled: true });
        }
    });
});

function trySendScheduleRefresh(tabId, attempt, onDone) {
    chrome.tabs.sendMessage(tabId, { type: 'ELC_REFRESH_SCHEDULE' }, () => {
        if (chrome.runtime.lastError && attempt < 4) {
            setTimeout(() => trySendScheduleRefresh(tabId, attempt + 1, onDone), 400);
            return;
        }
        if (onDone) onDone();
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ELC_ATHENA_IMPORT_DONE') {
        const athenaTabId = sender.tab && sender.tab.id;
        if (!athenaTabId) {
            sendResponse({ ok: false });
            return false;
        }
        chrome.tabs.query({}, (allTabs) => {
            const d2lTabs = (allTabs || []).filter(
                (t) => t.url && t.url.indexOf('https://uga.view.usg.edu') === 0
            );
            const done = () => sendResponse({ ok: true });
            if (d2lTabs.length) {
                const target = d2lTabs.find((t) => t.active) || d2lTabs[0];
                chrome.tabs.update(target.id, { active: true }, () => {
                    setTimeout(() => {
                        trySendScheduleRefresh(target.id, 0, () => {
                            chrome.tabs.remove(athenaTabId, () => done());
                        });
                    }, 200);
                });
            } else {
                chrome.storage.local.set({ elc_pending_open_schedule: Date.now() }, () => {
                    chrome.tabs.create({ url: 'https://uga.view.usg.edu/' }, () => {
                        chrome.tabs.remove(athenaTabId, () => done());
                    });
                });
            }
        });
        return true;
    }

    if (message.type !== 'GM_xmlhttpRequest') return false;

    const { method, url, headers, data } = message;

    const options = { method: method || 'GET' };

    if (headers && Object.keys(headers).length > 0) {
        options.headers = headers;
    }

    if (data) {
        options.body = data;
    }

    fetch(url, options)
        .then((response) =>
            response.text().then((text) => ({
                status: response.status,
                responseText: text
            }))
        )
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message || String(err) }));

    return true;
});
