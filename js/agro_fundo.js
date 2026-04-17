const params = new URLSearchParams(window.location.search);
const ticker = params.get("ticker");

let chartPreco = null;
let chartPvp = null;
let chartRetorno = null;
let chartSpread = null;
let dadosPrecoCompleto = [];
let dadosPvpCompleto = [];
let dadosPrecoAdjCompleto = [];
let dadosDyCompleto = [];
let dadosSpreadCompleto = [];
let cdiMapa = {};

const SPREAD_NTNB_ANOS = 5;

if (!ticker) window.location.href = "agro.html";
document.title = ticker + " — ImobData";

async function carregar() {
  try {
    const resp = await fetch("data/agro/" + encodeURIComponent(ticker) + ".json?v=" + Date.now());
    if (!resp.ok) throw new Error("Dados não encontrados para " + ticker);
    const data = await resp.json();

    renderizar(data);

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

function classeRet(valor) {
  const n = parseFloat(valor);
  if (isNaN(n)) return "";
  return n >= 0 ? "positivo" : "negativo";
}

function renderizar(data) {
  const d = data.dados || {};

  document.getElementById("fii-ticker").textContent = ticker;
  document.getElementById("fii-nome").textContent = d["Nome"] || "";
  document.getElementById("fii-setor").textContent = d["Tipo"] || "";
  document.getElementById("fii-preco").textContent = fmt(d["Preço Atual"], "preco");

  const varEl = document.getElementById("fii-variacao");
  const variacao = d["Variação Dia"];
  if (variacao != null) {
    const sinal = variacao >= 0 ? "+" : "";
    varEl.textContent = sinal + variacao.toFixed(2) + "%";
    varEl.className = "fii-variacao " + (variacao >= 0 ? "positivo" : "negativo");
  }

  document.getElementById("card-pvp").textContent = fmt(d["P/VP"], "pvp");
  document.getElementById("card-dy").textContent  = fmt(d["DY a.a."], "pct");
  document.getElementById("card-div").textContent = fmt(d["Último Dividendo Pago"], "div");

  const mtdEl = document.getElementById("card-mtd");
  mtdEl.textContent = fmt(d["Retorno - MTD"], "pct");
  mtdEl.className = "card-value " + classeRet(d["Retorno - MTD"]);

  const m12El = document.getElementById("card-12m");
  m12El.textContent = fmt(d["Retorno - 12M"], "pct");
  m12El.className = "card-value " + classeRet(d["Retorno - 12M"]);

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

  fetch("data/agro_index.json?v=" + Date.now())
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if (j?.atualizado_em) document.getElementById("ultima-atualizacao").textContent = "Atualizado em " + j.atualizado_em;
    }).catch(() => {});

  dadosPrecoCompleto   = data.historico_preco || [];
  dadosPvpCompleto     = data.historico_pvp || [];
  dadosPrecoAdjCompleto = (data.historico_preco_adj && data.historico_preco_adj.length)
    ? data.historico_preco_adj
    : (data.historico_preco || []);
  dadosDyCompleto = data.historico_dy || [];

  renderizarGrafico("preco", dadosPrecoCompleto, "1A");
  renderizarGrafico("pvp", dadosPvpCompleto, "1A");

  // CDI
  const dataInicioCdi = new Date();
  dataInicioCdi.setFullYear(dataInicioCdi.getFullYear() - 10);
  buscarCDI(dataInicioCdi.toISOString().slice(0, 10)).then(mapa => {
    cdiMapa = mapa;
    renderizarGraficoRetorno("1A");
  });

  // NTN-B → spread
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
  const v = valores.filter(x => x != null);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
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
    label, data: valores, borderColor: cor, backgroundColor: corFundo,
    borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3
  }];
  if (tipo === "pvp") {
    const media = calcularMedia(valores);
    if (media !== null) datasets.push({
      label: `Média (${media.toFixed(2)}x)`, data: Array(labels.length).fill(media),
      borderColor: "#000", borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0
    });
  }

  const chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: tipo === "pvp", labels: { boxWidth: 20, font: { size: 12 } } },
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
          ticks: { maxTicksLimit: 8, maxRotation: 0, callback: (_, i) => labels[i] ? labels[i].slice(0, 7) : "" },
          grid: { display: false }
        },
        y: { ticks: { callback: v => tipo === "preco" ? "R$ " + v.toFixed(0) : v.toFixed(2) + "x" } }
      }
    }
  });

  if (tipo === "preco") chartPreco = chart; else chartPvp = chart;
}

