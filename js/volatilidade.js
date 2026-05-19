// volatilidade.js — calcula vol anualizada e retorno do periodo por setor,
// renderiza tabela ordenavel + scatter (Chart.js).
//
// Fonte: data/volatilidade_base.json (gerado por gerar_volatilidade_base.py).
// Cada fundo tem serie [[YYYY-MM-DD, preco_ajustado], ...] em dias com pregao.

const DIAS_UTEIS_ANO = 252;
// Paleta harmonizada com o navy + laranja do site. Ordem aproximada por
// representatividade (maiores setores recebem os tons mais fortes).
const PALETA_SETORES = {
  "Crédito Imobiliário":   "#001f4d",  // navy principal
  "FOFs/Hedge Funds":      "#5b4b8a",  // roxo navy
  "Escritórios":           "#1d6e42",  // verde escuro
  "Logística":             "#ef6300",  // laranja do site
  "Tijolo Multissetorial": "#0c6e8a",  // ciano escuro
  "Shoppings":             "#a13a5a",  // vinho
  "Agro":                  "#7aa14d",  // verde claro
  "Terras agrícolas":      "#a07a2c",  // dourado
  "Desenvolvimento":       "#9a2828",  // vermelho terroso
};
const COR_DEFAULT = "#6b7a8d";

let _baseFundos = [];          // fundos do JSON (com series)
let _resultados = [];          // [{setor, vol, retorno, n}] do periodo aplicado
let _ordem = { campo: "vol", direcao: "desc" };
let _scatter = null;            // chart instance setores
let _scatterFiis = null;        // chart instance FIIs do setor selecionado
let _setorSelecionado = null;   // setor atualmente em foco no detalhe

