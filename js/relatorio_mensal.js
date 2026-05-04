// Relatório Mensal:
//   1) gráfico IFIX vs CDI dos últimos 12 meses
//   2) tabela com retorno por setor entre datas configuráveis + P/VP, DY,
//      spread atual e spread médio histórico (vs NTN-B 5a)

let _setoresRetorno = null;   // { Setor: [[data, indice], ...] }
let _setoresRetornoCurto = {};// idem, variante sem outliers (uso ≤35 dias)
const JANELA_CURTA_DIAS = 35;
let _setoresAtuais = null;    // tabela: [{Setor, P/VP, DY, % do IFIX}]
let _historicoDy = null;      // { Setor: [[data, dy_pct], ...] }
let _ntnb5a = null;           // [{date, ytm}]
let _spreadMedio = {};        // Setor → média histórica (pp)
let _spreadAtual = {};        // Setor → spread atual (pp)

async function carregar() {
  try {
    const hoje = new Date();
    const inicio = new Date();
    inicio.setFullYear(inicio.getFullYear() - 1);
    const dataMinISO = inicio.toISOString().slice(0, 10);

    const [ifixData, cdiMapa, setoresJson, setoresRet, ntnb] = await Promise.all([
      fetch("data/ifix.json").then(r => { if (!r.ok) throw new Error("ifix.json não encontrado"); return r.json(); }),
      buscarCDI(dataMinISO),
      fetch("data/setores.json").then(r => r.ok ? r.json() : null),
      fetch("data/setores_retorno.json").then(r => r.ok ? r.json() : null),
      fetch("data/ntnb.json").then(r => r.ok ? r.json() : null),
    ]);

    // ── IFIX vs CDI 12M ─────────────────────────────────────────────────
    const ifix12m = (ifixData.historico || []).filter(([d]) => d >= dataMinISO);
    if (ifix12m.length < 2) throw new Error("dados de IFIX insuficientes nos últimos 12 meses");
    const baseIfix = ifix12m[0][1];
    const ifixSerie = ifix12m.map(([d, v]) => [d, (v / baseIfix) * 100]);

    let acumCDI = 100;
    const cdiSerie = ifixSerie.map(([d]) => {
      const taxa = cdiMapa[d] ?? 0;
      acumCDI *= (1 + taxa);
      return [d, acumCDI];
    });

    const retIfix = ifixSerie[ifixSerie.length - 1][1] - 100;
    const retCDI  = cdiSerie [cdiSerie.length  - 1][1] - 100;
    document.getElementById("rm-resumo").innerHTML =
      `IFIX <b>${formatarPct(retIfix)}</b> · CDI <b>${formatarPct(retCDI)}</b>`;

    desenharGrafico(ifixSerie, cdiSerie);

    // ── Tabela setorial ─────────────────────────────────────────────────
    const ntnbOk = ntnb && ntnb.ytm && ntnb.duration
                   && Object.keys(ntnb.ytm).length > 0;
    if (setoresRet && setoresJson && ntnbOk) {
      _setoresRetorno = setoresRet.indices || {};
      _setoresRetornoCurto = setoresRet.indices_curto || {};
      _setoresAtuais  = setoresJson.tabela || [];
      _historicoDy    = setoresJson.historico_dy || {};
      _ntnb5a         = ntnbCalcularSerie(ntnb, 5);
      precalcularSpreads();
      aplicarPresetSetorial(12);  // dispara renderTabelaSetorial
    } else {
      const motivo = !setoresRet ? "setores_retorno.json"
                   : !setoresJson ? "setores.json"
                   : !ntnbOk      ? "ntnb.json (vazio ou inválido)"
                   : "indisponível";
      document.getElementById("tabela-setorial-body").innerHTML =
        `<tr><td colspan="7" class="sim-vazio-msg">Dados setoriais indisponíveis (${motivo}).</td></tr>`;
    }

    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = "Falha ao carregar: " + e.message;
  }
}

// ─── Tabela setorial ─────────────────────────────────────────────────────

