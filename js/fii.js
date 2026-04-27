const params = new URLSearchParams(window.location.search);
const ticker = params.get("ticker");

let chartPreco = null;
let chartPvp = null;
let chartRetorno = null;
let chartSpread = null;
let chartPortfolio = null;
let chartDpc = null;
let dadosPrecoCompleto = [];
let dadosPvpCompleto = [];
let dadosPrecoAdjCompleto = [];
let dadosDyCompleto = [];
let dadosSpreadCompleto = [];
let dadosPortfolio = {};
let dadosDpcCompleto = [];
let dadosCarteiraCvm = {};
let cdiMapa = {};

const SPREAD_NTNB_ANOS = 5;

const PRICES_URL = "https://raw.githubusercontent.com/brunoburthf/imobdatafii/master/prices.json";

if (!ticker) {
  window.location.href = "fiis.html";
}

document.title = ticker + " — ImobData";

async function carregarFii() {
  try {
    const [resp, respPrecos] = await Promise.all([
      fetch("data/fiis/" + encodeURIComponent(ticker) + ".json?v=" + Date.now()),
      fetch(PRICES_URL).catch(() => null)
    ]);

    if (!resp.ok) throw new Error("Dados não encontrados para " + ticker);
    const data = await resp.json();

    // Sobrescreve preço e variação com dados em tempo real
    if (respPrecos && respPrecos.ok) {
      const precos = await respPrecos.json();
      if (precos.precos?.[ticker] != null) data.dados["Preço Atual"] = precos.precos[ticker];
      if (precos.variacoes?.[ticker] != null) data.dados["Variação Dia"] = precos.variacoes[ticker];
    }

    renderizarFii(data);

    document.getElementById("loading").style.display = "none";
    document.getElementById("fii-main").style.display = "block";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

function fmt(valor, tipo) {
  if (valor == null || valor === "") return "—";
  const num = parseFloat(valor);
  if (isNaN(num)) return valor;
  if (tipo === "preco") return "R$ " + num.toFixed(2);
  if (tipo === "pvp") return num.toFixed(2) + "x";
  if (tipo === "pct") return (num * 100).toFixed(2) + "%";
  if (tipo === "div") return "R$ " + num.toFixed(2);
  return num.toFixed(2);
}

function classeRetorno(valor) {
  const num = parseFloat(valor);
  if (isNaN(num)) return "";
  return num >= 0 ? "positivo" : "negativo";
}

function renderizarFii(data) {
  const d = data.dados || {};

  document.getElementById("fii-ticker").textContent = ticker;
  document.getElementById("fii-nome").textContent = d["Nome"] || "";
  document.getElementById("fii-setor").textContent = d["Setor"] || "";
  document.getElementById("fii-preco").textContent = fmt(d["Preço Atual"], "preco");

  const varEl = document.getElementById("fii-variacao");
  const variacao = d["Variação Dia"];
  if (variacao != null) {
    const sinal = variacao >= 0 ? "+" : "";
    varEl.textContent = sinal + variacao.toFixed(2) + "%";
    varEl.className = "fii-variacao " + (variacao >= 0 ? "positivo" : "negativo");
  }

  document.getElementById("card-pvp").textContent = fmt(d["P/VP"], "pvp");
  document.getElementById("card-dy").textContent = fmt(d["DY a.a."], "pct");
  document.getElementById("card-div").textContent = fmt(d["Último Dividendo Pago"], "div");

  const mtdEl = document.getElementById("card-mtd");
  mtdEl.textContent = fmt(d["Retorno - MTD"], "pct");
  mtdEl.className = "card-value " + classeRetorno(d["Retorno - MTD"]);

  const m12El = document.getElementById("card-12m");
  m12El.textContent = fmt(d["Retorno - 12M"], "pct");
  m12El.className = "card-value " + classeRetorno(d["Retorno - 12M"]);

  document.getElementById("fii-visao-geral").textContent = d["Visão Geral"] || "Sem informação disponível.";
  document.getElementById("fii-comentario").textContent = d["Comentário"] || "Sem comentário disponível.";

  const mesRefEl = document.getElementById("fii-mes-ref");
  const mesRef = d["Mês Ref. Comentário"];
  if (mesRefEl) {
    if (mesRef) {
      mesRefEl.textContent = "Mês de Referência: " + mesRef;
      mesRefEl.style.display = "inline-block";
    } else {
      mesRefEl.style.display = "none";
    }
  }

  const indexResp = fetch("data/index.json")
    .then(r => r.json())
    .then(idx => {
      if (idx.atualizado_em) {
        document.getElementById("ultima-atualizacao").textContent = "Atualizado em " + idx.atualizado_em;
      }
    }).catch(() => {});

  dadosPrecoCompleto = data.historico_preco || [];
  dadosPvpCompleto = data.historico_pvp || [];
  dadosPrecoAdjCompleto = (data.historico_preco_adj && data.historico_preco_adj.length)
    ? data.historico_preco_adj
    : (data.historico_preco || []);
  dadosDyCompleto = data.historico_dy || [];
  dadosPortfolio = data.portfolio || {};
  dadosDpcCompleto = data.historico_dpc || [];
  dadosCarteiraCvm = data.carteira_trimestral || {};

  renderizarGrafico("preco", dadosPrecoCompleto, "1A");
  renderizarGrafico("pvp", dadosPvpCompleto, "1A");

  // CDI: busca a partir de 5 anos atrás (janela máxima visualizada é 5A/MAX).
  const dataInicioCdi = new Date();
  dataInicioCdi.setFullYear(dataInicioCdi.getFullYear() - 10);
  buscarCDI(dataInicioCdi.toISOString().slice(0, 10)).then(mapa => {
    cdiMapa = mapa;
    renderizarGraficoRetorno("1A");
  });

  // NTN-B → spread do fundo (DY - YTM interpolado a 5 anos)
  fetch("data/ntnb.json?v=" + Date.now())
    .then(r => r.ok ? r.json() : null)
    .then(ntnb => {
      if (!ntnb) return;
      const serieNtnb = interpolarNtnbDuration(ntnb, SPREAD_NTNB_ANOS);
      const dyMap = Object.fromEntries(dadosDyCompleto.map(([d, v]) => [d, v]));
      dadosSpreadCompleto = serieNtnb
        .filter(([d]) => dyMap[d] != null)
        .map(([d, ytm]) => [d, parseFloat((dyMap[d] - ytm).toFixed(4))]);
      renderizarGraficoSpread("1A");
    })
    .catch(() => {});
}

function interpolarNtnbDuration(ntnb, targetAnos) {
  const ytmPorData = {};
  for (const bond of Object.keys(ntnb.ytm || {})) {
    for (const [dt, val] of ntnb.ytm[bond]) {
      if (!ytmPorData[dt]) ytmPorData[dt] = {};
      ytmPorData[dt][bond] = val;
    }
  }
  const durSeries = {};
  for (const bond of Object.keys(ntnb.duration || {})) {
    durSeries[bond] = ntnb.duration[bond].slice().sort((a, b) => a[0] < b[0] ? -1 : 1);
  }
  const getDur = (bond, dt) => {
    const s = durSeries[bond];
    if (!s || !s.length) return null;
    let v = null;
    for (const [d, val] of s) {
      if (d <= dt) v = val;
      else break;
    }
    return v;
  };
  const todasDatas = Object.keys(ytmPorData).sort();
  const serie = [];
  for (const dt of todasDatas) {
    const ytmMap = ytmPorData[dt];
    const durMap = {};
    for (const b of Object.keys(ytmMap)) {
      const d = getDur(b, dt);
      if (d !== null) durMap[b] = d;
    }
    const y = interpolarDiaNtnb(ytmMap, durMap, targetAnos);
    if (y !== null) serie.push([dt, y]);
  }
  return serie;
}

function interpolarDiaNtnb(ytmMap, durMap, targetAnos) {
  const pontos = [];
  for (const bond of Object.keys(ytmMap)) {
    const y = ytmMap[bond], d = durMap[bond];
    if (y == null || d == null) continue;
    pontos.push({ ytm: y, durAnos: d / 365 });
  }
  if (pontos.length < 2) return null;
  pontos.sort((a, b) => a.durAnos - b.durAnos);
  const min = pontos[0].durAnos;
  const max = pontos[pontos.length - 1].durAnos;
  if (targetAnos < min || targetAnos > max) return null;
  for (let i = 0; i < pontos.length - 1; i++) {
    const lo = pontos[i], hi = pontos[i + 1];
    if (lo.durAnos <= targetAnos && hi.durAnos >= targetAnos) {
      if (hi.durAnos === lo.durAnos) return lo.ytm;
      return lo.ytm + (targetAnos - lo.durAnos) / (hi.durAnos - lo.durAnos) * (hi.ytm - lo.ytm);
    }
  }
  return null;
}

function renderizarGraficoSpread(periodo) {
  if (!dadosSpreadCompleto.length) return;
  const filtrado = filtrarPorPeriodo(dadosSpreadCompleto, periodo);
  if (!filtrado.length) return;

  const labels = filtrado.map(([d]) => d);
  const valores = filtrado.map(([, v]) => v);
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  const mediaArr = Array(valores.length).fill(parseFloat(media.toFixed(4)));

  const positivo = media >= 0;
  const corArea = positivo ? "rgba(14,159,110,0.15)" : "rgba(220,38,38,0.15)";
  const corLinhaMedia = positivo ? "rgb(14,159,110)" : "rgb(220,38,38)";

  const ctx = document.getElementById("grafico-spread").getContext("2d");
  if (chartSpread) chartSpread.destroy();

  chartSpread = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Spread (pp)",
          data: valores,
          borderColor: "rgb(0,9,60)",
          backgroundColor: corArea,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.2
        },
        {
          label: `Média (${media >= 0 ? "+" : ""}${media.toFixed(2)}pp)`,
          data: mediaArr,
          borderColor: corLinhaMedia,
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 20, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label.startsWith("Média") ? "Média" : "Spread"}: ${(ctx.parsed.y >= 0 ? "+" : "") + ctx.parsed.y.toFixed(2)}pp`
          }
        }
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8,
            maxRotation: 0,
            callback: (_, i) => labels[i] ? labels[i].slice(0, 7) : ""
          },
          grid: { display: false }
        },
        y: {
          ticks: { callback: v => (v >= 0 ? "+" : "") + v.toFixed(1) + "pp" }
        }
      }
    }
  });
}

async function buscarCDI(dataMinISO) {
  try {
    const fmt = iso => { const [a, m, d] = iso.split("-"); return `${d}/${m}/${a}`; };
    const hoje = new Date().toISOString().slice(0, 10);
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json`
              + `&dataInicial=${fmt(dataMinISO)}&dataFinal=${fmt(hoje)}`;
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const lista = await resp.json();
    const mapa = {};
    for (const { data, valor } of lista) {
      const [d, m, a] = data.split("/");
      mapa[`${a}-${m}-${d}`] = parseFloat(valor) / 100;
    }
    return mapa;
  } catch { return {}; }
}

