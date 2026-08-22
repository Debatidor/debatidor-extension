const fields = ['backendUrl', 'connectionId', 'debateId'];

chrome.storage.local.get(null).then((stored) => {
  document.getElementById('backendUrl').value =
    stored.backendUrl ?? 'ws://localhost:3001/extension';
  document.getElementById('connectionId').value =
    stored.connectionId ?? 'conn_dom_qwen_01';
  document.getElementById('debateId').value = stored.debateId ?? '';
  refresh();
});

document.getElementById('save').addEventListener('click', () => {
  const config = {};
  for (const id of fields) {
    config[id] = document.getElementById(id).value.trim();
  }
  chrome.runtime.sendMessage({ type: 'save-config', config }, () => refresh());
});

function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (status) => {
    const el = document.getElementById('status');
    el.textContent = status
      ? `socket ${status.socket} · tabs ${status.tabs.join(', ') || '—'}`
      : 'sin respuesta del service worker';
  });
}
