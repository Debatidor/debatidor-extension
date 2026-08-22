const fields = ['backendUrl', 'connectionId', 'debateId', 'apiKey'];

chrome.storage.local.get(null).then((stored) => {
  document.getElementById('backendUrl').value =
    stored.backendUrl ?? 'ws://localhost:3001/extension';
  document.getElementById('connectionId').value =
    stored.connectionId ?? 'conn_dom_qwen_01';
  document.getElementById('debateId').value = stored.debateId ?? '';
  document.getElementById('apiKey').value = stored.apiKey ?? '';
  refresh();
});

document.getElementById('save').addEventListener('click', save);
document.getElementById('local').addEventListener('click', () => {
  document.getElementById('backendUrl').value = 'ws://localhost:3001/extension';
});
document.getElementById('prod').addEventListener('click', () => {
  document.getElementById('backendUrl').value = 'wss://api.debatidor.com/extension';
});

function save() {
  const config = {};
  for (const id of fields) {
    config[id] = document.getElementById(id).value.trim();
  }
  chrome.runtime.sendMessage({ type: 'save-config', config }, () => {
    setTimeout(refresh, 400);
  });
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (status) => {
    const el = document.getElementById('status');
    if (!status) {
      el.textContent = 'Sin respuesta del service worker. Recarga la extensión.';
      return;
    }
    if (!status.hasKey) {
      el.textContent = 'Falta la API Key. Créala en el Hub → API Keys.';
      return;
    }
    el.textContent = status.socket === 'open'
      ? `Conectado · pestañas ${status.tabs.join(', ') || 'ninguna aún'}`
      : 'Clave guardada · esperando WebSocket';
  });
}

setInterval(refresh, 1500);