function precalcularSpreads() {
  // Mapa data → ytm pra lookup rápido
  const ytmPorDia = {};
  for (const { date, ytm } of _ntnb5a) ytmPorDia[date] = ytm;

  for (const setor of Object.keys(_historicoDy)) {
    const serie = _historicoDy[setor]; // [[data, dy_pct], ...]
    if (!serie || !serie.length) continue;
    let soma = 0, n = 0;
    let ultimo = null;
    for (const [dt, dy] of serie) {
      const ytm = ytmPorDia[dt];
      if (ytm == null || dy == null) continue;
      // historico_dy guarda DY como decimal (ex 0.13) — converte pra %
      const dyPct = dy * 100;
      const spread = dyPct - ytm;
      soma += spread;
      n++;
      ultimo = spread;
    }
    if (n > 0) {
      _spreadMedio[setor] = soma / n;
      _spreadAtual[setor] = ultimo;
    }
  }
}

function aplicarPresetSetorial(meses) {
  const idx = _setoresRetorno;
  if (!idx) return;
  // Última data disponível no índice setorial mais recente
  let ultima = null;
  for (const setor of Object.keys(idx)) {
    const s = idx[setor];
    const u = s.length ? s[s.length - 1][0] : null;
    if (u && (!ultima || u > ultima)) ultima = u;
  }
  if (!ultima) return;
  const ate = new Date(ultima);
  const de  = new Date(ultima);
  de.setMonth(de.getMonth() - meses);

  document.getElementById("rm-data-de").value  = de.toISOString().slice(0, 10);
  document.getElementById("rm-data-ate").value = ate.toISOString().slice(0, 10);

  document.querySelectorAll(".btn-rm-preset").forEach(b => {
    b.classList.toggle("ativo", parseInt(b.dataset.meses) === meses);
  });

  renderTabelaSetorial();
}

// Pega o ponto da série com data <= dataAlvo (forward-fill). Se não houver,
// pega o primeiro disponível.
function pontoMaisProximo(serie, dataAlvo) {
  if (!serie || !serie.length) return null;
  let achado = null;
  for (const [d, v] of serie) {
    if (d <= dataAlvo) achado = [d, v];
    else break;
  }
  return achado;
}

function calcularRetorno(setor, de, ate) {
  // Janela curta (≤35 dias) usa série sem outliers de curto prazo (ex: VIUR11
  // perdeu metade do valor em um dia e distorce o retorno mensal do Tijolo
  // Multissetorial). Em janelas maiores o efeito se dilui — usa a série cheia.
  const diasJanela = (new Date(ate) - new Date(de)) / 86400000;
  const fonte = (diasJanela <= JANELA_CURTA_DIAS && _setoresRetornoCurto[setor])
    ? _setoresRetornoCurto[setor]
    : _setoresRetorno[setor];
  if (!fonte || fonte.length < 2) return null;
  const pDe  = pontoMaisProximo(fonte, de);
  const pAte = pontoMaisProximo(fonte, ate);
  if (!pDe || !pAte || pDe[0] >= pAte[0]) return null;
  return (pAte[1] / pDe[1]) - 1;
}

