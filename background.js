// Clicking the toolbar icon on a PDF opens the converter with that PDF loaded.
// (A full tab is used because a toolbar popup closes as soon as the folder picker opens.)
// If the converter is already open, the PDF is added there instead of opening another one.
async function openFor(tab) {
  const src = tab && /^(https?|file):/i.test(tab.url || '') ? { url: tab.url, title: tab.title || '', tabId: tab.id } : {};
  try {
    const open = await chrome.runtime.sendMessage({ type: 't10pdf-add', ...src });
    if (open && open.tabId) {
      await chrome.tabs.update(open.tabId, { active: true });
      await chrome.windows.update(open.windowId, { focused: true });
      return;
    }
  } catch { /* the converter is not open */ }
  let url = chrome.runtime.getURL('app.html');
  if (src.url) url += '?src=' + encodeURIComponent(src.url) + '&title=' + encodeURIComponent(src.title) + (src.tabId ? '&tab=' + src.tabId : '');
  await chrome.tabs.create({ url, index: tab ? tab.index + 1 : undefined, windowId: tab ? tab.windowId : undefined });
}
// The icon opens the side panel next to the page (Chrome 116+). openFor (a full tab) is used for right-click and older Chrome.
const usePanel = () => chrome.sidePanel && chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
usePanel();
chrome.runtime.onStartup.addListener(usePanel);
chrome.action.onClicked.addListener(openFor); // only fires if the side panel is not available

// Right-click a link to a PDF -> "Save this PDF as images"
chrome.runtime.onInstalled.addListener(() => {
  usePanel();
  chrome.contextMenus.create({ id: 'link', title: 'Save this PDF as images', contexts: ['link'], targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.PDF', 'file:///*.pdf'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'link') return;
  if (chrome.sidePanel && tab) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {}); // must be called straight away (it needs the click)
    chrome.storage.session.set({ pendingLink: { url: info.linkUrl, time: Date.now() } });
    chrome.runtime.sendMessage({ type: 't10pdf-add', url: info.linkUrl }).catch(() => {});
    return;
  }
  openFor({ url: info.linkUrl, title: '', index: tab && tab.index, windowId: tab && tab.windowId });
});

/* ------------------------------------------------------------------ noticing PDFs as pages load them
   Sites like Teams / SharePoint show a PDF inside their own page and download it in the background, sometimes
   from a worker or with a sign-in header. Chrome tells the extension about every response; the ones that are PDFs
   are remembered (address, tab, time, and the request's sign-in headers so it can be read again) for an hour,
   in memory only (chrome.storage.session is never written to disk). Nothing is changed or blocked. */
const FILTER = { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'object', 'other'] };
const SKIP_HEADER = /^(cookie|host|content-length|range|if-range|if-none-match|if-modified-since|origin|referer|user-agent|accept-encoding|connection|sec-.*|proxy-.*|upgrade-insecure-requests|priority)$/i;
const signIn = new Map(); // requestId -> headers, kept only until the response arrives

chrome.webRequest.onSendHeaders.addListener(d => {
  const hs = (d.requestHeaders || []).filter(h => !SKIP_HEADER.test(h.name));
  if (!hs.some(h => /^(authorization|x-)/i.test(h.name))) return; // nothing special: cookies are enough
  if (signIn.size > 300) signIn.delete(signIn.keys().next().value);
  signIn.set(d.requestId, hs);
}, FILTER, ['requestHeaders', 'extraHeaders']);

let saving = Promise.resolve();
chrome.webRequest.onResponseStarted.addListener(d => {
  const headers = signIn.get(d.requestId); signIn.delete(d.requestId);
  if (d.statusCode >= 400 || (d.initiator || '').startsWith('chrome-extension:') || d.url.startsWith('chrome-extension:')) return;
  const get = n => ((d.responseHeaders || []).find(h => h.name.toLowerCase() === n) || {}).value || '';
  const ct = get('content-type'), cd = get('content-disposition');
  const pdf = /\bpdf\b/i.test(ct) || /\.pdf\b/i.test(cd) || /[?&]inputFormat=pdf\b|\/transform\/passthrough/i.test(d.url) || (/octet-stream|binary|download/i.test(ct) && /\.pdf([?#&]|$)/i.test(d.url));
  if (!pdf) return;
  const entry = { url: d.url, tabId: d.tabId, frameId: d.frameId, initiator: d.initiator || '', time: Date.now(), status: d.statusCode, cd, headers: headers || [] };
  saving = saving.then(async () => {
    const { captured = [] } = await chrome.storage.session.get('captured');
    const list = [entry, ...captured.filter(c => !(c.url === entry.url && c.tabId === entry.tabId)) .filter(c => Date.now() - c.time < 3600e3)].slice(0, 40);
    await chrome.storage.session.set({ captured: list });
  }).catch(() => {});
}, FILTER, ['responseHeaders']);
chrome.webRequest.onErrorOccurred.addListener(d => signIn.delete(d.requestId), FILTER);
chrome.tabs.onRemoved.addListener(tabId => {
  saving = saving.then(async () => {
    const { captured = [] } = await chrome.storage.session.get('captured');
    await chrome.storage.session.set({ captured: captured.filter(c => c.tabId !== tabId) });
  }).catch(() => {});
});
