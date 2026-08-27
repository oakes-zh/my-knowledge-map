// Extract main content from the current page
(function () {
  function extractContent() {
    // Remove noise elements
    var noise = document.querySelectorAll('script, style, nav, footer, aside, iframe, .ad, .advertisement, .sidebar');
    noise.forEach(function (el) { el.remove(); });

    // Try to find main content
    var main = document.querySelector('main') || document.querySelector('article') || document.querySelector('.content') || document.body;

    var title = document.title || '';
    var content = main.innerText || '';

    // Clean up whitespace
    var lines = content.split('\n').map(function (l) { return l.trim(); });
    content = lines.filter(function (l) { return l.length > 0; }).join('\n');

    return { title: title, content: content, url: window.location.href };
  }

  // Listen for requests from popup
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === 'extractContent') {
      sendResponse(extractContent());
    }
  });
})();
