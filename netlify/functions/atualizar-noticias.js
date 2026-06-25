// Netlify Function: dispara o workflow noticias-daily.yml no GitHub Actions.
//
// O token do GitHub fica na env var GITHUB_DISPATCH_TOKEN (secreta, configurada
// no painel do Netlify) — NUNCA vai pro cliente. Por isso o botão no site não
// precisa pedir token nenhum.
//
// Como o endpoint é público, validamos o ID token do Firebase enviado pelo
// cliente (via Identity Toolkit) e só disparamos se o email estiver na
// allowlist — assim ninguém de fora consegue abusar do dispatch.

const GH_REPO     = "brunoburthf/imobdata-pipeline";
const GH_WORKFLOW = "noticias-daily.yml";
const GH_REF      = "main";

// API key do Firebase é pública (já está em js/firebase-auth.js) — serve só pra
// chamar o endpoint de verificação do ID token.
const FIREBASE_API_KEY = "AIzaSyAlx8QBfnrwKj0a7ULWZ4vMOZW23_Bhuzg";

const ALLOWLIST = [
  "brunoburthf@gmail.com",
  "abner.melo@itau-unibanco.com.br",
];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return resp(405, { ok: false, erro: "method not allowed" });
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return resp(500, { ok: false, erro: "GITHUB_DISPATCH_TOKEN não configurado no Netlify" });
  }

  let idToken;
  try { idToken = JSON.parse(event.body || "{}").idToken; } catch (_) {}
  if (!idToken) {
    return resp(401, { ok: false, erro: "sem idToken — faça login" });
  }

  // Verifica o ID token e extrai o email.
  let email = null;
  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      }
    );
    const d = await r.json();
    email = d.users && d.users[0] && d.users[0].email;
  } catch (_) {}

  if (!email || !ALLOWLIST.includes(email.toLowerCase())) {
    return resp(403, { ok: false, erro: "conta não autorizada" });
  }

  // Dispara o workflow. workflow_dispatch responde 204 No Content.
  const gh = await fetch(
    `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "imobdata-netlify-fn",
      },
      body: JSON.stringify({ ref: GH_REF }),
    }
  );

  if (gh.status !== 204) {
    let msg = "";
    try { msg = (await gh.json()).message || ""; } catch (_) {}
    return resp(502, { ok: false, erro: `GitHub respondeu ${gh.status}${msg ? " — " + msg : ""}` });
  }

  return resp(200, { ok: true });
};

function resp(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
