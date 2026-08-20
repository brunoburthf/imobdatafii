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
let _exHoje = {};        // ticker -> R$/cota que saiu da cota hoje (ex-provento)
const _serieCache = {};  // ticker -> serie ajustada (retorno total)
const _nominalCache = {};  // ticker -> serie nominal (p/ detectar cotação parada)

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

// ── Ajuste ex-provento da variação do dia ──────────────────────────────────
// Um FII fica "ex" no pregão seguinte à data_com: a cota abre valendo o
// provento a menos, sem que nada tenha acontecido com o fundo. A variação do
// prices.json é nominal e não sabe disso, então num dia de pagamento o fundo
// aparece como "maior baixa" sem ter caído. Caso real: KOPA11 em 18/08/2026
// marcou -13,37%, mas R$ 24,00 dos R$ 34,75 eram amortização + rendimento —
// queda real de -4,14%. No fim do mês ~86 fundos ficam ex no mesmo dia, o que
// contamina a tabela inteira (e ela é copiada como imagem pra publicação).
//
// Fonte: data/noticias.json → dividendos (janela de 30d, cobertura conferida
// contra data/proventos/ em 19/08/2026: 100% dos data_com, e mais fresca).

// Último pregão ANTERIOR ao dia dos preços: é o data_com que deixa a cota ex
// hoje. Usa a série do IFIX, que já está carregada e é o calendário de pregão.
function pregaoAnterior(isoHoje) {
  for (let i = _ifix.length - 1; i >= 0; i--) {
    if (_ifix[i][0] < isoHoje) return _ifix[i][0];
  }
  return null;
}

// "18/08/2026 21:14 UTC" → "2026-08-18"
function isoDoCarimbo(carimbo) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(carimbo || "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function montarExHoje(noticias) {
  const hoje = isoDoCarimbo(_prices.atualizado_em);
  if (!hoje || !_ifix.length) return {};
  const dataCom = pregaoAnterior(hoje);
  if (!dataCom) return {};
  const mapa = {};
  (noticias.dividendos || []).forEach(d => {
    if (d.data_com === dataCom && d.ticker && d.valor > 0) {
      mapa[d.ticker] = (mapa[d.ticker] || 0) + d.valor;  // amortização + rendimento
    }
  });
  return mapa;
}

