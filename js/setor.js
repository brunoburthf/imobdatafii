let dadosSetores = null;
let todosFiis = [];
let setorSelecionado = null;
let chartCombo = null;
let chartPvpSetor = null;
let chartDySetor = null;
let dadosPvpCompleto = [];
let dadosDyCompleto = [];

const PRICES_URL = "https://raw.githubusercontent.com/brunoburthf/imobdatafii/master/prices.json";

// ─── CARREGAMENTO ────────────────────────────────────────────────────────────

async function carregarDados() {
  try {
    const [respSetores, respIndex, respPrecos] = await Promise.all([
      fetch("data/setores.json"),
      fetch("data/index.json"),
      fetch(PRICES_URL).catch(() => null)
    ]);

    if (!respSetores.ok) throw new Error("Dados de setores não encontrados. Rode o script de atualização primeiro.");
    if (!respIndex.ok) throw new Error("Dados de FIIs não encontrados.");

    dadosSetores = await respSetores.json();
    const dataIndex = await respIndex.json();
    todosFiis = dataIndex.fiis || [];

    if (respPrecos && respPrecos.ok) {
      const precos = await respPrecos.json();
      todosFiis.forEach(fii => {
        const t = fii["Ticker"];
        if (precos.precos?.[t] != null) fii["Preço Atual"] = precos.precos[t];
        if (precos.variacoes?.[t] != null) fii["Variação Dia"] = precos.variacoes[t];
      });
    }

    document.getElementById("loading").style.display = "none";

    const tabela = dadosSetores.tabela || [];
    if (!tabela.length || tabela.every(s => s["Setor"] == null)) {
      const el = document.getElementById("erro");
      el.style.display = "block";
      el.textContent = "Dados de setores não disponíveis. Abra o Excel com o Economatica logado e clique em \"Atualizar Dados\" na página principal.";
      return;
    }

    document.getElementById("conteudo").style.display = "block";
    renderizarTabelaSetores(tabela);
    renderizarGraficoCombo(tabela);

  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

// ─── TABELA DE SETORES (topo esquerda) ───────────────────────────────────────

function detectarColunaSetor(headers) {
  return headers.find(h => h.toLowerCase().includes("setor") || h.toLowerCase().includes("segmento")) || headers[0];
}

function renderizarTabelaSetores(tabela) {
  if (!tabela.length) return;

  const headers = Object.keys(tabela[0]).filter(h => h && !h.startsWith("col_"));
  const setorCol = detectarColunaSetor(headers);

  const thead = document.getElementById("tabela-setores-head");
  const tbody = document.getElementById("tabela-setores-body");

  thead.innerHTML = "<tr>" + headers.map(h => {
    const isNum = h !== setorCol;
    return `<th${isNum ? ' class="num"' : ""}>${h}</th>`;
  }).join("") + "</tr>";

  tbody.innerHTML = "";

  tabela.forEach(row => {
    const setor = row[setorCol];
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.title = "Clique para ver detalhes";
    tr.onclick = () => selecionarSetor(setor);

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

function formatarCelulaSetor(col, val) {
  if (val == null || val === "") return "—";
  if (typeof val !== "number") return val;
  const c = col.toLowerCase();
  if (c.includes("dy") || c.includes("retorno") || c.includes("ret")) return (val * 100).toFixed(2) + "%";
  if (c.includes("p/vp") || c.includes("pvp")) return val.toFixed(2) + "x";
  if (c.includes("preço") || c.includes("preco")) return "R$ " + val.toFixed(2);
  if (Number.isInteger(val)) return val.toString();
  return val.toFixed(2);
}

// ─── GRÁFICO COMBO (topo direita) ────────────────────────────────────────────

function renderizarGraficoCombo(tabela) {
  if (!tabela.length) return;

  const headers = Object.keys(tabela[0]);
  const setorCol = detectarColunaSetor(headers);
  const dyCol   = headers.find(h => h.toLowerCase().includes("dy"));
  const pvpCol  = headers.find(h => h.toLowerCase().includes("p/vp") || h.toLowerCase().includes("pvp"));

  if (!dyCol || !pvpCol) return;

  const labels  = tabela.map(r => r[setorCol] || "—");
  const dyData  = tabela.map(r => r[dyCol]  != null ? parseFloat((r[dyCol]  * 100).toFixed(2)) : null);
  const pvpData = tabela.map(r => r[pvpCol] != null ? parseFloat(r[pvpCol].toFixed(3))          : null);

  const ctx = document.getElementById("grafico-combo").getContext("2d");
  if (chartCombo) chartCombo.destroy();

  chartCombo = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "DY a.a. (%)",
          data: dyData,
          backgroundColor: "rgba(239,99,0,0.65)",
          borderColor: "rgba(239,99,0,1)",
          borderWidth: 1,
          yAxisID: "yDY",
          order: 2
        },
        {
          type: "line",
          label: "P/VP",
          data: pvpData,
          showLine: false,
          pointStyle: "rect",
          pointRadius: 7,
          pointHoverRadius: 9,
          backgroundColor: "rgba(28,43,58,0.85)",
          borderColor: "rgba(28,43,58,0)",
          yAxisID: "yPVP",
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "top", labels: { font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label.includes("DY")) return `DY: ${ctx.raw}%`;
              return `P/VP: ${ctx.raw}x`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { maxRotation: 40, font: { size: 11 } }
        },
        yDY: {
          type: "linear",
          position: "left",
          title: { display: true, text: "DY a.a. (%)", font: { size: 11 } },
          ticks: { callback: v => v + "%" }
        },
        yPVP: {
          type: "linear",
          position: "right",
          title: { display: true, text: "P/VP", font: { size: 11 } },
          ticks: { callback: v => v + "x" },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
}

// ─── SELEÇÃO DE SETOR ────────────────────────────────────────────────────────

function selecionarSetor(setor) {
  setorSelecionado = setor;

  // Destaca linha selecionada
  document.querySelectorAll("#tabela-setores-body tr").forEach(tr => {
    const primeira = tr.querySelector("td");
    tr.classList.toggle("selecionado", primeira && primeira.textContent === setor);
  });

  // Exibe seção inferior
  document.getElementById("setor-detalhe-titulo").textContent = setor;
  document.getElementById("tabela-fiis-setor-titulo").textContent = `FIIs — ${setor}`;
  document.getElementById("setor-detalhe").style.display = "block";

  // Histórico
  dadosPvpCompleto = dadosSetores.historico_pvp?.[setor] || [];
  dadosDyCompleto  = dadosSetores.historico_dy?.[setor]  || [];

  ["pvp", "dy"].forEach(tipo => {
    document.querySelectorAll(`[data-chart="${tipo}"]`).forEach(btn => {
      btn.classList.toggle("ativo", btn.dataset.periodo === "1A");
    });
    renderizarHistoricoSetor(tipo, "1A");
  });

  // Tabela de FIIs
  renderizarTabelaFiisSetor(todosFiis.filter(f => f["Setor"] === setor));

  // Rola para a seção
  setTimeout(() => {
    document.getElementById("setor-detalhe").scrollIntoView({ behavior: "smooth", block: "start" });
  }, 50);
}

// ─── GRÁFICOS HISTÓRICOS (inferior esquerda) ─────────────────────────────────

function filtrarHistorico(tipo, periodo) {
  document.querySelectorAll(`[data-chart="${tipo}"]`).forEach(btn => {
    btn.classList.toggle("ativo", btn.dataset.periodo === periodo);
  });
  renderizarHistoricoSetor(tipo, periodo);
}

function filtrarPorPeriodo(dados, periodo) {
  if (!dados.length || periodo === "MAX") return dados;
  const anos = { "1A": 1, "3A": 3, "5A": 5 }[periodo];
  const corte = new Date();
  corte.setFullYear(corte.getFullYear() - anos);
  return dados.filter(([d]) => new Date(d) >= corte);
}

function calcularMedia(dados) {
  if (!dados.length) return [];
  const media = dados.reduce((acc, [, v]) => acc + v, 0) / dados.length;
  return dados.map(([d]) => [d, parseFloat(media.toFixed(4))]);
}

function renderizarHistoricoSetor(tipo, periodo) {
  const isPvp     = tipo === "pvp";
  const completo  = isPvp ? dadosPvpCompleto : dadosDyCompleto;
  const filtrado  = filtrarPorPeriodo(completo, periodo);
  const labels    = filtrado.map(([d]) => d);
  const valores   = filtrado.map(([, v]) => v);
  const medias    = calcularMedia(filtrado).map(([, v]) => v);

  const cor      = isPvp ? "rgba(239,99,0,1)"     : "rgba(14,159,110,1)";
  const corFundo = isPvp ? "rgba(239,99,0,0.08)"  : "rgba(14,159,110,0.08)";
  const canvasId = isPvp ? "grafico-pvp-setor"      : "grafico-dy-setor";
  const labelSerie = isPvp ? "P/VP" : "DY a.a.";

  const yCallback = isPvp
    ? v => v.toFixed(2) + "x"
    : v => (v * 100).toFixed(1) + "%";
  const tooltipFmt = isPvp
    ? v => `P/VP: ${v.toFixed(2)}x`
    : v => `DY: ${(v * 100).toFixed(2)}%`;
  const tooltipMedia = isPvp
    ? v => `Média: ${v.toFixed(2)}x`
    : v => `Média: ${(v * 100).toFixed(2)}%`;

  const ctx = document.getElementById(canvasId).getContext("2d");
  if (isPvp) { if (chartPvpSetor) chartPvpSetor.destroy(); }
  else        { if (chartDySetor)  chartDySetor.destroy();  }

  const chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: labelSerie,
          data: valores,
          borderColor: cor,
          backgroundColor: corFundo,
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.3
        },
        {
          label: "Média",
          data: medias,
          borderColor: "rgba(107,122,141,0.65)",
          borderWidth: 1.5,
          borderDash: [6, 3],
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "top", labels: { font: { size: 11 } } },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            label: ctx => ctx.datasetIndex === 0 ? tooltipFmt(ctx.raw) : tooltipMedia(ctx.raw)
          }
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

  if (isPvp) chartPvpSetor = chart;
  else       chartDySetor  = chart;
}

// ─── TABELA DE FIIs DO SETOR (inferior direita) ──────────────────────────────

function renderizarTabelaFiisSetor(fiis) {
  const tbody = document.getElementById("tabela-fiis-setor-body");
  tbody.innerHTML = "";

  if (!fiis.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#6b7a8d;padding:20px">Nenhum FII encontrado neste setor</td></tr>';
    return;
  }

  const colunas = [
    "Ticker", "Preço Atual", "Variação Dia", "P/VP",
    "DY a.a.", "Retorno - MTD", "Retorno - 12M", "Último Dividendo Pago"
  ];

  fiis.forEach(fii => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.onclick = () => window.location.href = "fii.html?ticker=" + encodeURIComponent(fii["Ticker"]);

    colunas.forEach(col => {
      const td = document.createElement("td");
      const val = fii[col];

      if (col === "Ticker") {
        td.className = "ticker-cell";
      } else {
        const num = parseFloat(val);
        let cls = "num";
        if (["Variação Dia", "Retorno - MTD", "Retorno - 12M"].includes(col) && !isNaN(num)) {
          cls += num >= 0 ? " positivo" : " negativo";
        }
        td.className = cls;
      }

      td.textContent = formatarCelulaFii(col, val);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

function formatarCelulaFii(col, val) {
  if (val == null || val === "") return "—";
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  if (col === "Preço Atual") return "R$ " + num.toFixed(2);
  if (col === "P/VP") return num.toFixed(2) + "x";
  if (col === "Variação Dia") return (num >= 0 ? "+" : "") + num.toFixed(2) + "%";
  if (["DY a.a.", "Retorno - MTD", "Retorno - 12M"].includes(col)) return (num * 100).toFixed(2) + "%";
  if (col === "Último Dividendo Pago") return "R$ " + num.toFixed(2);
  return num.toFixed(2);
}

carregarDados();
