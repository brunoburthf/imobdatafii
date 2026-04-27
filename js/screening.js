/* screening.js — Screening Consolidado — gráfico de linha por critério */

let esferaAtiva = "fii";
let periodoAtivo = "1A";
let todosFundos = [];
let ativosSelecionados = [];
let scrSugIdx = -1;
let scrChart = null;

const CORES = [
  "#EF6300","#2563EB","#16A34A","#DC2626","#9333EA",
  "#0891B2","#D97706","#059669","#7C3AED","#DB2777",
  "#0284C7","#65A30D","rgb(0,9,60)","#F59E0B","#6366F1"
];

// ─── Carregamento ────────────────────────────────────────────────────────────

async function carregarDados() {
  try {
    const [r1, r2, r3] = await Promise.all([
      fetch("data/index.json?v=" + Date.now()).catch(() => null),
      fetch("data/infra_index.json?v=" + Date.now()).catch(() => null),
      fetch("data/agro_index.json?v=" + Date.now()).catch(() => null)
    ]);
    if (r1 && r1.ok) {
      const d = await r1.json();
      (d.fiis || []).forEach(f => todosFundos.push({
        ticker: f["Ticker"], nome: f["Nome"] || "", setor: f["Setor"] || "", dir: "fiis", raw: f
      }));
    }
    if (r2 && r2.ok) {
      const d = await r2.json();
      (d.fundos || []).forEach(f => todosFundos.push({
        ticker: f["Ticker"], nome: f["Nome"] || "", setor: f["Tipo"] || "", dir: "infra", raw: f
      }));
    }
    if (r3 && r3.ok) {
      const d = await r3.json();
      (d.fundos || []).forEach(f => todosFundos.push({
        ticker: f["Ticker"], nome: f["Nome"] || "", setor: "FI-Agro", dir: "agro", raw: f
      }));
    }
    document.getElementById("loading").style.display = "none";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    document.getElementById("erro").style.display = "block";
    document.getElementById("erro").textContent = e.message;
  }
}

// ─── Esfera / Período ────────────────────────────────────────────────────────

function trocarEsfera(esfera) {
  esferaAtiva = esfera;
  document.querySelectorAll(".screening-esfera-btn").forEach(b =>
    b.classList.toggle("ativo", b.dataset.esfera === esfera));

  const busca = document.getElementById("scr-busca");
  if (esfera === "setor") {
    busca.placeholder = "Buscar setor...";
  } else {
    busca.placeholder = "Buscar ticker...";
  }
  // Limpa seleção ao trocar esfera
  ativosSelecionados = [];
  renderizarTags();
  document.getElementById("scr-resultado-grafico").style.display = "none";
  document.getElementById("scr-resultado-tabela").style.display = "none";
  document.getElementById("scr-placeholder").style.display = "block";
}

function scrTrocarPeriodo(periodo) {
  periodoAtivo = periodo;
  document.querySelectorAll(".screening-periodo-btn").forEach(b =>
    b.classList.toggle("ativo", b.dataset.periodo === periodo));
}

// ─── Busca de ativos ─────────────────────────────────────────────────────────

function scrFiltrarSugestoes() {
  const q = document.getElementById("scr-busca").value.trim().toUpperCase();
  const box = document.getElementById("scr-sugestoes");
  scrSugIdx = -1;
  if (!q) { box.style.display = "none"; return; }

  if (esferaAtiva === "setor") {
    // Busca setores
    const ja = new Set(ativosSelecionados.map(a => a.ticker)); // ticker = setor name aqui
    const setores = [...new Set(todosFundos.map(f => f.setor).filter(Boolean))];
    const res = setores
      .filter(s => !ja.has(s) && s.toUpperCase().includes(q))
      .slice(0, 8);
    if (!res.length) { box.style.display = "none"; return; }
    box.innerHTML = res.map((s, i) =>
      `<div class="sim-sugestao" data-idx="${i}" onmousedown="scrAdicionarSetor('${s.replace(/'/g,"\\'")}')">
        <span class="sim-sug-ticker">${s}</span>
        <span class="sim-sug-nome">${todosFundos.filter(f => f.setor === s).length} fundos</span>
      </div>`).join("");
    box._res = res;
    box.style.display = "block";
  } else {
    // Busca tickers
    const ja = new Set(ativosSelecionados.map(a => a.ticker));
    const res = todosFundos
      .filter(f => !ja.has(f.ticker) &&
        (f.ticker.toUpperCase().includes(q) || f.nome.toUpperCase().includes(q)))
      .slice(0, 8);
    if (!res.length) { box.style.display = "none"; return; }
    box.innerHTML = res.map((f, i) =>
      `<div class="sim-sugestao" data-idx="${i}" onmousedown="scrAdicionarAtivo('${f.ticker}')">
        <span class="sim-sug-ticker">${f.ticker}</span>
        <span class="sim-sug-nome">${f.nome}</span>
      </div>`).join("");
    box._res = res;
    box.style.display = "block";
  }
}