async function carregar() {
  try {
    const v = Math.floor(Date.now() / 60000);
    const r = await fetch("data/volatilidade_base.json?v=" + v);
    if (!r.ok) throw new Error("Base nao encontrada. Rode scripts/gerar_volatilidade_base.py primeiro.");
    const doc = await r.json();
    _baseFundos = doc.fundos || [];

    // Range global: min e max de TODAS as series, pra preencher os datepickers
    let dataMin = null, dataMax = null;
    for (const f of _baseFundos) {
      if (!f.serie || !f.serie.length) continue;
      const ini = f.serie[0][0], fim = f.serie[f.serie.length - 1][0];
      if (!dataMin || ini < dataMin) dataMin = ini;
      if (!dataMax || fim > dataMax) dataMax = fim;
    }

    // Default: ultimos 12 meses ate dataMax
    const fimDate = new Date(dataMax);
    const iniDefault = new Date(fimDate);
    iniDefault.setFullYear(iniDefault.getFullYear() - 1);
    const iniStr = iniDefault.toISOString().slice(0, 10);

    const inputIni = document.getElementById("vol-data-ini");
    const inputFim = document.getElementById("vol-data-fim");
    inputIni.min = dataMin;
    inputIni.max = dataMax;
    inputFim.min = dataMin;
    inputFim.max = dataMax;
    inputIni.value = iniStr < dataMin ? dataMin : iniStr;
    inputFim.value = dataMax;

    document.getElementById("vol-btn-aplicar").addEventListener("click", aplicar);
    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "";

    aplicar();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

function aplicar() {
  const ini = document.getElementById("vol-data-ini").value;
  const fim = document.getElementById("vol-data-fim").value;
  if (!ini || !fim || ini >= fim) {
    document.getElementById("vol-info").textContent = "Selecione um intervalo válido.";
    return;
  }
  _resultados = calcularPorSetor(ini, fim);
  ordenarTabela(_ordem.campo, true);
  renderScatter();
  const total = _resultados.reduce((acc, r) => acc + r.n, 0);
  document.getElementById("vol-info").textContent =
    `${_resultados.length} setores, ${total} FIIs com dados suficientes no período.`;
  // Se ja havia um setor selecionado, re-renderiza o detalhe com o novo periodo.
  if (_setorSelecionado && _resultados.some(r => r.setor === _setorSelecionado)) {
    renderScatterFiis(_setorSelecionado);
  } else {
    _setorSelecionado = null;
    document.getElementById("vol-detalhe").style.display = "none";
  }
}

// Filtra a serie de um fundo pra [ini, fim] e devolve so os precos.
function recortarSerie(serie, ini, fim) {
  const pontos = [];
  for (const [d, p] of serie) {
    if (d < ini) continue;
    if (d > fim) break;
    pontos.push(p);
  }
  return pontos;
}

// Log-returns diarios + vol anualizada (sqrt(252) × stdev) + retorno total
// do periodo. Retorna null se a serie tem < 20 pontos (pra evitar vol ruim).
function calcularFundo(serie, ini, fim) {
  const precos = recortarSerie(serie, ini, fim);
  if (precos.length < 20) return null;

  const logRet = [];
  for (let i = 1; i < precos.length; i++) {
    if (precos[i - 1] <= 0) continue;
    logRet.push(Math.log(precos[i] / precos[i - 1]));
  }
  if (!logRet.length) return null;

  const media = logRet.reduce((a, b) => a + b, 0) / logRet.length;
  const variancia = logRet.reduce((a, b) => a + (b - media) ** 2, 0) / (logRet.length - 1 || 1);
  const volDiaria = Math.sqrt(variancia);
  const volAnual = volDiaria * Math.sqrt(DIAS_UTEIS_ANO);

  const retornoTotal = precos[precos.length - 1] / precos[0] - 1;

  return { vol: volAnual, retorno: retornoTotal, n_obs: precos.length };
}

function calcularPorSetor(ini, fim) {
  const porSetor = new Map();
  for (const f of _baseFundos) {
    if (!f.setor) continue;
    const m = calcularFundo(f.serie, ini, fim);
    if (!m) continue;
    if (!porSetor.has(f.setor)) porSetor.set(f.setor, []);
    porSetor.get(f.setor).push(m);
  }
  const linhas = [];
  for (const [setor, fundos] of porSetor.entries()) {
    if (!fundos.length) continue;
    const vol = fundos.reduce((a, b) => a + b.vol, 0) / fundos.length;
    const retorno = fundos.reduce((a, b) => a + b.retorno, 0) / fundos.length;
    linhas.push({ setor, vol, retorno, n: fundos.length });
  }
  return linhas;
}

window.ordenarTabela = function(campo, manterDirecao = false) {
  if (!manterDirecao) {
    if (_ordem.campo === campo) {
      _ordem.direcao = _ordem.direcao === "asc" ? "desc" : "asc";
    } else {
      _ordem.campo = campo;
      _ordem.direcao = (campo === "setor") ? "asc" : "desc";
    }
  }
  _resultados.sort((a, b) => {
    const va = a[campo], vb = b[campo];
    if (typeof va === "string") return _ordem.direcao === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    return _ordem.direcao === "asc" ? va - vb : vb - va;
  });
  renderTabela();
};

function fmtPct(x) {
  return (x * 100).toFixed(2) + "%";
}

function renderTabela() {
  const tbody = document.getElementById("vol-tabela-body");
  tbody.innerHTML = "";
  for (const r of _resultados) {
    const tr = document.createElement("tr");
    const cor = PALETA_SETORES[r.setor] || COR_DEFAULT;
    tr.style.cursor = "pointer";
    if (r.setor === _setorSelecionado) tr.classList.add("selecionado");
    tr.innerHTML = `
      <td><span class="vol-dot" style="background:${cor}"></span>${r.setor}</td>
      <td class="num">${fmtPct(r.vol)}</td>
      <td class="num ${r.retorno >= 0 ? "positivo" : "negativo"}">${fmtPct(r.retorno)}</td>
      <td class="num">${r.n}</td>
    `;
    tr.addEventListener("click", () => selecionarSetor(r.setor));
    tbody.appendChild(tr);
  }
}

function selecionarSetor(setor) {
  _setorSelecionado = setor;
  // Re-render pra aplicar a classe .selecionado na linha clicada
  renderTabela();
  renderScatterFiis(setor);
}

// Scatter de TODOS os FIIs do setor selecionado: cada ponto = 1 fundo.
// 1 dataset por FII pra que a legend do Chart.js mostre ticker + cor.
// Cores vivas e contrastantes: rainbow HSL varrendo 360 graus + alternancia
// de luminosidade (50% / 38%) pra dobrar a separacao visual entre vizinhos.
function renderScatterFiis(setor) {
  const ini = document.getElementById("vol-data-ini").value;
  const fim = document.getElementById("vol-data-fim").value;
  if (!ini || !fim) return;

  const fundos = [];
  for (const f of _baseFundos) {
    if (f.setor !== setor) continue;
    const m = calcularFundo(f.serie, ini, fim);
    if (!m) continue;
    fundos.push({ ticker: f.ticker, vol: m.vol, retorno: m.retorno, n: m.n_obs });
  }
  fundos.sort((a, b) => a.ticker.localeCompare(b.ticker));

  const datasets = fundos.map((f, i) => {
    const cor = corContrastante(i, fundos.length);
    return {
      label: f.ticker,
      data: [{ x: f.vol * 100, y: f.retorno * 100, ticker: f.ticker }],
      backgroundColor: cor,
      borderColor: cor,
      pointRadius: 6,
      pointHoverRadius: 10,
    };
  });

  document.getElementById("vol-detalhe-titulo").textContent = `${setor} — ${fundos.length} FIIs`;
  document.getElementById("vol-detalhe").style.display = "";

  const canvas = document.getElementById("vol-scatter-fiis");
  const ctx = canvas.getContext("2d");
  if (_scatterFiis) _scatterFiis.destroy();

  _scatterFiis = new Chart(ctx, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: {
            boxWidth: 8, boxHeight: 8, padding: 6,
            font: { size: 10 },
            usePointStyle: true,
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = ctx.raw;
              return `${p.ticker}: vol ${p.x.toFixed(2)}%, retorno ${p.y.toFixed(2)}%`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: "Volatilidade anualizada (%)" }, beginAtZero: true },
        y: { title: { display: true, text: "Retorno do período (%)" } },
      },
    },
    plugins: [quadrantesPlugin],
  });
}