function renderizarGraficoRetorno(periodo) {
  if (!dadosPrecoAdjCompleto.length) return;
  const filtrado = filtrarPorPeriodo(dadosPrecoAdjCompleto, periodo);
  if (filtrado.length < 2) return;

  const labels = filtrado.map(([d]) => d);
  const p0 = filtrado[0][1];
  const valoresFii = filtrado.map(([, p]) => p0 > 0 ? parseFloat(((p / p0 - 1) * 100).toFixed(4)) : 0);

  // CDI acumulado — multiplica (1 + taxa) a cada data; se a data não tiver taxa, usa a do dia anterior
  const valoresCdi = [0];
  let acum = 100;
  for (let i = 1; i < filtrado.length; i++) {
    const d  = filtrado[i][0];
    const d0 = filtrado[i - 1][0];
    const taxa = cdiMapa[d] ?? cdiMapa[d0] ?? 0;
    acum *= (1 + taxa);
    valoresCdi.push(parseFloat((acum - 100).toFixed(4)));
  }

  // Retorno do fundo / retorno do CDI no período (ex.: "118% do CDI")
  const retFii = valoresFii.at(-1);
  const retCdi = valoresCdi.at(-1);
  const badge  = document.getElementById("retorno-vs-cdi-badge");
  const valorEl = document.getElementById("retorno-vs-cdi-valor");
  if (badge && valorEl) {
    if (retCdi && Math.abs(retCdi) > 0.01) {
      const pct = (retFii / retCdi) * 100;
      valorEl.textContent = (pct >= 0 ? "" : "") + pct.toFixed(1) + "%";
      valorEl.style.color = pct >= 100 ? "rgb(14,159,110)" : (pct >= 0 ? "var(--azul-escuro)" : "rgb(220,38,38)");
      badge.style.display = "flex";
    } else {
      badge.style.display = "none";
    }
  }

  const corFii = valoresFii.at(-1) >= 0 ? "rgba(239,99,0,1)" : "#DC2626";
  const ctx = document.getElementById("grafico-retorno").getContext("2d");
  if (chartRetorno) chartRetorno.destroy();

  chartRetorno = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: ticker,
          data: valoresFii,
          borderColor: corFii,
          backgroundColor: corFii.replace("1)", "0.15)"),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2
        },
        {
          label: "CDI",
          data: valoresCdi,
          borderColor: "rgb(0,9,60)",
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 20, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}%`
          }
        }
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8,
            maxRotation: 0,
            callback: (_, i) => labels[i] ? labels[i].slice(0, 7) : ""
          },
          grid: { display: false }
        },
        y: {
          ticks: { callback: v => v.toFixed(1) + "%" }
        }
      }
    }
  });
}

function filtrarPorPeriodo(dados, periodo) {
  if (!dados.length) return dados;
  if (periodo === "MAX") return dados;

  const anos = periodo === "1A" ? 1 : periodo === "3A" ? 3 : 5;
  const corte = new Date();
  corte.setFullYear(corte.getFullYear() - anos);
  const corteStr = corte.toISOString().split("T")[0];

  return dados.filter(([data]) => data >= corteStr);
}

function calcularMedia(valores) {
  const validos = valores.filter(v => v != null);
  if (!validos.length) return null;
  return validos.reduce((a, b) => a + b, 0) / validos.length;
}

function renderizarGrafico(tipo, dados, periodo) {
  const filtrado = filtrarPorPeriodo(dados, periodo);
  const labels = filtrado.map(([d]) => d);
  const valores = filtrado.map(([, v]) => v);

  const canvasId = tipo === "preco" ? "grafico-preco" : "grafico-pvp";
  const cor = tipo === "preco" ? "rgb(0,9,60)" : "rgba(239,99,0,1)";
  const corFundo = tipo === "preco" ? "rgba(0,9,60,0.15)" : "rgba(239,99,0,0.1)";
  const label = tipo === "preco" ? "Preço (R$)" : "P/VP";

  const ctx = document.getElementById(canvasId).getContext("2d");

  if (tipo === "preco" && chartPreco) chartPreco.destroy();
  if (tipo === "pvp" && chartPvp) chartPvp.destroy();

  const datasets = [{
    label,
    data: valores,
    borderColor: cor,
    backgroundColor: corFundo,
    borderWidth: 2,
    pointRadius: 0,
    fill: true,
    tension: 0.3
  }];

  // Linha de média apenas no gráfico de P/VP
  if (tipo === "pvp") {
    const media = calcularMedia(valores);
    if (media !== null) {
      datasets.push({
        label: `Média (${media.toFixed(2)}x)`,
        data: Array(labels.length).fill(media),
        borderColor: "#000000",
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0
      });
    }
  }

  const chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: tipo === "pvp",
          labels: { boxWidth: 20, font: { size: 12 } }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (tipo === "preco") return "R$ " + v.toFixed(2);
              return v.toFixed(2) + "x";
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8,
            maxRotation: 0,
            callback: (_, i) => {
              const d = labels[i];
              if (!d) return "";
              return d.slice(0, 7); // YYYY-MM
            }
          },
          grid: { display: false }
        },
        y: {
          ticks: {
            callback: v => tipo === "preco" ? "R$ " + v.toFixed(0) : v.toFixed(2) + "x"
          }
        }
      }
    }
  });

  if (tipo === "preco") chartPreco = chart;
  else chartPvp = chart;
}

function filtrarGrafico(tipo, periodo) {
  // Atualizar botões ativos
  document.querySelectorAll(`.btn-periodo[data-chart="${tipo}"]`).forEach(btn => {
    btn.classList.toggle("ativo", btn.dataset.periodo === periodo);
  });

  if (tipo === "retorno") {
    renderizarGraficoRetorno(periodo);
    return;
  }
  if (tipo === "spread") {
    renderizarGraficoSpread(periodo);
    return;
  }
  const dados = tipo === "preco" ? dadosPrecoCompleto : dadosPvpCompleto;
  renderizarGrafico(tipo, dados, periodo);
}

// ─── ABAS ────────────────────────────────────────────────────────────────────

function trocarAba(aba) {
  document.querySelectorAll(".aba-btn").forEach(b => {
    b.classList.toggle("ativo", b.dataset.aba === aba);
  });
  document.getElementById("aba-mercado").style.display     = aba === "mercado" ? "block" : "none";
  document.getElementById("aba-operacional").style.display  = aba === "operacional" ? "block" : "none";

  if (aba === "operacional") {
    if (!chartPortfolio) renderizarPortfolio();
    if (!chartDpc) renderizarDpc();
    renderizarCarteiraCvm();
  }
}

// ─── GRÁFICO DE PIZZA — COMPOSIÇÃO DO PORTFOLIO ──────────────────────────────

const CORES_PORTFOLIO = [
  "#EF6300","#2563EB","#16A34A","#DC2626","#9333EA",
  "#0891B2","#D97706","#059669","#7C3AED","#DB2777",
  "#0284C7","#65A30D"
];

function renderizarPortfolio() {
  const canvas = document.getElementById("grafico-portfolio");
  const vazio  = document.getElementById("portfolio-vazio");
  if (!canvas) return;

  const dataRef = dadosPortfolio._data_ref || null;
  const entries = Object.entries(dadosPortfolio).filter(([k, v]) => k !== "_data_ref" && v > 0);
  if (!entries.length) {
    canvas.style.display = "none";
    vazio.style.display = "block";
    return;
  }
  canvas.style.display = "block";
  vazio.style.display = "none";

  // Atualiza título com data de referência
  const tituloEl = canvas.closest(".grafico-box")?.querySelector("h2");
  if (tituloEl) {
    tituloEl.textContent = "Composição do Portfolio" + (dataRef ? " — Ref. " + dataRef : "");
  }

  const total = entries.reduce((s, [, v]) => s + v, 0);
  const labels = entries.map(([k]) => k);
  const dados  = entries.map(([, v]) => parseFloat((v / total * 100).toFixed(2)));
  const cores  = labels.map((_, i) => CORES_PORTFOLIO[i % CORES_PORTFOLIO.length]);

  if (chartPortfolio) chartPortfolio.destroy();

  chartPortfolio = new Chart(canvas.getContext("2d"), {
    type: "pie",
    plugins: [ChartDataLabels],
    data: {
      labels,
      datasets: [{
        data: dados,
        backgroundColor: cores,
        borderColor: "#fff",
        borderWidth: 2,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: true, position: "bottom", labels: { font: { size: 12 }, padding: 16 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}%`
          }
        },
        datalabels: {
          color: "#fff",
          font: { size: 11, weight: "700" },
          textAlign: "center",
          formatter: (value) => value >= 3 ? value.toFixed(1) + "%" : "",
          display: ctx => ctx.dataset.data[ctx.dataIndex] >= 3
        }
      }
    }
  });
}