function renderizarGraficoRetorno(periodo) {
  if (!dadosPrecoAdjCompleto.length) return;
  const filtrado = filtrarPorPeriodo(dadosPrecoAdjCompleto, periodo);
  if (filtrado.length < 2) return;

  const labels = filtrado.map(([d]) => d);
  const p0 = filtrado[0][1];
  const valoresFii = filtrado.map(([, p]) => p0 > 0 ? parseFloat(((p / p0 - 1) * 100).toFixed(4)) : 0);

  const valoresCdi = [0];
  let acum = 100;
  for (let i = 1; i < filtrado.length; i++) {
    const d = filtrado[i][0];
    const d0 = filtrado[i - 1][0];
    const taxa = cdiMapa[d] ?? cdiMapa[d0] ?? 0;
    acum *= (1 + taxa);
    valoresCdi.push(parseFloat((acum - 100).toFixed(4)));
  }

  const retFii = valoresFii.at(-1);
  const retCdi = valoresCdi.at(-1);
  const badge = document.getElementById("retorno-vs-cdi-badge");
  const valorEl = document.getElementById("retorno-vs-cdi-valor");
  if (badge && valorEl) {
    if (retCdi && Math.abs(retCdi) > 0.01) {
      const pct = (retFii / retCdi) * 100;
      valorEl.textContent = pct.toFixed(1) + "%";
      valorEl.style.color = pct >= 100 ? "rgb(14,159,110)" : (pct >= 0 ? "var(--azul-escuro)" : "rgb(220,38,38)");
      badge.style.display = "flex";
    } else badge.style.display = "none";
  }

  const corFii = valoresFii.at(-1) >= 0 ? "rgba(239,99,0,1)" : "#DC2626";
  const ctx = document.getElementById("grafico-retorno").getContext("2d");
  if (chartRetorno) chartRetorno.destroy();

  chartRetorno = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: ticker, data: valoresFii, borderColor: corFii,
          backgroundColor: corFii.replace("1)", "0.15)"), borderWidth: 2, pointRadius: 0, fill: true, tension: 0.2 },
        { label: "CDI", data: valoresCdi, borderColor: "rgb(0,9,60)", borderWidth: 1.5,
          borderDash: [5, 4], pointRadius: 0, fill: false, tension: 0.2 }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 20, font: { size: 12 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}%` } }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8, maxRotation: 0, callback: (_, i) => labels[i] ? labels[i].slice(0, 7) : "" }, grid: { display: false } },
        y: { ticks: { callback: v => v.toFixed(1) + "%" } }
      }
    }
  });
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
    for (const [d, val] of s) { if (d <= dt) v = val; else break; }
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
  const min = pontos[0].durAnos, max = pontos[pontos.length - 1].durAnos;
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
        { label: "Spread (pp)", data: valores, borderColor: "rgb(0,9,60)", backgroundColor: corArea,
          borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.2 },
        { label: `Média (${media >= 0 ? "+" : ""}${media.toFixed(2)}pp)`, data: mediaArr,
          borderColor: corLinhaMedia, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, fill: false }
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
        x: { ticks: { maxTicksLimit: 8, maxRotation: 0, callback: (_, i) => labels[i] ? labels[i].slice(0, 7) : "" }, grid: { display: false } },
        y: { ticks: { callback: v => (v >= 0 ? "+" : "") + v.toFixed(1) + "pp" } }
      }
    }
  });
}

function filtrarGrafico(tipo, periodo) {
  document.querySelectorAll(`.btn-periodo[data-chart="${tipo}"]`).forEach(btn => {
    btn.classList.toggle("ativo", btn.dataset.periodo === periodo);
  });
  if (tipo === "retorno") return renderizarGraficoRetorno(periodo);
  if (tipo === "spread")  return renderizarGraficoSpread(periodo);
  const dados = tipo === "preco" ? dadosPrecoCompleto : dadosPvpCompleto;
  renderizarGrafico(tipo, dados, periodo);
}

carregar();
