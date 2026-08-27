document.addEventListener('DOMContentLoaded', function () {
  var clipBtn = document.getElementById('clipBtn');
  var statusEl = document.getElementById('status');
  var summaryEl = document.getElementById('summaryText');
  var tagsEl = document.getElementById('tagsContainer');
  var urlDisplay = document.getElementById('urlDisplay');
  var settingsLink = document.getElementById('settingsLink');
  var settingsPanel = document.getElementById('settingsPanel');
  var backendUrlInput = document.getElementById('backendUrl');
  var saveSettingsBtn = document.getElementById('saveSettings');

  // Load settings
  chrome.storage.local.get(['backendUrl'], function (result) {
    var url = result.backendUrl || 'http://localhost:8900';
    backendUrlInput.value = url;
  });

  // Show current tab URL
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs[0]) {
      urlDisplay.textContent = tabs[0].url;
    }
  });

  // Settings toggle
  settingsLink.addEventListener('click', function () {
    settingsPanel.classList.toggle('show');
  });

  saveSettingsBtn.addEventListener('click', function () {
    chrome.storage.local.set({ backendUrl: backendUrlInput.value }, function () {
      settingsPanel.classList.remove('show');
      statusEl.className = 'status success';
      statusEl.textContent = '设置已保存';
      setTimeout(function () { statusEl.className = 'status'; }, 2000);
    });
  });

  // Clip button
  clipBtn.addEventListener('click', function () {
    clipBtn.disabled = true;
    statusEl.className = 'status loading';
    statusEl.innerHTML = '<span class="loading-spinner"></span>正在抓取页面内容...';
    summaryEl.classList.remove('show');
    tagsEl.classList.remove('show');

    // Get content from page
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'extractContent' }, function (response) {
        if (!response) {
          statusEl.className = 'status error';
          statusEl.textContent = '无法读取页面内容';
          clipBtn.disabled = false;
          return;
        }

        // Get backend URL
        chrome.storage.local.get(['backendUrl'], function (result) {
          var backendUrl = result.backendUrl || 'http://localhost:8900';

          statusEl.innerHTML = '<span class="loading-spinner"></span>正在入库...';

          // Send to backend
          fetch(backendUrl + '/ingest/url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: response.url })
          })
            .then(function (r) {
              if (!r.ok) throw new Error('Server error: ' + r.status);
              return r.json();
            })
            .then(function (data) {
              if (data.success) {
                statusEl.className = 'status success';
                statusEl.textContent = '入库成功!';

                if (data.summary) {
                  summaryEl.textContent = data.summary;
                  summaryEl.classList.add('show');
                }

                if (data.tags && data.tags.length > 0) {
                  tagsEl.innerHTML = data.tags.map(function (t) {
                    return '<span class="tag">' + t + '</span>';
                  }).join('');
                  tagsEl.classList.add('show');
                }
              } else {
                throw new Error(data.message || 'Unknown error');
              }
            })
            .catch(function (err) {
              statusEl.className = 'status error';
              statusEl.textContent = '入库失败: ' + err.message;
            })
            .finally(function () {
              clipBtn.disabled = false;
            });
        });
      });
    });
  });
});
