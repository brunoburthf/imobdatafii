/* spread.js — NTN-B Spread com duration constante via interpolação linear */

const COR_LINHA  = "rgba(239,99,0,1)";
const COR_FUNDO  = "rgba(239,99,0,0.08)";
const COR_NAVY   = "rgb(0,9,60)";

let dadosCompletos = [];   // [{date, ytm}]
let grafico = null;
let periodoAtivo = "1A";

async function inicializar() {
  const loadEl = document.getElementById("loading");
  const erroEl = document.getElementById("erro");
  const conteudoEl = document.getElementById("conteudo");

  try {
    const resp = await fetch("data/ntnb.json");
    if (!resp.ok) throw new Error("Arquivo ntnb.json não encontrado.");
    const dados = await resp.json();
    window._ntnbDados = dados;
    loadEl.style.display = "none";
    conteudoEl.style.display = "block";
  } catch (e) {
    loadEl.style.display = "none";
    erroEl.style.display = "block";
    erroEl.textContent = "Erro ao carregar dados NTN-B: " + e.message;
  }
}

function interpolarDia(ytmPorBond, durPorBond, targetAnos) {
  // Monta lista de {bond, ytm, durAnos} para essa data
  const pontos = [];
  for (const bond of Object.keys(ytmPorBond)) {
    const ytm = ytmPorBond[bond];
    const durDias = durPorBond[bond];
    if (ytm == null || durDias == null) continue;
    const durAnos = durDias / 365;
    pontos.push({ bond, ytm, durAnos });
  }
  if (pontos.length < 2) return null;
  pontos.sort((a, b) => a.durAnos - b.durAnos);

  const minDur = pontos[0].durAnos;
  const maxDur = pontos[pontos.length - 1].durAnos;
  if (targetAnos < minDur || targetAnos > maxDur) return null; // sem extrapolação

  // Encontrar bracket
  let low = null, high = null;
  for (let i = 0; i < pontos.length - 1; i++) {
    if (pontos[i].durAnos <= targetAnos && pontos[i + 1].durAnos >= targetAnos) {
      low = pontos[i];
      high = pontos[i + 1];
      break;
    }
  }
  if (!low || !high) return null;
  if (high.durAnos === low.durAnos) return low.ytm;

  return low.ytm + (targetAnos - low.durAnos) / (high.durAnos - low.durAnos) * (high.ytm - low.ytm);
}

function calcularSpread() {
  const dados = window._ntnbDados;
  if (!dados) return;

  const target = parseFloat(document.getElementById("input-duration").value);
  if (isNaN(target) || target <= 0) {
    alert("Informe um duration válido.");
    return;
  }

  // Reunir todas as datas presentes em ytm
  const todasDatas = new Set();
  for (const bond of Object.keys(dados.ytm)) {
    for (const [dt] of dados.ytm[bond]) todasDatas.add(dt);
  }

  // Construir índice: data → { bond: ytm }  e  data → { bond: durDias }
  const ytmPorData  = {};
  const durPorData  = {};

  for (const bond of Object.keys(dados.ytm)) {
    for (const [dt, val] of dados.ytm[bond]) {
      if (!ytmPorData[dt]) ytmPorData[dt] = {};
      ytmPorData[dt][bond] = val;
    }
  }
  for (const bond of Object.keys(dados.duration)) {
    for (const [dt, val] of dados.duration[bond]) {
      if (!durPorData[dt]) durPorData[dt] = {};
      durPorData[dt][bond] = val;
    }
  }

  // Calcular série interpolada
  const serie = [];
  for (const dt of [...todasDatas].sort()) {
    const ytmMap = ytmPorData[dt] || {};
    const durMap = durPorData[dt] || {};
    const ytmInterp = interpolarDia(ytmMap, durMap, target);
    if (ytmInterp !== null) {
      serie.push({ date: dt, ytm: ytmInterp });
    }
  }

  dadosCompletos = serie;

  // Valor atual (último ponto)
  if (serie.length > 0) {
    const ultimo = serie[serie.length - 1];
    document.getElementById("spread-atual-valor").textContent =
      (ultimo.ytm * 100).toFixed(2) + "% a.a.";
    document.getElementById("spread-atual-wrapper").style.display = "block";
  }

  // Atualizar título
  document.getElementById("spread-grafico-titulo").textContent =
    `NTN-B — Duration ${target} anos`;

  // Mostrar card do gráfico
  document.getElementById("spread-grafico-card").style.display = "block";

  // Resetar botão ativo para 1A
  document.querySelectorAll(".btn-periodo").forEach(b => b.classList.remove("ativo"));
  document.querySelector('[data-periodo="1A"]').classList.add("ativo");
  periodoAtivo = "1A";

  renderizarGrafico(filtrarPorPeriodo(dadosCompletos, "1A"));
}

function filtrarPorPeriodo(serie, periodo) {
  if (periodo === "MAX" || serie.length === 0) return serie;
  const ultima = new Date(serie[serie.length - 1].date);
  let anos = 1;
  if (periodo === "3A") anos = 3;
  else if (periodo === "5A") anos = 5;
  const corte = new Date(ultima);
  corte.setFullYear(corte.getFullYear() - anos);
  return serie.filter(d => new Date(d.date) >= corte);
}

function filtrarPeriodoSpread(periodo) {
  periodoAtivo = periodo;
  document.querySelectorAll(".btn-periodo").forEach(b => {
    b.classList.toggle("ativo", b.dataset.periodo === periodo);
  });
  renderizarGrafico(filtrarPorPeriodo(dadosCompletos, periodo));
}

function renderizarGrafico(serie) {
  const labels = serie.map(d => d.date);
  const valores = serie.map(d => parseFloat((d.ytm * 100).toFixed(4)));

  if (grafico) {
    grafico.data.labels = labels;
    grafico.data.datasets[0].data = valores;
    grafico.update();
    return;
  }

  const ctx = document.getElementById("grafico-spread").getContext("2d");
  grafico = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "NTN-B Interpolada (% a.a.)",
        data: valores,
        borderColor: COR_LINHA,
        backgroundColor: COR_FUNDO,
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => " " + ctx.parsed.y.toFixed(2) + "% a.a.",
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: COR_NAVY,
            maxTicksLimit: 8,
            maxRotation: 0,
          },
          grid: { color: "rgba(0,0,0,0.05)" }
        },
        y: {
          ticks: {
            color: COR_NAVY,
            callback: v => v.toFixed(2) + "%"
          },
          grid: { color: "rgba(0,0,0,0.05)" }
        }
      }
    }
  });
}

inicializar();
