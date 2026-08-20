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

const v = () => "?v=" + Math.floor(Date.now() / 60000);

// Estado carregado (fontes que não mudam por ticker ficam em cache de módulo).
let _varDia = null, _indexFiis = null, _infraIndex = null, _setoresRet = null,
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

// ── Variação do dia = ÚLTIMO PREGÃO FECHADO ────────────────────────────────
// O painel é um retrato do pregão que fechou, não do dia em curso. Fonte:
// data/variacoes_dia.json, gerado pelo scripts/gerar_variacoes_dia.py a partir
// da v2 (COTAHIST B3) no mesmo workflow que atualiza a base.
//
// Isso substituiu o prices.json (Yahoo, 5 em 5 min), que servia ao propósito
// oposto e trazia dois defeitos herdados:
//   - durante o pregão mostrava o dia EM CURSO (IBBP11 marcando -7,4% às 10h
//     de 20/08/2026 quando no pregão fechado, 19/08, tinha ficado de lado);
//   - em fundo sem negócio no dia, repetia a variação da véspera como se fosse
//     a de hoje (KOPA11 arrastando -13,37% por dias).
// Como o agregado só inclui ticker que fechou no pregão de referência, o
// segundo caso some por construção — sem heurística de "cotação parada".
//
// Cada ticker traz duas variações:
//   p = preço puro    t = retorno total (ajustado por provento/amortização)
// Usamos "t", igual às colunas de mês/12m, pra não repetir o caso KOPA11:
// -13,37% nominal em 18/08 eram -4,5% reais, o resto era amortização.
function varDiaTotal(ticker) {
  const r = _varDia?.variacoes?.[ticker];
  if (!r) return null;
  const pct = r.t ?? r.p;
  return (pct == null || !isFinite(pct)) ? null : pct;
}

function varDiaPreco(ticker) {
  const r = _varDia?.variacoes?.[ticker];
  return (r && isFinite(r.p)) ? r.p : null;
}

function precoFechamento(ticker) {
  const r = _varDia?.variacoes?.[ticker];
  return (r && isFinite(r.px)) ? r.px : null;
}

// "2026-08-19" → "19/08/2026"
function dataBR(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || "—");
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

function avisarSemVariacoes(motivo) {
  const el = document.getElementById("panorama-aviso");
  if (!el) return;
  if (!motivo) { el.style.display = "none"; return; }
  el.style.display = "block";
  el.textContent = `⚠ Não foi possível carregar as variações do pregão `
    + `(${motivo}). Var. dia, DY e maiores variações ficam vazios.`;
}

async function carregarBase() {
  const [varDia, idx, infra, setRet, setTab, ifix, classif] = await Promise.all([
    getJSON("data/variacoes_dia.json" + v()).catch(e => ({ _erro: e.message })),
    getJSON("data/index.json" + v()),
    getJSON("data/infra_index.json" + v()).catch(() => ({ fiis: [] })),
    getJSON("data/setores_retorno.json" + v()),
    getJSON("data/setores.json" + v()).catch(() => ({ tabela: [] })),
    getJSON("data/ifix.json" + v()),
    getJSON("data/classificacao_infra.json" + v()).catch(() => []),
  ]);
  _varDia = varDia._erro ? { variacoes: {} } : varDia;
  _indexFiis = idx.fiis || [];
  _infraIndex = Array.isArray(infra) ? infra : (infra.fiis || []);
  _setoresRet = setRet.indices || {};
  _setoresTab = setTab.tabela || [];
  _ifix = ifix.historico || [];
  _classifInfra = Array.isArray(classif) ? classif : [];

  // Carimbo = o pregão retratado, não a hora em que o arquivo foi gerado.
  const el = document.getElementById("panorama-atualizado");
  if (el) el.textContent = dataBR(_varDia.data) + " (pregão fechado)";
  avisarSemVariacoes(varDia._erro);
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
    // Fechamento do pregão retratado — mesma referência da variação do dia.
    const preco = precoFechamento(t);
    const varDia = varDiaTotal(t) ?? varSerie(serie, "dia");
    const div = info["Último Dividendo Pago"] ?? null;
    // DY** = último dividendo anualizado (×12) sobre o preço de fechamento
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

// O agregado já só contém quem fechou no pregão de referência, então não há
// cotação parada pra filtrar aqui — quem não negociou simplesmente não entra.
function renderMovers() {
  const infraSet = new Set(_classifInfra.map(c => c.ticker));
  const todos = Object.keys(_varDia?.variacoes || {})
    .map(t => ({ t, pct: varDiaTotal(t), infra: infraSet.has(t) }))
    .filter(x => x.pct != null && isFinite(x.pct));

  const fiis  = todos.filter(x => !x.infra).sort((a, b) => b.pct - a.pct);
  const infra = todos.filter(x =>  x.infra).sort((a, b) => b.pct - a.pct);

  preencherMovers("pan-fii-altas",    fiis.slice(0, 5));
  preencherMovers("pan-fii-baixas",   fiis.slice(-5).reverse());
  preencherMovers("pan-infra-altas",  infra.slice(0, 5));
  preencherMovers("pan-infra-baixas", infra.slice(-5).reverse());
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
    // Quando o total difere do preço, houve provento no dia — mostra os dois
    // no tooltip pra dar pra auditar de onde veio o número.
    const vp = varDiaPreco(x.t);
    const dica = (vp != null && Math.abs(vp - x.pct) > 0.01)
      ? `${nomeCurto(x.t)} — preço ${_vir(vp)}%, com provento ${_vir(x.pct)}%`
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