// ─── GRÁFICO DE BARRAS — DIVIDENDOS POR COTA ────────────────────────────────

const MESES_PT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

function renderizarDpc() {
  const canvas = document.getElementById("grafico-dpc");
  const vazio  = document.getElementById("dpc-vazio");
  if (!canvas) return;

  const ultimos = dadosDpcCompleto.slice(-12);
  if (!ultimos.length) {
    canvas.style.display = "none";
    vazio.style.display = "block";
    return;
  }
  canvas.style.display = "block";
  vazio.style.display = "none";

  const labels = ultimos.map(([d]) => {
    const [a, m] = d.split("-");
    return MESES_PT[parseInt(m) - 1] + "/" + a.slice(2);
  });
  const valores = ultimos.map(([, v]) => v);

  if (chartDpc) chartDpc.destroy();

  chartDpc = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Dividendo/cota (R$)",
        data: valores,
        backgroundColor: "rgba(239,99,0,0.85)",
        borderColor: "rgba(239,99,0,1)",
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        datalabels: {
          anchor: "end",
          align: "top",
          color: "var(--texto)",
          font: { size: 11, weight: "600" },
          formatter: v => "R$ " + v.toFixed(2)
        },
        tooltip: {
          callbacks: {
            label: ctx => " R$ " + ctx.parsed.y.toFixed(4)
          }
        }
      },
      scales: {
        x: { ticks: { font: { size: 11 } }, grid: { display: false } },
        y: {
          ticks: { font: { size: 11 }, callback: v => "R$ " + v.toFixed(2) },
          grid: { color: "rgba(0,0,0,0.05)" },
          min: Math.max(0, Math.min(...valores) * 0.85),
          suggestedMax: Math.max(...valores) * 1.05
        }
      }
    }
  });
}