function scrNavegarSugestoes(e) {
  const box = document.getElementById("scr-sugestoes");
  const items = box.querySelectorAll(".sim-sugestao");
  if (!items.length) return;
  if (e.key === "ArrowDown") { e.preventDefault(); scrSugIdx = Math.min(scrSugIdx + 1, items.length - 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); scrSugIdx = Math.max(scrSugIdx - 1, 0); }
  else if (e.key === "Enter") {
    e.preventDefault();
    const r = box._res?.[scrSugIdx >= 0 ? scrSugIdx : 0];
    if (r) {
      if (esferaAtiva === "setor") scrAdicionarSetor(r);
      else scrAdicionarAtivo(r.ticker);
    }
    return;
  } else if (e.key === "Backspace" && !document.getElementById("scr-busca").value && ativosSelecionados.length) {
    scrRemoverAtivo(ativosSelecionados.at(-1).ticker); return;
  } else if (e.key === "Escape") { box.style.display = "none"; return; }
  items.forEach((el, i) => el.classList.toggle("ativo", i === scrSugIdx));
}

function scrAdicionarAtivo(ticker) {
  if (ativosSelecionados.find(a => a.ticker === ticker)) return;
  const f = todosFundos.find(x => x.ticker === ticker);
  if (!f) return;
  ativosSelecionados.push(f);
  document.getElementById("scr-busca").value = "";
  document.getElementById("scr-sugestoes").style.display = "none";
  renderizarTags();
}

function scrAdicionarSetor(setor) {
  // Adiciona todos os fundos do setor que ainda não estão selecionados
  const ja = new Set(ativosSelecionados.map(a => a.ticker));
  const novos = todosFundos.filter(f => f.setor === setor && !ja.has(f.ticker));
  ativosSelecionados = ativosSelecionados.concat(novos);
  document.getElementById("scr-busca").value = "";
  document.getElementById("scr-sugestoes").style.display = "none";
  renderizarTags();
}

function scrRemoverAtivo(ticker) {
  ativosSelecionados = ativosSelecionados.filter(a => a.ticker !== ticker);
  renderizarTags();
}

function renderizarTags() {
  const c = document.getElementById("scr-tags");
  if (!ativosSelecionados.length) { c.style.display = "none"; c.innerHTML = ""; return; }
  c.style.display = "flex";

  if (esferaAtiva === "setor") {
    // Mostra tags por setor com contagem
    const setores = {};
    ativosSelecionados.forEach(a => {
      setores[a.setor] = (setores[a.setor] || 0) + 1;
    });
    c.innerHTML = Object.entries(setores).map(([setor, n]) =>
      `<span class="screening-tag">${setor} (${n})<span class="screening-tag-x" onclick="scrRemoverSetor('${setor.replace(/'/g,"\\'")}')">&times;</span></span>`
    ).join("");
  } else {
    c.innerHTML = ativosSelecionados.map(a =>
      `<span class="screening-tag">${a.ticker}<span class="screening-tag-x" onclick="scrRemoverAtivo('${a.ticker}')">&times;</span></span>`
    ).join("");
  }
}

function scrRemoverSetor(setor) {
  ativosSelecionados = ativosSelecionados.filter(a => a.setor !== setor);
  renderizarTags();
}

document.addEventListener("click", e => {
  if (!e.target.closest(".screening-ativos-container")) {
    const b = document.getElementById("scr-sugestoes");
    if (b) b.style.display = "none";
  }
});

