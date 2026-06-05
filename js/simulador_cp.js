// Simulador CP (Credito Privado): CRIs, CRAs, LCI/LCAs, debentures e
// titulos publicos. Carteiras salvas em Firestore (users/{uid}/carteiras_cp,
// separado da colecao do simulador de FII).
//
// Engine:
// - Taxa nominal anual = (indexador atual) + spread (ou puro pra PREFIX)
// - Taxa mensal = (1 + a)^(1/12) - 1
// - Saldo devedor capitaliza juros mes a mes; cupom pago no fim do periodo
//   (mensal/semestral/anual)
// - Amortizacao bullet: principal so no vcto. Price: parcela fixa
//   (juros + amort) usando formula PMT.
// - IR: tabela regressiva (22.5% a 15%) sobre o cupom dos papeis nao-isentos.
//   Isento default por tipo (CRI/CRA/LCI/LCA = true; DEB e TPF = false,
//   editavel no form).
//
// Premissas atuais (MVP, sem curva forward):
// - CDI ≈ Selic atual − 0.1% (lido de data/selic/serie_diaria.json)
// - IPCA = 4.5% a.a. (hardcoded Focus-ish)

const MAX_CARTEIRAS_CP   = 30;
const MAX_PAPEIS_POR_CARTEIRA = 50;

let _papeisAtual = [];            // papeis da carteira sendo editada
let _carteiraIdAtual = null;      // id Firestore da carteira aberta (null = nova)
let _cdiAnualAtual = null;        // % a.a. cacheado pra premissa
let _ipcaSerie = [];              // [{mes:"YYYY-MM", valor: 0.67}, ...]
let _ipcaPremissaAnual = 4.5;     // fallback para meses futuros
let _editandoIdx = null;          // indice do papel em edicao (null = novo)
let _chartProjecao = null;        // instancia Chart.js

// ── Tipos com tributacao default isento_ir ─────────────────────────────────
const ISENTO_POR_TIPO = {
  CRI: true,  CRA: true,
  LCI: true,  LCA: true,
  DEB: false, TPF: false,
};

// ── Firestore CRUD (colecao carteiras_cp) ──────────────────────────────────
function userCarteirasCpRef() {
  if (!window.currentUser) return null;
  return db.collection("users").doc(window.currentUser.uid).collection("carteiras_cp");
}

async function listarCarteirasCP() {
  const ref = userCarteirasCpRef();
  if (!ref) return [];
  const snap = await ref.get();
  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return docs.sort((a, b) => (b.updated_at?.toMillis?.() || 0) - (a.updated_at?.toMillis?.() || 0));
}

async function salvarCarteiraCpFirestore(id, data) {
  const ref = userCarteirasCpRef();
  if (!ref) return null;
  data.updated_at = firebase.firestore.Timestamp.now();
  if (id) {
    await ref.doc(id).set(data, { merge: true });
    return id;
  }
  const snap = await ref.get();
  if (snap.size >= MAX_CARTEIRAS_CP) {
    const err = new Error(`Limite de ${MAX_CARTEIRAS_CP} carteiras atingido.`);
    throw err;
  }
  const doc = await ref.add(data);
  return doc.id;
}

async function deletarCarteiraCpFirestore(id) {
  const ref = userCarteirasCpRef();
  if (!ref) return;
  await ref.doc(id).delete();
}

// ── Carregamento inicial ──────────────────────────────────────────────────
document.addEventListener("auth-state-changed", () => {
  atualizarUiAuth();
  if (window.currentUser) {
    document.getElementById("auth-bar")?.classList.remove("show");
    mostrarTela("tela-escolha");
    atualizarContagemCarteirasCP();
  } else {
    mostrarTela("tela-login");
  }
});

async function inicializar() {
  document.getElementById("loading").style.display = "none";
  document.getElementById("conteudo").style.display = "block";
  // Auth pode demorar; mostra login por default
  if (!window.currentUser) mostrarTela("tela-login");
  // Carrega premissas (CDI + IPCA) e indice TPF em background
  carregarCdiPremissa().catch(() => {});
  carregarIpcaSerie().catch(() => {});
  carregarTpfIndex().catch(() => {});
  carregarDebentureIndex().catch(() => {});
}

// ── Indice TPF (autocomplete) ──────────────────────────────────────────────
let _tpfIndex = [];   // [{codigo, nome, tipo, indexador, data_vencimento, cupom_periodo, taxa_compra, pu_compra}, ...]

async function carregarTpfIndex() {
  try {
    const r = await fetch("data/credito_privado/tpf/_index.json");
    if (!r.ok) return;
    const d = await r.json();
    _tpfIndex = d.titulos || [];
  } catch (e) {
    console.warn("Nao conseguiu carregar indice TPF:", e);
  }
}

// ── Indice debentures (autocomplete) ──────────────────────────────────────
let _debIndex = [];  // [{codigo, nome, incentivada, tipo, indexador, spread, data_vencimento, taxa_indicativa, pu, duration_du}, ...]

async function carregarDebentureIndex() {
  try {
    const r = await fetch("data/credito_privado/debentures/_index.json");
    if (!r.ok) return;
    const d = await r.json();
    _debIndex = d.debentures || [];
  } catch (e) {
    console.warn("Nao conseguiu carregar indice debentures:", e);
  }
}

// Label amigavel pra debenture: "PETR23 — PETROBRAS · IPCA + 6,5% · vcto 2030"
function _labelDeb(d) {
  const ano = (d.data_vencimento || "").slice(0, 4);
  const idxBase = (d.indexador || "?").replace(/\+$/, "");  // tira o + final ("IPCA+" -> "IPCA")
  let taxa = idxBase;
  if (d.spread != null && d.spread !== 0) {
    const s = d.spread.toFixed(2).replace(".", ",") + "%";
    if (d.indexador === "CDIp")      taxa = `${s.replace("%", "")}% do CDI`;
    else if (d.indexador === "PREFIX") taxa = `${s} pré`;
    else                              taxa = `${idxBase} + ${s}`;
  }
  return `${d.codigo} — ${d.nome} · ${taxa} · vcto ${ano}`;
}

// Nome curto pro select (ex: "NTN-B 2035 Cupom", "LFT 2027").
function _labelTpf(t) {
  const ano = (t.data_vencimento || "").slice(0, 4);
  switch (t.tipo) {
    case "NTN-B":            return `NTN-B ${ano} Cupom`;
    case "NTN-B Principal":  return `NTN-B ${ano} Principal`;
    case "NTN-F":            return `NTN-F ${ano} Cupom`;
    case "LTN":              return `LTN ${ano}`;
    case "LFT":              return `LFT ${ano}`;
    case "Educa+":           return `Tesouro Educa+ ${ano}`;
    case "RendA+":           return `Tesouro RendA+ ${ano}`;
    default:                 return t.nome || t.codigo;
  }
}

// Ordem dos tipos no dropdown.
const _ORDEM_TIPO_TPF = ["NTN-B", "NTN-B Principal", "NTN-F", "LFT", "LTN", "Educa+", "RendA+"];

// Mantem placeholder + visibilidade do Emissor conforme tipo (TPF esconde).
function popularDatalistTpf() {
  const tipo = document.getElementById("cp-tipo").value;
  const inp = document.getElementById("cp-codigo");
  const emissorLbl = document.getElementById("cp-emissor-label");
  if (!inp) return;
  if (emissorLbl) emissorLbl.style.display = (tipo === "TPF") ? "none" : "";
  if (tipo === "TPF") {
    inp.placeholder = "Buscar TPF — NTN-B, LFT, Educa+ ...";
  } else if (tipo === "DEB") {
    inp.placeholder = "Buscar debênture — código (PETR23) ou nome (Petrobras, Vale...)";
  } else {
    inp.placeholder = "ex: CRI22A123";
  }
}

// ── Caixa de sugestoes (mesmo padrao do simulador FII) ─────────────────────
let _sugestaoIdx = -1;

// Ranqueia matches por relevancia decrescente:
//   100: codigo == q (exact)
//    80: codigo comeca com q  (ex: q="VALE" -> "VALE48")
//    60: alguma palavra do nome comeca com q (ex: q="VALE" -> "VALE S/A")
//    40: codigo CONTEM q
//    20: nome contem q como substring qualquer (ex: q="VALE" -> "AGRO ... DO VALE ...")
// Dentro de cada tier, ordena por codigo alfabeticamente.
// Quando q vazio, devolve tudo na ordem original.
function _rankearMatches(lista, q, fnCampos) {
  if (!q) return lista.slice();
  const Q = q.toUpperCase();
  const ranked = [];
  for (const item of lista) {
    const campos = fnCampos(item).map(s => (s || "").toUpperCase());
    const codigo = campos[0] || "";
    const nome   = campos[1] || "";
    let score = 0;
    if (codigo === Q)                                   score = 100;
    else if (codigo.startsWith(Q))                      score = 80;
    else if (_algumaPalavraComeca(nome, Q))             score = 60;
    else if (codigo.includes(Q))                        score = 40;
    else if (campos.some(c => c.includes(Q)))           score = 20;
    if (score > 0) ranked.push({ item, score, codigo });
  }
  ranked.sort((a, b) => b.score - a.score || a.codigo.localeCompare(b.codigo));
  return ranked.map(r => r.item);
}

function _algumaPalavraComeca(texto, q) {
  // Quebra texto em palavras (espaco, traco, ponto, virgula) e ve se alguma
  // delas comeca com q. Ignora palavras curtas estilo "DE", "DO", "DA".
  if (!texto) return false;
  const palavras = texto.split(/[\s\-.,\/()]+/).filter(p => p.length >= 3);
  return palavras.some(p => p.startsWith(q));
}

function filtrarSugestoesCp() {
  const tipo = document.getElementById("cp-tipo").value;
  const q = (document.getElementById("cp-codigo").value || "").trim().toUpperCase();
  const box = document.getElementById("cp-sugestoes");
  if (!box) return;
  _sugestaoIdx = -1;

  let resultados = [];
  let renderItem;

  if (tipo === "TPF" && _tpfIndex.length > 0) {
    resultados = _rankearMatches(_tpfIndex, q, t => [t.codigo, t.nome, _labelTpf(t)]);
    resultados = resultados.slice(0, 30);
    renderItem = t => {
      const taxa = t.taxa_compra != null ? `${t.taxa_compra.toFixed(2).replace(".",",")}%` : "—";
      return `<div class="sim-sugestao" onmousedown="selecionarSugestaoTpf('${t.codigo}')">
        <span class="sim-sug-ticker">${_escapeAttr(_labelTpf(t))}</span>
        <span class="sim-sug-nome">taxa ${taxa} · vcto ${t.data_vencimento}</span>
      </div>`;
    };
  } else if (tipo === "DEB" && _debIndex.length > 0) {
    resultados = _rankearMatches(_debIndex, q, d => [d.codigo, d.nome]);
    resultados = resultados.slice(0, 30);
    renderItem = d => {
      const taxa = d.taxa_indicativa != null ? `${d.taxa_indicativa.toFixed(2).replace(".",",")}%` : "—";
      const idx = (d.indexador || "?").replace(/\+$/, "");
      const sp = d.spread != null && d.spread !== 0 ? ` + ${d.spread.toFixed(2).replace(".",",")}%` : "";
      const inc = d.incentivada ? ` <span class="cp-sug-tag-inc">isenta IR</span>` : "";
      return `<div class="sim-sugestao" onmousedown="selecionarSugestaoDeb('${d.codigo}')">
        <span class="sim-sug-ticker">${d.codigo}</span>
        <span class="sim-sug-nome">${_escapeAttr(d.nome)} · ${idx}${sp} · vcto ${(d.data_vencimento||"").slice(0,4)} · taxa ${taxa}${inc}</span>
      </div>`;
    };
  } else {
    box.style.display = "none";
    return;
  }

  if (!resultados.length) {
    box.style.display = "none";
    return;
  }

  box.innerHTML = resultados.map(renderItem).join("");
  box._resultados = resultados;
  box._tipo = tipo;
  box.style.display = "block";
}