// Variação do dia com o provento devolvido à cota (retorno total do dia).
function varDiaTotal(ticker) {
  const pct = _prices.variacoes?.[ticker];
  if (pct == null || !isFinite(pct)) return null;
  const prov = _exHoje[ticker];
  const px = _prices.precos?.[ticker];
  if (!prov || !px || pct <= -100) return pct;
  const anterior = px / (1 + pct / 100);   // fechamento do pregão anterior
  return anterior ? ((px + prov) / anterior - 1) * 100 : pct;
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

// prices.json vem do GH Action (a cada 5 min). O raw.githubusercontent devolve
// 429 (rate limit por IP) com alguma frequência — quando isso acontece a página
// perdia, EM SILÊNCIO, o DY dos ofertados (precisa do preço atual) e os dois
// blocos de maiores variações (vêm de `variacoes`). Fallback: a cópia
// same-origin publicada junto com o site — mesma fonte, só congelada no último
// deploy. Se as duas falharem, o aviso na topbar explica o vazio.
async function carregarPrecos() {
  try {
    return { dados: await getJSON(PRICES_URL()), origem: "live" };
  } catch (e1) {
    try {
      return { dados: await getJSON("prices.json" + v()), origem: "fallback", motivo: e1.message };
    } catch (_) {
      return { dados: { precos: {}, variacoes: {} }, origem: "falhou", motivo: e1.message };
    }
  }
}

function avisarOrigemPrecos(res) {
  const el = document.getElementById("panorama-aviso");
  if (!el) return;
  if (res.origem === "live") { el.style.display = "none"; return; }
  el.style.display = "block";
  el.textContent = res.origem === "fallback"
    ? `⚠ Preços ao vivo indisponíveis (${res.motivo}). Usando a cópia publicada com o site: `
      + `var. dia, DY e maiores variações podem estar defasados.`
    : `⚠ Falha ao carregar os preços (${res.motivo}). DY e maiores variações ficam vazios.`;
}

async function carregarBase() {
  const [precosRes, idx, infra, setRet, setTab, ifix, classif, noticias] = await Promise.all([
    carregarPrecos(),
    getJSON("data/index.json" + v()),
    getJSON("data/infra_index.json" + v()).catch(() => ({ fiis: [] })),
    getJSON("data/setores_retorno.json" + v()),
    getJSON("data/setores.json" + v()).catch(() => ({ tabela: [] })),
    getJSON("data/ifix.json" + v()),
    getJSON("data/classificacao_infra.json" + v()).catch(() => []),
    getJSON("data/noticias.json" + v()).catch(() => ({ dividendos: [] })),
  ]);
  _prices = precosRes.dados;
  _indexFiis = idx.fiis || [];
  _infraIndex = Array.isArray(infra) ? infra : (infra.fiis || []);
  _setoresRet = setRet.indices || {};
  _setoresTab = setTab.tabela || [];
  _ifix = ifix.historico || [];
  _classifInfra = Array.isArray(classif) ? classif : [];
  _exHoje = montarExHoje(noticias);

  // carimbo de atualização (usa a fonte de preço, mais fresca)
  const el = document.getElementById("panorama-atualizado");
  if (el) el.textContent = _prices.atualizado_em || setRet.atualizado_em || "—";
  avisarOrigemPrecos(precosRes);
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

// ── Cotação parada (fundo não negociou no pregão em curso) ─────────────────
// O atualizar_precos.py compara os dois últimos fechamentos que o Yahoo
// devolve. Se o fundo não negociou hoje, esses dois são ontem e anteontem —
// e a variação de ONTEM é publicada como "do dia". Num FII ilíquido logo
// depois de uma amortização isso vira um -13% fantasma no ranking.
//
// Detecção: durante o pregão, o preço vivo difere do último fechamento da v2;
// quem bate centavo a centavo com esse fechamento não negociou.
//
// MAS isso só vale ENQUANTO o pregão corre. Depois que a v2 fecha o dia (roda
// 22h BRT), o preço do prices.json passa a ser exatamente esse fechamento
// para TODO MUNDO — e aí não há nada parado: a variação publicada é a do
// último pregão, legítima. Sem essa ressalva o filtro derrubava os 175
// tickers e a tela ficava sem nenhuma variação (bug visto em 20/08/2026).
// Mesma coisa em fim de semana, feriado e antes da abertura.
const TICKER_REF = "KNCR11";  // líquido, negocia todo pregão — sonda do regime

async function getSerieNominal(ticker) {
  if (_nominalCache[ticker] !== undefined) return _nominalCache[ticker];
  try {
    const d = await getJSON(`data/historico_precos_v2/nominal/${ticker}.json` + v());
    _nominalCache[ticker] = d.serie || null;
  } catch (_) {
    _nominalCache[ticker] = null;
  }
  return _nominalCache[ticker];
}

async function cotacaoParada(ticker) {
  const serie = await getSerieNominal(ticker);
  if (!serie || !serie.length) return false;  // sem base: não descarta
  const px = _prices.precos?.[ticker];
  if (px == null) return false;
  return Math.abs(serie[serie.length - 1][1] - px) < 0.005;
}

// Conjunto de tickers a descartar do ranking do dia. Vazio quando o
// prices.json não é de um pregão em curso — ver bloco acima.
async function tickersDefasados(candidatos) {
  const dataPrecos = isoDoCarimbo(_prices.atualizado_em);
  const ref = await getSerieNominal(TICKER_REF);
  const ultimoFechamento = ref && ref.length ? ref[ref.length - 1][0] : null;

  // A v2 já fechou o pregão a que o prices.json se refere: nada está parado.
  if (!dataPrecos || !ultimoFechamento || dataPrecos <= ultimoFechamento) {
    return new Set();
  }

  const paradas = new Set();
  let checados = 0;
  for (const t of candidatos) {
    const serie = await getSerieNominal(t);
    if (!serie || !serie.length) continue;
    checados++;
    if (await cotacaoParada(t)) paradas.add(t);
  }

  // Rede de segurança: se quase todo mundo bateu com o fechamento, o
  // prices.json inteiro é do pregão anterior (fim de semana, feriado, antes
  // da abertura) — filtrar esvaziaria a tela em vez de limpá-la.
  if (checados && paradas.size / checados > 0.8) return new Set();
  return paradas;
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
    const varDia = varDiaTotal(t) ?? varSerie(serie, "dia");  // % (live > série)
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

async function renderMovers() {
  const infraSet = new Set(_classifInfra.map(c => c.ticker));
  const vars = _prices.variacoes || {};
  const todos = Object.keys(vars)
    .map(t => ({ t, pct: varDiaTotal(t), infra: infraSet.has(t), ex: _exHoje[t] || 0 }))
    .filter(x => x.pct != null && isFinite(x.pct));

  const fiis  = todos.filter(x => !x.infra).sort((a, b) => b.pct - a.pct);
  const infra = todos.filter(x =>  x.infra).sort((a, b) => b.pct - a.pct);

  // Só os extremos podem aparecer, então basta sondar esses — evita 175 fetches.
  const N = 15;
  const candidatos = [...new Set(
    [...fiis.slice(0, N), ...fiis.slice(-N), ...infra.slice(0, N), ...infra.slice(-N)]
      .map(x => x.t)
  )];
  const fora = await tickersDefasados(candidatos);
  const top = lista => lista.filter(x => !fora.has(x.t)).slice(0, 5);

  preencherMovers("pan-fii-altas", top(fiis));
  preencherMovers("pan-fii-baixas", top([...fiis].reverse()));
  preencherMovers("pan-infra-altas", top(infra));
  preencherMovers("pan-infra-baixas", top([...infra].reverse()));
}

function preencherMovers(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="pan-vazio">—</td></tr>`;
    return;
  }
  // Barra proporcional: largura ∝ |variação| relativo ao maior do grupo (top = cheio).
  const maxAbs = Math.max(...lista.map(x => Math.abs(x.pct))) || 1;
  tbody.innerHTML = lista.map(x => {
    const pos = x.pct >= 0;
    const w = Math.max(5, Math.round(Math.abs(x.pct) / maxAbs * 100));  // min 5% p/ visibilidade
    const corCls = pos ? "pan-pos" : "pan-neg";
    const barCls = pos ? "pan-bar-pos" : "pan-bar-neg";
    // Marca o ajuste no tooltip pra dar pra auditar de onde veio o número.
    const dica = x.ex
      ? `${nomeCurto(x.t)} — ex R$ ${_vir(x.ex)}/cota hoje; variação já ajustada`
      : nomeCurto(x.t);
    return `
    <tr title="${dica}">
      <td class="pan-ticker">${x.t}</td>
      <td class="pan-bar-cell"><span class="pan-bar ${barCls}" style="width:${w}%"></span></td>
      <td class="num ${corCls}">${_vir(x.pct)}%</td>
    </tr>`;
  }).join("");
}

// ── Copiar como imagem ──────────────────────────────────────────────────────
// Renderiza um elemento via html2canvas e copia o PNG pro clipboard. Usa
// ClipboardItem com Promise<Blob> para preservar o gesto do clique (exigido por
// Safari; suportado no Chrome) e evitar erro de "no user gesture".
async function _copiarComoImagem(alvoId, btnId, nomeArquivo) {
  const btn = document.getElementById(btnId);
  const alvo = document.getElementById(alvoId);
  if (!btn || !alvo) return;
  const txt = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Gerando…";

  const gerarBlob = async () => {
    if (typeof html2canvas === "undefined") throw new Error("biblioteca de captura não carregou");
    const canvas = await html2canvas(alvo, {
      backgroundColor: "#ffffff",
      scale: 1.8,
      useCORS: true,
      logging: false,
    });
    return await new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error("falha ao gerar PNG")), "image/png"));
  };

  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": gerarBlob() })]);
      btn.textContent = "✓ Copiado!";
    } else {
      const blob = await gerarBlob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = nomeArquivo;
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

function copiarImagemTabelas() {
  _copiarComoImagem("panorama-tabelas", "btn-copiar-imagem", "panorama_diario.png");
}
// ── Boot ────────────────────────────────────────────────────────────────────

async function iniciarPanorama() {
  try {
    await carregarBase();
    renderSetores();
    await renderMovers();
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
