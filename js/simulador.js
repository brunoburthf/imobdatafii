const MAX_FUNDOS = 15;

let todosFiis = [];
let carteira  = []; // [{ticker, nome, setor}]
let sugestaoIdx = -1;
let vazioEl = null; // referência persistente ao <tr id="sim-vazio">

// ─── CARREGAMENTO ────────────────────────────────────────────────────────────

async function carregarDados() {
  vazioEl = document.getElementById("sim-vazio");
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
  const aviso  = document.getElementById("sim-aviso");
  const vazio  = vazioEl;

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
      <td class="num sim-posicao-valor">—</td>
      <td>
        <button class="sim-remover" onclick="removerFii('${f.ticker}')" title="Remover">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  atualizarTotal();
}

function formatarBRL(valor) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseValorCarteira(str) {
  if (!str) return 0;
  // Remove separadores de milhar (pontos) e troca vírgula decimal por ponto
  return parseFloat(str.replace(/\./g, "").replace(",", ".")) || 0;
}

function formatarInputCarteira() {
  const inp = document.getElementById("sim-valor-total");
  const val = parseValorCarteira(inp.value);
  inp.value = val > 0
    ? val.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "";
  atualizarTotal();
}

function desformatarInputCarteira() {
  const inp = document.getElementById("sim-valor-total");
  const val = parseValorCarteira(inp.value);
  inp.value = val > 0 ? String(val).replace(".", ",") : "";
}

function atualizarTotal() {
  const inputs   = document.querySelectorAll(".sim-peso-input");
  const totalEl  = document.getElementById("sim-total-valor");
  const totalPos = document.getElementById("sim-total-posicao");
  const aviso    = document.getElementById("sim-aviso");
  const valorCarteira = parseValorCarteira(document.getElementById("sim-valor-total")?.value);

  let soma = 0;
  inputs.forEach(inp => { soma += parseFloat(inp.value) || 0; });

  // Atualiza valor de posição em cada linha
  document.querySelectorAll("tr[data-ticker]").forEach(tr => {
    const inp     = tr.querySelector(".sim-peso-input");
    const posCell = tr.querySelector(".sim-posicao-valor");
    if (!inp || !posCell) return;
    const peso = parseFloat(inp.value) || 0;
    posCell.textContent = valorCarteira > 0
      ? formatarBRL((peso / 100) * valorCarteira)
      : "—";
  });

  // Atualiza total de posição no tfoot
  if (totalPos) {
    totalPos.textContent = valorCarteira > 0
      ? formatarBRL((soma / 100) * valorCarteira)
      : "—";
  }

  totalEl.textContent = soma.toFixed(2) + "%";

  const btnWrapper = document.getElementById("sim-btn-wrapper");
  const diff = Math.abs(soma - 100);
  if (!carteira.length) {
    aviso.style.display = "none";
    totalEl.className = "num";
    btnWrapper.style.display = "none";
  } else if (diff < 0.01) {
    totalEl.className = "num sim-total-ok";
    aviso.style.display = "none";
    btnWrapper.style.display = "flex";
  } else {
    totalEl.className = "num sim-total-erro";
    aviso.style.display = "block";
    aviso.textContent = soma < 100
      ? `A soma dos pesos é ${soma.toFixed(2)}% — faltam ${(100 - soma).toFixed(2)}% para chegar a 100%.`
      : `A soma dos pesos é ${soma.toFixed(2)}% — reduza ${(soma - 100).toFixed(2)}% para chegar a 100%.`;
    btnWrapper.style.display = "none";
  }
}

function simularCarteira() {
  const pesos = {};
  document.querySelectorAll("tr[data-ticker]").forEach(tr => {
    const inp = tr.querySelector(".sim-peso-input");
    if (inp) pesos[tr.dataset.ticker] = parseFloat(inp.value) || 0;
  });

  const valorTotal = parseValorCarteira(document.getElementById("sim-valor-total")?.value);

  localStorage.setItem("sim_carteira",   JSON.stringify(carteira));
  localStorage.setItem("sim_pesos",      JSON.stringify(pesos));
  localStorage.setItem("sim_valor_total", String(valorTotal));

  window.location.href = "resultado.html";
}

carregarDados();