function renderTabelaSetorial() {
  const de  = document.getElementById("rm-data-de").value;
  const ate = document.getElementById("rm-data-ate").value;
  const tbody = document.getElementById("tabela-setorial-body");
  if (!de || !ate || de >= ate) {
    tbody.innerHTML = '<tr><td colspan="7" class="sim-vazio-msg">Selecione um intervalo válido.</td></tr>';
    return;
  }

  // Linha por setor — usa a tabela atual (P/VP, DY) como fonte de verdade
  const linhas = (_setoresAtuais || [])
    .filter(s => s.Setor && s.Setor !== "Total")
    .map(s => {
      const setor = s.Setor;
      const ret = calcularRetorno(setor, de, ate);
      const pvp = s["P/VP"];
      const dy  = s["DY"];
      const sprAtual = _spreadAtual[setor];
      const sprMed   = _spreadMedio[setor];
      const delta = (sprAtual != null && sprMed != null) ? sprAtual - sprMed : null;
      return { setor, ret, pvp, dy, sprAtual, sprMed, delta };
    });

  // Ordena por retorno descendente (nulls no fim)
  linhas.sort((a, b) => {
    if (a.ret == null && b.ret == null) return 0;
    if (a.ret == null) return 1;
    if (b.ret == null) return -1;
    return b.ret - a.ret;
  });

  tbody.innerHTML = linhas.map(l => `
    <tr>
      <td>${l.setor}</td>
      <td class="num">${formatarRet(l.ret)}</td>
      <td class="num">${l.pvp != null ? l.pvp.toFixed(2) : "—"}</td>
      <td class="num">${l.dy  != null ? (l.dy*100).toFixed(2) + "%" : "—"}</td>
      <td class="num">${formatarPp(l.sprAtual)}</td>
      <td class="num">${formatarPp(l.sprMed)}</td>
      <td class="num">${formatarDeltaPp(l.delta)}</td>
    </tr>
  `).join("");

  document.getElementById("rm-setorial-meta").textContent =
    `${formatarDataLabel(de)} → ${formatarDataLabel(ate)}`;
}

function formatarRet(v) {
  if (v == null) return "—";
  const pct = v * 100;
  const cls = pct >= 0 ? "var-pos" : "var-neg";
  return `<span class="${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
}
function formatarPp(v) {
  if (v == null) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(2) + " pp";
}
function formatarDeltaPp(v) {
  if (v == null) return "—";
  const cls = v >= 0 ? "var-pos" : "var-neg";
  return `<span class="${cls}">${v >= 0 ? "+" : ""}${v.toFixed(2)} pp</span>`;
}

async function buscarCDI(dataMinISO) {
  const fmt = iso => { const [a,m,d] = iso.split("-"); return `${d}/${m}/${a}`; };
  const hoje = new Date().toISOString().slice(0, 10);
  const url  = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json`
             + `&dataInicial=${fmt(dataMinISO)}&dataFinal=${fmt(hoje)}`;
  const resp = await fetch(url);
  if (!resp.ok) return {};
  const lista = await resp.json();
  const mapa = {};
  for (const { data, valor } of lista) {
    const [d, m, a] = data.split("/");
    mapa[`${a}-${m}-${d}`] = parseFloat(valor) / 100;  // taxa decimal diária
  }
  return mapa;
}

function desenharGrafico(ifixSerie, cdiSerie) {
  const ctx = document.getElementById("grafico-ifix-cdi");

  new Chart(ctx, {
    type: "line",
    data: {
      labels: ifixSerie.map(([d]) => d),
      datasets: [
        {
          label: "IFIX",
          data: ifixSerie.map(([, v]) => v),
          borderColor: "#EF6300",
          backgroundColor: "rgba(239,99,0,0.08)",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15,
          fill: true,
        },
        {
          label: "CDI",
          data: cdiSerie.map(([, v]) => v),
          borderColor: "#00093C",
          backgroundColor: "rgba(0,9,60,0.04)",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0,
          borderDash: [6, 4],
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 14, font: { size: 13 } } },
        tooltip: {
          callbacks: {
            title: ctx => formatarDataLabel(ctx[0].label),
            label: ctx => `${ctx.dataset.label}: ${formatarPct(ctx.parsed.y - 100)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 12,
            callback: function(_, idx) {
              const d = this.getLabelForValue(idx);
              const [a, m] = d.split("-");
              const meses = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
              return `${meses[parseInt(m,10)-1]}/${a.slice(2)}`;
            },
          },
          grid: { display: false },
        },
        y: {
          ticks: {
            callback: v => formatarPct(v - 100),
          },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
      },
    },
  });
}

function formatarPct(v) {
  const sinal = v >= 0 ? "+" : "";
  return `${sinal}${v.toFixed(2)}%`;
}

function formatarDataLabel(iso) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

carregar();