// ─── CARTEIRA TRIMESTRAL CVM — ACCORDIONS ────────────────────────────────────

function renderizarCarteiraCvm() {
  const section = document.getElementById("carteira-cvm-section");
  const ativos = dadosCarteiraCvm.ativos || [];
  const imoveis = dadosCarteiraCvm.imoveis || [];
  const dataRefAt = dadosCarteiraCvm.data_ref_ativos || dadosCarteiraCvm.data_ref || "";
  const dataRefIm = dadosCarteiraCvm.data_ref_imoveis || dadosCarteiraCvm.data_ref || "";

  if (!ativos.length && !imoveis.length) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";

  const fmtR = v => v != null ? "R$ " + v.toLocaleString("pt-BR", {minimumFractionDigits:0, maximumFractionDigits:0}) : "—";
  const fmtPct = v => v != null ? (v * 100).toFixed(1) + "%" : "—";
  const fmtData = d => {
    if (!d) return "";
    const [a,m,dd] = d.split("-");
    return `${dd}/${m}/${a}`;
  };

  // Calcula valor total do portfolio (pizza)
  const portfolioEntries = Object.entries(dadosPortfolio).filter(([k, v]) => k !== "_data_ref" && v > 0);
  const totalPortfolio = portfolioEntries.reduce((s, [, v]) => s + v, 0);

  // Agrupa ativos por tipo
  const porTipo = {};
  ativos.forEach(a => {
    porTipo[a.tipo] = porTipo[a.tipo] || [];
    porTipo[a.tipo].push(a);
  });
  for (const t in porTipo) porTipo[t].sort((a, b) => (b.valor || 0) - (a.valor || 0));

  // Título
  const dataRef = dataRefAt || dataRefIm;
  document.getElementById("carteira-cvm-titulo").textContent = "Carteira Detalhada — Ref. " + fmtData(dataRef);

  const container = document.getElementById("carteira-cvm-accordions");
  let html = "";

  // Função para mapear tipo CVM → categoria da pizza
  function pctDoPortfolio(tipo) {
    const mapa = {
      "CRI/CRA": "CRI/CRA", "CRI": "CRI/CRA",
      "FII": "Cotas de FIIs",
      "Outras Cotas de FI": "Cotas de FIIs",
      "FIP": "Cotas de FIIs",
      "FIDC": "FIDCs",
      "LCI/LCA": "CRI/CRA", "LCI": "CRI/CRA", "LCA": "CRI/CRA", "LIG": "CRI/CRA",
      "Outros Ativos Financeiros": "Outros",
      "Ações de Sociedades": "Ações/Cotas em Sociedades",
      "Cotas de Sociedades": "Ações/Cotas em Sociedades",
      "Ações": "Ações/Cotas em Sociedades",
    };
    const cat = mapa[tipo];
    if (!cat || totalPortfolio <= 0) return null;
    const val = dadosPortfolio[cat];
    return val ? val / totalPortfolio : null;
  }

  // Accordion para cada tipo de ativo financeiro
  for (const [tipo, lista] of Object.entries(porTipo)) {
    const totalTipo = lista.reduce((s, a) => s + (a.valor || 0), 0);
    const pct = pctDoPortfolio(tipo);
    const id = "acc-" + tipo.replace(/[^\w]/g, "");

    const isCRI = tipo.includes("CRI") || tipo.includes("CRA") || tipo.includes("LCI") || tipo.includes("LIG");

    html += `<div class="carteira-accordion">
      <div class="carteira-accordion-header" onclick="toggleAccordion('${id}')">
        <div class="carteira-accordion-left">
          <span class="carteira-accordion-seta">&#9654;</span>
          <span class="carteira-accordion-tipo">${tipo}</span>
          <span class="carteira-accordion-count">(${lista.length} ativos)</span>
        </div>
        <div class="carteira-accordion-right">
          <span class="carteira-accordion-valor">${fmtR(totalTipo)}</span>
          <span class="carteira-accordion-pct">${pct != null ? fmtPct(pct) : "—"}</span>
        </div>
      </div>
      <div class="carteira-accordion-body" id="${id}">
        <table>
          <thead><tr>
            ${isCRI ? '<th>Nome</th><th>Emissor</th><th>Série</th><th>Emissão</th>' : '<th>Emissor</th><th>Nome</th>'}
            <th>Vencimento</th>
            <th class="num">Valor (R$)</th>
          </tr></thead>
          <tbody>`;
    lista.forEach(a => {
      html += `<tr>
        ${isCRI
          ? `<td style="font-weight:600;color:var(--navy)">${a.nome_cri || "—"}</td><td>${a.emissor || "—"}</td><td>${a.serie || "—"}</td><td>${a.emissao || "—"}</td>`
          : `<td>${a.emissor || "—"}</td><td>${a.nome || a.emissor || "—"}</td>`}
        <td>${fmtData(a.vencimento)}</td>
        <td class="num">${fmtR(a.valor)}</td>
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
  }

  // Accordion para imóveis
  if (imoveis.length) {
    const pctImoveis = totalPortfolio > 0 && dadosPortfolio["Imóveis"]
      ? dadosPortfolio["Imóveis"] / totalPortfolio : null;
    const totalImoveis = dadosPortfolio["Imóveis"] || null;
    const id = "acc-imoveis";

    html += `<div class="carteira-accordion">
      <div class="carteira-accordion-header" onclick="toggleAccordion('${id}')">
        <div class="carteira-accordion-left">
          <span class="carteira-accordion-seta">&#9654;</span>
          <span class="carteira-accordion-tipo">Imóveis</span>
          <span class="carteira-accordion-count">(${imoveis.length} imóveis — Ref. ${fmtData(dataRefIm)})</span>
        </div>
        <div class="carteira-accordion-right">
          <span class="carteira-accordion-valor">${totalImoveis ? fmtR(totalImoveis) : "—"}</span>
          <span class="carteira-accordion-pct">${pctImoveis != null ? fmtPct(pctImoveis) : "—"}</span>
        </div>
      </div>
      <div class="carteira-accordion-body" id="${id}">
        <table>
          <thead><tr>
            <th>Nome</th>
            <th>UF</th>
            <th class="num">Participação</th>
            <th class="num">ABL (m²)</th>
            <th class="num">Vacância</th>
          </tr></thead>
          <tbody>`;
    const UFS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];
    imoveis.forEach(im => {
      const end = (im.endereco || "").toUpperCase();
      const uf = UFS.find(u => new RegExp("\\b" + u + "\\b").test(end)) || "—";
      html += `<tr>
        <td>${im.nome || "—"}</td>
        <td>${uf}</td>
        <td class="num">${fmtPct(im.pct_total)}</td>
        <td class="num">${im.area != null ? im.area.toLocaleString("pt-BR") : "—"}</td>
        <td class="num">${fmtPct(im.vacancia)}</td>
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
  }

  container.innerHTML = html;
}

function toggleAccordion(id) {
  const body = document.getElementById(id);
  const header = body?.previousElementSibling;
  if (!body) return;
  const aberto = body.classList.toggle("aberto");
  if (header) header.classList.toggle("aberto", aberto);
}

carregarFii();
