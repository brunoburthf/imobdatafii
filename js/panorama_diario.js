// Panorama Diário (aba interna): replica o dashboard de variações de mercado.
// Calcula tudo no navegador a partir dos JSONs já atualizados diariamente —
// não há pipeline nova. Blocos:
//   1. Fundos Ofertados (lista curada editável)  — var dia/mês/12m, últ. div, DY
//   2. Mercado por setor + IFIX                   — var dia/mês/12m, DY
//   3. Maiores altas/baixas FIIs (do dia)
//   4. Maiores altas/baixas FI-Infra (do dia)
//
// IMA-B foi omitido (projeto só tem YTM da NTN-B, não o índice IMA-B).

// ── Config ──────────────────────────────────────────────────────────────────

// Lista padrão de "Fundos Ofertados" (curada). Editável na própria página;
// override persistido em localStorage. Tickers da imagem que não existem no
// universo de preços (IBIG11, VINI11) foram omitidos do padrão.
const DEFAULT_OFERTADOS = ["KNCR11", "KNHY11", "KNRI11", "BTLG11", "PVBI11", "XPML11", "TOPP11"];
const LS_OFERTADOS = "panorama_ofertados";

// Setores na ordem da imagem (só os que têm índice diário em setores_retorno).
const SETORES_ORDEM = [
  "Escritórios", "FOFs/Hedge Funds", "Crédito Imobiliário",
  "Shoppings", "Logística", "Tijolo Multissetorial", "Agro",
];

const PRICES_URL = () =>
  "https://raw.githubusercontent.com/brunoburthf/imobdatafii/master/prices.json?t=" +
  Math.floor(Date.now() / 60000);
const v = () => "?v=" + Math.floor(Date.now() / 60000);

// Estado carregado (fontes que não mudam por ticker ficam em cache de módulo).
let _prices = null, _indexFiis = null, _infraIndex = null, _setoresRet = null,
    _setoresTab = null, _ifix = null, _classifInfra = null;
const _serieCache = {};  // ticker -> serie ajustada (retorno total)

// ── Helpers de cálculo ────────────────────────────────────────────────────

// serie: [[YYYY-MM-DD, preco], ...] em ordem cronológica. Retorna variação %.
function varSerie(serie, modo) {
  if (!Array.isArray(serie) || serie.length < 2) return null;
  const [lastDate, lastPx] = serie[serie.length - 1];
  let ref = null;
  if (modo === "dia") {
    ref = serie[serie.length - 2];
  } else if (modo === "mes") {
    const ym = lastDate.slice(0, 7);
    for (let i = serie.length - 2; i >= 0; i--) {
      if (serie[i][0].slice(0, 7) < ym) { ref = serie[i]; break; }
    }
  } else if (modo === "12m") {
    const alvo = isoMenosAno(lastDate);
    for (let i = serie.length - 1; i >= 0; i--) {
      if (serie[i][0] <= alvo) { ref = serie[i]; break; }
    }
  }
  if (!ref || !ref[1]) return null;
  return (lastPx / ref[1] - 1) * 100;
}

function isoMenosAno(iso) {
  const d = new Date(iso + "T00:00:00");
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Fetch ────────────────────────────────────────────────────────────────

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(url + " → HTTP " + r.status);
  return r.json();
}

async function carregarBase() {
  const [prices, idx, infra, setRet, setTab, ifix, classif] = await Promise.all([
    getJSON(PRICES_URL()).catch(() => ({ precos: {}, variacoes: {} })),
    getJSON("data/index.json" + v()),
    getJSON("data/infra_index.json" + v()).catch(() => ({ fiis: [] })),
    getJSON("data/setores_retorno.json" + v()),
    getJSON("data/setores.json" + v()).catch(() => ({ tabela: [] })),
    getJSON("data/ifix.json" + v()),
    getJSON("data/classificacao_infra.json" + v()).catch(() => []),
  ]);
  _prices = prices;
  _indexFiis = idx.fiis || [];
  _infraIndex = Array.isArray(infra) ? infra : (infra.fiis || []);
  _setoresRet = setRet.indices || {};
  _setoresTab = setTab.tabela || [];
  _ifix = ifix.historico || [];
  _classifInfra = Array.isArray(classif) ? classif : [];

  // carimbo de atualização (usa a fonte de preço, mais fresca)
  const el = document.getElementById("panorama-atualizado");
  if (el) el.textContent = prices.atualizado_em || setRet.atualizado_em || "—";
}

