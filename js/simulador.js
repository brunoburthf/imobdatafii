const MAX_FUNDOS = 15;

let todosFiis = [];
let carteira  = []; // [{ticker, nome, setor}]
let sugestaoIdx = -1;

// ─── CARREGAMENTO ────────────────────────────────────────────────────────────

async function carregarDados() {
  try {
    const resp = await fetch("data/index.json");
    if (!resp.ok) throw new Error("Dados não encontrados. Rode o script de atualização primeiro.");
    const data = await resp.json();
    todosFiis = data.fiis || [];
    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

// ─── BUSCA E SUGESTÕES ───────────────────────────────────────────────────────

function filtrarSugestoes() {
  const q = document.getElementById("sim-busca").value.trim().toUpperCase();
  const box = document.getElementById("sim-sugestoes");
  sugestaoIdx = -1;

  if (!q) { box.style.display = "none"; return; }

  const tickersNaCarteira = new Set(carteira.map(f => f.ticker));
  const resultados = todosFiis
    .filter(f => {
      const t = (f["Ticker"] || "").toUpperCase();
      const n = (f["Nome"]   || "").toUpperCase();
      return (t.includes(q) || n.includes(q)) && !tickersNaCarteira.has(f["Ticker"]);
    })
    .slice(0, 8);

  if (!resultados.length) { box.style.display = "none"; return; }

  box.innerHTML = resultados.map((f, i) =>
    `<div class="sim-sugestao" data-idx="${i}"
      onmousedown="adicionarFii('${f["Ticker"]}')">
      <span class="sim-sug-ticker">${f["Ticker"]}</span>
      <span class="sim-sug-nome">${f["Nome"] || ""}</span>
    </div>`
  ).join("");

  box._resultados = resultados;
  box.style.display = "block";
}

function navegarSugestoes(e) {
  const box   = document.getElementById("sim-sugestoes");
  const items = box.querySelectorAll(".sim-sugestao");
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    sugestaoIdx = Math.min(sugestaoIdx + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    sugestaoIdx = Math.max(sugestaoIdx - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const idx = sugestaoIdx >= 0 ? sugestaoIdx : 0;
    const r   = box._resultados?.[idx];
    if (r) adicionarFii(r["Ticker"]);
    return;
  } else if (e.key === "Escape") {
    box.style.display = "none";
    return;
  }

  items.forEach((el, i) => el.classList.toggle("ativo", i === sugestaoIdx));
}

document.addEventListener("click", e => {
  if (!e.target.closest(".sim-busca-container")) {
    document.getElementById("sim-sugestoes").style.display = "none";
  }
});

// ─── GERENCIAR CARTEIRA ──────────────────────────────────────────────────────

function adicionarFii(ticker) {
  if (carteira.length >= MAX_FUNDOS) return;
  if (carteira.find(f => f.ticker === ticker)) return;

  const fii = todosFiis.find(f => f["Ticker"] === ticker);
  if (!fii) return;

  carteira.push({ ticker, nome: fii["Nome"] || "", setor: fii["Setor"] || "" });

  document.getElementById("sim-busca").value = "";
  document.getElementById("sim-sugestoes").style.display = "none";

  renderizarTabela();
}

function removerFii(ticker) {
  carteira = carteira.filter(f => f.ticker !== ticker);
  renderizarTabela();
}

// ─── TABELA ──────────────────────────────────────────────────────────────────

function renderizarTabela() {
  const tbody  = document.getElementById("sim-tbody");
  const tfoot  = document.getElementById("sim-tfoot");
  const vazio  = document.getElementById("sim-vazio");
  const aviso  = document.getElementById("sim-aviso");

  document.getElementById("sim-contador").textContent =
    `${carteira.length} / ${MAX_FUNDOS} fundos`;

  if (!carteira.length) {
    tbody.innerHTML = "";
    tbody.appendChild(vazio);
    vazio.style.display = "";
    tfoot.style.display = "none";
    aviso.style.display = "none";
    return;
  }

  vazio.style.display = "none";
  tfoot.style.display = "";

  // Preserva os pesos já digitados
  const pesosAtuais = {};
  tbody.querySelectorAll("tr[data-ticker]").forEach(tr => {
    const input = tr.querySelector("input");
    if (input) pesosAtuais[tr.dataset.ticker] = input.value;
  });

  tbody.innerHTML = "";

  carteira.forEach(f => {
    const tr = document.createElement("tr");
    tr.dataset.ticker = f.ticker;

    const pesoAtual = pesosAtuais[f.ticker] ?? "";

    tr.innerHTML = `
      <td class="ticker-cell">${f.ticker}</td>
      <td>${f.nome}</td>
      <td>${f.setor || "—"}</td>
      <td class="num">
        <input type="number" class="sim-peso-input" min="0" max="100" step="0.01"
          value="${pesoAtual}" placeholder="0"
          oninput="atualizarTotal()" />
        <span class="sim-peso-pct">%</span>
      </td>
      <td>
        <button class="sim-remover" onclick="removerFii('${f.ticker}')" title="Remover">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  atualizarTotal();
}

function atualizarTotal() {
  const inputs = document.querySelectorAll(".sim-peso-input");
  let soma = 0;
  inputs.forEach(inp => { soma += parseFloat(inp.value) || 0; });

  const totalEl = document.getElementById("sim-total-valor");
  const aviso   = document.getElementById("sim-aviso");

  totalEl.textContent = soma.toFixed(2) + "%";

  const diff = Math.abs(soma - 100);
  if (!carteira.length) {
    aviso.style.display = "none";
    totalEl.className = "num";
  } else if (diff < 0.01) {
    totalEl.className = "num sim-total-ok";
    aviso.style.display = "none";
  } else {
    totalEl.className = "num sim-total-erro";
    aviso.style.display = "block";
    aviso.textContent = soma < 100
      ? `A soma dos pesos é ${soma.toFixed(2)}% — faltam ${(100 - soma).toFixed(2)}% para chegar a 100%.`
      : `A soma dos pesos é ${soma.toFixed(2)}% — reduza ${(soma - 100).toFixed(2)}% para chegar a 100%.`;
  }
}

carregarDados();