// Plugin que pinta 4 quadrantes coloridos no scatter, dividindo pela
// MEDIANA de vol e retorno dos pontos. Tambem desenha linhas tracejadas
// nas medianas pra evidenciar as divisorias.
//   top-left  (vol baixa, retorno alto)  = VERDE
//   top-right (vol alta, retorno alto)   = AMARELO
//   bot-right (vol alta, retorno baixo)  = VERMELHO
//   bot-left  (vol baixa, retorno baixo) = LARANJA
const quadrantesPlugin = {
  id: "quadrantes",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales: { x, y } } = chart;
    if (!chartArea) return;

    // Coleta todos os pontos
    const pts = chart.data.datasets.flatMap(ds => ds.data || []);
    if (pts.length < 2) return;   // sem mediana significativa

    const xs = pts.map(p => p.x).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    const ys = pts.map(p => p.y).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (xs.length < 2 || ys.length < 2) return;

    const med = arr => {
      const n = arr.length;
      return n % 2 ? arr[(n - 1) / 2] : (arr[n/2 - 1] + arr[n/2]) / 2;
    };
    const xMed = med(xs);
    const yMed = med(ys);
    const xPx = x.getPixelForValue(xMed);
    const yPx = y.getPixelForValue(yMed);

    // Clipa ao chartArea pras pinturas
    const xL = Math.max(chartArea.left, Math.min(chartArea.right, xPx));
    const yL = Math.max(chartArea.top,  Math.min(chartArea.bottom, yPx));

    ctx.save();

    // VERDE  — top-left  (vol baixa, retorno alto)
    ctx.fillStyle = "rgba(14, 159, 110, 0.12)";
    ctx.fillRect(chartArea.left, chartArea.top, xL - chartArea.left, yL - chartArea.top);

    // AMARELO — top-right (vol alta, retorno alto)
    ctx.fillStyle = "rgba(234, 179, 8, 0.14)";
    ctx.fillRect(xL, chartArea.top, chartArea.right - xL, yL - chartArea.top);

    // VERMELHO — bottom-right (vol alta, retorno baixo)
    ctx.fillStyle = "rgba(224, 36, 36, 0.12)";
    ctx.fillRect(xL, yL, chartArea.right - xL, chartArea.bottom - yL);

    // LARANJA — bottom-left (vol baixa, retorno baixo)
    ctx.fillStyle = "rgba(239, 99, 0, 0.12)";
    ctx.fillRect(chartArea.left, yL, xL - chartArea.left, chartArea.bottom - yL);

    // Linhas tracejadas nas medianas
    ctx.strokeStyle = "rgba(0,9,60,0.30)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xL, chartArea.top);    ctx.lineTo(xL, chartArea.bottom);
    ctx.moveTo(chartArea.left, yL);   ctx.lineTo(chartArea.right, yL);
    ctx.stroke();

    ctx.restore();
  },
};

// Cores vivas e contrastantes pra N pontos. Estrategia:
//   1) Hue distribuido com golden angle (137.508°) pra maximizar separacao
//      entre vizinhos sequenciais (melhor que step linear 360/N pra qualquer N)
//   2) Saturacao alta (78%) e luminosidade alternada (48%/35%) pra dobrar a
//      separacao visual sem perder contraste com fundo branco
function corContrastante(i, total) {
  const GOLDEN = 137.508;
  const hue = (i * GOLDEN) % 360;
  const sat = 78;
  const lum = (i % 2 === 0) ? 48 : 35;
  return `hsl(${hue.toFixed(1)}, ${sat}%, ${lum}%)`;
}

function renderScatter() {
  const canvas = document.getElementById("vol-scatter");
  const ctx = canvas.getContext("2d");
  if (_scatter) _scatter.destroy();

  const pontos = _resultados.map(r => ({
    x: r.vol * 100,
    y: r.retorno * 100,
    setor: r.setor,
    n: r.n,
  }));
  const cores = _resultados.map(r => PALETA_SETORES[r.setor] || COR_DEFAULT);

  _scatter = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [{
        data: pontos,
        backgroundColor: cores,
        borderColor: cores,
        pointRadius: 10,
        pointHoverRadius: 14,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = ctx.raw;
              return `${p.setor}: vol ${p.x.toFixed(2)}%, retorno ${p.y.toFixed(2)}% (${p.n} FIIs)`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Volatilidade anualizada (%)" },
          beginAtZero: true,
        },
        y: {
          title: { display: true, text: "Retorno do período (%)" },
        },
      },
    },
  });
}

document.addEventListener("DOMContentLoaded", carregar);
