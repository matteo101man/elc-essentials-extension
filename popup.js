(function () {
    const KEY = 'elc_extension_enabled';
    const cb = document.getElementById('elc-enabled');

    // Default: enabled. Only "false" means off (set when user unchecks the box).
    chrome.storage.local.get({ [KEY]: true }, function (cfg) {
        if (chrome.runtime.lastError) {
            cb.checked = true;
            return;
        }
        cb.checked = cfg[KEY] !== false;
    });

    cb.addEventListener('change', function () {
        chrome.storage.local.set({ [KEY]: cb.checked });
    });
})();