// ─── Mapa critério → campo do JSON individual ───────────────────────────────

const CRITERIO_CAMPO = {
  dy:      "historico_dy",
  pvp:     "historico_pvp",
  retorno: "historico_preco_adj",
  spread:  "historico_dy",     // DY - NTN-B (calculamos no front)
};

const CRITERIO_LABEL = {
  dy: "DY a.a. (%)",
  pvp: "P/VP",
  retorno: "Retorno Acumulado (%)",
  spread: "Spread NTN-B (pp)",
  pct_cdi: "% Dias acima do CDI 12M",
};

// ─── Analisar ────────────────────────────────────────────────────────────────

async function scrAnalisar() {
  if (!ativosSelecionados.length) {
    alert("Selecione ao menos um ativo.");
    return;
  }
  const criterio = document.getElementById("scr-criterio").value;

  document.getElementById("scr-placeholder").style.display = "none";

  // Busca JSONs individuais de cada ativo
  const dados = await Promise.all(ativosSelecionados.map(async f => {
    try {
      const resp = await fetch(`data/${f.dir}/${f.ticker}.json?v=${Date.now()}`);
      if (!resp.ok) return { ticker: f.ticker, fundo: f };
      return { ticker: f.ticker, json: await resp.json(), fundo: f };
    } catch { return { ticker: f.ticker, fundo: f }; }
  }));

  if (criterio === "retorno") {
    // % Dias acima CDI → tabela ranqueada (dados já no index.json, não precisa fetch individual)
    document.getElementById("scr-resultado-grafico").style.display = "none";
    document.getElementById("scr-resultado-tabela").style.display = "block";
    renderizarTabelaPctCdi();
    return;
  } else {
    // Demais → gráfico de linha
    document.getElementById("scr-resultado-tabela").style.display = "none";
    document.getElementById("scr-resultado-grafico").style.display = "block";
    document.getElementById("scr-grafico-titulo").textContent = "Carregando...";

    const series = {};
    for (const d of dados) {
      if (!d.json) continue;
      const campo = CRITERIO_CAMPO[criterio];
      const serie = d.json[campo] || [];
      if (serie.length) series[d.ticker] = serie;
    }
    const filtrado = {};
    for (const [tk, serie] of Object.entries(series)) {
      filtrado[tk] = filtrarPorPeriodo(serie, periodoAtivo);
    }
    renderizarGrafico(filtrado, criterio);
  }
}

let scrTabelaResultados = [];
let scrOrdemCol = "MAX";
let scrOrdemAsc = false;

function renderizarTabelaPctCdi() {
  const janelas = ["1A", "3A", "5A", "MAX"];

  scrTabelaResultados = ativosSelecionados
    .map(f => {
      const r = { ticker: f.ticker, nome: f.nome, setor: f.setor };
      for (const j of janelas) r[j] = f.raw["% Dias Acima CDI " + j] ?? null;
      return r;
    })
    .filter(r => janelas.some(j => r[j] != null));

  scrOrdemCol = "MAX";
  scrOrdemAsc = false;
  scrRenderTabela();
}

function scrOrdenarTabela(col) {
  if (scrOrdemCol === col) scrOrdemAsc = !scrOrdemAsc;
  else { scrOrdemCol = col; scrOrdemAsc = col === "ticker" || col === "nome" || col === "setor"; }
  scrRenderTabela();
}