function navegarSugestoesCp(e) {
  const box = document.getElementById("cp-sugestoes");
  if (!box) return;
  const items = box.querySelectorAll(".sim-sugestao");
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    _sugestaoIdx = Math.min(_sugestaoIdx + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    _sugestaoIdx = Math.max(_sugestaoIdx - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const idx = _sugestaoIdx >= 0 ? _sugestaoIdx : 0;
    const r = box._resultados?.[idx];
    if (r) {
      if (box._tipo === "TPF") aplicarTitulo(r);
      else if (box._tipo === "DEB") aplicarDebenture(r);
      box.style.display = "none";
    }
    return;
  } else if (e.key === "Escape") {
    box.style.display = "none";
    return;
  }
  items.forEach((el, i) => el.classList.toggle("ativo", i === _sugestaoIdx));
}

function selecionarSugestaoTpf(codigo) {
  const t = _tpfIndex.find(x => x.codigo === codigo);
  if (t) aplicarTitulo(t);
  document.getElementById("cp-sugestoes").style.display = "none";
}

async function selecionarSugestaoDeb(codigo) {
  const d = _debIndex.find(x => x.codigo === codigo);
  if (!d) return;
  // Busca o JSON individual pra trazer o cronograma de amortizacoes
  // (campo cronograma_amort_futuro_estimado, gerado por scripts/enriquecer_
  // debentures_eventos.py via scraping do SND).
  try {
    const r = await fetch(`data/credito_privado/debentures/${codigo}.json`);
    if (r.ok) {
      const doc = await r.json();
      // Prioridade: cronograma_amort_futuro (Anbima real, com % exato do
      // termo) > cronograma_amort_futuro_estimado (estimativa uniforme).
      d._cronograma = doc.cronograma_amort_futuro || doc.cronograma_amort_futuro_estimado || [];
    }
  } catch (e) { /* sem cronograma, segue com bullet */ }
  aplicarDebenture(d);
  document.getElementById("cp-sugestoes").style.display = "none";
}

// Click fora da caixa fecha as sugestoes
document.addEventListener("click", e => {
  const box = document.getElementById("cp-sugestoes");
  if (!box) return;
  if (!e.target.closest(".cp-codigo-wrapper")) {
    box.style.display = "none";
  }
});

function _escapeAttr(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Quando o usuario seleciona/digita algo no codigo, tenta resolver pra um
// papel conhecido (TPF ou debenture) e preenche os campos.
function onChangeCodigoTpf() {
  const tipo = document.getElementById("cp-tipo").value;
  const valor = (document.getElementById("cp-codigo").value || "").trim();
  if (!valor) return;
  if (tipo === "TPF" && _tpfIndex.length > 0) {
    const titulo = _tpfIndex.find(t => _labelTpf(t) === valor || t.codigo === valor || t.nome === valor);
    if (titulo) aplicarTitulo(titulo);
    return;
  }
  if (tipo === "DEB" && _debIndex.length > 0) {
    const deb = _debIndex.find(d => _labelDeb(d) === valor || d.codigo === valor || d.nome === valor);
    if (deb) aplicarDebenture(deb);
    return;
  }
}

function aplicarDebenture(d) {
  document.getElementById("cp-tipo").value = "DEB";
  document.getElementById("cp-codigo").value = d.codigo;
  document.getElementById("cp-emissor").value = d.nome || "";
  // Indexador
  if (d.indexador) document.getElementById("cp-indexador").value = d.indexador;
  onChangeIndexador();
  // Taxa (spread sobre indexador, ou multiplicador pra CDIp)
  if (d.spread != null) document.getElementById("cp-taxa").value = d.spread.toFixed(2);
  if (d.pu   != null) document.getElementById("cp-pu-medio").value = d.pu.toFixed(2);
  document.getElementById("cp-data-vencimento").value = d.data_vencimento || "";
  // VN base: pra debentures com amortizacao "percentual_fixo", o saldo
  // devedor ja foi reduzido por amortizacoes previas. Usamos VNA atual
  // (do SND) como base e ancoramos data_emissao = data_vna pra evitar
  // duplo-contar IPCA acumulado ate a data do snapshot.
  const hoje = new Date().toISOString().slice(0, 10);
  if (d.amortizacao === "percentual_fixo" && d.vna_atual && d.data_vna) {
    document.getElementById("cp-pu-emissao").value = d.vna_atual.toFixed(2);
    document.getElementById("cp-data-emissao").value = d.data_vna;
  } else {
    // Debentures bullet: VN historico R$ 1000 corrigido por IPCA desde
    // emissao oficial - o comportamento padrao da engine ja faz isso.
    document.getElementById("cp-pu-emissao").value = "1000";
    document.getElementById("cp-data-emissao").value = d.data_emissao || hoje;
  }
  // Periodicidade real do cupom (semestral/anual/mensal) - vem do SND apos enrichment
  document.getElementById("cp-cupom-periodo").value = d.cupom_periodo || "semestral";
  // Amortizacao: SND classifica como "percentual_fixo" pra ~75% das deb. Sem
  // o cronograma detalhado de cada periodo, projetamos como bullet (renda
  // mensal aproximada vai estar correta; principal so cai na ultima data).
  document.getElementById("cp-amortizacao").value = "bullet";
  document.getElementById("cp-isento").checked = !!d.incentivada;
  // Guarda primeiro_cupom + cronograma como atributos "shadow"
  _proxPrimeiroCupom = d.primeiro_cupom || null;
  _proxCronoAmort = d._cronograma || null;
  // Salva pct_pu_par e duration_du do snapshot Anbima pra calculo do spread
  // efetivo: spread = spread_contratual - (pct_pu_par - 1) / duration_anos
  _proxPctPuParSnap = d.pct_pu_par || null;
  _proxDurationDuSnap = d.duration_du || null;
  _proxPuSnap = d.pu || null;
  _atualizarLabelTaxaEntrada();
  _sincTaxaDoPuMedioSync();   // preenche cp-taxa-entrada imediatamente
  let info = `Preenchido do SND (${d.codigo}`;
  if (d.data_emissao && d.primeiro_cupom) info += ` · 1o cupom ${d.primeiro_cupom}`;
  if (d.incentivada) info += ` · incentivada Lei 12.431`;
  if (_proxCronoAmort && _proxCronoAmort.length > 0) info += ` · ${_proxCronoAmort.length} amort. futuras programadas`;
  info += `).`;
  const msg = document.getElementById("cp-form-msg");
  msg.textContent = info;
  msg.style.color = "#2a7";
}

// Guarda primeiro_cupom + cronograma do papel atualmente sendo editado.
let _proxPrimeiroCupom = null;
let _proxCronoAmort = null;
let _proxPctPuParSnap = null;
let _proxDurationDuSnap = null;
let _proxPuSnap = null;
// True se o user digitou taxa manualmente (override). Aplicarado pra YTM
// no resumo: em vez de bisectar do PU, usa a taxa que ele digitou.
let _proxTaxaManual = false;

function aplicarTitulo(t) {
  document.getElementById("cp-tipo").value = "TPF";
  // Salva o nome amigavel ("NTN-B 2035 Cupom") como codigo do papel
  document.getElementById("cp-codigo").value = _labelTpf(t);
  document.getElementById("cp-emissor").value = "Tesouro Nacional";
  document.getElementById("cp-indexador").value = t.indexador;
  onChangeIndexador();
  if (t.taxa_compra != null) document.getElementById("cp-taxa").value = t.taxa_compra.toFixed(2);
  // pu_emissao = VN par historico (1000) pra NTN-B/F/LTN/Principal/Educa/RendA;
  // LFT mantem o pu_compra do snapshot porque "VN efetivo" da LFT eh ele
  // mesmo (acumulou Selic desde 2000-07-01 e o snapshot ja reflete isso).
  const ehLft = (t.tipo === "LFT");
  document.getElementById("cp-pu-emissao").value = (ehLft && t.pu_compra != null)
    ? t.pu_compra.toFixed(2) : "1000";
  // pu_medio = sugestao de PU de entrada = pu_compra atual do mercado
  if (t.pu_compra != null) document.getElementById("cp-pu-medio").value = t.pu_compra.toFixed(2);
  document.getElementById("cp-data-vencimento").value = t.data_vencimento;
  // Data emissao: hoje (aquisicao no secundario)
  document.getElementById("cp-data-emissao").value = new Date().toISOString().slice(0, 10);
  document.getElementById("cp-cupom-periodo").value = t.cupom_periodo;
  // Amortizacao: anuidade pra RendA+/Educa+, bullet pro resto
  const amort = (t.tipo === "RendA+" || t.tipo === "Educa+") ? "anuidade" : "bullet";
  document.getElementById("cp-amortizacao").value = amort;
  document.getElementById("cp-isento").checked = false;  // TPF sempre tributado
  _atualizarLabelTaxaEntrada();
  _sincTaxaDoPuMedioSync();   // preenche cp-taxa-entrada imediatamente
  const msg = document.getElementById("cp-form-msg");
  msg.textContent = `Preenchido a partir do indice TPF (${t.tipo}).`;
  msg.style.color = "#2a7";
}

// Aplica os valores dos inputs de premissa CDI/IPCA nas variaveis globais
// e re-projeta a carteira pra refletir o impacto.
function _aplicarPremissasUI() {
  const elCdi = document.getElementById("cp-premissa-cdi");
  const elIpca = document.getElementById("cp-premissa-ipca");
  if (elCdi) {
    const v = parseFloat(elCdi.value);
    if (!isNaN(v) && v > 0) _cdiAnualAtual = v;
  }
  if (elIpca) {
    const v = parseFloat(elIpca.value);
    if (!isNaN(v) && v >= 0) _ipcaPremissaAnual = v;
  }
  // Re-projeta se ja houver carteira ativa
  if (_papeisAtual && _papeisAtual.length > 0) projetarCarteiraUI();
}

async function carregarIpcaSerie() {
  try {
    const r = await fetch("data/ipca/serie_mensal.json");
    if (!r.ok) return;
    const d = await r.json();
    _ipcaSerie = d.serie || [];
    if (d.premissa_anual_futura) _ipcaPremissaAnual = d.premissa_anual_futura;
    const el = document.getElementById("cp-premissa-ipca");
    if (el) el.value = _ipcaPremissaAnual.toFixed(2);
  } catch (e) {
    console.warn("Não conseguiu carregar IPCA:", e);
  }
}

async function carregarCdiPremissa() {
  try {
    const r = await fetch("data/selic/serie_diaria.json");
    if (!r.ok) return;
    const d = await r.json();
    // ultima entrada com 'efetiva' nao-null, senao usa 'meta'
    const serie = d.serie || [];
    let ultEf = null, ultMeta = null;
    for (let i = serie.length - 1; i >= 0; i--) {
      const e = serie[i];
      if (ultEf === null && e.efetiva != null) ultEf = e.efetiva;
      if (ultMeta === null && e.meta != null) ultMeta = e.meta;
      if (ultEf !== null) break;
    }
    const selicAnual = ultEf ?? ultMeta;
    if (selicAnual != null) {
      _cdiAnualAtual = +(selicAnual - 0.1).toFixed(2);  // CDI ≈ Selic − 0,1
      const el = document.getElementById("cp-premissa-cdi");
      if (el) el.value = _cdiAnualAtual.toFixed(2);
    }
  } catch (e) {
    console.warn("Não conseguiu carregar CDI:", e);
  }
}

inicializar();

// ── Navegação entre telas ──────────────────────────────────────────────────
function mostrarTela(id) {
  ["tela-login","tela-escolha","tela-carteiras","tela-simulador"].forEach(t => {
    const el = document.getElementById(t);
    if (el) el.style.display = (t === id) ? "" : "none";
  });
}

function atualizarUiAuth() {
  const userSpan  = document.getElementById("auth-header-user");
  const loginMsg  = document.getElementById("auth-header-login-msg");
  const loginBtn  = document.getElementById("auth-header-login");
  if (window.currentUser) {
    userSpan.style.display = "";
    userSpan.innerHTML = `${window.currentUser.email} <button class="auth-btn auth-btn-logout" onclick="logout()">Sair</button>`;
    loginMsg.style.display = "none";
    loginBtn.style.display = "none";
  } else {
    userSpan.style.display = "none";
    loginMsg.style.display = "";
    loginBtn.style.display = "";
  }
}

async function atualizarContagemCarteirasCP() {
  try {
    const lista = await listarCarteirasCP();
    document.getElementById("escolha-count-cp").textContent =
      lista.length ? `${lista.length} salva${lista.length !== 1 ? "s" : ""}` : "Nenhuma ainda";
  } catch (e) {
    console.warn("contagem falhou:", e);
  }
}

async function mostrarMinhasCarteirasCP() {
  mostrarTela("tela-carteiras");
  const cont = document.getElementById("lista-carteiras-cp");
  cont.innerHTML = "<p style='color:#888'>Carregando...</p>";
  const lista = await listarCarteirasCP();
  if (!lista.length) {
    cont.innerHTML = `<p style="color:#888">Nenhuma carteira salva ainda. Clique em "Criar Nova Carteira CP".</p>`;
    return;
  }
  cont.innerHTML = lista.map(c => {
    const n = (c.papeis || []).length;
    const dt = c.updated_at?.toDate?.()?.toLocaleDateString("pt-BR") || "—";
    return `<div class="carteira-item">
      <div class="carteira-item-info">
        <div class="carteira-item-nome">${escapeHtml(c.nome || "(sem nome)")}</div>
        <div class="carteira-item-meta">${n} título${n !== 1 ? "s" : ""} · atualizada ${dt}</div>
      </div>
      <div class="carteira-item-acoes">
        <button class="btn-carteira-acao" onclick="abrirCarteiraCP('${c.id}')">Abrir</button>
        <button class="btn-carteira-acao btn-carteira-del" onclick="excluirCarteiraCP('${c.id}','${escapeHtml(c.nome||'')}')">Excluir</button>
      </div>
    </div>`;
  }).join("");
}

function voltarEscolhaCP() {
  mostrarTela("tela-escolha");
  atualizarContagemCarteirasCP();
}

function mostrarCriarNovaCP() {
  _carteiraIdAtual = null;
  _papeisAtual = [];
  _editandoIdx = null;
  document.getElementById("cp-carteira-nome").value = "";
  resetFormPapel();
  renderPapeis();
  document.getElementById("cp-resultado").style.display = "none";
  mostrarTela("tela-simulador");
}

async function abrirCarteiraCP(id) {
  const ref = userCarteirasCpRef();
  if (!ref) return;
  const doc = await ref.doc(id).get();
  if (!doc.exists) {
    alert("Carteira não encontrada.");
    return;
  }
  const data = doc.data();
  _carteiraIdAtual = id;
  _papeisAtual = data.papeis || [];
  _editandoIdx = null;
  document.getElementById("cp-carteira-nome").value = data.nome || "";
  resetFormPapel();
  renderPapeis();
  document.getElementById("cp-resultado").style.display = "none";
  mostrarTela("tela-simulador");
}

async function excluirCarteiraCP(id, nome) {
  if (!confirm(`Excluir carteira "${nome}"? Esta ação não pode ser desfeita.`)) return;
  try {
    await deletarCarteiraCpFirestore(id);
    mostrarMinhasCarteirasCP();
  } catch (e) {
    alert("Falha ao excluir: " + e.message);
  }
}

// ── Formulário de papel ────────────────────────────────────────────────────
// Mostra/esconde a secao com taxa, datas, cupom, amortizacao etc.
function toggleDetalhes(forcar) {
  const div = document.getElementById("cp-form-detalhes");
  const btn = document.getElementById("cp-btn-detalhes");
  if (!div) return;
  let abrir;
  if (forcar === true)      abrir = true;
  else if (forcar === false) abrir = false;
  else                       abrir = (div.style.display === "none");
  div.style.display = abrir ? "" : "none";
  if (btn) btn.textContent = abrir ? "− Ocultar detalhes" : "+ Criar ativo";
}

function onChangeIndexador() {
  const idx = document.getElementById("cp-indexador").value;
  const lbl = document.getElementById("cp-taxa-label");
  if (idx === "CDIp")        lbl.textContent = "% do CDI (ex: 110)";
  else if (idx === "PREFIX") lbl.textContent = "Taxa prefixada (% a.a.)";
  else                       lbl.textContent = "Spread sobre indexador (% a.a.)";
  _atualizarLabelTaxaEntrada();
}

function resetFormPapel() {
  _editandoIdx = null;
  document.getElementById("cp-tipo").value = "CRI";
  document.getElementById("cp-codigo").value = "";
  document.getElementById("cp-emissor").value = "";
  document.getElementById("cp-indexador").value = "CDI+";
  document.getElementById("cp-taxa").value = "";
  document.getElementById("cp-quantidade").value = "";
  document.getElementById("cp-pu-emissao").value = "1000";
  document.getElementById("cp-pu-medio").value = "";
  document.getElementById("cp-data-emissao").value = "";
  document.getElementById("cp-data-vencimento").value = "";
  document.getElementById("cp-cupom-periodo").value = "mensal";
  document.getElementById("cp-amortizacao").value = "bullet";
  document.getElementById("cp-isento").checked = true;
  document.getElementById("cp-form-msg").textContent = "";
  document.getElementById("cp-btn-adicionar").textContent = "Adicionar à carteira";
  onChangeIndexador();
  popularDatalistTpf();
  toggleDetalhes(false);  // esconde detalhes ao resetar (UI compacta)
  // Auto-marca isento conforme tipo + popula datalist TPF
  document.getElementById("cp-tipo").onchange = () => {
    const t = document.getElementById("cp-tipo").value;
    document.getElementById("cp-isento").checked = ISENTO_POR_TIPO[t] ?? false;
    popularDatalistTpf();
  };
}

function lerPapelFormulario() {
  const tipo = document.getElementById("cp-tipo").value;
  const codigo = document.getElementById("cp-codigo").value.trim();
  const indexador = document.getElementById("cp-indexador").value;
  const taxa = parseFloat(document.getElementById("cp-taxa").value);
  const qtd  = parseInt(document.getElementById("cp-quantidade").value, 10);
  const puEm = parseFloat(document.getElementById("cp-pu-emissao").value);
  const puMed = parseFloat(document.getElementById("cp-pu-medio").value) || puEm;
  const dataEm = document.getElementById("cp-data-emissao").value;
  const dataVc = document.getElementById("cp-data-vencimento").value;
  const cup = document.getElementById("cp-cupom-periodo").value;
  const amort = document.getElementById("cp-amortizacao").value;
  const isento = document.getElementById("cp-isento").checked;

  const erros = [];
  if (!codigo) erros.push("código");
  if (isNaN(taxa)) erros.push("taxa");
  if (isNaN(qtd) || qtd <= 0) erros.push("quantidade");
  if (isNaN(puEm) || puEm <= 0) erros.push("PU emissão");
  if (!dataEm) erros.push("data emissão");
  if (!dataVc) erros.push("data vencimento");
  if (dataVc && dataEm && dataVc <= dataEm) erros.push("vcto deve ser após emissão");
  if (erros.length) {
    const msg = "Faltam/inválidos: " + erros.join(", ");
    const el = document.getElementById("cp-form-msg");
    el.textContent = msg;
    el.style.color = "#c33";
    return null;
  }
  return {
    tipo, codigo,
    emissor: document.getElementById("cp-emissor").value.trim(),
    indexador, taxa,
    quantidade: qtd,
    pu_emissao: puEm,
    pu_medio: puMed,
    data_emissao: dataEm,
    data_vencimento: dataVc,
    cupom_periodo: cup,
    amortizacao: amort,
    isento_ir: isento,
    primeiro_cupom: _proxPrimeiroCupom,
    cronograma_amort_futuro: _proxCronoAmort,
    pct_pu_par_snap: _proxPctPuParSnap,
    duration_du_snap: _proxDurationDuSnap,
    pu_snap: _proxPuSnap,
    // Taxa de entrada (= o que aparece no campo cp-taxa-entrada, na
    // convencao Anbima do indexador: spread CDI, % CDI, real IPCA, etc).
    // Usado pra exibir na carteira via formatTaxa.
    taxa_entrada: parseFloat(document.getElementById("cp-taxa-entrada").value) || null,
    taxa_entrada_manual: _proxTaxaManual,
  };
}

function adicionarPapel() {
  const p = lerPapelFormulario();
  if (!p) return;
  if (_editandoIdx !== null) {
    _papeisAtual[_editandoIdx] = p;
  } else {
    if (_papeisAtual.length >= MAX_PAPEIS_POR_CARTEIRA) {
      alert(`Limite de ${MAX_PAPEIS_POR_CARTEIRA} títulos por carteira.`);
      return;
    }
    _papeisAtual.push(p);
  }
  resetFormPapel();
  renderPapeis();
  const el = document.getElementById("cp-form-msg");
  el.textContent = "Título adicionado.";
  el.style.color = "#1b7a3a";
  setTimeout(() => { if (el.textContent === "Título adicionado.") el.textContent = ""; }, 2000);
}

function editarPapel(idx) {
  const p = _papeisAtual[idx];
  if (!p) return;
  _editandoIdx = idx;
  document.getElementById("cp-tipo").value = p.tipo;
  document.getElementById("cp-codigo").value = p.codigo;
  document.getElementById("cp-emissor").value = p.emissor || "";
  document.getElementById("cp-indexador").value = p.indexador;
  document.getElementById("cp-taxa").value = p.taxa;
  document.getElementById("cp-quantidade").value = p.quantidade;
  document.getElementById("cp-pu-emissao").value = p.pu_emissao;
  document.getElementById("cp-pu-medio").value = p.pu_medio;
  document.getElementById("cp-data-emissao").value = p.data_emissao;
  document.getElementById("cp-data-vencimento").value = p.data_vencimento;
  document.getElementById("cp-cupom-periodo").value = p.cupom_periodo;
  document.getElementById("cp-amortizacao").value = p.amortizacao;
  document.getElementById("cp-isento").checked = !!p.isento_ir;
  // Repoe shadow vars + taxa de entrada calculada
  _proxPrimeiroCupom = p.primeiro_cupom || null;
  _proxCronoAmort = p.cronograma_amort_futuro || null;
  _proxPctPuParSnap = p.pct_pu_par_snap || null;
  _proxDurationDuSnap = p.duration_du_snap || null;
  _proxPuSnap = p.pu_snap || null;
  if (p.taxa_entrada != null) {
    document.getElementById("cp-taxa-entrada").value = p.taxa_entrada;
  } else {
    _sincTaxaDoPuMedioSync();
  }
  _atualizarLabelTaxaEntrada();
  document.getElementById("cp-btn-adicionar").textContent = "Salvar edição";
  document.getElementById("cp-form-papel").open = true;
  onChangeIndexador();
  popularDatalistTpf();
  toggleDetalhes(true);  // editando: mostra detalhes pra inspecao/ajuste
  window.scrollTo({ top: document.getElementById("cp-form-papel").offsetTop - 60, behavior: "smooth" });
}

function removerPapel(idx) {
  if (!confirm(`Remover "${_papeisAtual[idx].codigo}" da carteira?`)) return;
  _papeisAtual.splice(idx, 1);
  renderPapeis();
}

function renderPapeis() {
  const tbody = document.getElementById("cp-tbody");
  const tfoot = document.getElementById("cp-tfoot");
  const wrap  = document.getElementById("cp-salvar-wrapper");
  if (!_papeisAtual.length) {
    tbody.innerHTML = `<tr id="cp-vazio"><td colspan="11" class="sim-vazio-msg">Adicione títulos pelo formulário acima.</td></tr>`;
    tfoot.style.display = "none";
    wrap.style.display = "none";
    return;
  }
  let custoTotal = 0;
  tbody.innerHTML = _papeisAtual.map((p, i) => {
    const custo = p.pu_medio * p.quantidade;
    custoTotal += custo;
    return `<tr>
      <td>${p.tipo}</td>
      <td title="${escapeHtml(p.emissor||'')}">${escapeHtml(p.codigo)}</td>
      <td>${formatIndexador(p.indexador)}</td>
      <td class="num">${formatTaxa(p)}</td>
      <td class="num">${p.quantidade}</td>
      <td class="num">${fmtR$(p.pu_medio)}</td>
      <td class="num">${fmtR$(custo)}</td>
      <td>${fmtDataIso(p.data_vencimento)}</td>
      <td>${formatCupom(p.cupom_periodo)}</td>
      <td>${p.isento_ir ? "isento" : "tabela"}</td>
      <td>
        <button class="btn-tab-acao" onclick="editarPapel(${i})" title="Editar">✎</button>
        <button class="btn-tab-acao btn-tab-del" onclick="removerPapel(${i})" title="Remover">✕</button>
      </td>
    </tr>`;
  }).join("");
  document.getElementById("cp-total-custo").textContent = fmtR$(custoTotal);
  tfoot.style.display = "";
  wrap.style.display = "";
}

// ── Salvar carteira ───────────────────────────────────────────────────────
async function salvarCarteiraCP() {
  if (!window.currentUser) { alert("Faça login primeiro."); return; }
  const nome = document.getElementById("cp-carteira-nome").value.trim();
  if (!nome) { alert("Digite um nome para a carteira."); return; }
  if (!_papeisAtual.length) { alert("Adicione pelo menos 1 título."); return; }
  const status = document.getElementById("cp-salvar-status");
  status.textContent = "Salvando...";
  status.style.color = "#666";
  try {
    const id = await salvarCarteiraCpFirestore(_carteiraIdAtual, {
      nome,
      papeis: _papeisAtual,
    });
    _carteiraIdAtual = id;
    status.textContent = "Salvo.";
    status.style.color = "#1b7a3a";
    setTimeout(() => { status.textContent = ""; }, 2500);
  } catch (e) {
    status.textContent = "Erro: " + e.message;
    status.style.color = "#c33";
  }
}

// ──────────────────────────────────────────────────────────────────────────
//   ENGINE DE PROJEÇÃO
// ──────────────────────────────────────────────────────────────────────────

// Taxa anual EFETIVA do papel (já com indexador atual). É composta em DU/252
// a cada periodo: fator_periodo = (1+taxa_efetiva)^(DU/252).
// Convenção mercado brasileiro CRI/Debenture/CRA:
//   CDI+spread   → (1+CDI)(1+spread) − 1     [composição multiplicativa]
//   IPCA+spread  → spread puro (VNA absorve IPCA separadamente)
//   %CDI         → CDI × pct                  [aproximação aceita p/ simulação]
//   PREFIX       → taxa pura
function taxaSpreadAnual(papel) {
  const cdi   = (_cdiAnualAtual ?? 14.4) / 100;
  const selic = cdi + 0.001;
  // Se taxa foi editada manualmente pelo user, usa ela como spread/taxa
  // base em vez do spread contratual. Cupons em R$ refletem a taxa manual.
  // Convencao por indexador (alinha com display):
  //   IPCA+   -> taxa_entrada eh % real -> spread real
  //   CDI+    -> taxa_entrada eh spread sobre DI -> compoe com CDI
  //   CDIp    -> taxa_entrada eh multiplicador (100 = CDI puro) -> CDI x t
  //   SELIC+  -> spread sobre Selic
  //   PREFIX  -> taxa nominal direta
  const usaManual = papel.taxa_entrada_manual && papel.taxa_entrada != null;
  const t = (usaManual ? papel.taxa_entrada : papel.taxa) / 100;
  switch (papel.indexador) {
    case "IPCA+":   return t;                                // VNA absorve IPCA
    case "CDI+":    return (1 + cdi)   * (1 + t) - 1;        // multiplicativa
    case "CDIp":    return cdi * t;                          // t = 1.10 → 110% CDI
    case "SELIC+":  return (1 + selic) * (1 + t) - 1;
    case "PREFIX":  return t;
    default:        return t;
  }
}

// Fator IPCA acumulado seguindo metodologia ANBIMA pra VNA da NTN-B:
//   - IPCA aplicado integralmente nos dias 15 de cada mes (anchor points)
//   - Entre dois dia-15, pro-rata em dias uteis: (1 + IPCA)^(du1/du2)
//     onde du1 = DU(ultimo 15, dataFim), du2 = DU(ultimo 15, prox 15)
//   - IPCA usado: do mes que sera totalmente aplicado no proximo dia 15
//     (= mes-2 do prox 15). Se ainda nao divulgado, usa projecao.
function fatorIpcaEntre(dataIni, dataFim) {
  if (!dataIni || !dataFim || dataIni >= dataFim) return 1;
  const cal = window.CalendarioDU;
  if (!cal) return _fatorIpcaMesCheio(dataIni, dataFim);

  // Acha ultimo dia 15 <= dataFim e proximo dia 15 > dataFim
  const yFim = parseInt(dataFim.slice(0, 4), 10);
  const mFim = parseInt(dataFim.slice(5, 7), 10);
  const dFim = parseInt(dataFim.slice(8, 10), 10);
  const pad = (n) => String(n).padStart(2, "0");
  let ultimo15, prox15;
  if (dFim >= 15) {
    ultimo15 = `${yFim}-${pad(mFim)}-15`;
    const yp = mFim === 12 ? yFim + 1 : yFim;
    const mp = mFim === 12 ? 1 : mFim + 1;
    prox15 = `${yp}-${pad(mp)}-15`;
  } else {
    const ya = mFim === 1 ? yFim - 1 : yFim;
    const ma = mFim === 1 ? 12 : mFim - 1;
    ultimo15 = `${ya}-${pad(ma)}-15`;
    prox15 = `${yFim}-${pad(mFim)}-15`;
  }

  // Fator IPCA cheio entre dataIni e ultimo15 (todos os meses fechados)
  const fatorFull = _fatorIpcaMesCheio(dataIni, ultimo15);
  if (dataFim === ultimo15) return fatorFull;

  // Pro-rata DU desde ultimo15 ate dataFim
  const du1 = cal.diasUteisEntre(ultimo15, dataFim);
  const du2 = cal.diasUteisEntre(ultimo15, prox15);
  if (du2 <= 0 || du1 <= 0) return fatorFull;
  // IPCA que sera totalmente aplicado no prox 15 = IPCA do mes (prox15 - 2)
  const refProRata = _mesRefIpca(prox15);
  const ipcaProRata = _ipcaMesDecimal(refProRata);
  return fatorFull * Math.pow(1 + ipcaProRata, du1 / du2);
}

// Versao mes-cheio (sem pro-rata) - usada internamente entre dois dia-15.
function _fatorIpcaMesCheio(dataIni, dataFim) {
  if (!dataIni || !dataFim || dataIni >= dataFim) return 1;
  const refIni = _mesRefIpca(dataIni);
  const refFim = _mesRefIpca(dataFim);
  let fator = 1;
  let cur = refIni;
  while (cur < refFim) {
    cur = _proxMes(cur);
    fator *= 1 + _ipcaMesDecimal(cur);
  }
  return fator;
}

function _mesRefIpca(dataISO) {
  // Defasagem M-1 conforme metodologia ANBIMA (Guia de Padronizacao
  // para Calculo de Debentures, secao IPCA pag 11-14): "NIK = valor do
  // numero-indice do IPCA do mes anterior ao mes de atualizacao". Ou
  // seja, o aniversario do dia 15/M aplica o IPCA divulgado em meados
  // de M referente ao mes M-1. Ex.: aniversario 15/05/2024 aplica
  // IPCA-abril (0,38%, divulgado ~10/05/2024).
  // Antes usavamos -2 (= mes M-2), o que causava erro de -0,03% a
  // -0,47% no VNA acumulado vs oficial Tesouro Direto.
  const d = new Date(dataISO + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function _proxMes(ym) {
  const [y, m] = ym.split("-").map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function _ipcaMesDecimal(ym) {
  // Devolve IPCA do mes ym (YYYY-MM) em decimal (ex: 0.0067 = 0.67%).
  // Se nao existe (mes futuro), aplica premissa anual composta mensal.
  const p = _ipcaSerie.find(x => x.mes === ym);
  if (p) return p.valor / 100;
  // Mes futuro -> premissa anual composta: (1 + anual)^(1/12) - 1
  return Math.pow(1 + _ipcaPremissaAnual / 100, 1 / 12) - 1;
}

function mesesEntre(d1, d2) {
  // numero de meses (cheios) entre duas datas YYYY-MM-DD; >=0
  if (!d1 || !d2) return 0;
  const a = new Date(d1 + "T00:00:00");
  const b = new Date(d2 + "T00:00:00");
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1;
  return Math.max(0, m);
}

function addMeses(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

function aliquotaIRRegressiva(diasAplicado) {
  if (diasAplicado <= 180) return 0.225;
  if (diasAplicado <= 360) return 0.20;
  if (diasAplicado <= 720) return 0.175;
  return 0.15;
}

function periodoEmMeses(cup) {
  return { mensal: 1, semestral: 6, anual: 12, zero: 0 }[cup] ?? 1;
}

// Fator IPCA acumulado entre a data-base oficial do VNA e hoje. Pra IPCA+
// (NTN-B/Principal/Educa+/RendA+) retorna ex. ~4.7; pra demais, 1.0.
function fatorIpcaVnaAtual(papel) {
  if (papel.indexador !== "IPCA+") return 1.0;
  const hoje = new Date().toISOString().slice(0, 10);
  return fatorIpcaEntre(DATA_BASE_VNA, hoje);
}

// PU em valor REAL (base R$ 1.000 de 15/07/2000) - usado pra calcular YTM
// real comparavel com a taxa do Tesouro Direto.
function puRealTpf(papel, puPago) {
  return puPago / fatorIpcaVnaAtual(papel);
}

// Quando o usuario muda PU de entrada num TPF, recalcula a taxa em tempo
// real. Pra IPCA+ usa YTM REAL (consistente com snapshot Tesouro); pra
// PREFIX/SELIC usa YTM nominal (que ja eh o que aparece no snapshot).
// Flag pra evitar loop infinito entre _sincTaxaDoPuMedio e _sincPuMedioDaTaxa
let _sincPuTaxaEmCurso = false;
// Debounce timer pra evitar recalcular a cada keystroke (cashflows + bisection
// custam ~50-200ms por ciclo, especialmente pra deb. IPCA+ longas)
let _sincDebounceTimer = null;
const _SINC_DEBOUNCE_MS = 300;

function _debouncedSinc(fn) {
  if (_sincDebounceTimer) clearTimeout(_sincDebounceTimer);
  _sincDebounceTimer = setTimeout(() => {
    _sincDebounceTimer = null;
    fn();
  }, _SINC_DEBOUNCE_MS);
}

// Constroi papel "tentativo" a partir dos campos atuais do form pra cálculos
// de PU<->taxa de entrada. Inclui shadow vars (_proxPrimeiroCupom, etc).
function _papelDoForm(puOverride = null) {
  const tipo = document.getElementById("cp-tipo").value;
  const pu = puOverride != null ? puOverride
           : parseFloat(document.getElementById("cp-pu-medio").value);
  return {
    tipo,
    indexador:       document.getElementById("cp-indexador").value,
    cupom_periodo:   document.getElementById("cp-cupom-periodo").value,
    amortizacao:     document.getElementById("cp-amortizacao").value,
    data_emissao:    document.getElementById("cp-data-emissao").value,
    data_vencimento: document.getElementById("cp-data-vencimento").value,
    pu_emissao:      parseFloat(document.getElementById("cp-pu-emissao").value) || 1000,
    taxa:            parseFloat(document.getElementById("cp-taxa").value) || 0,
    pu_medio:        pu,
    quantidade:      1,
    isento_ir:       document.getElementById("cp-isento").checked,
    primeiro_cupom:  _proxPrimeiroCupom,
    cronograma_amort_futuro: _proxCronoAmort,
    pct_pu_par_snap: _proxPctPuParSnap,
    duration_du_snap: _proxDurationDuSnap,
    pu_snap: _proxPuSnap,
  };
}

// Convencao da taxa de entrada por indexador (alinha com snapshot Anbima):
//   IPCA+  -> taxa REAL (% a.a. acima de IPCA)
//   PREFIX -> taxa NOMINAL (% a.a. direta)
//   CDI+   -> SPREAD sobre DI (= y_nominal_engine deflacionado pelo CDI premissa)
//   CDIp   -> MULTIPLICADOR (= % do CDI, ex: 110)
//   SELIC+ -> SPREAD sobre Selic
function _modoTaxaEntrada(indexador) {
  if (indexador === "IPCA+") return "real";
  if (indexador === "CDI+") return "spread_cdi";
  if (indexador === "CDIp") return "pct_cdi";
  if (indexador === "SELIC+") return "spread_selic";
  return "nominal";
}

function _taxaEntradaEhReal(indexador) { return _modoTaxaEntrada(indexador) === "real"; }

// Calcula YTM nominal "bruta" pelo PU (= bisseccao direta com cashflows nom).
function _calcularYtmNominalDoPu(papel) {
  if (!papel.pu_medio || papel.pu_medio <= 0) return null;
  if (!papel.data_vencimento) return null;
  const hojeISO = new Date().toISOString().slice(0, 10);
  let cfs;
  if (papel.tipo === "TPF") {
    cfs = cashflowsTpf(papel, { real: false });
  } else {
    const evs = _projetarPapelGenerico(papel, "1900-01-01", 600, { real: false });
    cfs = evs.map(e => ({ data: e.data, fluxo: e.juros + e.amort }));
  }
  if (!cfs.length) return null;
  return calcularYtm(cfs, papel.pu_medio, hojeISO);
}

// Calcula a taxa de entrada pra exibicao usando formula Anbima implicita:
//   spread_efetivo = spread_contratual - (pct_pu_par - 1) / duration_anos
// Onde pct_pu_par eh ajustado pelo PU atual vs PU snapshot:
//   pct_pu_par_atual = pct_pu_par_snap * (PU_atual / PU_snap)
//
// Validado em < 5 bps vs snapshots Anbima:
//   EQTL17 (CDI+): 0.6581% vs Anbima 0.6577% (+0.04 bps)
//   VALE48 (IPCA+): 7.36% vs 7.41% (-4 bps)
//   AEAB11 (IPCA+): 8.26% vs 8.38% (-12 bps por duration longa)
//
// Pra IPCA+ longa, formula simples subestima por 10-15 bps. Pra precisao
// extra, usar engine real mode (porem requer cashflows reais corretos).
function _calcularYtmEntrada(papel) {
  if (!papel.pu_medio || papel.pu_medio <= 0) return null;
  const modo = _modoTaxaEntrada(papel.indexador);
  // CDIp eh tratado separado (multiplicador do CDI)
  if (modo === "pct_cdi") {
    const ytmNom = _calcularYtmNominalDoPu(papel);
    const cdi = (_cdiAnualAtual ?? 14.4) / 100;
    return ytmNom != null ? ytmNom / cdi : null;
  }
  const spreadContratualPct = parseFloat(papel.taxa) || 0;
  if (papel.pct_pu_par_snap && papel.duration_du_snap && papel.pu_snap) {
    // Ajusta pct_pu_par pelo PU atual vs PU snapshot. Premio total ate o
    // vcto = (PU - PU_par)/PU_par; spread efetivo = contratual - premio/dur.
    const pctParAtual = papel.pct_pu_par_snap * (papel.pu_medio / papel.pu_snap);
    const durAnos = papel.duration_du_snap / 252;
    const premio = (pctParAtual / 100) - 1;
    return (spreadContratualPct - (premio * 100) / durAnos) / 100;
  }
  // Fallback: papel sem dados de snapshot Anbima (deb. avulsa criada
  // manualmente). Usa engine bisseccao + Fisher.
  const ytmNom = _calcularYtmNominalDoPu(papel);
  if (ytmNom == null) return null;
  const cdi = (_cdiAnualAtual ?? 14.4) / 100;
  const selic = cdi + 0.001;
  switch (modo) {
    case "spread_cdi":   return (1 + ytmNom) / (1 + cdi) - 1;
    case "spread_selic": return (1 + ytmNom) / (1 + selic) - 1;
    case "real":         return ytmNom;  // ja eh real via engine
    case "nominal":
    default:             return ytmNom;
  }
}

// Inverso: dado uma taxa, calcula PU implicito (PV dos cashflows @ taxa)
function _calcularPuDaTaxa(papel, taxaAnual) {
  if (!papel.data_vencimento) return null;
  const hojeISO = new Date().toISOString().slice(0, 10);
  const ehReal = _taxaEntradaEhReal(papel.indexador);
  let cfs;
  if (papel.tipo === "TPF") {
    cfs = cashflowsTpf(papel, { real: ehReal });
  } else {
    const evs = _projetarPapelGenerico(papel, "1900-01-01", 600, { real: ehReal });
    cfs = evs.map(e => ({ data: e.data, fluxo: e.juros + e.amort }));
  }
  if (!cfs.length) return null;
  const cal = window.CalendarioDU;
  const dCompra = new Date(hojeISO + "T00:00:00Z");
  let pvReal = 0;
  for (const cf of cfs) {
    if (cf.data < hojeISO) continue;
    const du = cal.diasUteisEntre(hojeISO, cf.data);
    pvReal += cf.fluxo / Math.pow(1 + taxaAnual, du / 252);
  }
  if (!ehReal) return pvReal;
  // Pra IPCA+: PU nominal = PV_real x fator_IPCA(data_base -> hoje)
  if (papel.tipo === "TPF") {
    return pvReal * fatorIpcaVnaAtual(papel);
  }
  if (papel.data_emissao) {
    return pvReal * fatorIpcaEntre(papel.data_emissao, hojeISO);
  }
  return pvReal;
}

// Versao SINCRONA usada por aplicarTitulo/Debenture (precisa popular taxa
// imediatamente apos selecionar o papel - sem debounce).
function _sincTaxaDoPuMedioSync() {
  if (_sincPuTaxaEmCurso) return;
  const papel = _papelDoForm();
  const ytm = _calcularYtmEntrada(papel);
  if (ytm == null) return;
  _sincPuTaxaEmCurso = true;
  document.getElementById("cp-taxa-entrada").value = (ytm * 100).toFixed(4);
  _proxTaxaManual = false;   // ao sincronizar do PU, deixa de ser override
  _sincPuTaxaEmCurso = false;
}

// Marca que a taxa atual foi digitada pelo user (override do PU)
function _marcarTaxaManual() {
  _proxTaxaManual = true;
}

// Quando user muda PU (oninput): debounce pra nao recalcular a cada
// keystroke. Calculo de YTM custa ~50-200ms - sem debounce trava a UI.
function _sincTaxaDoPuMedio() {
  if (_sincPuTaxaEmCurso) return;
  _debouncedSinc(_sincTaxaDoPuMedioSync);
}

function _sincPuMedioDaTaxaSync() {
  if (_sincPuTaxaEmCurso) return;
  const taxaPct = parseFloat(document.getElementById("cp-taxa-entrada").value);
  if (isNaN(taxaPct)) return;
  const papel = _papelDoForm();
  const pu = _calcularPuDaTaxa(papel, taxaPct / 100);
  if (pu == null || pu <= 0) return;
  _sincPuTaxaEmCurso = true;
  document.getElementById("cp-pu-medio").value = pu.toFixed(2);
  _sincPuTaxaEmCurso = false;
}

function _sincPuMedioDaTaxa() {
  if (_sincPuTaxaEmCurso) return;
  _debouncedSinc(_sincPuMedioDaTaxaSync);
}

// Atualiza o label do campo conforme indexador (real, spread, %CDI, nominal)
function _atualizarLabelTaxaEntrada() {
  const idx = document.getElementById("cp-indexador").value;
  const el = document.getElementById("cp-taxa-entrada-label");
  if (!el) return;
  switch (_modoTaxaEntrada(idx)) {
    case "real":         el.textContent = "Taxa de entrada (% a.a. real)"; break;
    case "spread_cdi":   el.textContent = "Spread sobre DI (% a.a.)"; break;
    case "spread_selic": el.textContent = "Spread sobre Selic (% a.a.)"; break;
    case "pct_cdi":      el.textContent = "Taxa de entrada (% do CDI)"; break;
    default:             el.textContent = "Taxa de entrada (% a.a.)";
  }
}

// ── TPF: cupom interno e projecao especifica ──────────────────────────────
// Reconhece o subtipo de TPF a partir de (indexador, cupom_periodo, amortizacao)
// pra aplicar o cupom interno correto (NTN-B = 6%, NTN-F = 10%, LFT = Selic, etc.).
function inferirTipoCurtoTpf(papel) {
  if (papel.tipo !== "TPF") return null;
  if (papel.amortizacao === "anuidade") return "RendA+/Educa+";  // pagamento mensal pos-vcto
  const i = papel.indexador;
  const c = papel.cupom_periodo;
  if (i === "IPCA+"  && c === "semestral") return "NTN-B";
  if (i === "IPCA+"  && c === "zero")      return "NTN-B Principal";
  if (i === "PREFIX" && c === "semestral") return "NTN-F";
  if (i === "PREFIX" && c === "zero")      return "LTN";
  if (i === "SELIC+" && c === "zero")      return "LFT";
  return null;
}

// Cupom interno fixo do TPF (% a.a. sobre o VN/VNA correspondente).
const CUPOM_INTERNO_TPF = {
  "NTN-B":           0.06,  // 6% sobre VNA (corrigido por IPCA)
  "NTN-B Principal": 0.00,
  "NTN-F":           0.10,  // 10% sobre VN nominal R$ 1.000
  "LTN":             0.00,
  "LFT":             0.00,  // acumula Selic, sem cupom
};

// Data base oficial do VNA de NTN-B / NTN-B Principal (e usada tambem como
// proxy para Educa+/RendA+). Fator IPCA acumulado dessa data ate hoje
// transforma "PU nominal pago" em "PU real" (base R$ 1.000).
const DATA_BASE_VNA = "2000-07-15";

// Cashflows de um TPF (em unidade por titulo - serao multiplicados por qtd
// depois). Retorna [{data, fluxo}, ...] em ordem cronologica.
// opt.real = true -> cashflows reais (sem multiplicar pelo fator IPCA);
// usado pra YTM real comparavel com taxa snapshot do Tesouro Direto.
function cashflowsTpf(papel, opt = {}) {
  const real = opt.real === true;
  const sub = inferirTipoCurtoTpf(papel);
  if (!sub) return [];
  // VN base:
  // - LFT: usa pu_emissao (snapshot, que ja reflete Selic acumulada desde 2000)
  // - Demais: VN historico R$ 1.000 (par real de NTN-B/F/LTN, ignora pu_emissao
  //   do form que vem do PU snapshot, NAO eh o par real)
  const VN = (sub === "LFT") ? (papel.pu_emissao || 1000) : 1000;
  const dataEmissao = papel.data_emissao;
  const dataVcto    = papel.data_vencimento;
  const cal = window.CalendarioDU;
  if (!cal) return [];

  // Fator IPCA pra cashflows NOMINAIS de IPCA+: usa data-base oficial do VNA
  // (15/07/2000), nao a data de aquisicao no secundario. Em modo REAL, fator=1.
  const usaVna = (papel.indexador === "IPCA+") && !real;
  const dataBaseFator = DATA_BASE_VNA;

  const cashflows = [];

  if (sub === "LFT") {
    // Zero coupon que acumula Selic. PU snapshot ja reflete a Selic acumulada
    // do passado; pro futuro aplicamos a Selic atual ate vcto. Cashflow unico
    // no vcto = pu_emissao × (1 + Selic_anual)^(DU/252).
    const selicAnual = (_cdiAnualAtual ?? 13.5) / 100;  // fallback
    const du = cal.diasUteisEntre(dataEmissao, dataVcto);
    const valorFinal = VN * Math.pow(1 + selicAnual, du / 252);
    cashflows.push({ data: dataVcto, fluxo: valorFinal });
    return cashflows;
  }

  if (sub === "RendA+/Educa+") {
    // Apos a data_vencimento, paga 240 parcelas mensais (20 anos).
    // Cada parcela = VNA_na_data × (anuidade_constante / 240). Pra simplificar
    // o MVP: parcela igual em VNA (cresce com IPCA), valor = (VN_emissao corrigido) / 240.
    // Total recebido ao longo de 20 anos = VN corrigido × algum fator.
    // Aproximacao: assume que o usuario "recebe" mensalmente VN_emissao
    // (R$ 1000 default) / 240 × fator_ipca_na_data_parcela.
    const ANOS_ANUIDADE = 20;
    const NUM_PARCELAS = 12 * ANOS_ANUIDADE;
    const parcelaBase = VN / NUM_PARCELAS;
    for (let i = 1; i <= NUM_PARCELAS; i++) {
      const dataParcela = addMeses(dataVcto, i);  // i meses apos vcto
      const fator = usaVna ? fatorIpcaEntre(dataBaseFator, dataParcela) : 1;
      cashflows.push({ data: dataParcela, fluxo: parcelaBase * fator });
    }
    return cashflows;
  }

  // Bullets normais: NTN-B, NTN-B Principal, NTN-F, LTN
  const cupomAnual = CUPOM_INTERNO_TPF[sub] ?? 0;
  const cupomSemestralRate = Math.pow(1 + cupomAnual, 0.5) - 1;  // 2,956% pra 6%

  if (papel.cupom_periodo === "zero") {
    // NTN-B Principal e LTN: 1 unico cashflow no vcto
    const fator = usaVna ? fatorIpcaEntre(dataBaseFator, dataVcto) : 1;
    const valorFinal = VN * fator;
    cashflows.push({ data: dataVcto, fluxo: valorFinal });
    return cashflows;
  }

  // NTN-B / NTN-F: cupom semestral + principal no vcto
  // Gera datas de pagamento: a cada 6 meses contando do vcto pra tras
  const datasPgto = [];
  let cur = dataVcto;
  while (cur > dataEmissao) {
    datasPgto.unshift(cur);
    cur = addMeses(cur, -6);
  }
  // Cupom em cada data; no vcto soma o principal (VNA atualizado)
  for (let k = 0; k < datasPgto.length; k++) {
    const d = datasPgto[k];
    const fator = usaVna ? fatorIpcaEntre(dataBaseFator, d) : 1;
    const cupom = VN * fator * cupomSemestralRate;
    if (k === datasPgto.length - 1) {
      // ultima data: cupom final + principal (VNA atualizado)
      cashflows.push({ data: d, fluxo: cupom + VN * fator });
    } else {
      cashflows.push({ data: d, fluxo: cupom });
    }
  }
  return cashflows;
}

// YTM efetiva por bisection. Dado cashflows futuros (data + fluxo) e o PU pago
// no ato da compra (data_compra), encontra a taxa anual tal que
//   PU = SUM(fluxo_k / (1 + YTM)^(DU(data_compra -> data_k) / 252))
// Retorna a YTM em decimal anual (ex: 0.077 = 7,7% a.a.) ou null se nao achar.
function calcularYtm(cashflows, puPago, dataCompraIso) {
  const cal = window.CalendarioDU;
  if (!cal || !cashflows.length || puPago <= 0) return null;
  // Mantem so fluxos futuros (apos data_compra)
  const futuros = cashflows.filter(c => c.data > dataCompraIso);
  if (!futuros.length) return null;
  const npv = (taxa) => {
    let s = 0;
    for (const cf of futuros) {
      const du = cal.diasUteisEntre(dataCompraIso, cf.data);
      s += cf.fluxo / Math.pow(1 + taxa, du / 252);
    }
    return s - puPago;
  };
  // Bisection em [0%, 100%]
  let lo = 0.0001, hi = 1.0;
  let nLo = npv(lo), nHi = npv(hi);
  if (nLo * nHi > 0) {
    // Sem mudanca de sinal — provavelmente PU fora da faixa razoavel.
    return null;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const nMid = npv(mid);
    if (Math.abs(nMid) < 0.001) return mid;
    if (nMid * nLo < 0) { hi = mid; nHi = nMid; }
    else                { lo = mid; nLo = nMid; }
  }
  return (lo + hi) / 2;
}

// Projeta um TPF retornando eventos no formato esperado pela engine atual.
function projetarPapelTpf(papel, hojeISO) {
  const cashflows = cashflowsTpf(papel);
  if (!cashflows.length) return [];
  const qtd = papel.quantidade;
  // Separa juros vs amort: principal so na ultima data (ou em cada parcela
  // pra anuidade). Pra simplificar IR/UI, juros = fluxo - amort.
  const sub = inferirTipoCurtoTpf(papel);
  const eventos = [];
  for (let k = 0; k < cashflows.length; k++) {
    const cf = cashflows[k];
    if (cf.data < hojeISO) continue;
    let amortUnit, jurosUnit;
    if (sub === "RendA+/Educa+") {
      // Cada parcela e mistura juros+amort. Aproximacao: 50/50 (sera revisto)
      amortUnit = cf.fluxo * 0.5;
      jurosUnit = cf.fluxo * 0.5;
    } else if (k === cashflows.length - 1) {
      // Ultima data: principal + ultimo cupom. Para coerencia com cashflowsTpf:
      // - LFT: VN = pu_emissao (snapshot). Demais: VN = 1000 (par real).
      // - IPCA+: aplica fator IPCA desde DATA_BASE_VNA (15/07/2000), nao data_emissao
      const subFinal = inferirTipoCurtoTpf(papel);
      const VN = (subFinal === "LFT") ? (papel.pu_emissao || 1000) : 1000;
      const fator = (papel.indexador === "IPCA+") ? fatorIpcaEntre(DATA_BASE_VNA, cf.data) : 1;
      amortUnit = VN * fator;
      jurosUnit = cf.fluxo - amortUnit;
    } else {
      // Cupom intermediario: tudo eh juros
      amortUnit = 0;
      jurosUnit = cf.fluxo;
    }
    const irUnit = papel.isento_ir ? 0 : jurosUnit * aliquotaIRRegressiva(diasEntre(papel.data_emissao, cf.data));
    eventos.push({
      data:    cf.data,
      juros:   jurosUnit * qtd,
      amort:   amortUnit * qtd,
      ir:      irUnit    * qtd,
      liquido: (jurosUnit + amortUnit - irUnit) * qtd,
    });
  }
  return eventos;
}

function projetarPapel(papel, hojeISO, mesesAFrente) {
  // TPF: usa cupom interno correto (NTN-B 6%, NTN-F 10%, etc) em vez da taxa
  // de mercado direta. Cashflows projetados pela engine TPF, nao a generica.
  if (papel.tipo === "TPF") {
    return projetarPapelTpf(papel, hojeISO);
  }
  // CRI/CRA/DEB/LCI/LCA: convencao brasileira (engine generica abaixo)
  return _projetarPapelGenerico(papel, hojeISO, mesesAFrente);
}

// Cashflows da carteira em modo NOMINAL (R$ correntes, TPF IPCA+ ja com IPCA)
// ou REAL (R$ base 2000, TPF IPCA+ sem multiplicar IPCA).
function cashflowsCarteira(papeis, opt = {}) {
  const real = opt.real === true;
  const todos = [];
  for (const p of papeis) {
    let cfs = [];
    if (p.tipo === "TPF") {
      cfs = cashflowsTpf(p, { real }).map(c => ({ data: c.data, fluxo: c.fluxo * p.quantidade }));
    } else {
      // Non-TPF (CRI/CRA/DEB/LCI/LCA): passa opt.real pra engine pra que ela
      // gere cashflows reais (sem multiplicar IPCA forward) ou nominais.
      const evs = _projetarPapelGenerico(p, "1900-01-01", 600, { real });
      cfs = evs.map(e => ({ data: e.data, fluxo: e.juros + e.amort }));
    }
    for (const cf of cfs) todos.push(cf);
  }
  return todos.sort((a, b) => a.data.localeCompare(b.data));
}

// PU total pago da carteira em valor REAL (descontando o IPCA acumulado).
// Pra TPF IPCA+: divide pelo VNA atual (= 1000 * IPCA acumulado desde 2000-07-15).
// Pra non-TPF IPCA+ (debentures, CRI/CRA com indexador IPCA+): divide pelo
// fator IPCA(data_emissao -> hoje). Pra deb. amortizada onde a aplicarDebenture
// setou data_emissao = data_vna (~hoje), fator ~1 e PU real ~PU nominal,
// mas os cashflows reais sao diferentes (sem IPCA forward), o que diferencia
// as YTMs corretamente.
function puPagoCarteiraReal(papeis) {
  const hojeISO = new Date().toISOString().slice(0, 10);
  return papeis.reduce((s, p) => {
    let fator = 1.0;
    if (p.tipo === "TPF") {
      fator = fatorIpcaVnaAtual(p);
    } else if (p.indexador === "IPCA+" && p.data_emissao) {
      fator = fatorIpcaEntre(p.data_emissao, hojeISO);
    }
    return s + (p.pu_medio * p.quantidade) / fator;
  }, 0);
}

function ytmCarteiraNominal(papeis, dataCompraIso, puPagoNominal) {
  if (puPagoNominal <= 0 || !papeis.length) return null;
  const cfs = cashflowsCarteira(papeis, { real: false });
  return calcularYtm(cfs, puPagoNominal, dataCompraIso);
}

function ytmCarteiraReal(papeis, dataCompraIso) {
  if (!papeis.length) return null;
  // Pra papeis IPCA+ (TPF ou debentures): engine ja gera cashflows reais
  // (sem IPCA forward) e PU real (dividindo por fator IPCA acumulado).
  // Pra non-IPCA+ (CDI+/CDIp/SELIC+/PREFIX): engine projeta cashflows
  // NOMINAIS com CDI/Selic premissa embutida no spread efetivo. Pra
  // converter a YTM nominal -> real, aplicamos Fisher pos-engine:
  //   y_real = (1 + y_nom) / (1 + ipca_premissa) - 1
  // Pra carteira mista, ponderamos pela exposicao IPCA+ vs nao.
  const cfs = cashflowsCarteira(papeis, { real: true });
  const puReal = puPagoCarteiraReal(papeis);
  const yEngine = calcularYtm(cfs, puReal, dataCompraIso);
  if (yEngine == null) return null;
  // Calcula fracao da carteira em CDI+/CDIp/SELIC+/PREFIX (precisam Fisher)
  const custoTotal = papeis.reduce((s, p) => s + p.pu_medio * p.quantidade, 0);
  if (custoTotal <= 0) return yEngine;
  const ehNominal = idx => ["CDI+", "CDIp", "SELIC+", "PREFIX"].includes(idx);
  const custoNominal = papeis.reduce(
    (s, p) => s + (ehNominal(p.indexador) ? p.pu_medio * p.quantidade : 0), 0);
  const fracNominal = custoNominal / custoTotal;
  if (fracNominal <= 0) return yEngine;
  // Aplica Fisher ponderado: a parte nominal precisa ser deflacionada pelo
  // IPCA premissa; a parte IPCA+ ja foi tratada pela engine.
  const ipca = (_ipcaPremissaAnual ?? 4.5) / 100;
  // y_real ponderado: (1 + y_engine) / (1 + ipca * fracNominal) - 1
  return (1 + yEngine) / (1 + ipca * fracNominal) - 1;
}

function _projetarPapelGenerico(papel, hojeISO, mesesAFrente, opt = {}) {
  // Convenção brasileira (CRI/CRA/Debenture/TPF):
  //   fator_spread_k = (1 + spread_anual)^(DU_k / 252)
  //   cupom_k = VNA_k × (fator_spread_k - 1)
  // Onde DU_k = dias úteis entre cupom_{k-1} (ou emissão) e cupom_k.
  // Para IPCA+: VNA atualiza pelo IPCA mensal (defasagem 2m); para os demais
  // indexadores, VNA = pu_emissao constante.
  // Quando opt.real=true e indexador=IPCA+: nao multiplica VNA pelo IPCA
  // forward - gera cashflows em R$ base data_emissao (espaco real).
  const real         = opt.real === true;
  const dataEmissao  = papel.data_emissao;
  const dataVencto   = papel.data_vencimento;
  const totalMeses   = mesesEntre(dataEmissao, dataVencto);
  if (totalMeses <= 0) return [];
  const periodoMeses = periodoEmMeses(papel.cupom_periodo);
  const tSpread      = taxaSpreadAnual(papel);
  const VN           = papel.pu_emissao;
  const qtd          = papel.quantidade;
  const usaIpcaVna   = (papel.indexador === "IPCA+") && !real;
  const eventos      = [];
  const cal          = window.CalendarioDU;
  if (!cal) {
    console.error("CalendarioDU não carregado");
    return [];
  }

  // CASO 1: Zero coupon (sem pagamento intermediário; principal+juros no vcto)
  if (papel.cupom_periodo === "zero") {
    const dataPgto = cal.proximaDataPagamento(dataEmissao, totalMeses);
    if (dataPgto < hojeISO) return [];
    const du       = cal.diasUteisEntre(dataEmissao, dataPgto);
    const vnaFinal = usaIpcaVna ? VN * fatorIpcaEntre(dataEmissao, dataPgto) : VN;
    const fatorSpread = Math.pow(1 + tSpread, du / 252);
    const valorFinal  = vnaFinal * fatorSpread;
    const jurosUnit   = valorFinal - VN;       // ganho total
    const amortUnit   = VN;
    const irUnit      = papel.isento_ir
      ? 0
      : jurosUnit * aliquotaIRRegressiva(diasEntre(dataEmissao, dataPgto));
    eventos.push({
      data:    dataPgto,
      juros:   jurosUnit * qtd,
      amort:   amortUnit * qtd,
      ir:      irUnit    * qtd,
      liquido: (jurosUnit + amortUnit - irUnit) * qtd,
    });
    return eventos;
  }

  // CASO 2: Cupom periódico (mensal / semestral / anual)
  // Se o papel tem primeiro_cupom definido (vindo do SND pras debentures),
  // usa esse como ancora; senao, gera a partir de dataEmissao + periodo.
  const temPrimeiroCupom = !!papel.primeiro_cupom && papel.primeiro_cupom > dataEmissao;
  const baseData = temPrimeiroCupom ? papel.primeiro_cupom : dataEmissao;
  const nParcelas = temPrimeiroCupom
    ? Math.max(1, Math.round(mesesEntre(papel.primeiro_cupom, dataVencto) / periodoMeses) + 1)
    : Math.max(1, Math.floor(totalMeses / periodoMeses));

  // Cronograma de amortizacao futuro (preferencia: cronograma_amort_futuro
  // que tem o % real do termo Anbima; fallback: cronograma_amort_futuro_
  // estimado que tem estimativa uniforme). Quando presente, sobrescreve o
  // comportamento bullet/price: usamos as datas e valores como amortizacoes
  // que reduzem saldoFrac ao longo do tempo.
  const cronoFonte = papel.cronograma_amort_futuro || papel.cronograma_amort_futuro_estimado || [];
  const cronoAmort = cronoFonte
    .filter(c => c.data >= hojeISO)
    .map(c => ({ data: c.data, valor: c.valor_estimado }));
  const usaCronoAmort = cronoAmort.length > 0;

  // Inicializa VNA. Para IPCA+, VNA acompanha correção; para os demais,
  // fica em VN.
  let vna  = VN;
  let saldoFrac = 1.0;        // fração do principal ainda viva (Price decresce)
  let dataAnt = dataEmissao;

  // Pra Price: parcela constante por período (sobre VN inicial). Cálculo
  // é uma aproximação razoável porque a taxa do período varia ligeiramente
  // com DU. Usamos DU = ~21 (mensal) / 126 (semestral) / 252 (anual).
  let pmtFracPrice = 0;
  if (papel.amortizacao === "price") {
    const duMedio = { 1: 21, 6: 126, 12: 252 }[periodoMeses] || 21;
    const tPerMedio = Math.pow(1 + tSpread, duMedio / 252) - 1;
    pmtFracPrice = tPerMedio / (1 - Math.pow(1 + tPerMedio, -nParcelas));
  }

  for (let p = 1; p <= nParcelas; p++) {
    const offsetMeses = temPrimeiroCupom ? (p - 1) * periodoMeses : p * periodoMeses;
    const dataPgto = cal.proximaDataPagamento(baseData, offsetMeses);
    const eVencto  = (p === nParcelas);
    const du       = cal.diasUteisEntre(dataAnt, dataPgto);
    if (usaIpcaVna) vna *= fatorIpcaEntre(dataAnt, dataPgto);
    const fatorSpread = Math.pow(1 + tSpread, du / 252);
    let jurosUnit = 0, amortUnit = 0, irUnit = 0;

    if (usaCronoAmort) {
      // Engine com cronograma real: juros sobre saldo atual + amort se a
      // data deste cupom bate com (ou esta proxima a) uma data do cronograma.
      jurosUnit = vna * saldoFrac * (fatorSpread - 1);
      const tolDias = 30;
      const amortMatch = cronoAmort.find(c => Math.abs(diasEntre(c.data, dataPgto)) <= tolDias);
      if (amortMatch) {
        amortUnit = amortMatch.valor;
        // Reduz saldoFrac proporcionalmente ao saldo VN atual
        const fracAmort = (vna > 0) ? (amortUnit / vna) : 0;
        saldoFrac = Math.max(0, saldoFrac - fracAmort);
      }
      if (eVencto && saldoFrac > 0) {
        // No vcto, liquida o saldo remanescente (alem do que o crono ja agendou)
        amortUnit += vna * saldoFrac;
        saldoFrac = 0;
      }
    } else if (papel.amortizacao === "bullet") {
      jurosUnit = vna * saldoFrac * (fatorSpread - 1);
      amortUnit = eVencto ? vna * saldoFrac : 0;
      // bullet não muda saldoFrac até o vcto
    } else { // price
      const baseJuros = vna * saldoFrac;
      jurosUnit       = baseJuros * (fatorSpread - 1);
      const pmt       = vna * pmtFracPrice;
      amortUnit       = Math.max(0, pmt - jurosUnit);
      if (eVencto) amortUnit = baseJuros;   // liquida o que sobrou
      const fracAmort = vna * saldoFrac > 0 ? amortUnit / (vna * saldoFrac) : 0;
      saldoFrac      *= (1 - fracAmort);
    }

    if (!papel.isento_ir && jurosUnit > 0) {
      irUnit = jurosUnit * aliquotaIRRegressiva(diasEntre(dataEmissao, dataPgto));
    }

    dataAnt = dataPgto;

    if (dataPgto < hojeISO) continue;        // cupom passado
    if (mesesAFrente && eventos.length >= mesesAFrente) break;

    eventos.push({
      data:    dataPgto,
      juros:   jurosUnit * qtd,
      amort:   amortUnit * qtd,
      ir:      irUnit    * qtd,
      liquido: (jurosUnit + amortUnit - irUnit) * qtd,
    });
  }
  return eventos;
}

function diasEntre(d1ISO, d2ISO) {
  return (new Date(d2ISO + "T00:00:00") - new Date(d1ISO + "T00:00:00")) / 86400000;
}

function agregarPorMes(eventosTodos) {
  const map = new Map();
  for (const ev of eventosTodos) {
    const k = ev.data.slice(0, 7);  // YYYY-MM
    if (!map.has(k)) map.set(k, { mes: k, juros: 0, amort: 0, ir: 0, liquido: 0 });
    const acc = map.get(k);
    acc.juros   += ev.juros;
    acc.amort   += ev.amort;
    acc.ir      += ev.ir;
    acc.liquido += ev.liquido;
  }
  return [...map.values()].sort((a, b) => a.mes < b.mes ? -1 : 1);
}

// ── Render projeção ────────────────────────────────────────────────────────
function projetarCarteiraUI() {
  if (!_papeisAtual.length) { alert("Adicione títulos primeiro."); return; }
  const hojeISO = new Date().toISOString().slice(0, 10);
  const todos = [];
  for (const p of _papeisAtual) {
    const evs = projetarPapel(p, hojeISO, 120);
    for (const e of evs) todos.push(e);
  }
  const meses = agregarPorMes(todos);
  if (!meses.length) {
    alert("Nenhum fluxo futuro projetado (verifique datas dos títulos).");
    return;
  }

  // Resumo
  const proximos12 = meses.slice(0, 12);
  const totalLiq12 = proximos12.reduce((s, m) => s + m.liquido, 0);
  const medioMes   = totalLiq12 / Math.min(12, proximos12.length);
  const custoTotal = _papeisAtual.reduce((s, p) => s + p.pu_medio * p.quantidade, 0);
  // Yield 12m sobre custo: quanto do capital volta como renda nos
  // proximos 12 meses (= total liq 12m / custo). Substitui o antigo
  // "yield mensal" que dividia por 12 - papeis semestrais/anuais nao
  // pagam mensalmente, entao a media era enganosa.
  const yield12m = custoTotal > 0 ? (totalLiq12 / custoTotal) * 100 : 0;
  const proxVcto = [..._papeisAtual]
    .map(p => p.data_vencimento)
    .filter(d => d >= hojeISO)
    .sort()[0] || "—";

  document.getElementById("cp-resumo-renda-media").textContent = fmtR$(medioMes);
  document.getElementById("cp-resumo-renda-12m").textContent   = fmtR$(totalLiq12);
  document.getElementById("cp-resumo-yield-12m-pct").textContent = yield12m.toFixed(2).replace(".", ",") + "%";
  document.getElementById("cp-resumo-prox-vcto").textContent   = fmtDataIso(proxVcto);

  // YTM efetiva agregada da carteira em DUAS visoes:
  //   nominal: cashflows IPCA-corrected (renda total que o investidor recebe)
  //   real:    cashflows sem IPCA (comparavel com taxa snapshot Tesouro)
  // Override de YTM por papel: se taxa_entrada_manual, usa a taxa que o
  // user digitou (convertida pra nominal) em vez de bisectar do PU. Pra
  // carteira mista, faz media ponderada por custo.
  function _ytmNomOverride() {
    if (!_papeisAtual.every(p => p.taxa_entrada_manual && p.taxa_entrada != null)) {
      return null;  // sem override total -> usa bisseccao normal
    }
    const cdi = (_cdiAnualAtual ?? 14.4) / 100;
    const selic = cdi + 0.001;
    const ipca = (_ipcaPremissaAnual ?? 4.5) / 100;
    let sw = 0, sy = 0;
    for (const p of _papeisAtual) {
      const peso = p.pu_medio * p.quantidade;
      const t = p.taxa_entrada / 100;
      let yNom;
      switch (p.indexador) {
        case "IPCA+":   yNom = (1 + t) * (1 + ipca) - 1; break;
        case "CDI+":    yNom = (1 + t) * (1 + cdi) - 1;  break;
        case "CDIp":    yNom = (p.taxa_entrada) * cdi;   break; // p.taxa_entrada em decimal multiplicador (1.10)
        case "SELIC+":  yNom = (1 + t) * (1 + selic) - 1; break;
        case "PREFIX":  yNom = t; break;
        default:        yNom = t;
      }
      sw += peso; sy += yNom * peso;
    }
    return sw > 0 ? sy / sw : null;
  }
  const ytmNomOverride = _ytmNomOverride();
  const ytmNom = ytmNomOverride != null
    ? ytmNomOverride
    : ytmCarteiraNominal(_papeisAtual, hojeISO, custoTotal);
  // YTM real so faz sentido pra carteira com exposicao IPCA+.
  const temIpca = _papeisAtual.some(p =>
    p.indexador === "IPCA+" || (p.tipo === "TPF" && p.indexador === "IPCA+"));
  const fmtY = v => (v != null) ? (v * 100).toFixed(2).replace(".", ",") + "%" : "—";
  document.getElementById("cp-resumo-ytm").textContent = fmtY(ytmNom);
  const elReal = document.getElementById("cp-resumo-ytm-real");
  const elRealLabel = document.querySelector("[for='cp-resumo-ytm-real']")
    || elReal?.previousElementSibling
    || elReal?.parentElement;
  if (elReal) {
    if (temIpca) {
      const ytmReal = ytmCarteiraReal(_papeisAtual, hojeISO);
      elReal.textContent = fmtY(ytmReal);
      if (elReal.parentElement) elReal.parentElement.style.display = "";
    } else {
      // Sem IPCA na carteira: esconde a linha de YTM real
      if (elReal.parentElement) elReal.parentElement.style.display = "none";
    }
  }

  // Cronograma detalhado
  document.getElementById("cp-cronograma-body").innerHTML = meses.map(m => `
    <tr>
      <td>${fmtMesIso(m.mes)}</td>
      <td class="num">${fmtR$(m.juros)}</td>
      <td class="num">${m.amort > 0 ? fmtR$(m.amort) : "—"}</td>
      <td class="num">${m.ir > 0 ? fmtR$(m.ir) : "—"}</td>
      <td class="num"><strong>${fmtR$(m.liquido)}</strong></td>
    </tr>
  `).join("");

  // Gráfico (bar chart de juros liquidos + linha de amortizacoes)
  renderChart(meses);

  document.getElementById("cp-resultado").style.display = "";
  document.getElementById("cp-resultado").scrollIntoView({ behavior: "smooth" });
}

function renderChart(meses) {
  const ctx = document.getElementById("cp-chart");
  if (_chartProjecao) _chartProjecao.destroy();
  const labels = meses.map(m => fmtMesIso(m.mes));
  const dataJuros = meses.map(m => +(m.juros - m.ir).toFixed(2));
  const dataAmort = meses.map(m => +m.amort.toFixed(2));
  _chartProjecao = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Cupom líquido", data: dataJuros, backgroundColor: "rgba(46,160,67,0.7)", stack: "x" },
        { label: "Amortização",   data: dataAmort, backgroundColor: "rgba(31,119,180,0.6)", stack: "x" },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          ticks: { callback: v => "R$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${fmtR$(c.parsed.y)}`,
          },
        },
      },
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtR$(v) {
  if (v == null || isNaN(v)) return "—";
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDataIso(s) {
  if (!s || s === "—") return "—";
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
}

function fmtMesIso(ym) {
  if (!ym) return "—";
  const [y, m] = ym.split("-");
  return `${m}/${y}`;
}

function formatIndexador(idx) {
  return { "CDI+": "CDI+", "CDIp": "% CDI", "IPCA+": "IPCA+", "PREFIX": "Pré", "SELIC+": "Selic+" }[idx] || idx;
}

function formatTaxa(p) {
  // Prioriza taxa_entrada (convencao Anbima por indexador):
  //   IPCA+ -> % a.a. real
  //   CDI+  -> % a.a. spread sobre DI
  //   CDIp  -> % do CDI (ex: 110)
  //   SELIC+ -> % a.a. spread sobre Selic
  //   PREFIX -> % a.a. nominal
  const valor = (p.taxa_entrada != null) ? p.taxa_entrada : p.taxa;
  const t = valor.toLocaleString("pt-BR", { maximumFractionDigits: 4 });
  switch (p.indexador) {
    case "IPCA+":   return t + "% real";
    case "CDI+":    return "DI + " + t + "%";
    case "CDIp":    return t + "% CDI";
    case "SELIC+":  return "Selic + " + t + "%";
    case "PREFIX":  return t + "% a.a.";
    default:        return t + "% a.a.";
  }
}

function formatCupom(c) {
  return { mensal: "Mensal", semestral: "Semestral", anual: "Anual", zero: "Zero" }[c] || c;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
