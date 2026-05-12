// Controla visibilidade dos elementos .val-restrito (cards/links "Ferramentas
// de Valuation") e bloqueia acesso direto via URL pras paginas protegidas.
//
// Regras:
//   - Em localhost: sempre liberado (modo dev).
//   - Em prod: libera SE o usuario logado tem email na VALUATION_ALLOWLIST.
//
// Limitacao: allowlist visivel via devtools (frontend-only). Como os dados
// abaixo (data/*.json) sao publicos no CDN, a "protecao" e controle de UX,
// nao seguranca real. Pra protecao server-side, ver Firestore roles.

const VALUATION_ALLOWLIST = [
  "brunoburthf@gmail.com",
  "abner.melo@itau-unibanco.com.br",
];

const _isLocalHost = ["localhost", "127.0.0.1"].includes(location.hostname);

function _emailAutorizado() {
  const email = window.currentUser?.email?.toLowerCase();
  if (!email) return false;
  return VALUATION_ALLOWLIST.some(e => e.toLowerCase() === email);
}

function _aplicarValRestrito() {
  if (_isLocalHost || _emailAutorizado()) {
    document.querySelectorAll(".val-restrito").forEach(el => el.classList.remove("val-restrito"));
  }
}

// Aplica no load (cobre o caso localhost — auth nao precisa resolver).
_aplicarValRestrito();

// E em cada mudanca de auth state (so dispara em paginas com firebase-auth.js).
document.addEventListener("auth-state-changed", _aplicarValRestrito);

// Guard pras paginas internas (valuation.html, spread.html, etc). Espera o
// Firebase Auth resolver e redireciona pra index se a conta nao tem acesso.
// Chamado inline com <script>guardValuation();</script>.
window.guardValuation = function() {
  if (_isLocalHost) return;

  if (typeof firebase === "undefined" || !firebase.auth) {
    // Pagina sem Firebase carregado nao tem como autenticar — bloqueia.
    location.href = "index.html";
    return;
  }

  firebase.auth().onAuthStateChanged(user => {
    window.currentUser = user;
    if (!_emailAutorizado()) {
      // Passa motivo no query param pra index.html mostrar mensagem.
      const motivo = user ? "no-access" : "login-needed";
      location.href = "index.html?msg=" + motivo;
    }
  });
};
