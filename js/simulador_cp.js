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
  // Carrega premissas (CDI + IPCA) em background
  carregarCdiPremissa().catch(() => {});
  carregarIpcaSerie().catch(() => {});
}

async function carregarIpcaSerie() {
  try {
    const r = await fetch("data/ipca/serie_mensal.json");
    if (!r.ok) return;
    const d = await r.json();
    _ipcaSerie = d.serie || [];
    if (d.premissa_anual_futura) _ipcaPremissaAnual = d.premissa_anual_futura;
    const el = document.getElementById("cp-premissa-ipca");
    if (el) el.textContent = _ipcaPremissaAnual.toFixed(1).replace(".", ",");
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
      if (el) el.textContent = _cdiAnualAtual.toFixed(2).replace(".", ",");
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
function onChangeIndexador() {
  const idx = document.getElementById("cp-indexador").value;
  const lbl = document.getElementById("cp-taxa-label");
  if (idx === "CDIp")        lbl.textContent = "% do CDI (ex: 110)";
  else if (idx === "PREFIX") lbl.textContent = "Taxa prefixada (% a.a.)";
  else                       lbl.textContent = "Spread sobre indexador (% a.a.)";
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
  // Auto-marca isento conforme tipo
  document.getElementById("cp-tipo").onchange = () => {
    const t = document.getElementById("cp-tipo").value;
    document.getElementById("cp-isento").checked = ISENTO_POR_TIPO[t] ?? false;
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
  document.getElementById("cp-btn-adicionar").textContent = "Salvar edição";
  document.getElementById("cp-form-papel").open = true;
  onChangeIndexador();
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
  const t     = papel.taxa / 100;
  switch (papel.indexador) {
    case "IPCA+":   return t;                                // VNA absorve IPCA
    case "CDI+":    return (1 + cdi)   * (1 + t) - 1;        // multiplicativa
    case "CDIp":    return cdi * t;                          // t = 1.10 → 110% CDI
    case "SELIC+":  return (1 + selic) * (1 + t) - 1;
    case "PREFIX":  return t;
    default:        return t;
  }
}

// Para IPCA+: aplica IPCA mensal entre cupons. Para os demais: retorna 1
// (VNA constante = pu_emissao).
function fatorIpcaEntre(dataIni, dataFim) {
  // dataIni, dataFim em YYYY-MM-DD. Aplica IPCA dos meses cuja "Data Ref."
  // (mes-2 da data do cupom) cai entre os dois pagamentos. Convenção
  // mercado brasileiro: defasagem de 2 meses do IPCA divulgado.
  if (!dataIni || !dataFim || dataIni >= dataFim) return 1;
  // Mes de referencia inicial e final (m - 2 de cada extremo)
  const refIni = _mesRefIpca(dataIni);  // YYYY-MM
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
  // Subtrai 2 meses: cupom em 27/04 -> ref = 01/02
  const d = new Date(dataISO + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 2);
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

function projetarPapel(papel, hojeISO, mesesAFrente) {
  // Convenção brasileira (CRI/CRA/Debenture/TPF):
  //   fator_spread_k = (1 + spread_anual)^(DU_k / 252)
  //   cupom_k = VNA_k × (fator_spread_k - 1)
  // Onde DU_k = dias úteis entre cupom_{k-1} (ou emissão) e cupom_k.
  // Para IPCA+: VNA atualiza pelo IPCA mensal (defasagem 2m); para os demais
  // indexadores, VNA = pu_emissao constante.
  const dataEmissao  = papel.data_emissao;
  const dataVencto   = papel.data_vencimento;
  const totalMeses   = mesesEntre(dataEmissao, dataVencto);
  if (totalMeses <= 0) return [];
  const periodoMeses = periodoEmMeses(papel.cupom_periodo);
  const tSpread      = taxaSpreadAnual(papel);
  const VN           = papel.pu_emissao;
  const qtd          = papel.quantidade;
  const usaIpcaVna   = papel.indexador === "IPCA+";
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
  const nParcelas = Math.max(1, Math.floor(totalMeses / periodoMeses));

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
    const dataPgto = cal.proximaDataPagamento(dataEmissao, p * periodoMeses);
    const eVencto  = (p === nParcelas);
    const du       = cal.diasUteisEntre(dataAnt, dataPgto);
    if (usaIpcaVna) vna *= fatorIpcaEntre(dataAnt, dataPgto);
    const fatorSpread = Math.pow(1 + tSpread, du / 252);
    let jurosUnit = 0, amortUnit = 0, irUnit = 0;

    if (papel.amortizacao === "bullet") {
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
  const yieldMensal = custoTotal > 0 ? (medioMes / custoTotal) * 100 : 0;
  const proxVcto = [..._papeisAtual]
    .map(p => p.data_vencimento)
    .filter(d => d >= hojeISO)
    .sort()[0] || "—";

  document.getElementById("cp-resumo-renda-media").textContent = fmtR$(medioMes);
  document.getElementById("cp-resumo-renda-12m").textContent   = fmtR$(totalLiq12);
  document.getElementById("cp-resumo-yield-mensal").textContent = yieldMensal.toFixed(3).replace(".", ",") + "%";
  document.getElementById("cp-resumo-prox-vcto").textContent   = fmtDataIso(proxVcto);

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
  const t = p.taxa.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  if (p.indexador === "CDIp")    return t + "%";
  if (p.indexador === "PREFIX")  return t + "% a.a.";
  return t + "% a.a.";
}

function formatCupom(c) {
  return { mensal: "Mensal", semestral: "Semestral", anual: "Anual", zero: "Zero" }[c] || c;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
