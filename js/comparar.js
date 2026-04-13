let dadosSetores = null;
let setoresSelecionados = new Set();
let chartCompararPvp = null;
let chartCompararDy  = null;
let periodoPvp = "1A";
let periodoDy  = "1A";

const CORES = [
  "#ef6300", "#1c6bbd", "#0e9f6e", "#9333ea",
  "#e02424", "#ca8a04", "#0891b2", "#be185d",
  "#16a34a", "#7c3aed", "#b45309", "#0f766e"
];

async function carregarDados() {
  try {
    const resp = await fetch("data/setores.json");
    if (!resp.ok) throw new Error("Dados de setores não encontrados.");
    dadosSetores = await resp.json();

    if (dadosSetores.atualizado_em) {
      document.getElementById("ultima-atualizacao").textContent =
        "Atualizado em " + dadosSetores.atualizado_em;
    }

    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";

    renderizarTabela();
    renderizarGraficos();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

// ─── TABELA COM CHECKBOXES ────────────────────────────────────────────────────

function renderizarTabela() {
  const tabela = dadosSetores.tabela || [];
  if (!tabela.length) return;

  const headers = Object.keys(tabela[0]).filter(h => h && !h.startsWith("col_"));
  const setorCol = headers.find(h => h.toLowerCase().includes("setor")) || headers[0];

  const thead = document.getElementById("comparar-thead");
  const tbody = document.getElementById("comparar-tbody");

  thead.innerHTML = "<tr><th></th>" + headers.map(h => {
    const isNum = h !== setorCol;
    return `<th${isNum ? ' class="num"' : ""}>${h}</th>`;
  }).join("") + "</tr>";

  tbody.innerHTML = "";

  tabela.forEach((row, idx) => {
    const setor = row[setorCol];
    const cor = CORES[idx % CORES.length];
    const checked = setoresSelecionados.has(setor);

    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.onclick = () => toggleSetor(setor);

    // Célula do checkbox com bolinha colorida
    const tdCheck = document.createElement("td");
    tdCheck.className = "comparar-check-cell";
    tdCheck.innerHTML = `
      <span class="comparar-dot" style="background:${cor};opacity:${checked ? 1 : 0.2}"></span>
      <input type="checkbox" ${checked ? "checked" : ""}
        onclick="event.stopPropagation();toggleSetor('${setor.replace(/'/g, "\\'")}')" />
    `;
    tr.appendChild(tdCheck);

    headers.forEach(h => {
      const td = document.createElement("td");
      const val = row[h];
      if (h !== setorCol) td.className = "num";
      td.textContent = formatarCelulaSetor(h, val);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

function toggleSetor(setor) {
  if (setoresSelecionados.has(setor)) {
    setoresSelecionados.delete(setor);
  } else {
    setoresSelecionados.add(setor);
  }
  renderizarTabela();
  renderizarGraficos();
}

function formatarCelulaSetor(col, val) {
  if (val == null || val === "") return "—";
  if (typeof val !== "number") return val;
  const c = col.toLowerCase();
  if (c.includes("dy") || c.includes("retorno") || c.includes("ret")) return (val * 100).toFixed(2) + "%";
  if (c.includes("p/vp") || c.includes("pvp")) return val.toFixed(2) + "x";
  if (Number.isInteger(val)) return val.toString();
  return val.toFixed(2);
}

// ─── GRÁFICOS DE COMPARAÇÃO ──────────────────────────────────────────────────

function filtrarComparar(tipo, periodo) {
  document.querySelectorAll(`[data-chart="c${tipo}"]`).forEach(btn => {
    btn.classList.toggle("ativo", btn.dataset.periodo === periodo);
  });
  if (tipo === "pvp") periodoPvp = periodo;
  else periodoDy = periodo;
  renderizarGraficos();
}

function filtrarPorPeriodo(dados, periodo) {
  if (!dados.length || periodo === "MAX") return dados;
  const anos = { "1A": 1, "3A": 3, "5A": 5 }[periodo];
  const corte = new Date();
  corte.setFullYear(corte.getFullYear() - anos);
  return dados.filter(([d]) => new Date(d) >= corte);
}

function renderizarGraficos() {
  renderizarGraficoComparar("pvp");
  renderizarGraficoComparar("dy");
}

function renderizarGraficoComparar(tipo) {
  const isPvp    = tipo === "pvp";
  const histAll  = isPvp ? dadosSetores.historico_pvp : dadosSetores.historico_dy;
  const canvasId = isPvp ? "grafico-comparar-pvp" : "grafico-comparar-dy";
  const periodo  = isPvp ? periodoPvp : periodoDy;

  const yCallback   = isPvp ? v => v.toFixed(2) + "x" : v => (v * 100).toFixed(1) + "%";
  const tooltipFmt  = isPvp ? v => `P/VP: ${v.toFixed(2)}x` : v => `DY: ${(v * 100).toFixed(2)}%`;

  // Coleta todos os labels (datas) dos setores selecionados
  const setores = [...setoresSelecionados];
  const tabela  = dadosSetores.tabela || [];

  let labels = [];
  const datasets = [];

  setores.forEach((setor, i) => {
    const serie = filtrarPorPeriodo(histAll?.[setor] || [], periodo);
    if (!serie.length) return;

    // Usa os labels do primeiro setor com dados
    if (!labels.length) labels = serie.map(([d]) => d);

    const idx = tabela.findIndex(r => Object.values(r).includes(setor));
    const cor = CORES[(idx >= 0 ? idx : i) % CORES.length];

    datasets.push({
      label: setor,
      data: serie.map(([, v]) => v),
      borderColor: cor,
      backgroundColor: cor + "18",
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0.3
    });
  });

  const ctx = document.getElementById(canvasId).getContext("2d");
  if (isPvp) { if (chartCompararPvp) chartCompararPvp.destroy(); }
  else        { if (chartCompararDy)  chartCompararDy.destroy();  }

  const chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "top", labels: { font: { size: 11 }, usePointStyle: true } },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: { label: ctx => `${ctx.dataset.label}: ${tooltipFmt(ctx.raw)}` }
        }
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8,
            font: { size: 10 },
            callback: (_, i) => labels[i]?.slice(0, 7) ?? ""
          }
        },
        y: { ticks: { callback: yCallback, font: { size: 10 } } }
      }
    }
  });

  if (isPvp) chartCompararPvp = chart;
  else       chartCompararDy  = chart;
}

carregarDados();
