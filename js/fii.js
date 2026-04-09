const params = new URLSearchParams(window.location.search);
const ticker = params.get("ticker");

let chartPreco = null;
let chartPvp = null;
let dadosPrecoCompleto = [];
let dadosPvpCompleto = [];

const PRICES_URL = "https://raw.githubusercontent.com/brunoburthf/imobdatafii/master/prices.json";

if (!ticker) {
  window.location.href = "fiis.html";
}

document.title = ticker + " — ImobData";

async function carregarFii() {
  try {
    const [resp, respPrecos] = await Promise.all([
      fetch("data/fiis/" + encodeURIComponent(ticker) + ".json"),
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

  const indexResp = fetch("data/index.json")
    .then(r => r.json())
    .then(idx => {
      if (idx.atualizado_em) {
        document.getElementById("ultima-atualizacao").textContent = "Atualizado em " + idx.atualizado_em;
      }
    }).catch(() => {});

  dadosPrecoCompleto = data.historico_preco || [];
  dadosPvpCompleto = data.historico_pvp || [];

  renderizarGrafico("preco", dadosPrecoCompleto, "1A");
  renderizarGrafico("pvp", dadosPvpCompleto, "1A");
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
  const cor = tipo === "preco" ? "rgba(236,112,0,1)" : "#0e9f6e";
  const label = tipo === "preco" ? "Preço (R$)" : "P/VP";

  const ctx = document.getElementById(canvasId).getContext("2d");

  if (tipo === "preco" && chartPreco) chartPreco.destroy();
  if (tipo === "pvp" && chartPvp) chartPvp.destroy();

  const datasets = [{
    label,
    data: valores,
    borderColor: cor,
    backgroundColor: cor + "18",
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

  const dados = tipo === "preco" ? dadosPrecoCompleto : dadosPvpCompleto;
  renderizarGrafico(tipo, dados, periodo);
}

carregarFii();