async function getSerieAjustada(ticker) {
  if (_serieCache[ticker] !== undefined) return _serieCache[ticker];
  try {
    // Ajustada por proventos/splits/amortizações = retorno total (mês/12m).
    const d = await getJSON(`data/historico_precos_v2/ajustado/${ticker}.json` + v());
    _serieCache[ticker] = d.serie || null;
  } catch (_) {
    _serieCache[ticker] = null;
  }
  return _serieCache[ticker];
}

// ── Render: helpers de célula ──────────────────────────────────────────────

// Formatação fiel à imagem: vírgula decimal, sem sinal "+", monocromático.
const _vir = (x, dec = 2) => x.toFixed(dec).replace(".", ",");
function celVar(pct) {
  if (pct == null || !isFinite(pct)) return '<td class="num">—</td>';
  const cls = pct >= 0 ? "pan-pos" : "pan-neg";  // verde / vermelho-laranja
  return `<td class="num ${cls}">${_vir(pct)}%</td>`;
}
function celDinheiro(x) {  // "Dividendo R$" → número puro, ex: 1,00
  if (x == null || !isFinite(x)) return '<td class="num">—</td>';
  return `<td class="num">${_vir(x)}</td>`;
}
function celPct(dec) {  // valor decimal → percentual, ex: 11,19%
  if (dec == null || !isFinite(dec)) return '<td class="num">—</td>';
  return `<td class="num">${_vir(dec * 100)}%</td>`;
}

// ── Bloco 1: Fundos Ofertados ───────────────────────────────────────────────

function getOfertados() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_OFERTADOS));
    if (Array.isArray(v) && v.length) return v;
  } catch (_) {}
  return DEFAULT_OFERTADOS.slice();
}
function setOfertados(lista) {
  localStorage.setItem(LS_OFERTADOS, JSON.stringify(lista));
}

async function renderOfertados() {
  const lista = getOfertados();
  const tbody = document.getElementById("pan-ofertados-body");
  tbody.innerHTML = `<tr><td colspan="6" class="pan-vazio">Calculando…</td></tr>`;

  const idxByTicker = {};
  _indexFiis.forEach(f => { idxByTicker[f.Ticker] = f; });

  const linhas = await Promise.all(lista.map(async (t) => {
    const serie = await getSerieAjustada(t);
    const info = idxByTicker[t] || {};
    const preco = _prices.precos?.[t] ?? null;
    const varDia = _prices.variacoes?.[t] ?? varSerie(serie, "dia");  // % (live > série)
    const div = info["Último Dividendo Pago"] ?? null;
    // DY** = último dividendo anualizado (×12) sobre o preço atual
    const dy = (div != null && preco) ? (div * 12 / preco) : null;
    return { t,
      dia: varDia,
      mes: varSerie(serie, "mes"),
      ano: varSerie(serie, "12m"),
      div, dy };
  }));

  renderEditorOfertados(lista);

  tbody.innerHTML = linhas.map(r => `
    <tr>
      <td class="pan-ticker">${r.t}</td>
      ${celVar(r.dia)}
      ${celVar(r.mes)}
      ${celVar(r.ano)}
      ${celDinheiro(r.div)}
      ${celPct(r.dy)}
    </tr>`).join("");
}

function renderEditorOfertados(lista) {
  const cont = document.getElementById("pan-ofertados-chips");
  if (!cont) return;
  cont.innerHTML = lista.map(t =>
    `<span class="pan-chip">${t}<button type="button" title="Remover" onclick="removerOfertado('${t}')">×</button></span>`
  ).join("");
}

window.removerOfertado = function (t) {
  setOfertados(getOfertados().filter(x => x !== t));
  renderOfertados();
};
window.adicionarOfertado = function () {
  const inp = document.getElementById("pan-ofertados-input");
  const t = (inp.value || "").trim().toUpperCase();
  if (!/^[A-Z]{4}\d{1,2}$/.test(t)) { inp.classList.add("pan-input-erro"); return; }
  inp.classList.remove("pan-input-erro");
  const lista = getOfertados();
  if (!lista.includes(t)) lista.push(t);
  setOfertados(lista);
  inp.value = "";
  renderOfertados();
};
window.resetarOfertados = function () {
  localStorage.removeItem(LS_OFERTADOS);
  renderOfertados();
};

// ── Bloco 2: Mercado por setor + IFIX ───────────────────────────────────────