function scrRenderTabela() {
  const sorted = [...scrTabelaResultados].sort((a, b) => {
    let va = a[scrOrdemCol], vb = b[scrOrdemCol];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string") return scrOrdemAsc ? va.localeCompare(vb, "pt-BR") : vb.localeCompare(va, "pt-BR");
    return scrOrdemAsc ? va - vb : vb - va;
  });

  const seta = "↕";
  const thead = document.getElementById("scr-thead");
  thead.innerHTML = `<tr>
    <th style="width:40px;text-align:center">#</th>
    <th onclick="scrOrdenarTabela('ticker')" style="cursor:pointer">Ticker ${seta}</th>
    <th onclick="scrOrdenarTabela('nome')" style="cursor:pointer">Nome ${seta}</th>
    <th onclick="scrOrdenarTabela('setor')" style="cursor:pointer">Setor ${seta}</th>
    <th class="num" onclick="scrOrdenarTabela('1A')" style="cursor:pointer">1 Ano ${seta}</th>
    <th class="num" onclick="scrOrdenarTabela('3A')" style="cursor:pointer">3 Anos ${seta}</th>
    <th class="num" onclick="scrOrdenarTabela('5A')" style="cursor:pointer">5 Anos ${seta}</th>
    <th class="num" onclick="scrOrdenarTabela('MAX')" style="cursor:pointer">Máximo ${seta}</th>
  </tr>`;

  const tbody = document.getElementById("scr-tbody");
  tbody.innerHTML = "";

  sorted.forEach((r, i) => {
    const tr = document.createElement("tr");
    const fmtCell = v => {
      if (v == null) return '<td class="num">—</td>';
      const pct = (v * 100).toFixed(1);
      const classe = v >= 0.5 ? "positivo" : "negativo";
      return `<td class="num ${classe}" style="font-weight:700">${pct}%</td>`;
    };
    tr.innerHTML = `
      <td class="rank-cell">${i + 1}</td>
      <td class="ticker-cell">${r.ticker}</td>
      <td>${r.nome || "—"}</td>
      <td>${r.setor || "—"}</td>
      ${fmtCell(r["1A"])}
      ${fmtCell(r["3A"])}
      ${fmtCell(r["5A"])}
      ${fmtCell(r["MAX"])}
    `;
    tbody.appendChild(tr);
  });
}

function filtrarPorPeriodo(serie, periodo) {
  if (!serie.length || periodo === "MAX") return serie;
  const anos = { "1A": 1, "3A": 3, "5A": 5 }[periodo] || 1;
  const corte = new Date();
  corte.setFullYear(corte.getFullYear() - anos);
  const corteStr = corte.toISOString().split("T")[0];
  return serie.filter(([d]) => d >= corteStr);
}

// ─── Gráfico ─────────────────────────────────────────────────────────────────

function renderizarGrafico(series, criterio) {
  const tickers = Object.keys(series);
  if (!tickers.length) {
    document.getElementById("scr-grafico-titulo").textContent = "Sem dados disponíveis para o critério selecionado.";
    return;
  }

  // Monta eixo X: datas únicas ordenadas (amostragem se muito denso)
  const todasDatas = [...new Set(tickers.flatMap(t => series[t].map(([d]) => d)))].sort();

  // Formata Y
  const fmtY = criterio === "pvp"
    ? v => v.toFixed(2) + "x"
    : v => v.toFixed(2) + "%";

  const fmtTooltip = criterio === "pvp"
    ? v => v.toFixed(2) + "x"
    : v => v.toFixed(2) + "%";

  const datasets = tickers.map((tk, i) => {
    const mapa = Object.fromEntries(series[tk]);
    const data = todasDatas.map(d => mapa[d] ?? null);
    return {
      label: tk,
      data,
      borderColor: CORES[i % CORES.length],
      backgroundColor: "transparent",
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.2,
      spanGaps: true
    };
  });

  const label = CRITERIO_LABEL[criterio] || criterio;
  document.getElementById("scr-grafico-titulo").textContent =
    label + " — " + tickers.join(", ");

  const ctx = document.getElementById("scr-grafico").getContext("2d");
  if (scrChart) scrChart.destroy();

  scrChart = new Chart(ctx, {
    type: "line",
    data: { labels: todasDatas, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { boxWidth: 14, font: { size: 12 } }
        },
        tooltip: {
          callbacks: {
            label: ctx => ctx.parsed.y != null
              ? ` ${ctx.dataset.label}: ${fmtTooltip(ctx.parsed.y)}`
              : ""
          }
        }
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 10,
            maxRotation: 0,
            callback: (_, i) => todasDatas[i] ? todasDatas[i].slice(0, 7) : ""
          },
          grid: { display: false }
        },
        y: {
          ticks: { callback: v => fmtY(v) },
          grid: { color: "rgba(0,0,0,0.05)" }
        }
      }
    }
  });
}

carregarDados();
