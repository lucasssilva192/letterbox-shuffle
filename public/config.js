// Endereço do backend (server.js). Rodando localmente, o próprio servidor
// serve o site e a API fica no mesmo endereço; no GitHub Pages, as chamadas
// vão para o serviço hospedado no Render.
window.API_BASE = location.hostname.endsWith('github.io') ? 'https://letterbox-shuffle.onrender.com' : '';