function renderSetores() {
  const tbody = document.getElementById("pan-setores-body");
  const dyBySetor = {};
  _setoresTab.forEach(s => { dyBySetor[s.Setor] = s.DY; });

  const linhas = SETORES_ORDEM
    .filter(s => _setoresRet[s])
    .map(s => {
      const serie = _setoresRet[s];
      return {
        nome: s,
        dia: varSerie(serie, "dia"),
        mes: varSerie(serie, "mes"),
        ano: varSerie(serie, "12m"),
        dy: dyBySetor[s] ?? null,
      };
    });

  let html = linhas.map(r => `
    <tr>
      <td class="pan-ticker">${r.nome}</td>
      ${celVar(r.dia)}${celVar(r.mes)}${celVar(r.ano)}${celPct(r.dy)}
    </tr>`).join("");

  // Linha do IFIX
  html += `
    <tr class="pan-linha-indice">
      <td class="pan-ticker">IFIX</td>
      ${celVar(varSerie(_ifix, "dia"))}
      ${celVar(varSerie(_ifix, "mes"))}
      ${celVar(varSerie(_ifix, "12m"))}
      <td class="num">—</td>
    </tr>`;

  tbody.innerHTML = html;
}

// ── Blocos 3 e 4: maiores variações do dia ──────────────────────────────────

function nomeCurto(ticker) {
  const f = _indexFiis.find(x => x.Ticker === ticker) ||
            _infraIndex.find(x => x.Ticker === ticker);
  if (!f || !f.Nome) return "";
  return f.Nome.length > 22 ? f.Nome.slice(0, 21) + "…" : f.Nome;
}

function renderMovers() {
  const infraSet = new Set(_classifInfra.map(c => c.ticker));
  const vars = _prices.variacoes || {};
  const todos = Object.keys(vars)
    .filter(t => vars[t] != null && isFinite(vars[t]))
    .map(t => ({ t, pct: vars[t], infra: infraSet.has(t) }));

  const fiis  = todos.filter(x => !x.infra).sort((a, b) => b.pct - a.pct);
  const infra = todos.filter(x =>  x.infra).sort((a, b) => b.pct - a.pct);

  preencherMovers("pan-fii-altas",   fiis.slice(0, 5));
  preencherMovers("pan-fii-baixas",  fiis.slice(-5).reverse());
  preencherMovers("pan-infra-altas", infra.slice(0, 5));
  preencherMovers("pan-infra-baixas", infra.slice(-5).reverse());
}

function preencherMovers(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="pan-vazio">—</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map(x => `
    <tr>
      <td class="pan-ticker">${x.t}</td>
      <td class="pan-nome" title="${nomeCurto(x.t)}">${nomeCurto(x.t)}</td>
      ${celVar(x.pct)}
    </tr>`).join("");
}

// ── Copiar tabelas como imagem ──────────────────────────────────────────────
// Renderiza #panorama-tabelas via html2canvas e copia o PNG pro clipboard.
// Usa ClipboardItem com Promise<Blob> para preservar o gesto do clique
// (exigido por Safari; suportado no Chrome) e evitar erro de "no user gesture".
async function copiarImagemTabelas() {
  const btn = document.getElementById("btn-copiar-imagem");
  const alvo = document.getElementById("panorama-tabelas");
  if (!btn || !alvo) return;
  const txt = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Gerando…";

  const gerarBlob = async () => {
    if (typeof html2canvas === "undefined") throw new Error("biblioteca de captura não carregou");
    const canvas = await html2canvas(alvo, {
      backgroundColor: "#ffffff",
      scale: 1.8,               // 20% maior que o anterior (1.5)
      useCORS: true,
      logging: false,
    });
    return await new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error("falha ao gerar PNG")), "image/png"));
  };

  try {
    if (navigator.clipboard && window.ClipboardItem) {
      // Passa a Promise direto pro ClipboardItem (mantém o gesto do clique).
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": gerarBlob() }),
      ]);
      btn.textContent = "✓ Copiado!";
    } else {
      // Fallback: baixa o PNG se o clipboard de imagem não for suportado.
      const blob = await gerarBlob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "panorama_diario.png";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      btn.textContent = "✓ Baixado (clipboard indisponível)";
    }
  } catch (e) {
    btn.textContent = "Erro: " + (e.message || e);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = txt; }, 2600);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function iniciarPanorama() {
  try {
    await carregarBase();
    renderSetores();
    renderMovers();
    await renderOfertados();
    document.getElementById("panorama-loading").style.display = "none";
    document.getElementById("panorama-conteudo").style.display = "block";
  } catch (e) {
    const el = document.getElementById("panorama-erro");
    document.getElementById("panorama-loading").style.display = "none";
    el.style.display = "block";
    el.textContent = "Erro ao carregar dados: " + e.message;
  }
}

iniciarPanorama();
