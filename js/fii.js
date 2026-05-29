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
let dadosPrecoCorpCompleto = [];
let dadosDyCompleto = [];
let dadosSpreadCompleto = [];
let dadosFiiNome = "";
let dadosPortfolio = {};
let dadosDpcCompleto = [];
let dadosCarteiraCvm = {};
let cdiMapa = {};

const SPREAD_NTNB_ANOS = 5;

// Cache-bust por minuto via funcao (ao inves de constante) pra que o polling
// pegue versoes novas do GH Action de precos (a cada 5 min).
function urlPrecos() {
  return "https://raw.githubusercontent.com/brunoburthf/imobdatafii/master/prices.json?t=" + Math.floor(Date.now() / 60000);
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let _dadosFii = null;  // referencia global pro polling

if (!ticker) {
  window.location.href = "fiis.html";
}

document.title = ticker + " — ImobData";

// Aplica precos.json em data.dados (mutacao in-place): Preco, Variacao, P/VP.
function aplicarPrecosLive(dados, precos) {
  if (!precos || !precos.precos) return false;
  if (precos.precos?.[ticker] != null) dados["Preço Atual"] = precos.precos[ticker];
  if (precos.variacoes?.[ticker] != null) dados["Variação Dia"] = precos.variacoes[ticker];
  const vp = dados["VP/cota"];
  if (vp && vp > 0 && typeof dados["Preço Atual"] === "number") {
    dados["P/VP"] = dados["Preço Atual"] / vp;
  }
  return true;
}

async function fetchPrecosLive() {
  try {
    const r = await fetch(urlPrecos());
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Le data/taxas.json (cache global por sessao) e devolve a entrada do ticker
// pedido. Devolve null se nao houver dado.
let _taxasCachePromise = null;
async function fetchTaxasTicker(tk) {
  if (!_taxasCachePromise) {
    _taxasCachePromise = fetch("data/taxas.json")
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  }
  const doc = await _taxasCachePromise;
  if (!doc || !doc.taxas) return null;
  return doc.taxas[tk] || null;
}

function renderTaxas(t) {
  const elAdm   = document.getElementById("card-adm");
  const elPerf  = document.getElementById("card-perf");
  const elBadge = document.getElementById("taxas-conf-badge");
  if (!elAdm) return;
  if (!t) {
    elAdm.textContent = "—";
    elPerf.textContent = "Sem dado";
    elPerf.title = "data/taxas.json não tem entrada pra esse ticker";
    return;
  }
  // Admin
  if (t.adm_pct != null) {
    const tipo = t.adm_tipo === "efetiva" ? " (efetiva)" : "";
    elAdm.textContent = fmtPctTaxa(t.adm_pct) + tipo;
    elAdm.title = t.adm_obs || "";
  } else {
    elAdm.textContent = "—";
    elAdm.title = "Admin não extraído na fnet (revisar overrides)";
  }
  // Performance
  if (t.perf === true) {
    let txt = "+ perf";
    if (t.perf_pct != null) txt += " " + t.perf_pct + "%";
    if (t.perf_bench)       txt += " " + t.perf_bench;
    elPerf.textContent = txt;
    elPerf.title = t.perf_txt || "";
    elPerf.className = "card-sub card-sub-perf";
  } else if (t.perf === false) {
    elPerf.textContent = "Sem performance";
    elPerf.title = "";
    elPerf.className = "card-sub card-sub-noperf";
  } else {
    elPerf.textContent = "Performance ?";
    elPerf.title = "Indeterminado — fnet não trouxe sinal claro";
    elPerf.className = "card-sub card-sub-unknown";
  }
  // Badge de confianca
  if (t.conf && t.conf !== "alta") {
    elBadge.style.display = "";
    elBadge.textContent = t.conf;
    elBadge.className = "taxas-conf-badge conf-" + t.conf;
    elBadge.title = "Confiança da extração (verde=alta, amarelo=média, etc)";
  } else {
    elBadge.style.display = "none";
  }
}

function fmtPctTaxa(v) {
  if (v == null) return "—";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "% a.a.";
}

async function carregarFii() {
  try {
    const [resp, precos, taxas] = await Promise.all([
      fetch("data/fiis/" + encodeURIComponent(ticker) + ".json?v=" + Date.now()),
      fetchPrecosLive(),
      fetchTaxasTicker(ticker),
    ]);

    if (!resp.ok) throw new Error("Dados não encontrados para " + ticker);
    const data = await resp.json();
    _dadosFii = data;

    if (precos) aplicarPrecosLive(data.dados || {}, precos);

    renderizarFii(data);
    renderTaxas(taxas);

    document.getElementById("loading").style.display = "none";
    document.getElementById("fii-main").style.display = "block";

    iniciarPollingPrecos();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

// Atualiza apenas os cards de topo (Preco, Variacao, P/VP, DY, Retornos, Div).
// Nao re-renderiza graficos — eles ficam estaveis ate o user dar F5.
function renderTopCards(d) {
  document.getElementById("fii-preco").textContent = fmt(d["Preço Atual"], "preco");

  const varEl = document.getElementById("fii-variacao");
  const variacao = d["Variação Dia"];
  if (varEl && variacao != null) {
    const sinal = variacao >= 0 ? "+" : "";
    varEl.textContent = sinal + variacao.toFixed(2) + "%";
    varEl.className = "fii-variacao " + (variacao >= 0 ? "positivo" : "negativo");
  }

  document.getElementById("card-pvp").textContent = fmt(d["P/VP"], "pvp");
  document.getElementById("card-dy").textContent = fmt(d["DY a.a."], "pct");
  document.getElementById("card-div").textContent = fmt(d["Último Dividendo Pago"], "div");

  const mtdEl = document.getElementById("card-mtd");
  if (mtdEl) {
    mtdEl.textContent = fmt(d["Retorno - MTD"], "pct");
    mtdEl.className = "card-value " + classeRetorno(d["Retorno - MTD"]);
  }
  const m12El = document.getElementById("card-12m");
  if (m12El) {
    m12El.textContent = fmt(d["Retorno - 12M"], "pct");
    m12El.className = "card-value " + classeRetorno(d["Retorno - 12M"]);
  }
}

let _pollingHandle = null;
function iniciarPollingPrecos() {
  if (_pollingHandle) return;

  const refresh = async () => {
    if (!_dadosFii) return;
    const precos = await fetchPrecosLive();
    if (!precos) return;
    aplicarPrecosLive(_dadosFii.dados || {}, precos);
    renderTopCards(_dadosFii.dados || {});
  };

  _pollingHandle = setInterval(refresh, REFRESH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
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
  // Preco nominal split + amort-ajustado (sem reinvestir dividendos). Mantem
  // preco atual = mercado, sem degraus em split. Fallback pra nominal puro.
  dadosPrecoCorpCompleto = (data.historico_preco_corp_adj && data.historico_preco_corp_adj.length)
    ? data.historico_preco_corp_adj
    : (data.historico_preco || []);
  dadosDyCompleto = data.historico_dy || [];
  dadosPortfolio = data.portfolio || {};
  dadosDpcCompleto = data.historico_dpc || [];
  dadosCarteiraCvm = data.carteira_trimestral || {};
  dadosFiiNome = (data.dados && data.dados["Nome"]) || "";

  // Grafico de preco usa serie corp_adj (nominal ajustado por splits e
  // amortizacoes via back-adjust com razao observada). Mantem preco atual
  // = mercado, ajusta retroativamente pra remover degraus em ex-days.
  renderizarGrafico("preco", dadosPrecoCorpCompleto, "1A");
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
  const dados = tipo === "preco" ? dadosPrecoCorpCompleto : dadosPvpCompleto;
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
    renderizarKpisOperacionais();
    if (!chartPortfolio) renderizarPortfolio();
    if (!chartDpc) renderizarDpc();
    // Garante lookup nome→ticker antes de renderizar carteira (pra exibir
    // ticker dos FIIs investidos em FOFs/FIIs com participação cruzada).
    _carregarTickerPorNome().then(() => renderizarCarteiraCvm());
  }
}

// ─── LOOKUP nome → ticker (pra exibir ticker dos FIIs investidos na carteira)
let _tickerPorNomeCache = null;
function _normNomeFii(s) {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // remove acentos
    .toUpperCase()
    // remove sufixos comuns mesmo truncados ("FUNDO DE INVESTIMENTO IMOBI...")
    .replace(/F(?:UNDO?)?S?\.?\s+(?:DE\s+)?INV(?:EST(?:IMENTOS?)?)?\.?\s+IMOBIL?(?:I[AÁ]?(?:RIOS?)?)?\.?/gi, "")
    .replace(/\bFII\b/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
async function _carregarTickerPorNome() {
  if (_tickerPorNomeCache) return _tickerPorNomeCache;
  const fontes = await Promise.all([
    fetch("data/index.json").then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/infra_index.json").then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/agro_index.json").then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  const map = {};
  for (const f of fontes) {
    if (!f) continue;
    const lista = f.fiis || f.fundos || [];
    for (const x of lista) {
      const t = x.Ticker || x.ticker;
      const n = x.Nome || x.nome;
      if (t && n) {
        const key = _normNomeFii(n);
        if (key) map[key] = t;
      }
    }
  }
  _tickerPorNomeCache = map;
  return map;
}
function _acharTickerInv(emissor) {
  if (!emissor) return null;
  // 1) Emissor já vem com ticker no início ("XXXX11 - blah")
  const m = emissor.match(/\b([A-Z]{4}1[12])\b/);
  if (m) return m[1];
  // 2) Match por nome normalizado (ou substring forte)
  if (!_tickerPorNomeCache) return null;
  const norm = _normNomeFii(emissor);
  if (!norm) return null;
  if (_tickerPorNomeCache[norm]) return _tickerPorNomeCache[norm];
  // Substring (fundos com nome truncado pelo CVM)
  for (const k in _tickerPorNomeCache) {
    if (k.length >= 8 && (k.startsWith(norm) || norm.startsWith(k))) {
      return _tickerPorNomeCache[k];
    }
  }
  return null;
}
function _ehTipoFii(tipo) {
  return /\bFII\b|Cotas? de FI|FIP\b/i.test(tipo || "");
}

// ─── KPIs OPERACIONAIS (TOPO DA ABA) ─────────────────────────────────────────

const UFS_BR = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];
function _detectarUF(endereco) {
  const e = (endereco || "").toUpperCase();
  return UFS_BR.find(u => new RegExp("\\b" + u + "\\b").test(e)) || null;
}

function _fmtR(v, decimais = 0) {
  if (v == null || isNaN(v)) return "—";
  if (Math.abs(v) >= 1e9) return "R$ " + (v / 1e9).toFixed(2) + " bi";
  if (Math.abs(v) >= 1e6) return "R$ " + (v / 1e6).toFixed(1) + " mi";
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: decimais, maximumFractionDigits: decimais });
}
function _fmtPct(v, dec = 1) {
  return v != null && !isNaN(v) ? (v * 100).toFixed(dec) + "%" : "—";
}

function renderizarKpisOperacionais() {
  const container = document.getElementById("kpis-operacionais");
  if (!container) return;

  const ativos = (dadosCarteiraCvm.ativos || []);
  const imoveis = (dadosCarteiraCvm.imoveis || []);
  // PL total = soma do portfolio (categorias agregadas) + caixa
  const portEntries = Object.entries(dadosPortfolio).filter(([k, v]) => k !== "_data_ref" && v > 0);
  const plTotal = portEntries.reduce((s, [, v]) => s + v, 0);

  const cris = ativos.filter(a => /CRI|CRA|LCI|LIG/.test(a.tipo || ""));

  const kpis = [];

  if (plTotal > 0) {
    kpis.push({
      label: "PL Total", valor: _fmtR(plTotal),
      icone: "💰", cor: "azul",
      help: "Patrimônio total do fundo (soma dos ativos da carteira)"
    });
  }

  // KPIs específicos pra FII de papel (CRI/CRA dominante)
  const valorCris = cris.reduce((s, a) => s + (a.valor || 0), 0);
  if (cris.length >= 5 && valorCris > 0.3 * plTotal) {
    kpis.push({
      label: "Nº de CRIs", valor: cris.length,
      icone: "📄", cor: "navy",
      help: `Quantidade de CRIs/CRAs distintos na carteira (valor total: ${_fmtR(valorCris)})`
    });
    const porDevedor = {};
    cris.forEach(a => {
      const k = a.nome_cri || a.emissor || "—";
      porDevedor[k] = (porDevedor[k] || 0) + (a.valor || 0);
    });
    const ranking = Object.entries(porDevedor).sort((a, b) => b[1] - a[1]);
    if (ranking.length) {
      const [topNome, topVal] = ranking[0];
      const top5 = ranking.slice(0, 5).reduce((s, [, v]) => s + v, 0);
      kpis.push({
        label: "Top devedor",
        valor: topNome.length > 22 ? topNome.slice(0, 20) + "…" : topNome,
        sub: _fmtPct(topVal / valorCris) + " da carteira de CRI",
        icone: "🏛️", cor: "laranja",
        help: `Maior exposição: ${topNome} (${_fmtR(topVal)})`
      });
      kpis.push({
        label: "Top 5 devedores",
        valor: _fmtPct(top5 / valorCris),
        sub: "concentração",
        icone: "📊", cor: "roxo",
        help: "Soma das 5 maiores exposições por devedor (sobre a carteira de CRI)"
      });
    }
  }

  // KPIs específicos pra FII de tijolo (imóveis)
  if (imoveis.length) {
    kpis.push({
      label: "Nº de imóveis", valor: imoveis.length,
      icone: "🏢", cor: "navy",
      help: "Quantidade de imóveis físicos no portfolio"
    });
    const ablTotal = imoveis.reduce((s, i) => s + (i.area || 0), 0);
    if (ablTotal > 0) {
      kpis.push({
        label: "ABL total",
        valor: ablTotal.toLocaleString("pt-BR", { maximumFractionDigits: 0 }),
        sub: "m² locáveis",
        icone: "📐", cor: "azul",
        help: "Área Bruta Locável somada de todos os imóveis"
      });
      const ablOcupado = imoveis.reduce((s, i) =>
        s + (i.area || 0) * (1 - (i.vacancia || 0)), 0);
      const vacanciaPond = 1 - ablOcupado / ablTotal;
      kpis.push({
        label: "Vacância média",
        valor: _fmtPct(vacanciaPond),
        sub: "ponderada por ABL",
        icone: vacanciaPond > 0.10 ? "⚠️" : "✓",
        cor: vacanciaPond > 0.10 ? "vermelho" : "verde",
        help: "Vacância média ponderada pela área de cada imóvel"
      });
    }
    const ufs = new Set(imoveis.map(i => _detectarUF(i.endereco)).filter(Boolean));
    if (ufs.size) {
      kpis.push({
        label: "Estados (UF)",
        valor: ufs.size,
        sub: [...ufs].sort().slice(0, 4).join(", ") + (ufs.size > 4 ? "…" : ""),
        icone: "🗺️", cor: "verde",
        help: "Quantidade de UFs onde o fundo tem imóveis"
      });
    }
  }

  if (!kpis.length) {
    container.style.display = "none";
    return;
  }

  container.style.display = "grid";
  container.innerHTML = kpis.map(k => `
    <div class="kpi-card kpi-${k.cor || "azul"}" ${k.help ? `title="${k.help.replace(/"/g, "&quot;")}"` : ""}>
      <div class="kpi-icone">${k.icone || ""}</div>
      <div class="kpi-conteudo">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-valor">${k.valor}</div>
        ${k.sub ? `<div class="kpi-sub">${k.sub}</div>` : ""}
      </div>
    </div>
  `).join("");
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
    const isFii = !isCRI && _ehTipoFii(tipo);

    // Consolida CRIs com mesma (nome_cri, serie, emissao): soma valor e
    // quantidade, mantem demais campos da primeira ocorrencia.
    // Conservador: so consolida quando nome_cri esta preenchido. Sem nome
    // confiavel (CVM as vezes traz emissao=0 sem devedor), mantem linhas
    // separadas pra evitar somar CRIs distintos por engano.
    let listaRender = lista;
    if (isCRI) {
      const grupos = new Map();
      const semChave = [];
      lista.forEach(a => {
        if (!a.nome_cri) {
          semChave.push(a);
          return;
        }
        const k = `${a.nome_cri}|${a.serie || ""}|${a.emissao || ""}`;
        if (grupos.has(k)) {
          const g = grupos.get(k);
          g.valor = (g.valor || 0) + (a.valor || 0);
          if (a.quantidade != null) g.quantidade = (g.quantidade || 0) + a.quantidade;
        } else {
          grupos.set(k, { ...a });
        }
      });
      listaRender = [...Array.from(grupos.values()), ...semChave]
        .sort((a, b) => (b.valor || 0) - (a.valor || 0));
    }
    const countLabel = isCRI && listaRender.length !== lista.length
      ? `${listaRender.length} ativos / ${lista.length} linhas`
      : `${lista.length} ativos`;

    html += `<div class="carteira-accordion">
      <div class="carteira-accordion-header" onclick="toggleAccordion('${id}')">
        <div class="carteira-accordion-left">
          <span class="carteira-accordion-seta">&#9654;</span>
          <span class="carteira-accordion-tipo">${tipo}</span>
          <span class="carteira-accordion-count">(${countLabel})</span>
        </div>
        <div class="carteira-accordion-right">
          <span class="carteira-accordion-valor">${fmtR(totalTipo)}</span>
          <span class="carteira-accordion-pct">${pct != null ? fmtPct(pct) : "—"}</span>
        </div>
      </div>
      <div class="carteira-accordion-body" id="${id}">
        <div class="tabela-toolbar">
          <input type="text" class="tabela-busca" placeholder="🔍 Filtrar nesta tabela..." oninput="filtrarTabelaAccordion('${id}', this.value)" />
        </div>
        <table data-acc-id="${id}">
          <thead><tr>
            ${isCRI
              ? `<th data-col="nome_cri" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'nome_cri', 'str')" title="Devedor / nome do CRI">Nome <span class="sort-icon">↕</span></th><th data-col="emissor" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'emissor', 'str')" title="Securitizadora — companhia que emitiu o CRI">Emissor <span class="sort-icon">↕</span></th><th data-col="serie" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'serie', 'str')" title="Série da emissão (cada emissão pode ter várias séries com perfis diferentes)">Série <span class="sort-icon">↕</span></th><th data-col="emissao" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'emissao', 'str')" title="Número da emissão">Emissão <span class="sort-icon">↕</span></th><th data-col="taxa" data-tipo="str" title="Indexador e spread (ex: CDI+1,5%, IPCA+6%)">Taxa</th>`
              : isFii
                ? `<th data-col="ticker_inv" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'ticker_inv', 'str')" title="Ticker B3 do FII investido">Ticker <span class="sort-icon">↕</span></th><th data-col="emissor" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'emissor', 'str')" title="Nome do FII investido">Nome <span class="sort-icon">↕</span></th>`
                : `<th data-col="emissor" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'emissor', 'str')">Emissor <span class="sort-icon">↕</span></th><th data-col="nome" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'nome', 'str')">Nome <span class="sort-icon">↕</span></th>`}
            <th data-col="vencimento" data-tipo="data" onclick="ordenarTabelaAccordion('${id}', 'vencimento', 'data')" title="Data de vencimento do título">Vencimento <span class="sort-icon">↕</span></th>
            <th class="num" data-col="valor" data-tipo="num" onclick="ordenarTabelaAccordion('${id}', 'valor', 'num')" title="Valor de mercado em R$">Valor (R$) <span class="sort-icon">↕</span></th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div></div>`;
    // Anota ticker_inv pros accordions de FII (lookup nome→ticker)
    if (isFii) {
      listaRender = listaRender.map(a => ({ ...a, ticker_inv: _acharTickerInv(a.emissor) || "" }));
    }
    _accordionState[id] = {
      lista: listaRender,
      isCRI, isFii,
      busca: "",
      sortCol: "valor",
      sortDir: "desc",
    };
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
        <div class="tabela-toolbar">
          <input type="text" class="tabela-busca" placeholder="🔍 Filtrar nesta tabela..." oninput="filtrarTabelaAccordion('${id}', this.value)" />
        </div>
        <table data-acc-id="${id}">
          <thead><tr>
            <th data-col="nome" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'nome', 'str')">Nome <span class="sort-icon">↕</span></th>
            <th data-col="uf" data-tipo="str" onclick="ordenarTabelaAccordion('${id}', 'uf', 'str')">UF <span class="sort-icon">↕</span></th>
            <th class="num" data-col="pct_total" data-tipo="num" onclick="ordenarTabelaAccordion('${id}', 'pct_total', 'num')" title="Participação do imóvel sobre a carteira total">Participação <span class="sort-icon">↕</span></th>
            <th class="num" data-col="area" data-tipo="num" onclick="ordenarTabelaAccordion('${id}', 'area', 'num')" title="ABL = Área Bruta Locável (área disponível para locação)">ABL (m²) <span class="sort-icon">↕</span></th>
            <th class="num" data-col="vacancia" data-tipo="num" onclick="ordenarTabelaAccordion('${id}', 'vacancia', 'num')" title="Percentual da área não locada nesse imóvel">Vacância <span class="sort-icon">↕</span></th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div></div>`;
    // Pré-anota UF em cada imóvel pra ordenar/buscar por essa coluna
    const imoveisAnot = imoveis.map(im => ({ ...im, uf: _detectarUF(im.endereco) || "—" }));
    _accordionState[id] = {
      lista: imoveisAnot,
      isImovel: true,
      busca: "",
      sortCol: "pct_total",
      sortDir: "desc",
    };
  }

  container.innerHTML = html;
  // Renderiza tbody de cada accordion já filtrado/ordenado
  Object.keys(_accordionState).forEach(id => _renderAccordionTbody(id));
}

// Estado por accordion: { lista, isCRI?, isImovel?, busca, sortCol, sortDir }
const _accordionState = {};

function _renderAccordionTbody(id) {
  const st = _accordionState[id];
  if (!st) return;
  const tbody = document.querySelector(`table[data-acc-id="${id}"] tbody`);
  if (!tbody) return;

  const fmtR = v => v != null ? "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : "—";
  const fmtPct = v => v != null ? (v * 100).toFixed(1) + "%" : "—";
  const fmtData = d => {
    if (!d) return "";
    const [a, m, dd] = d.split("-");
    return `${dd}/${m}/${a}`;
  };
  const limpaSec = s => (s || "").replace(/^CRI_\S+\s*-\s*/, "").replace(/\s*-\s*\d{2}[A-Z]\d{5,}$/, "").replace(/\s+\d{2}[A-Z]\d{5,}$/, "").trim() || s;

  // Filtro
  let lista = st.lista;
  if (st.busca) {
    const q = st.busca.toLowerCase();
    lista = lista.filter(a => Object.values(a).some(v =>
      v != null && String(v).toLowerCase().includes(q)
    ));
  }

  // Ordenação
  const dir = st.sortDir === "asc" ? 1 : -1;
  lista = [...lista].sort((a, b) => {
    let va = a[st.sortCol], vb = b[st.sortCol];
    // pra "vencimento" usar vencimento_cri se disponivel
    if (st.sortCol === "vencimento") { va = a.vencimento_cri || a.vencimento; vb = b.vencimento_cri || b.vencimento; }
    if (va == null || va === "") return 1;   // vazios sempre no fim
    if (vb == null || vb === "") return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true }) * dir;
  });

  // Atualiza ícones das colunas
  const thead = document.querySelector(`table[data-acc-id="${id}"] thead`);
  thead?.querySelectorAll("th").forEach(th => {
    const ic = th.querySelector(".sort-icon");
    if (!ic) return;
    if (th.dataset.col === st.sortCol) ic.textContent = st.sortDir === "asc" ? "↑" : "↓";
    else ic.textContent = "↕";
  });

  // Render
  if (st.isImovel) {
    tbody.innerHTML = lista.map(im => `
      <tr>
        <td>${im.nome || "—"}</td>
        <td>${im.uf || "—"}</td>
        <td class="num">${fmtPct(im.pct_total)}</td>
        <td class="num">${im.area != null ? im.area.toLocaleString("pt-BR") : "—"}</td>
        <td class="num">${fmtPct(im.vacancia)}</td>
      </tr>`).join("") || `<tr><td colspan="5" style="text-align:center;color:var(--texto-suave)">Nenhum item.</td></tr>`;
  } else if (st.isCRI) {
    tbody.innerHTML = lista.map(a => `
      <tr>
        <td style="font-weight:600;color:var(--navy)">${a.nome_cri || "—"}</td>
        <td>${limpaSec(a.emissor)}</td>
        <td>${a.serie || "—"}</td>
        <td>${a.emissao || "—"}</td>
        <td style="white-space:nowrap">${a.taxa || "—"}</td>
        <td>${fmtData(a.vencimento_cri || a.vencimento)}</td>
        <td class="num">${fmtR(a.valor)}</td>
      </tr>`).join("") || `<tr><td colspan="7" style="text-align:center;color:var(--texto-suave)">Nenhum item.</td></tr>`;
  } else if (st.isFii) {
    tbody.innerHTML = lista.map(a => {
      // Tira o "TICKER -" do nome quando ja temos o ticker em coluna propria
      const nomeLimpo = a.ticker_inv
        ? (a.emissor || "").replace(new RegExp(`^${a.ticker_inv}\\s*-\\s*`, "i"), "")
        : (a.emissor || "—");
      return `<tr>
        <td>${a.ticker_inv ? `<a href="fii.html?ticker=${a.ticker_inv}" class="ticker-link">${a.ticker_inv}</a>` : '<span style="color:var(--texto-suave)">—</span>'}</td>
        <td>${nomeLimpo || "—"}</td>
        <td>${fmtData(a.vencimento_cri || a.vencimento)}</td>
        <td class="num">${fmtR(a.valor)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="4" style="text-align:center;color:var(--texto-suave)">Nenhum item.</td></tr>`;
  } else {
    tbody.innerHTML = lista.map(a => `
      <tr>
        <td>${a.emissor || "—"}</td>
        <td>${a.nome || a.emissor || "—"}</td>
        <td>${fmtData(a.vencimento_cri || a.vencimento)}</td>
        <td class="num">${fmtR(a.valor)}</td>
      </tr>`).join("") || `<tr><td colspan="4" style="text-align:center;color:var(--texto-suave)">Nenhum item.</td></tr>`;
  }
}

function filtrarTabelaAccordion(id, valor) {
  if (!_accordionState[id]) return;
  _accordionState[id].busca = valor || "";
  _renderAccordionTbody(id);
}

function ordenarTabelaAccordion(id, col, tipo) {
  const st = _accordionState[id];
  if (!st) return;
  if (st.sortCol === col) {
    st.sortDir = st.sortDir === "asc" ? "desc" : "asc";
  } else {
    st.sortCol = col;
    st.sortDir = (tipo === "num" || tipo === "data") ? "desc" : "asc";
  }
  _renderAccordionTbody(id);
}

function toggleAccordion(id) {
  const body = document.getElementById(id);
  const header = body?.previousElementSibling;
  if (!body) return;
  const aberto = body.classList.toggle("aberto");
  if (header) header.classList.toggle("aberto", aberto);
}

// ─── DOWNLOAD DA CARTEIRA EM EXCEL ───────────────────────────────────────────
let _sheetJsCarregandoFii = null;
async function _carregarSheetJsFii() {
  if (window.XLSX) return;
  if (_sheetJsCarregandoFii) return _sheetJsCarregandoFii;
  _sheetJsCarregandoFii = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => res();
    s.onerror = () => rej(new Error("Falha ao carregar SheetJS"));
    document.head.appendChild(s);
  });
  return _sheetJsCarregandoFii;
}

async function baixarCarteiraFiiExcel(btn) {
  const ativos = (dadosCarteiraCvm.ativos || []);
  const imoveis = (dadosCarteiraCvm.imoveis || []);
  if (!ativos.length && !imoveis.length) { alert("Nada a exportar."); return; }
  const textoOriginal = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "..."; }

  try {
    await _carregarSheetJsFii();

    const tk = (ticker || "").toUpperCase();
    const nome = dadosFiiNome || tk;
    const dataRef = dadosCarteiraCvm.data_ref_ativos || dadosCarteiraCvm.data_ref || "";

    const wb = XLSX.utils.book_new();

    // Aba 1: Ativos financeiros
    if (ativos.length) {
      const linhas = ativos.map(a => ({
        Tipo: a.tipo || "",
        "Nome do CRI / Ativo": a.nome_cri || a.nome || "",
        Emissor: a.emissor || "",
        Série: a.serie || "",
        Emissão: a.emissao || "",
        Taxa: a.taxa || "",
        Vencimento: a.vencimento_cri || a.vencimento || "",
        Quantidade: a.quantidade ?? null,
        "Valor (R$)": a.valor != null ? +a.valor.toFixed(2) : null,
      }));
      const cab = Object.keys(linhas[0]);
      const aoa = [
        [`Carteira Detalhada — ${tk} (${nome})`],
        [`Data de referência: ${dataRef}`],
        [`Total de ativos financeiros: ${ativos.length}`],
        [],
        cab,
        ...linhas.map(r => cab.map(c => r[c])),
      ];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{wch:18},{wch:32},{wch:32},{wch:8},{wch:10},{wch:18},{wch:14},{wch:14},{wch:18}];
      ws["!merges"] = [0,1,2].map(r => ({ s: { r, c: 0 }, e: { r, c: cab.length - 1 } }));
      XLSX.utils.book_append_sheet(wb, ws, "Ativos Financeiros");
    }

    // Aba 2: Imóveis
    if (imoveis.length) {
      const linhas = imoveis.map(im => ({
        Nome: im.nome || "",
        Endereço: im.endereco || "",
        UF: _detectarUF(im.endereco) || "",
        "ABL (m²)": im.area ?? null,
        "Vacância (%)": im.vacancia != null ? +(im.vacancia * 100).toFixed(2) : null,
        "Participação no portfolio (%)": im.pct_total != null ? +(im.pct_total * 100).toFixed(2) : null,
      }));
      const cab = Object.keys(linhas[0]);
      const aoa = [
        [`Imóveis — ${tk} (${nome})`],
        [`Data de referência: ${dadosCarteiraCvm.data_ref_imoveis || dataRef}`],
        [`Total de imóveis: ${imoveis.length}`],
        [],
        cab,
        ...linhas.map(r => cab.map(c => r[c])),
      ];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{wch:35},{wch:50},{wch:6},{wch:14},{wch:14},{wch:18}];
      ws["!merges"] = [0,1,2].map(r => ({ s: { r, c: 0 }, e: { r, c: cab.length - 1 } }));
      XLSX.utils.book_append_sheet(wb, ws, "Imóveis");
    }

    const dt = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `carteira_${tk}_${dt}.xlsx`);
  } catch (e) {
    alert("Erro ao gerar Excel: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
}

carregarFii();
